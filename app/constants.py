"""
GhostHub Application Constants
-----------------------------
Centralized constants for WebSocket events, API endpoints, and default settings.
Provides a single source of truth for string literals used throughout the app.
"""
# app/constants.py

# WebSocket Room Names
SYNC_ROOM = 'sync_room'  # Room for synchronized media viewing between users
CHAT_ROOM = 'chat_room'  # Room for real-time chat messages between users

# Socket Events - Used by both server and client
SOCKET_EVENTS = {
    # Connection events
    'CONNECT': 'connect',
    'DISCONNECT': 'disconnect',
    'CONNECTION_ERROR': 'connection_error',
    'CONNECTION_STATUS': 'connection_status',
    'HEARTBEAT': 'heartbeat',
    'HEARTBEAT_RESPONSE': 'heartbeat_response',
    
    # Sync events
    'JOIN_SYNC': 'join_sync',
    'LEAVE_SYNC': 'leave_sync',
    'SYNC_STATE': 'sync_state',
    'SYNC_UPDATE': 'sync_update',
    'SYNC_ERROR': 'sync_error',
    'USER_JOINED': 'user_joined',
    'USER_LEFT': 'user_left',
    
    # Chat events
    'JOIN_CHAT': 'join_chat',
    'REJOIN_CHAT': 'rejoin_chat',  # Added for handling page refreshes without notifications
    'LEAVE_CHAT': 'leave_chat',
    'CHAT_MESSAGE': 'chat_message',
    'CHAT_NOTIFICATION': 'chat_notification',
    'CHAT_ERROR': 'chat_error',
    
    # Command events (for slash commands)
    'COMMAND': 'command',
    
    # Client state update
    'UPDATE_MY_STATE': 'update_my_state'
}

# File Types
MEDIA_TYPES = {
    'IMAGE': 'image',
    'VIDEO': 'video'
}

# API Endpoints
API_ENDPOINTS = {
    'MEDIA_LIST': '/api/media/list',
    'MEDIA_ITEM': '/api/media/item',
    'CATEGORIES': '/api/categories',
    'SYNC': '/api/sync',
    'SYNC_STATE': '/api/sync/state',
    'SYNC_CONTROL': '/api/sync/control'
}

# Default Settings
DEFAULT_SETTINGS = {
    'PAGE_SIZE': 10,
    'CACHE_EXPIRY': 300,  # 5 minutes in seconds
    'SESSION_EXPIRY': 3600,  # 1 hour in seconds
    'PORT': 5000
}

# Error Messages
ERROR_MESSAGES = {
    'CATEGORY_NOT_FOUND': 'Category not found',
    'MEDIA_NOT_FOUND': 'Media not found',
    'INVALID_REQUEST': 'Invalid request',
    'SYNC_NOT_ENABLED': 'Sync mode is not currently active',
    'UNAUTHORIZED': 'Unauthorized access'
}
