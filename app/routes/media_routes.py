"""
Media Routes
-----------
API endpoints for media file serving with optimized streaming capabilities.
"""
# app/routes/media_routes.py
import os
import io
import time
import gevent # Import gevent for sleep
import random
import logging
import traceback
import socket
from urllib.parse import unquote
from flask import Blueprint, jsonify, current_app, Response, request, send_from_directory, abort
from werkzeug.utils import safe_join # Import safe_join from werkzeug
from app.services.media_service import MediaService
from app.services.category_service import CategoryService # Added for thumbnail route
from app.utils.media_utils import get_mime_type, THUMBNAIL_DIR_NAME # Added THUMBNAIL_DIR_NAME

# Configure socket timeouts for better handling of connection issues
socket.setdefaulttimeout(30)  # 30 second timeout

logger = logging.getLogger(__name__)
media_bp = Blueprint('media', __name__)

# Optimized chunk sizes for progressive loading
INITIAL_CHUNK_SIZE = 256 * 1024  # 256KB for fast initial loading (increased from 64KB)
SUBSEQUENT_CHUNK_SIZE = 512 * 1024  # 512KB for subsequent chunks
MAX_CHUNK_SIZE = 1024 * 1024  # 1MB maximum chunk size

# Small file threshold - files smaller than this will be served from memory
SMALL_FILE_THRESHOLD = 8 * 1024 * 1024  # 8MB - increased to cache more files in memory

# Video file extensions for special handling
VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv']

# Maximum number of concurrent streaming connections
MAX_CONCURRENT_STREAMS = 10

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

# Cache of recently accessed files to speed up repeated access
# Structure: {filepath: (last_access_time, file_data, file_size, mime_type, etag)}
small_file_cache = {}
# Cache of open file descriptors for large files
# Structure: {filepath: (last_access_time, file_descriptor, file_size, mime_type, etag)}
fd_cache = {}
# Maximum number of file descriptors to keep open
MAX_FD_CACHE_SIZE = 30  # Increased to keep more files open
# Cache expiry time in seconds
CACHE_EXPIRY = 600  # 10 minutes - increased for longer caching
# Prefetch buffer size for videos
PREFETCH_SIZE = 1024 * 1024  # 1MB prefetch buffer (increased from 256KB)

# Socket error handling
SOCKET_ERRORS = (ConnectionError, ConnectionResetError, ConnectionAbortedError, 
                BrokenPipeError, socket.timeout, socket.error)

def clean_caches():
    """Remove expired entries from file caches to prevent memory leaks."""
    current_time = time.time()
    
    # Clean small file cache
    expired_keys = [k for k, (access_time, _, _, _, _) in small_file_cache.items() 
                   if current_time - access_time > CACHE_EXPIRY]
    for k in expired_keys:
        del small_file_cache[k]
    
    # Clean file descriptor cache
    expired_fd_keys = [k for k, (access_time, fd, _, _, _) in fd_cache.items() 
                      if current_time - access_time > CACHE_EXPIRY]
    for k in expired_fd_keys:
        try:
            fd_cache[k][1].close()  # Close the file descriptor
        except Exception as e:
            logger.warning(f"Error closing cached file descriptor for {k}: {e}")
        del fd_cache[k]
    
    # If FD cache is still too large, close the least recently used ones
    if len(fd_cache) > MAX_FD_CACHE_SIZE:
        # Sort by access time (oldest first)
        sorted_items = sorted(fd_cache.items(), key=lambda x: x[1][0])
        # Close oldest file descriptors until we're under the limit
        for k, (_, fd, _, _, _) in sorted_items[:len(fd_cache) - MAX_FD_CACHE_SIZE]:
            try:
                fd.close()
            except Exception as e:
                logger.warning(f"Error closing cached file descriptor for {k}: {e}")
            del fd_cache[k]

def serve_small_file(filepath, mime_type, etag, is_video=False):
    """
    Serve small files from memory cache with optimized headers.
    Special handling for video files to improve playback.
    """
    current_time = time.time()
    
    # Check if file is in cache
    if filepath in small_file_cache:
        access_time, file_data, file_size, cached_mime_type, cached_etag = small_file_cache[filepath]
        # Update access time
        small_file_cache[filepath] = (current_time, file_data, file_size, cached_mime_type, cached_etag)
        logger.info(f"Serving small file from cache: {filepath}")
    else:
        # Load file into memory
        try:
            with open(filepath, 'rb') as f:
                file_data = f.read()
            file_size = len(file_data)
            # Cache the file data
            small_file_cache[filepath] = (current_time, file_data, file_size, mime_type, etag)
            logger.info(f"Loaded small file into cache: {filepath} ({file_size} bytes)")
        except Exception as e:
            logger.error(f"Error reading small file {filepath}: {e}")
            return jsonify({'error': f'Error reading file: {str(e)}'}), 500
    
    # Create response
    response = Response(
        file_data,
        mimetype=mime_type
    )
    
    # Add optimized headers
    response.headers['Content-Length'] = file_size
    response.headers['Cache-Control'] = 'public, max-age=86400'  # Cache for 1 day
    response.headers['ETag'] = etag
    
    # Add special headers for video files
    if is_video:
        logger.info(f"Applying video optimizations for small video: {filepath}")
        # Tell browser it can start playing as soon as possible
        response.headers['X-Content-Type-Options'] = 'nosniff'
        # Hint to browser to start playing ASAP
        response.headers['X-Play-Immediately'] = 'true'
        # Suggest inline display rather than download
        filename = os.path.basename(filepath)
        response.headers['Content-Disposition'] = f'inline; filename="{filename}"'
        
        # Add additional headers to help with browser compatibility
        response.headers['Access-Control-Allow-Origin'] = '*'  # Allow cross-origin requests
        response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept'
        
        # Add cache control headers for better browser caching
        response.headers['Cache-Control'] = 'public, max-age=86400, immutable'  # Cache for 1 day
        
        # Add content type parameters to help browsers
        if mime_type == 'video/mp4':
            response.headers['Content-Type'] = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
        elif mime_type == 'video/quicktime':
            # For MOV files, provide alternative MIME types that browsers might recognize better
            response.headers['Content-Type'] = 'video/quicktime'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            # Add a hint that this is H.264 video (common in MOV files)
            response.headers['X-Video-Codec'] = 'h264'
    
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
    current_time = time.time()
    file_obj = None
    
    # Prioritize video files in the cache
    if is_video and len(fd_cache) >= MAX_FD_CACHE_SIZE:
        # Find a non-video file to remove if needed
        non_video_keys = [k for k in fd_cache.keys() 
                         if not any(k.lower().endswith(ext) for ext in VIDEO_EXTENSIONS)]
        if non_video_keys:
            # Remove the oldest non-video file
            oldest_key = min(non_video_keys, key=lambda k: fd_cache[k][0])
            try:
                fd_cache[oldest_key][1].close()
            except:
                pass
            del fd_cache[oldest_key]
            logger.info(f"Removed non-video file from cache to make room for video: {oldest_key}")
    
    # Check if we have a cached file descriptor
    if filepath in fd_cache:
        access_time, file_obj, cached_size, cached_mime, cached_etag = fd_cache[filepath]
        # Verify the file hasn't changed
        if cached_size == file_size and cached_etag == etag:
            # Update access time
            fd_cache[filepath] = (current_time, file_obj, file_size, mime_type, etag)
            # Seek to beginning of file
            try:
                file_obj.seek(0)
                logger.info(f"Using cached file descriptor for: {filepath}")
            except Exception as e:
                logger.warning(f"Error seeking cached file descriptor for {filepath}: {e}")
                # Close and remove from cache if seeking fails
                try:
                    file_obj.close()
                except:
                    pass
                del fd_cache[filepath]
                file_obj = None
        else:
            # File has changed, close old descriptor
            try:
                file_obj.close()
            except:
                pass
            del fd_cache[filepath]
            file_obj = None
    
    # Open the file if needed
    if file_obj is None:
        try:
            file_obj = open(filepath, 'rb')
            # Cache the file descriptor if we're under the limit or it's a video
            if len(fd_cache) < MAX_FD_CACHE_SIZE or is_video:
                fd_cache[filepath] = (current_time, file_obj, file_size, mime_type, etag)
                logger.info(f"Cached file descriptor for: {filepath}")
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
            preload_buffer = file_obj.read(PREFETCH_SIZE)
            file_obj.seek(current_pos)  # Reset position after preloading
            logger.info(f"Preloaded {len(preload_buffer)} bytes for video: {filepath}")
        except Exception as e:
            logger.warning(f"Failed to preload video buffer: {e}")
            # Continue without preloading if it fails
    
    def generate():
        """Generator function that yields file chunks"""
        # Use a separate file object if not caching the descriptor
        f = file_obj if filepath in fd_cache else file_obj
        
        # Use global socket error handling
        
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
            
            # Don't treat client disconnections as errors
            if filepath not in fd_cache:
                try:
                    f.close()
                except:
                    pass
        except Exception as e:
            logger.error(f"Error streaming file {filepath}: {e}")
            # Close file if it's not cached
            if filepath not in fd_cache:
                try:
                    f.close()
                except:
                    pass
        finally:
            # Close file if it's not cached
            if filepath not in fd_cache:
                try:
                    f.close()
                except:
                    pass
    
    # Create streaming response
    response = Response(
        generate(),
        mimetype=mime_type,
        direct_passthrough=True  # Don't buffer in Flask
    )
    
    # Add optimized headers
    response.headers['Content-Length'] = content_length
    response.headers['Cache-Control'] = 'public, max-age=86400'  # Cache for 1 day
    response.headers['ETag'] = etag
    
    # Enable Range requests for videos to improve browser compatibility
    if is_video:
        response.headers['Accept-Ranges'] = 'bytes'
    else:
        response.headers['Accept-Ranges'] = 'none'
    
    # Set status code and additional headers for range requests
    if is_range_request:
        response.status_code = 206  # Partial Content
        response.headers['Content-Range'] = f'bytes {range_start}-{range_end}/{file_size}'
    
    # Add performance headers
    response.headers['X-Accel-Buffering'] = 'no'  # Disable proxy buffering
    response.headers['Connection'] = 'keep-alive'  # Keep connection open
    
    # Add special headers for video files
    if is_video:
        # Tell browser it can start playing as soon as possible
        response.headers['X-Content-Type-Options'] = 'nosniff'
        # Hint to browser to start playing ASAP
        response.headers['X-Play-Immediately'] = 'true'
        # Suggest inline display rather than download
        filename = os.path.basename(filepath)
        response.headers['Content-Disposition'] = f'inline; filename="{filename}"'
        
        # Add additional headers to help with browser compatibility
        response.headers['Access-Control-Allow-Origin'] = '*'  # Allow cross-origin requests
        response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept'
        
        # Add cache control headers for better browser caching
        response.headers['Cache-Control'] = 'public, max-age=86400, immutable'  # Cache for 1 day
        
        # Add content type parameters to help browsers
        if mime_type == 'video/mp4':
            response.headers['Content-Type'] = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
        elif mime_type == 'video/quicktime':
            # For MOV files, provide alternative MIME types that browsers might recognize better
            response.headers['Content-Type'] = 'video/quicktime'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            # Add a hint that this is H.264 video (common in MOV files)
            response.headers['X-Video-Codec'] = 'h264'
    
    return response

@media_bp.route('/media/<category_id>/<path:filename>')
def serve_media(category_id, filename):
    """
    Serve media file with optimized streaming based on file type and size.
    Uses different strategies for videos vs images and small vs large files.
    """
    try:
        # Decode the filename from the URL path
        try:
            decoded_filename = unquote(filename)
        except Exception as decode_error:
            logger.error(f"Error decoding filename '{filename}': {decode_error}")
            return jsonify({'error': 'Invalid filename encoding'}), 400

        # Use MediaService to get the validated file path
        filepath, error = MediaService.get_media_filepath(category_id, decoded_filename)

        if error:
            # Determine status code based on the error from the service
            if "not found" in error:
                status_code = 404
            elif "not readable" in error or "Access denied" in error:
                status_code = 403
            elif "Invalid filename" in error or "not a file" in error:
                 status_code = 400
            else:
                status_code = 500 # Default to server error
            logger.warning(f"Failed to get media filepath for Cat={category_id}, File='{decoded_filename}': {error}")
            return jsonify({'error': error}), status_code

        # Get file stats
        file_stats = os.stat(filepath)
        file_size = file_stats.st_size
        file_mtime = file_stats.st_mtime
        etag = f'"{file_size}-{int(file_mtime)}"'
        
        # Check if client supports caching
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == etag:
            return '', 304
        
        # Check if this is a video file for special handling
        is_video = is_video_file(decoded_filename)
        
        # Get MIME type - use our special mapping for videos
        if is_video:
            _, ext = os.path.splitext(decoded_filename.lower())
            if ext in SPECIAL_MIME_TYPES:
                mime_type = SPECIAL_MIME_TYPES[ext]
                logger.info(f"Using special MIME type for {ext}: {mime_type}")
            else:
                mime_type = get_mime_type(decoded_filename)
            
            # Use our new optimized video streaming function for videos
            logger.info(f"Using optimized HTTP Range streaming for video: {decoded_filename}")
            return stream_video_file(filepath, mime_type, file_size, etag)
        else:
            # For non-video files, use the existing methods
            mime_type = get_mime_type(decoded_filename)
            
            # For smaller files, use optimized in-memory serving
            if file_size < SMALL_FILE_THRESHOLD:
                return serve_small_file(filepath, mime_type, etag, is_video=False)
            
            # For larger non-video files, use the existing non-blocking streaming
            return serve_large_file_non_blocking(
                filepath, 
                mime_type, 
                file_size, 
                etag, 
                is_video=False,
                range_start=None,
                range_end=None
            )

    except Exception as e:
        # Catch-all for unexpected errors during file serving
        logger.error(f"Unexpected error serving media file Cat={category_id}, File='{decoded_filename}': {str(e)}")
        logger.debug(traceback.format_exc())
        # Return a generic error message to avoid exposing sensitive information
        return jsonify({'error': 'An unexpected error occurred while serving the media file'}), 500


@media_bp.route('/thumbnails/<category_id>/<filename>')
def serve_thumbnail(category_id, filename):
    """Serve generated thumbnail with caching headers."""
    logger.debug(f"Request received for thumbnail: Category ID={category_id}, Filename={filename}")
    try:
        # 1. Get category details (including path) using CategoryService
        category = CategoryService.get_category_by_id(category_id)
        if not category:
            logger.warning(f"Thumbnail request failed: Category ID {category_id} not found.")
            abort(404, description="Category not found")

        category_path = category.get('path')
        if not category_path or not os.path.isdir(category_path):
            logger.error(f"Thumbnail request failed: Invalid path for category ID {category_id}: {category_path}")
            abort(500, description="Category path configuration error")

        # 2. Construct the path to the thumbnails directory
        # Use safe_join to prevent directory traversal attacks
        # Note: safe_join needs the base path first.
        thumbnail_dir_abs = safe_join(os.path.abspath(category_path), THUMBNAIL_DIR_NAME)

        if not thumbnail_dir_abs or not os.path.isdir(thumbnail_dir_abs):
             # If the .thumbnails dir doesn't exist yet (e.g., no thumbnails generated), return 404
             logger.warning(f"Thumbnail directory not found or not accessible: {thumbnail_dir_abs}")
             abort(404, description="Thumbnail not found (directory missing)")

        logger.debug(f"Attempting to serve thumbnail from directory: {thumbnail_dir_abs}, file: {filename}")

        # 3. Serve the file using send_from_directory (handles security, MIME types, caching headers)
        # Use max_age for browser caching (e.g., 1 day = 86400 seconds)
        # send_from_directory needs the directory path relative to the app's root or an absolute path.
        # Since category_path can be anywhere, we use the absolute path.
        return send_from_directory(thumbnail_dir_abs, filename, max_age=86400)
    
    except Exception as e:
        logger.error(f"Error serving thumbnail {filename} for category {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        abort(500, description="Internal server error serving thumbnail")
