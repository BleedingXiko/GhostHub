"""
Sync Routes
----------
API endpoints for synchronized media viewing functionality.
"""
# app/routes/sync_routes.py
import logging
import traceback
from flask import Blueprint, jsonify, request
from app.services.sync_service import SyncService

logger = logging.getLogger(__name__)
sync_bp = Blueprint('sync', __name__)

@sync_bp.route('/status', methods=['GET'])
def sync_status():
    """Get current sync mode status."""
    try:
        status = SyncService.get_status()
        return jsonify(status)
    except Exception as e:
        logger.error(f"Error getting sync status: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({"error": "Failed to get sync status"}), 500

@sync_bp.route('/toggle', methods=['POST'])
def toggle_sync_mode():
    """Enable or disable synchronized viewing mode."""
    data = request.json
    if not data or 'enabled' not in data or not isinstance(data['enabled'], bool):
        return jsonify({"error": "Invalid request data: 'enabled' (boolean) is required"}), 400

    enable_sync = data['enabled']
    initial_media = data.get('media') # Optional initial state

    # Basic validation for initial_media if provided
    if initial_media is not None:
        if not isinstance(initial_media, dict) or not all(k in initial_media for k in ['category_id', 'file_url', 'index']):
             logger.warning(f"Invalid 'media' data provided during sync toggle: {initial_media}")
             initial_media = None # Ignore invalid initial media

    try:
        updated_status = SyncService.toggle_sync_mode(enable_sync, initial_media)
        return jsonify(updated_status)
    except Exception as e:
        logger.error(f"Error toggling sync mode: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({"error": "Failed to toggle sync mode"}), 500

@sync_bp.route('/current', methods=['GET'])
def get_current_media():
    """Get current media being displayed in sync mode."""
    try:
        media_state = SyncService.get_current_media()
        if "error" in media_state:
            return jsonify(media_state), 400 # Sync mode not enabled
        return jsonify(media_state)
    except Exception as e:
        logger.error(f"Error getting current sync media: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({"error": "Failed to get current sync media"}), 500

@sync_bp.route('/update', methods=['POST'])
def update_current_media():
    """Update current media in sync mode (host only)."""
    data = request.json
    if not data or not all(k in data for k in ['category_id', 'file_url', 'index']):
        return jsonify({"error": "Invalid update data: 'category_id', 'file_url', and 'index' are required"}), 400

    category_id = data.get('category_id')
    file_url = data.get('file_url')
    index = data.get('index')

    # Add type checking for index
    if not isinstance(index, int):
         try:
             index = int(index) # Try converting if it's a string number
         except (ValueError, TypeError):
              return jsonify({"error": "Invalid update data: 'index' must be an integer"}), 400

    try:
        success, error = SyncService.update_current_media(category_id, file_url, index)
        if not success:
            status_code = 403 if "Only the host" in error else 400 # 403 Forbidden for non-host
            return jsonify({"error": error}), status_code
            
        # Also update the session state for the host
        session_id = request.cookies.get('session_id')
        if session_id:
            SyncService.update_session_state(session_id, category_id, index)
            
        return jsonify({"success": True})
    except Exception as e:
        logger.error(f"Error updating sync media: {str(e)}")
        logger.debug(traceback.format_exc())
        return jsonify({"error": "Failed to update sync media"}), 500
