"""
Streaming Service
---------------
Provides optimized streaming capabilities for media files.
"""
# app/services/streaming_service.py

import os
import io
import time
import gevent
import random
import logging
import traceback
import socket
from flask import Response, request, jsonify
from app.utils.media_utils import get_mime_type
from app.utils.cache_utils import (
    get_from_small_cache, add_to_small_cache,
    get_from_fd_cache, add_to_fd_cache,
    clean_caches, SMALL_FILE_THRESHOLD
)

logger = logging.getLogger(__name__)

# Configure socket timeouts for better handling of connection issues
socket.setdefaulttimeout(30)  # 30 second timeout

# Optimized chunk sizes for progressive loading
INITIAL_CHUNK_SIZE = 256 * 1024  # 256KB for fast initial loading
SUBSEQUENT_CHUNK_SIZE = 512 * 1024  # 512KB for subsequent chunks
MAX_CHUNK_SIZE = 1024 * 1024  # 1MB maximum chunk size

# Video file extensions for special handling
VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv']

# Special MIME type mapping for problematic formats
SPECIAL_MIME_TYPES = {
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.flv': 'video/x-flv'
}

# Ultra-small initial chunk for immediate playback start
ULTRA_FAST_CHUNK_SIZE = 32 * 1024  # 32KB for immediate response

# Socket error handling
SOCKET_ERRORS = (ConnectionError, ConnectionResetError, ConnectionAbortedError, 
                BrokenPipeError, socket.timeout, socket.error)

def _set_common_response_headers(response, filepath, mime_type, file_size, etag, is_video, is_range_request=False, range_start=None, range_end=None):
    """Helper function to set common headers for streaming responses."""
    response.headers['Content-Length'] = file_size if not is_range_request else (range_end - range_start + 1)
    response.headers['Cache-Control'] = 'public, max-age=86400'  # Cache for 1 day
    if etag:
        response.headers['ETag'] = etag
    
    filename = os.path.basename(filepath)
    response.headers['Content-Disposition'] = f'inline; filename="{filename}"'
    response.headers['Connection'] = 'keep-alive'

    if is_video:
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Play-Immediately'] = 'true'
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept'
        response.headers['Cache-Control'] = 'public, max-age=86400, immutable' # More specific for videos

        if mime_type == 'video/mp4':
            response.headers['Content-Type'] = f'{mime_type}; codecs="avc1.42E01E, mp4a.40.2"'
        elif mime_type == 'video/quicktime':
            response.headers['Content-Type'] = mime_type # Keep original
            response.headers['X-Video-Codec'] = 'h264' # Hint codec
        # else, Content-Type is already set by mimetype in Response constructor
    else:
        response.headers['Accept-Ranges'] = 'none'

    if is_range_request:
        response.status_code = 206  # Partial Content
        response.headers['Content-Range'] = f'bytes {range_start}-{range_end}/{file_size}'
    
    # For non-range requests that are videos, ensure Content-Type is set correctly if not already modified
    elif is_video and mime_type not in ['video/mp4', 'video/quicktime']:
         response.headers['Content-Type'] = mime_type


def serve_small_file(filepath, mime_type, etag, is_video=False):
    """
    Serve small files from memory cache with optimized headers.
    Special handling for video files to improve playback.
    """
    # Check if file is in cache
    cache_result = get_from_small_cache(filepath)
    
    if cache_result:
        file_data, file_size, cached_mime_type, cached_etag = cache_result
    else:
        # Load file into memory
        try:
            with open(filepath, 'rb') as f:
                file_data = f.read()
            file_size = len(file_data)
            # Cache the file data
            add_to_small_cache(filepath, file_data, file_size, mime_type, etag)
        except Exception as e:
            logger.error(f"Error reading small file {filepath}: {e}")
            return jsonify({'error': f'Error reading file: {str(e)}'}), 500
    
    # Create response
    response = Response(
        file_data,
        mimetype=mime_type # Initial mimetype
    )
    
    _set_common_response_headers(response, filepath, mime_type, file_size, etag, is_video)
    
    # Specific logging for small video files
    if is_video:
        logger.info(f"Serving small video with optimized headers: {filepath}")

    return response

def is_video_file(filename):
    """Check if file has a video extension."""
    _, ext = os.path.splitext(filename.lower())
    return ext in VIDEO_EXTENSIONS

def parse_range_header(range_header, file_size):
    """
    Parse HTTP Range header for partial content requests.
    
    Returns (start_byte, end_byte, is_valid) tuple.
    """
    if not range_header or not range_header.startswith('bytes='):
        return 0, file_size - 1, False
    
    try:
        # Remove 'bytes=' prefix and get the range
        ranges_str = range_header[6:].strip()
        
        # We only support a single range for now (most browsers only request one)
        if ',' in ranges_str:
            logger.warning(f"Multiple ranges requested, but only supporting first range: {ranges_str}")
            ranges_str = ranges_str.split(',')[0].strip()
        
        # Parse the range
        range_parts = ranges_str.split('-')
        
        # Handle different range formats: bytes=X-Y, bytes=X-, bytes=-Y
        if range_parts[0]:
            start_byte = int(range_parts[0])
            end_byte = int(range_parts[1]) if range_parts[1] else file_size - 1
        else:
            # Handle suffix range: bytes=-Y (last Y bytes)
            suffix_length = int(range_parts[1])
            start_byte = max(0, file_size - suffix_length)
            end_byte = file_size - 1
        
        # Validate range
        if start_byte < 0 or end_byte >= file_size or start_byte > end_byte:
            logger.warning(f"Invalid range requested: {range_header} for file size {file_size}")
            return 0, file_size - 1, False
        
        return start_byte, end_byte, True
    except (ValueError, IndexError) as e:
        logger.warning(f"Error parsing range header '{range_header}': {e}")
        return 0, file_size - 1, False

def stream_video_file(filepath, mime_type, file_size, etag=None):
    """
    Stream video with HTTP Range support for efficient seeking.
    Sets optimal headers for smooth browser playback.
    """
    # Default chunk size for streaming (256KB is a good balance)
    CHUNK_SIZE = 256 * 1024
    
    # Check for Range header
    range_header = request.headers.get('Range')
    start_byte, end_byte, is_range_request = parse_range_header(range_header, file_size)
    
    # Calculate content length
    content_length = end_byte - start_byte + 1
    
    # Handle If-Range header (conditional range requests)
    if_range = request.headers.get('If-Range', '')
    if is_range_request and etag and if_range and if_range != etag:
        # If the entity is not unchanged, send entire entity
        start_byte, end_byte = 0, file_size - 1
        content_length = file_size
        is_range_request = False
    
    # Handle If-None-Match header (conditional GET)
    if_none_match = request.headers.get('If-None-Match', '')
    if etag and if_none_match and etag in [tag.strip() for tag in if_none_match.split(',')]:
        return '', 304  # Not Modified
    
    # Create response headers
    headers = {
        'Content-Type': mime_type,
        'Content-Length': content_length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',  # Cache for 1 day
        'Connection': 'keep-alive'
    }
    
    # Add ETag if provided
    if etag:
        headers['ETag'] = etag
    
    # Set Content-Range header for range requests
    if is_range_request:
        headers['Content-Range'] = f'bytes {start_byte}-{end_byte}/{file_size}'
    
    # Set Content-Disposition to suggest inline display
    filename = os.path.basename(filepath)
    headers['Content-Disposition'] = f'inline; filename="{filename}"'
    
    # Define the generator function for streaming
    def generate():
        try:
            with open(filepath, 'rb') as video_file:
                # Seek to the starting byte for range requests
                video_file.seek(start_byte)
                
                # Track how many bytes we've sent
                bytes_sent = 0
                bytes_to_send = content_length
                
                # Stream the file in chunks
                while bytes_to_send > 0:
                    # Read the appropriate chunk size
                    chunk_size = min(CHUNK_SIZE, bytes_to_send)
                    chunk = video_file.read(chunk_size)
                    
                    # If we've reached EOF, break
                    if not chunk:
                        break
                    
                    # Update counters
                    bytes_sent += len(chunk)
                    bytes_to_send -= len(chunk)
                    
                    # Yield the chunk
                    yield chunk

                    # Yield control to other greenlets
                    gevent.sleep(0)

        except SOCKET_ERRORS as e:
            # Handle client disconnections gracefully
            logger.debug(f"Client disconnected during streaming of {filepath}: {e}")
        except Exception as e:
            logger.error(f"Error streaming file {filepath}: {e}")
            logger.debug(traceback.format_exc())
    
    # Create and return the streaming response
    status_code = 206 if is_range_request else 200
    return Response(
        generate(),
        status=status_code,
        headers=headers,
        direct_passthrough=True  # Don't buffer in Flask
    )

def serve_large_file_non_blocking(filepath, mime_type, file_size, etag, is_video=False, range_start=None, range_end=None):
    """
    Stream large files with progressive chunk sizes and non-blocking I/O.
    Optimized for video playback with prefetching and range support.
    """
    # Handle range request
    is_range_request = range_start is not None and range_end is not None
    content_length = range_end - range_start + 1 if is_range_request else file_size
    
    # Check if we have a cached file descriptor
    cache_result = get_from_fd_cache(filepath)
    
    if cache_result:
        file_obj, cached_size, cached_mime, cached_etag = cache_result
        # Verify the file hasn't changed
        if cached_size != file_size or cached_etag != etag:
            # File has changed, close old descriptor
            try:
                file_obj.close()
            except:
                pass
            file_obj = None
    else:
        file_obj = None
    
    # Open the file if needed
    if file_obj is None:
        try:
            file_obj = open(filepath, 'rb')
            # Cache the file descriptor
            add_to_fd_cache(filepath, file_obj, file_size, mime_type, etag)
        except Exception as e:
            logger.error(f"Error opening file {filepath}: {e}")
            return jsonify({'error': f'Error opening file: {str(e)}'}), 500
    
    # Clean caches periodically
    if random.random() < 0.05:  # ~5% chance on each request
        clean_caches()
    
    # For videos, preload a small buffer to speed up initial playback
    preload_buffer = None
    if is_video:
        try:
            current_pos = file_obj.tell()
            preload_buffer = file_obj.read(ULTRA_FAST_CHUNK_SIZE)
            file_obj.seek(current_pos)  # Reset position after preloading
            logger.info(f"Preloaded {len(preload_buffer)} bytes for video: {filepath}")
        except Exception as e:
            logger.warning(f"Failed to preload video buffer: {e}")
            # Continue without preloading if it fails
    
    def generate():
        """Generator function that yields file chunks"""
        # Use a separate file object if not caching the descriptor
        f = file_obj
        
        try:
            # Handle range request - seek to the start position
            if is_range_request:
                f.seek(range_start)
                bytes_sent = 0
                bytes_remaining = content_length
                logger.info(f"Range request: {range_start}-{range_end} ({content_length} bytes)")
            else:
                # Send preloaded buffer first for videos (only for non-range requests)
                if is_video and preload_buffer:
                    yield preload_buffer
                    bytes_sent = len(preload_buffer)
                else:
                    bytes_sent = 0
                bytes_remaining = file_size - bytes_sent
            
            # Start with ultra-small chunks for immediate playback start
            # Use even smaller chunks for MOV files which seem problematic
            if is_video and filepath.lower().endswith('.mov'):
                current_chunk_size = ULTRA_FAST_CHUNK_SIZE
                logger.info(f"Using ultra-fast chunk size for MOV file: {filepath}")
            else:
                current_chunk_size = INITIAL_CHUNK_SIZE
            next_chunk = None  # For prefetching
            
            while bytes_remaining > 0:
                # If we have a prefetched chunk, use it
                if next_chunk:
                    chunk = next_chunk
                    next_chunk = None
                else:
                    # For range requests, adjust chunk size for the last chunk
                    if is_range_request and bytes_remaining < current_chunk_size:
                        chunk = f.read(bytes_remaining)
                    else:
                        # Read a chunk
                        chunk = f.read(current_chunk_size)
                
                if not chunk:
                    break
                
                # For range requests, ensure we don't send more than requested
                if is_range_request and len(chunk) > bytes_remaining:
                    chunk = chunk[:bytes_remaining]
                
                # Start prefetching the next chunk in parallel
                # This helps ensure we always have data ready to send
                if is_video and bytes_sent > INITIAL_CHUNK_SIZE and bytes_remaining > SUBSEQUENT_CHUNK_SIZE:
                    try:
                        next_chunk_size = min(SUBSEQUENT_CHUNK_SIZE, MAX_CHUNK_SIZE)
                        # Limit prefetch size based on remaining bytes
                        next_chunk_size = min(next_chunk_size, bytes_remaining - current_chunk_size)
                        if next_chunk_size > 0:
                            next_chunk = f.read(next_chunk_size)
                    except:
                        next_chunk = None
                
                # Yield control to other greenlets
                gevent.sleep(0)
                
                yield chunk
                
                chunk_size = len(chunk)
                bytes_sent += chunk_size
                bytes_remaining -= chunk_size
                
                # Progressively increase chunk size for better throughput
                # But only after sending the initial chunk
                if bytes_sent > INITIAL_CHUNK_SIZE and current_chunk_size < MAX_CHUNK_SIZE:
                    # For range requests (seeking), keep chunks smaller for faster response
                    if is_range_request:
                        current_chunk_size = min(INITIAL_CHUNK_SIZE * 2, MAX_CHUNK_SIZE)
                    else:
                        current_chunk_size = min(SUBSEQUENT_CHUNK_SIZE, MAX_CHUNK_SIZE)

                # Yield control to other greenlets
                gevent.sleep(0)

        except SOCKET_ERRORS as e:
            # Handle connection errors gracefully - these are expected during video streaming
            # Browsers often abort connections after receiving enough data or when seeking
            if is_range_request:
                # For range requests, connection aborts are completely normal
                logger.debug(f"Client disconnected during range request for {filepath}: {e}")
            else:
                logger.info(f"Client disconnected during streaming of {filepath}: {e}")
        except Exception as e:
            logger.error(f"Error streaming file {filepath}: {e}")
    
    # Create streaming response
    response = Response(
        generate(),
        mimetype=mime_type, # Initial mimetype
        direct_passthrough=True
    )
    
    _set_common_response_headers(response, filepath, mime_type, file_size, etag, is_video, is_range_request, range_start, range_end)
    response.headers['X-Accel-Buffering'] = 'no' # Specific to this function for proxy interaction

    # Ensure status code is set correctly by helper or here
    if not is_range_request:
        response.status_code = 200
    
    return response
