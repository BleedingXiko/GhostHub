"""
Sync Service
-----------
Manages synchronized media viewing between multiple users.
Handles host/client relationships and real-time state updates.
"""
# app/services/sync_service.py
import time
import logging
from flask import request, current_app
from .. import socketio # Import the socketio instance
from ..constants import SYNC_ROOM # Import from constants

logger = logging.getLogger(__name__)

# Global sync state (in-memory, non-persistent)
SYNC_MODE_ENABLED = False
HOST_SESSION_ID = None
current_media_state = {
    "category_id": None,
    "file_url": None,
    "index": 0,
    "timestamp": time.time()
}

class SyncService:
    """Service for managing synchronized media viewing."""

    @staticmethod
    def get_status():
        """
        Get current sync mode status.
        
        Returns dict with 'active' and 'is_host' flags.
        """
        global SYNC_MODE_ENABLED, HOST_SESSION_ID
        session_id = request.cookies.get('session_id')
        is_host = SYNC_MODE_ENABLED and session_id == HOST_SESSION_ID
        return {
            "active": SYNC_MODE_ENABLED,
            "is_host": is_host
        }

    @staticmethod
    def toggle_sync_mode(enable, initial_media=None):
        """
        Enable or disable synchronized viewing mode.
        
        Returns updated sync status dictionary.
        """
        global SYNC_MODE_ENABLED, HOST_SESSION_ID, current_media_state

        session_id = request.cookies.get('session_id')
        if not session_id:
            logger.error("Cannot toggle sync mode: Session ID cookie is missing.")
            # In a real app, you might return an error or raise an exception
            # For now, return current state which will likely be inactive
            return SyncService.get_status()

        if enable and not SYNC_MODE_ENABLED:
            # Enabling sync mode
            SYNC_MODE_ENABLED = True
            HOST_SESSION_ID = session_id # The user enabling becomes the host
            logger.info(f"Sync mode enabled by session {HOST_SESSION_ID}.")
            # Reset or set initial media state
            if initial_media and all(k in initial_media for k in ['category_id', 'file_url', 'index']):
                current_media_state = {
                    "category_id": initial_media.get('category_id'),
                    "file_url": initial_media.get('file_url'),
                    "index": initial_media.get('index', 0),
                    "timestamp": time.time()
                }
                logger.info(f"Sync mode initialized with media: {current_media_state}")
            else:
                # Reset if no valid initial media provided
                current_media_state = {
                    "category_id": None, "file_url": None, "index": 0, "timestamp": time.time()
                }
                logger.info("Sync mode enabled with no initial media state.")
            
            # Notify all clients that sync mode has been enabled
            try:
                # Emit to all connected clients (not just those in the sync room)
                socketio.emit('sync_enabled', {
                    'active': True,
                    'host_session_id': HOST_SESSION_ID,
                    'media': current_media_state
                })
                logger.info("Emitted sync_enabled event to all clients")
            except Exception as e:
                logger.error(f"Error emitting sync_enabled event: {e}")

        elif not enable and SYNC_MODE_ENABLED:
            # Disabling sync mode (anyone can disable)
            logger.info(f"Sync mode disabled by session {session_id}.")
            SYNC_MODE_ENABLED = False
            HOST_SESSION_ID = None
            # Reset media state
            current_media_state = {
                "category_id": None, "file_url": None, "index": 0, "timestamp": time.time()
            }
            
            # Notify all clients that sync mode has been disabled
            try:
                # Emit to all connected clients
                socketio.emit('sync_disabled', {
                    'active': False
                })
                logger.info("Emitted sync_disabled event to all clients")
            except Exception as e:
                logger.error(f"Error emitting sync_disabled event: {e}")
        else:
            # No change in state (e.g., already enabled and trying to enable again)
            logger.debug(f"Sync mode toggle requested but state remains {'enabled' if SYNC_MODE_ENABLED else 'disabled'}.")

        return SyncService.get_status()

    @staticmethod
    def get_current_media():
        """
        Get the current shared media state.
        
        Returns media state dict or error if sync disabled.
        """
        global SYNC_MODE_ENABLED, current_media_state
        if not SYNC_MODE_ENABLED:
            return {"error": "Sync mode not enabled"}
        return current_media_state

    @staticmethod
    def update_current_media(category_id, file_url, index):
        """
        Update shared media state (host only).
        
        Returns (success, error_message) tuple.
        """
        global SYNC_MODE_ENABLED, HOST_SESSION_ID, current_media_state

        if not SYNC_MODE_ENABLED:
            return False, "Sync mode not enabled"

        session_id = request.cookies.get('session_id')
        if session_id != HOST_SESSION_ID:
            logger.warning(f"Non-host session {session_id} attempted to update sync state.")
            return False, "Only the host can update the current media"

        # Validate input types (basic)
        if not isinstance(category_id, str) or (file_url is not None and not isinstance(file_url, str)) or not isinstance(index, int):
             logger.error(f"Invalid data types received for sync update: cat={type(category_id)}, url={type(file_url)}, idx={type(index)}")
             return False, "Invalid update data types"

        current_media_state = {
            "category_id": category_id,
            "file_url": file_url,
            "index": index,
            "timestamp": time.time()
        }
        logger.info(f"Host {HOST_SESSION_ID} updated sync media: Cat={category_id}, Idx={index}")

        # Emit the updated state to all clients in the sync room
        try:
            socketio.emit('sync_state', current_media_state, room=SYNC_ROOM)
            logger.info(f"Emitted sync_state update to room '{SYNC_ROOM}': {current_media_state}")
        except Exception as e:
            # Log error but don't fail the HTTP request if emit fails
            logger.error(f"Error emitting sync_state update via WebSocket: {e}")

        return True, None

    @staticmethod
    def is_sync_enabled():
        """Check if sync mode is currently active."""
        global SYNC_MODE_ENABLED
        return SYNC_MODE_ENABLED

    @staticmethod
    def get_host_session_id():
        """Get the session ID of the current host."""
        global HOST_SESSION_ID
        return HOST_SESSION_ID
