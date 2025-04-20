# app/routes/api_routes.py
import logging
import traceback
import tkinter as tk
from tkinter import filedialog
from flask import Blueprint, jsonify, request, current_app
from app.services.category_service import CategoryService
from app.services.media_service import MediaService
from app.services.sync_service import SyncService # Import SyncService

logger = logging.getLogger(__name__)
api_bp = Blueprint('api', __name__)

@api_bp.route('/categories', methods=['GET'])
def list_categories():
    """API endpoint to list all categories with details."""
    try:
        categories = CategoryService.get_all_categories_with_details()
        return jsonify(categories)
    except Exception as e:
        logger.error(f"Error in list_categories endpoint: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': 'Failed to retrieve categories'}), 500

@api_bp.route('/categories', methods=['POST'])
def add_category():
    """API endpoint to add a new category."""
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
    """API endpoint to delete a category."""
    try:
        success, error = CategoryService.delete_category(category_id)
        if not success:
            status_code = 404 if error == "Category not found" else 500
            return jsonify({'error': error}), status_code

        # Also clear media cache and session tracker for the deleted category
        if category_id in MediaService.media_file_cache:
            del MediaService.media_file_cache[category_id]
            logger.info(f"Cleared media cache for deleted category: {category_id}")
        MediaService.clear_session_tracker(category_id=category_id)

        return '', 204
    except Exception as e:
        logger.error(f"Unexpected error deleting category ID {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': 'An unexpected error occurred while deleting the category'}), 500

@api_bp.route('/categories/<category_id>/media', methods=['GET'])
def list_media(category_id):
    """API endpoint to list media files for a category with pagination."""
    try:
        page = request.args.get('page', 1, type=int)
        limit = request.args.get('limit', None, type=int) # Use None to default in service
        force_refresh = request.args.get('force_refresh', 'false').lower() == 'true'
        # Default shuffle to true, but override if sync mode is active
        default_shuffle = True
        if SyncService.is_sync_enabled():
             default_shuffle = False # Don't shuffle in sync mode
             logger.info(f"Sync mode enabled, overriding shuffle to False for category {category_id}")

        shuffle = request.args.get('shuffle', str(default_shuffle)).lower() == 'true'


        media_files, pagination, error = MediaService.list_media_files(
            category_id,
            page=page,
            limit=limit, # Pass None or the value
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

        return jsonify({
            'files': media_files,
            'pagination': pagination
        })
    except Exception as e:
        logger.error(f"Error listing media for category {category_id}: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({'error': f"Server error listing media: {str(e)}"}), 500


@api_bp.route('/browse-folders', methods=['GET'])
def browse_folders():
    """
    API endpoint to open a folder selection dialog on the server.
    Requires Tkinter.
    
    In Docker environment, this will return a message instructing the user
    to mount volumes in docker-compose.yml instead.
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

# Add common error handlers for the API blueprint
@api_bp.app_errorhandler(404)
def api_not_found(e):
    logger.warning(f"API 404 Not Found: {request.path}")
    return jsonify(error="Resource not found"), 404

@api_bp.app_errorhandler(500)
def api_server_error(e):
    # Log the original exception
    original_exception = getattr(e, "original_exception", e)
    logger.error(f"API 500 Internal Server Error: {original_exception}", exc_info=True)
    return jsonify(error="Internal server error"), 500

@api_bp.app_errorhandler(400)
def api_bad_request(e):
    logger.warning(f"API 400 Bad Request: {request.path} - {e.description}")
    return jsonify(error=e.description), 400

@api_bp.app_errorhandler(403)
def api_forbidden(e):
     logger.warning(f"API 403 Forbidden: {request.path} - {e.description}")
     return jsonify(error=e.description), 403
