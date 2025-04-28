"""
API Routes
---------
REST API endpoints for category and media management.
"""
# app/routes/api_routes.py
import logging
import traceback
import tkinter as tk
from tkinter import filedialog
import os # Import os for path operations
from flask import Blueprint, jsonify, request, current_app
from app.services.category_service import CategoryService
from app.services.media_service import MediaService
from app.services.sync_service import SyncService # Import SyncService
# Import transcoding related services and utils
from app.services.transcoding_service import TranscodingService
from app.services.storage_service import StorageService
from app.services.streaming_service import is_video_file # Corrected import location

logger = logging.getLogger(__name__)
api_bp = Blueprint('api', __name__)

@api_bp.route('/categories', methods=['GET'])
def list_categories():
    """Get all categories with media counts and thumbnails."""
    try:
        categories = CategoryService.get_all_categories_with_details()
        return jsonify(categories)
    except Exception as e:
        logger.error(f"Error in list_categories endpoint: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': 'Failed to retrieve categories'}), 500

@api_bp.route('/categories', methods=['POST'])
def add_category():
    """Create new media category with name and path."""
    data = request.json
    if not data or 'name' not in data or 'path' not in data:
        return jsonify({'error': 'Name and path are required'}), 400

    name = data.get('name')
    path = data.get('path')

    try:
        new_category, error = CategoryService.add_category(name, path)
        if error:
            # Determine appropriate status code based on error
            status_code = 400 if "exists" in error or "not a directory" in error else 500
            return jsonify({'error': error}), status_code
        return jsonify(new_category), 201
    except Exception as e:
        logger.error(f"Unexpected error adding category: Name='{name}', Path='{path}': {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': 'An unexpected error occurred while adding the category'}), 500

@api_bp.route('/categories/<category_id>', methods=['DELETE'])
def delete_category(category_id):
    """Delete category and clear associated caches."""
    try:
        success, error = CategoryService.delete_category(category_id)
        if not success:
            status_code = 404 if error == "Category not found" else 500
            return jsonify({'error': error}), status_code

        # Clear session tracker for the deleted category
        # We don't need to clear the media_file_cache anymore as we're using the index file
        MediaService.clear_session_tracker(category_id=category_id)
        logger.info(f"Cleared session tracker for deleted category: {category_id}")

        return '', 204
    except Exception as e:
        logger.error(f"Unexpected error deleting category ID {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': 'An unexpected error occurred while deleting the category'}), 500

@api_bp.route('/categories/<category_id>/media', methods=['GET'])
def list_media(category_id):
    """Get paginated media files with optional shuffling and async indexing for large directories."""
    try:
        page = request.args.get('page', 1, type=int)
        limit = request.args.get('limit', None, type=int) # Use None to default in service
        force_refresh = request.args.get('force_refresh', 'false').lower() == 'true'
        # Default shuffle to config value, but override if sync mode is active
        default_shuffle = current_app.config.get('SHUFFLE_MEDIA', True)
        if SyncService.is_sync_enabled():
             default_shuffle = False # Don't shuffle in sync mode
             logger.info(f"Sync mode enabled, overriding shuffle to False for category {category_id}")

        shuffle = request.args.get('shuffle', str(default_shuffle)).lower() == 'true'
        

        # Use the async method for large directories
        # This will create and use the index file for every category
        logger.info(f"API route calling list_media_files_async for category {category_id}, page={page}, limit={limit}, force_refresh={force_refresh}")
        
        # Ensure page and limit are valid integers
        if page < 1:
            return jsonify({'error': 'Page number must be 1 or greater'}), 400
        
        if limit is not None and limit < 1:
            return jsonify({'error': 'Limit must be greater than 0'}), 400
        
        # Log the actual query parameters for debugging
        logger.info(f"Query parameters: {dict(request.args)}")
        
        
        # Use the async method which handles large directories more efficiently
        media_files, pagination, error, is_async = MediaService.list_media_files_async(
            category_id,
            page=page,
            limit=limit,
            force_refresh=force_refresh,
            shuffle=shuffle
        )

        if error:
            # Determine status code based on error message
            if "not found" in error:
                status_code = 404
            elif "Permission denied" in error:
                status_code = 403
            elif "Page number" in error or "Limit must be" in error:
                 status_code = 400
            else:
                status_code = 500
            return jsonify({'error': error}), status_code

        response_data = {
            'files': media_files,
            'pagination': pagination
        }
        
        # Add async indexing info if applicable
        if is_async:
            response_data['async_indexing'] = True
            # Include indexing progress if available
            if 'indexing_progress' in pagination:
                response_data['indexing_progress'] = pagination['indexing_progress']
                # Remove from pagination object to maintain backward compatibility
                del pagination['indexing_progress']

        return jsonify(response_data)
    except Exception as e:
        logger.error(f"Error listing media for category {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': f"Server error listing media: {str(e)}"}), 500


@api_bp.route('/browse-folders', methods=['GET'])
def browse_folders():
    """
    Open folder selection dialog on server.
    Returns Docker-specific message if in container.
    """
    # Check if running in Docker environment
    import os
    if os.path.exists('/.dockerenv'):
        logger.info("Running in Docker environment, folder browser not available")
        return jsonify({
            'error': 'Folder browser not available in Docker environment',
            'message': 'To add media directories in Docker, mount volumes in docker-compose.yml',
            'docker': True
        }), 501  # 501 Not Implemented
    
    # Check if running in a headless environment or if Tkinter is available
    try:
        # Attempt to import tkinter and create a root window
        root = tk.Tk()
        root.withdraw() # Hide the main window
        # Bring the dialog to the front
        root.attributes('-topmost', True)
        folder_path = filedialog.askdirectory(title="Select Category Folder")
        root.destroy() # Clean up the Tkinter instance

        if folder_path:
            logger.info(f"Folder selected via Tkinter dialog: {folder_path}")
            return jsonify({'path': folder_path})
        else:
            logger.info("Folder browser cancelled or no folder selected.")
            return jsonify({'path': None}) # Return null path if cancelled
    except (ImportError, tk.TclError) as e:
         logger.error(f"Tkinter error opening folder browser: {str(e)}. This usually means the server environment doesn't support GUI operations.")
         return jsonify({'error': 'Server environment does not support graphical folder browser.'}), 501 # 501 Not Implemented
    except Exception as e:
        logger.error(f"Unexpected error opening folder browser: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': f'Failed to open folder browser: {str(e)}'}), 500


# --- Transcoding API Endpoints ---

@api_bp.route('/api/transcoding/status/<category_id>/<path:filename>')
def get_transcoding_status_route(category_id, filename):
    """Get status of transcoding for a specific file."""
    try:
        # Decode filename
        from urllib.parse import unquote
        decoded_filename = unquote(filename)

        # Get the filepath for the original file
        filepath, error = MediaService.get_media_filepath(category_id, decoded_filename)
        
        if error:
             # Use appropriate status code based on error
            status_code = 404 if "not found" in error else 400 if "Invalid" in error else 500
            return jsonify({'error': error}), status_code
            
        # Get the status from the service
        status = TranscodingService.get_transcoding_status(filepath)
        
        if not status or status.get('status') == 'unknown': # Check if status is empty or unknown
            # Check if it's already transcoded and provide details
            if TranscodingService.has_transcoded_version(category_id, decoded_filename):
                try:
                    # Get original and transcoded file sizes
                    original_size = StorageService.get_file_size(filepath)
                    transcoded_path = StorageService.get_transcoded_path(category_id, decoded_filename)
                    transcoded_size = StorageService.get_file_size(transcoded_path)
                    
                    # Calculate savings
                    size_reduction = original_size - transcoded_size
                    percent_reduction = (size_reduction / original_size) * 100 if original_size > 0 else 0
                    
                    return jsonify({
                        'status': 'complete',
                        'progress': 100,
                        'original_size': original_size,
                        'transcoded_size': transcoded_size,
                        'size_reduction': size_reduction,
                        'percent_reduction': round(percent_reduction, 1)
                    })
                except Exception as size_err:
                     logger.error(f"Error getting file sizes for status check: {size_err}")
                     # Fallback to simple complete status if size check fails
                     return jsonify({'status': 'complete', 'progress': 100})

            # If not transcoded and no active job, check if it *should* be transcoded
            elif TranscodingService.should_transcode(filepath):
                 return jsonify({'status': 'pending', 'progress': 0, 'message': 'Eligible for transcoding'})
            else:
                 return jsonify({'status': 'not_applicable', 'progress': 0, 'message': 'Transcoding not required or file too small'})
        
        # Return the status obtained from the service
        return jsonify(status)
    
    except Exception as e:
        logger.error(f"Error getting transcoding status for {filename}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': f'Server error getting status: {str(e)}'}), 500

@api_bp.route('/api/transcoding/start/<category_id>/<path:filename>', methods=['POST']) # Use POST for action
def start_transcoding_route(category_id, filename):
    """Manually start transcoding for a file."""
    try:
        # Decode filename
        from urllib.parse import unquote
        decoded_filename = unquote(filename)

        # Get the filepath
        filepath, error = MediaService.get_media_filepath(category_id, decoded_filename)
        
        if error:
            status_code = 404 if "not found" in error else 400 if "Invalid" in error else 500
            return jsonify({'error': error}), status_code
            
        # Only allow transcoding videos
        if not is_video_file(decoded_filename):
            return jsonify({'error': 'Only video files can be transcoded'}), 400
            
        # Check if it should be transcoded (e.g., size check)
        if not TranscodingService.should_transcode(filepath):
             return jsonify({'status': 'skipped', 'message': 'Transcoding not required for this file (e.g., too small)'}), 200

        # Start transcoding
        success = TranscodingService.transcode_video(
            category_id, filepath, decoded_filename)
            
        if success:
            # Return status indicating job was queued or already running
            status = TranscodingService.get_transcoding_status(filepath)
            return jsonify({'status': status.get('status', 'queued'), 'message': 'Transcoding job started or already exists.'}), 202 # 202 Accepted
        else:
            # Check if there was a specific error reported by the service
            status = TranscodingService.get_transcoding_status(filepath)
            error_msg = status.get('error', 'Failed to start transcoding job.')
            return jsonify({'error': error_msg}), 500
    
    except Exception as e:
        logger.error(f"Error starting transcoding for {filename}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': f'Server error starting job: {str(e)}'}), 500


# --- End Transcoding API Endpoints ---


# API error handlers
@api_bp.app_errorhandler(404)
def api_not_found(e):
    """Handle 404 errors with JSON response."""
    logger.warning(f"API 404 Not Found: {request.path}")
    return jsonify(error="Resource not found"), 404

@api_bp.app_errorhandler(500)
def api_server_error(e):
    """Handle 500 errors with JSON response."""
    original_exception = getattr(e, "original_exception", e)
    logger.error(f"API 500 Internal Server Error: {original_exception}", exc_info=True)
    return jsonify(error="Internal server error"), 500

@api_bp.app_errorhandler(400)
def api_bad_request(e):
    """Handle 400 errors with JSON response."""
    logger.warning(f"API 400 Bad Request: {request.path} - {e.description}")
    return jsonify(error=e.description), 400

@api_bp.app_errorhandler(403)
def api_forbidden(e):
    """Handle 403 errors with JSON response."""
    logger.warning(f"API 403 Forbidden: {request.path} - {e.description}")
    return jsonify(error=e.description), 403
