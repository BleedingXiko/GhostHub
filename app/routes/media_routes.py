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
from app.utils.media_utils import get_mime_type, get_media_type as util_get_media_type # Renamed to avoid conflict
from app.services.transcoding_service import TranscodingService # Import new service
from flask import current_app # For accessing config

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
        # is_vid = is_video_file(decoded_filename) # We'll determine this after potential transcoding
        
        # Determine media type and potentially transcode
        current_media_type = util_get_media_type(decoded_filename)
        effective_filepath = filepath # Path to serve, might be updated by transcoding
        effective_filename_for_mime = decoded_filename # Filename to use for MIME, might change

        if current_media_type == 'video':
            logger.debug(f"Processing video file: {decoded_filename}")
            _, ext = os.path.splitext(decoded_filename.lower())
            formats_requiring_transcoding = current_app.config['VIDEO_FORMATS_REQUIRING_TRANSCODING']
            logger.debug(f"File extension: {ext}, Formats requiring transcoding: {formats_requiring_transcoding}")

            if ext in formats_requiring_transcoding:
                logger.info(f"Video format {ext} for {decoded_filename} is in VIDEO_FORMATS_REQUIRING_TRANSCODING. Attempting transcoding.")
                # Need category_path for transcoding service
                category = CategoryService.get_category_by_id(category_id)
                if not category or not category.get('path'):
                    logger.error(f"Could not get category path for category_id {category_id} during transcoding check for {decoded_filename}. Cannot proceed with transcoding.")
                    # Fallback to serving original or error out
                else:
                    category_path = category['path']
                    # On-the-fly streaming is determined SOLELY by the config setting.
                    on_the_fly_enabled = current_app.config.get('TRANSCODE_ON_THE_FLY_STREAMING', False)
                    logger.info(f"On-the-fly streaming decision for {decoded_filename}: {on_the_fly_enabled} (Config: {on_the_fly_enabled})")

                    if on_the_fly_enabled:
                        logger.info(f"Attempting on-the-fly streaming for: {filepath}")
                        streaming_response = TranscodingService.stream_transcoded_video_on_the_fly(filepath)
                        if streaming_response:
                            logger.info(f"Successfully initiated on-the-fly streaming for {decoded_filename}.")
                            # Note: ETag/caching headers are tricky with pure on-the-fly.
                            # The Response object from stream_transcoded_video_on_the_fly handles its own mimetype.
                            # For simplicity, we are not adding complex ETag handling here for the streaming response.
                            return streaming_response
                        else:
                            logger.warning(f"On-the-fly streaming failed for {decoded_filename}. Falling back to transcode-and-save.")
                            # Fall through to standard transcode-and-save if on-the-fly fails

                    # Standard transcode-and-save (or fallback from failed on-the-fly)
                    logger.debug(f"Calling TranscodingService.get_or_create_transcoded_video for original: {filepath}, category_path: {category_path}")
                    transcoded_path = TranscodingService.get_or_create_transcoded_video(filepath, category_path)
                    
                    if transcoded_path and os.path.exists(transcoded_path) and transcoded_path != filepath:
                        logger.info(f"Successfully obtained/created transcoded video path: {transcoded_path}. Will serve this version.")
                        effective_filepath = transcoded_path
                        effective_filename_for_mime = os.path.basename(transcoded_path)
                        file_stats = os.stat(effective_filepath)
                        file_size = file_stats.st_size
                        file_mtime = file_stats.st_mtime
                        etag = f'"{file_size}-{int(file_mtime)}"'
                        if client_etag and client_etag == etag:
                            logger.debug(f"Client ETag matches for (saved) transcoded file {effective_filename_for_mime}. Returning 304.")
                            return '', 304
                    elif transcoded_path == filepath:
                        logger.info(f"Transcoding service returned original path for {decoded_filename} (or no transcoding needed/fallback).")
                    else: # transcoded_path is None or doesn't exist after get_or_create
                        logger.warning(f"Transcoding (save method) failed or no valid path for {decoded_filename}. Will attempt to serve original.")
            else:
                logger.info(f"Video format {ext} for {decoded_filename} does not require transcoding. Serving original.")

        # Now determine how to serve based on effective_filepath and effective_filename_for_mime
        logger.debug(f"Final effective_filepath: {effective_filepath}, effective_filename_for_mime: {effective_filename_for_mime}")
        is_effective_vid = is_video_file(effective_filename_for_mime) # Check if the file to be served is video
        logger.debug(f"Is effective file a video? {is_effective_vid}")

        if is_effective_vid:
            _, ext = os.path.splitext(effective_filename_for_mime.lower())
            if ext in SPECIAL_MIME_TYPES:
                mime_type = SPECIAL_MIME_TYPES[ext]
                logger.info(f"Using special MIME type for {ext}: {mime_type}")
            else:
                mime_type = get_mime_type(effective_filename_for_mime)
            
            logger.info(f"Using optimized HTTP Range streaming for video: {effective_filename_for_mime}")
            return stream_video_file(effective_filepath, mime_type, file_size, etag)
        else:
            # For non-video files (or videos not streamed with range requests, though unlikely now)
            mime_type = get_mime_type(effective_filename_for_mime)
            
            if file_size < SMALL_FILE_THRESHOLD: # Use file_size of the (potentially transcoded) file
                # Use effective_filepath here
                return serve_small_file(effective_filepath, mime_type, etag, is_video=False)
            
            # For larger non-video files, use the non-blocking streaming
            # Use effective_filepath here
            return serve_large_file_non_blocking(
                effective_filepath, 
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

        # 2. Construct the path to the thumbnails directory (inside .ghosthub)
        # Use safe_join to prevent directory traversal attacks
        ghosthub_dir = safe_join(os.path.abspath(category_path), current_app.config['GHOSTHUB_SUBDIR_NAME'])
        thumbnail_dir_abs = safe_join(ghosthub_dir, current_app.config['THUMBNAIL_SUBDIR_NAME'])

        if not thumbnail_dir_abs or not os.path.isdir(thumbnail_dir_abs):
             # If the .ghosthub/.thumbnails dir doesn't exist yet, return 404
             logger.warning(f"Thumbnail directory not found or not accessible: {thumbnail_dir_abs}")
             abort(404, description="Thumbnail not found (directory missing)")

        logger.debug(f"Attempting to serve thumbnail from directory: {thumbnail_dir_abs}, file: {filename}")

        # 3. Serve the file using send_from_directory
        # Use max_age for browser caching (e.g., 1 day = 86400 seconds)
        # send_from_directory needs the directory path relative to the app's root or an absolute path.
        # Since category_path can be anywhere, we use the absolute path.
        return send_from_directory(thumbnail_dir_abs, filename, max_age=86400)
    
    except Exception as e:
        logger.error(f"Error serving thumbnail {filename} for category {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        abort(500, description="Internal server error serving thumbnail")
