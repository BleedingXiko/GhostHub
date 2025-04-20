# app/constants.py
"""
GhostHub Application Constants
-----------------------------
Centralized constants used throughout the application.
"""

# WebSocket Room Names
SYNC_ROOM = 'sync_room'  # Room name for WebSocket sync communication
CHAT_ROOM = 'chat_room'  # Room name for WebSocket chat communication

# Socket Events
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
    'CHAT_ERROR': 'chat_error'
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
