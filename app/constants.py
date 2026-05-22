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
    
    # Playback sync events (play, pause, seek)
    'PLAYBACK_SYNC': 'playback_sync',
    
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
    'UPDATE_MY_STATE': 'update_my_state',

    # View command specific events
    'REQUEST_VIEW_INFO': 'request_view_info',
    'VIEW_INFO_RESPONSE': 'view_info_response',

    # Admin kick events
    'ADMIN_KICK_USER': 'admin_kick_user',
    'YOU_HAVE_BEEN_KICKED': 'you_have_been_kicked',
    'ADMIN_KICK_CONFIRMATION': 'admin_kick_confirmation',

    # Admin status update (broadcast when admin role becomes free or changes)
    'ADMIN_STATUS_UPDATE': 'admin_status_update',

    # Profile events
    'PROFILE_SELECTED': 'profile_selected',
    'PROFILES_CHANGED': 'profiles_changed',
    
    # USB/Storage events
    'USB_MOUNTS_CHANGED': 'usb_mounts_changed',
    
    # Tunnel status events
    'TUNNEL_STATUS_UPDATE': 'tunnel_status_update',

    # Library/category broadcast events
    'CATEGORY_UPDATED': 'category_updated',
    'THUMBNAIL_STATUS_UPDATE': 'thumbnail_status_update',

    # Progress broadcast events
    'PROGRESS_UPDATE': 'progress_update',

    # Sync toggle broadcast events
    'SYNC_ENABLED': 'sync_enabled',
    'SYNC_DISABLED': 'sync_disabled',

    # GhostStream broadcast events
    'GHOSTSTREAM_PROGRESS': 'ghoststream_progress',
    'GHOSTSTREAM_STATUS': 'ghoststream_status',

    # Factory reset (USB sentinel file detected)
    'FACTORY_RESET': 'factory_reset',
}

# File Types
MEDIA_TYPES = {
    'IMAGE': 'image',
    'VIDEO': 'video'
}

# Default Settings
DEFAULT_SETTINGS = {
    'PAGE_SIZE': 10,
    'CACHE_EXPIRY': 300,  # 5 minutes in seconds
    'SESSION_EXPIRY': 604800,  # 7 days in seconds
    'PORT': 5000
}

# TV Display Events
TV_EVENTS = {
    'TV_CONNECTED': 'tv_connected',              # Emitted by TV display client on connection
    'TV_STATUS_UPDATE': 'tv_status_update',      # Broadcast by server: {'connected': True/False, 'tv_sid': sid_if_connected}
    'REQUEST_TV_STATUS': 'request_tv_status',    # Emitted by main client to check TV status
    'CAST_MEDIA_TO_TV': 'cast_media_to_tv',      # Emitted by main client to send media
    'DISPLAY_MEDIA_ON_TV': 'display_media_on_tv',# Emitted by server to TV display client
    'TV_ERROR': 'tv_error',                      # Emitted by server for TV related errors
    'CAST_SUCCESS': 'cast_success',              # Emitted by server to casting client on success
    'TV_PLAYBACK_CONTROL': 'tv_playback_control',# Emitted by caster to control TV playback (play/pause/seek)
    'TV_PLAYBACK_STATE': 'tv_playback_state',    # Emitted by server to caster/admin with current playback state
    'TV_REPORT_STATE': 'tv_report_state',        # Emitted by TV to server with current playback state
    'TV_REQUEST_STATE': 'tv_request_state',      # Emitted by server to TV to request immediate state snapshot
    'TV_STOP_CASTING': 'tv_stop_casting',        # Emitted by caster to stop casting and clear TV display
    'GUEST_CAST_PROGRESS': 'guest_cast_progress',# Emitted by server to guest caster with progress data for IndexedDB saving
    'TV_ADD_SUBTITLE': 'tv_add_subtitle',        # Emitted by caster to add a subtitle track to the TV display

    # HDMI/kiosk status events
    'HDMI_STATUS': 'hdmi_status',                # HDMI display status broadcast
    'KIOSK_STATUS': 'kiosk_status',              # Kiosk process status broadcast

    # Kiosk boot events
    'KIOSK_BOOTING': 'kiosk_booting',            # Emitted when kiosk boot is initiated (before TV connects)
    'KIOSK_BOOT_COMPLETE': 'kiosk_boot_complete',# Emitted when kiosk successfully connects
    'KIOSK_BOOT_TIMEOUT': 'kiosk_boot_timeout',  # Emitted if kiosk fails to boot within timeout
}

# Error Messages
ERROR_MESSAGES = {
    'CATEGORY_NOT_FOUND': 'Category not found',
    'MEDIA_NOT_FOUND': 'Media not found',
    'INVALID_REQUEST': 'Invalid request',
    'SYNC_NOT_ENABLED': 'Sync mode is not currently active',
    'UNAUTHORIZED': 'Unauthorized access'
}

# ======================================================================
# SPECTER Internal Bus Event Constants
# Convention: 'domain:action' (e.g. 'storage:mount_changed')
# These are for the SPECTER internal event bus only.
# Socket events go through SOCKET_EVENTS / TV_EVENTS above.
# ======================================================================

BUS_EVENTS = {
    # Storage — drive mount/unmount, directory changes
    'STORAGE_MOUNT_CHANGED': 'storage:mount_changed',
    'STORAGE_DRIVE_ADDED': 'storage:drive_added',
    'STORAGE_DRIVE_REMOVED': 'storage:drive_removed',
    'STORAGE_FILE_UPLOADED': 'storage:file_uploaded',
    'STORAGE_BATCH_UPLOADED': 'storage:batch_uploaded',
    'STORAGE_FILE_DELETED': 'storage:file_deleted',
    'STORAGE_FILES_DELETED': 'storage:files_deleted',
    'STORAGE_FILE_RENAMED': 'storage:file_renamed',
    'STORAGE_FOLDER_DELETED': 'storage:folder_deleted',
    'STORAGE_SESSION_CLEARED': 'storage:session_cleared',

    # Media — file operations, library scanning
    'MEDIA_FILE_ADDED': 'media:file_added',
    'MEDIA_FILE_DELETED': 'media:file_deleted',
    'MEDIA_SCAN_STARTED': 'media:scan_started',
    'MEDIA_SCAN_COMPLETED': 'media:scan_completed',

    # Category — cache invalidation, discovery
    'CATEGORY_INVALIDATED': 'categories:invalidated',
    'CATEGORY_UPDATED': 'categories:updated',

    # Thumbnail — generation, queue status
    'THUMBNAIL_GENERATED': 'thumbnail:generated',
    'THUMBNAIL_QUEUE_EMPTY': 'thumbnail:queue_empty',

    # System — lifecycle, health
    'SYSTEM_STARTUP_COMPLETE': 'system:startup_complete',
    'SYSTEM_SHUTDOWN_STARTED': 'system:shutdown_started',
    'SYSTEM_HEALTH_CHECK': 'system:health_check',

    # Database — schema changes, cleanup
    'DATABASE_CLEANUP_COMPLETE': 'database:cleanup_complete',
    'DATABASE_MIGRATION_COMPLETE': 'database:migration_complete',
}
