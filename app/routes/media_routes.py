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
from app.utils.media_utils import get_mime_type, THUMBNAIL_DIR_NAME

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
        
        # Get MIME type - use our special mapping for videos
        if is_vid:
            _, ext = os.path.splitext(decoded_filename.lower())
            if ext in SPECIAL_MIME_TYPES:
                mime_type = SPECIAL_MIME_TYPES[ext]
                logger.info(f"Using special MIME type for {ext}: {mime_type}")
            else:
                mime_type = get_mime_type(decoded_filename)
            
            # Use our optimized video streaming function from streaming_service
            logger.info(f"Using optimized HTTP Range streaming for video: {decoded_filename}")
            return stream_video_file(filepath, mime_type, file_size, etag)
        else:
            # For non-video files, use the appropriate methods from streaming_service
            mime_type = get_mime_type(decoded_filename)
            
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
