"""
Media Routes
-----------
API endpoints for media file serving with optimized streaming capabilities.
"""
# app/routes/media_routes.py
import os
import logging
import traceback
from urllib.parse import unquote
from flask import Blueprint, jsonify, request, send_from_directory, abort, Response
from werkzeug.utils import safe_join
from app.services.media_service import MediaService
from app.services.category_service import CategoryService
from app.services.streaming_service import (
    serve_small_file, stream_video_file, serve_large_file_non_blocking,
    is_video_file, SMALL_FILE_THRESHOLD, SPECIAL_MIME_TYPES
)
# Import new services
from app.services.storage_service import StorageService
from app.services.transcoding_service import TranscodingService
from app.utils.media_utils import get_mime_type # Removed THUMBNAIL_DIR_NAME import

logger = logging.getLogger(__name__)
media_bp = Blueprint('media', __name__)

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
        is_vid = is_video_file(decoded_filename)
        original_filepath = filepath # Keep original path for transcoding check

        # --- Transcoding Logic ---
        if is_vid and TranscodingService.is_enabled():
            # Get the category path from the category ID
            category = CategoryService.get_category_by_id(category_id)
            category_path = category['path']
            
            # Check if a valid transcoded version exists
            if TranscodingService.has_transcoded_version(category_path, decoded_filename):
                # Use the transcoded file path
                filepath = StorageService.get_transcoded_path(category_path, decoded_filename)
                logger.info(f"Serving transcoded version for {decoded_filename}")
                
                # Update file stats for the transcoded file
                try:
                    file_stats = os.stat(filepath)
                    file_size = file_stats.st_size
                    file_mtime = file_stats.st_mtime
                    etag = f'"{file_size}-{int(file_mtime)}"' # Recalculate ETag
                    # MIME type for transcoded files is always mp4
                    mime_type = 'video/mp4' 
                except FileNotFoundError:
                     logger.error(f"Transcoded file {filepath} reported as existing but not found. Serving original.")
                     filepath = original_filepath # Fallback to original
                     # Re-fetch original stats
                     file_stats = os.stat(filepath)
                     file_size = file_stats.st_size
                     file_mtime = file_stats.st_mtime
                     etag = f'"{file_size}-{int(file_mtime)}"'
                     mime_type = get_mime_type(decoded_filename) # Get original mime type
                
            elif TranscodingService.should_transcode(original_filepath):
                # No transcoded version exists, and it should be transcoded
                # Schedule transcoding for the *original* file
                TranscodingService.transcode_video(
                    category_path, original_filepath, decoded_filename)
                logger.info(f"Scheduled transcoding for future viewing: {decoded_filename}")
                # Serve the original file for now
                filepath = original_filepath 
                mime_type = get_mime_type(decoded_filename) # Use original mime type
            else:
                 # Transcoding not needed or file too small, serve original
                 filepath = original_filepath
                 mime_type = get_mime_type(decoded_filename) # Use original mime type

        else:
             # Not a video or transcoding disabled, get original mime type
             mime_type = get_mime_type(decoded_filename)
        # --- End Transcoding Logic ---


        # Serve the file (either original or transcoded)
        if is_vid:
            # Use special MIME type mapping if applicable (primarily for original files)
            # Transcoded files should generally be mp4
            if filepath == original_filepath: # Only apply special types if serving original
                 _, ext = os.path.splitext(decoded_filename.lower())
                 if ext in SPECIAL_MIME_TYPES:
                      mime_type = SPECIAL_MIME_TYPES[ext]
                      logger.info(f"Using special MIME type for original {ext}: {mime_type}")
            
            # Use optimized video streaming (works for both original and transcoded mp4)
            logger.info(f"Using optimized HTTP Range streaming for video: {os.path.basename(filepath)}")
            return stream_video_file(filepath, mime_type, file_size, etag)
        else:
            # For non-video files (images, etc.)
            # Use the appropriate methods from streaming_service
            
            # For smaller files, use optimized in-memory serving
            if file_size < SMALL_FILE_THRESHOLD:
                return serve_small_file(filepath, mime_type, etag, is_video=False)
            
            # For larger non-video files, use the non-blocking streaming
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


# Route uses '/media/thumbnails/' prefix now for consistency
@media_bp.route('/media/thumbnails/<category_id>/<filename>')
def serve_thumbnail(category_id, filename):
    """Serve thumbnail from .ghosthub directory within category path."""
    logger.debug(f"Request received for thumbnail: Category ID={category_id}, Filename={filename}")
    try:
        # Decode filename just in case
        try:
            decoded_filename = unquote(filename)
        except Exception as decode_error:
            logger.error(f"Error decoding thumbnail filename '{filename}': {decode_error}")
            abort(400, description='Invalid filename encoding')

        # Get the category path from the category ID
        category = CategoryService.get_category_by_id(category_id)
        if not category:
            logger.error(f"Category not found for thumbnail: {category_id}")
            abort(404, description="Category not found")
        
        category_path = category['path']
        
        # Get the directory where thumbnails for this category are stored
        thumbnail_dir = StorageService.get_thumbnail_dir(category_path)
        
        # Check if the specific thumbnail file exists
        thumbnail_path = os.path.join(thumbnail_dir, decoded_filename)

        if not os.path.exists(thumbnail_path) or not os.path.isfile(thumbnail_path):
            logger.warning(f"Thumbnail file not found: {thumbnail_path}")
            # Optionally, trigger generation here if needed, or just 404
            abort(404, description="Thumbnail not found")

        logger.debug(f"Attempting to serve thumbnail from: {thumbnail_path}")

        # Serve the file using send_from_directory
        # It needs the directory and the filename separately
        return send_from_directory(
            thumbnail_dir, 
            decoded_filename, 
            max_age=86400 # Cache for 1 day
        )
    
    except Exception as e:
        logger.error(f"Error serving thumbnail {filename} for category {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        abort(500, description="Internal server error serving thumbnail")
