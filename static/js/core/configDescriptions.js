/**
 * Configuration Descriptions
 * Provides descriptive text for each configuration setting.
 */

export const CONFIG_DESCRIPTIONS = {
    // Python Config
    "python_config.CACHE_EXPIRY": "Cache Expiry (seconds): How long server-side caches for things like media lists will be stored before being refreshed. Default: 300.",
    "python_config.DEFAULT_PAGE_SIZE": "Default Page Size: Number of items the server returns per page for paginated data (e.g., media files). Default: 10.",
    "python_config.SESSION_EXPIRY": "Session Expiry (seconds): How long a user's session remains active. Default: 3600 (1 hour).",
    "python_config.SHUFFLE_MEDIA": "Shuffle Media (boolean): If true, media items within a category are shuffled by default. Sync mode overrides this to false. Default: true.",
    "python_config.WS_RECONNECT_ATTEMPTS": "WebSocket Reconnect Attempts (Server): Max attempts server-side components might try to reconnect (if applicable, primarily a guide). Default: 10.",
    "python_config.WS_RECONNECT_DELAY": "WebSocket Reconnect Delay (ms, Server): Initial delay before server-side components attempt WebSocket reconnection. Default: 1000.",
    "python_config.WS_RECONNECT_FACTOR": "WebSocket Reconnect Factor (Server): Multiplier for WebSocket reconnection delay increase after each failed attempt. Default: 1.5.",
    "python_config.MEMORY_CLEANUP_INTERVAL": "Memory Cleanup Interval (ms, Server): How often the server performs certain memory cleanup tasks. Default: 60000.",
    "python_config.MAX_CACHE_SIZE": "Max Cache Size (Server/Client): Maximum number of items for certain server-side caches. This value is also passed to the client to guide its media element cache size. Default: 50.",
    "python_config.SAVE_CURRENT_INDEX": "Save Current Index (boolean): If true, the application will remember the last viewed item in each category. Default: false.",
    "python_config.SESSION_PASSWORD": "Session Password: Set a password to protect access to categories. Leave blank to disable. Takes effect immediately.",
    
    // GhostStream Settings
    "python_config.GHOSTSTREAM_ENABLED": "GhostStream Enabled: Enable GhostStream integration for external GPU transcoding. Requires a GhostStream server running on your network.",
    "python_config.GHOSTSTREAM_SERVER": "GhostStream Server: Server address (e.g., '192.168.4.2:8765'). Leave empty for automatic mDNS discovery.",
    "python_config.GHOSTSTREAM_AUTO_TRANSCODE": "Auto Transcode: Automatically transcode incompatible video formats (MKV, AVI, HEVC, etc.) for browser playback.",
    "python_config.GHOSTSTREAM_DEFAULT_RESOLUTION": "Default Resolution: Target resolution for transcoding (4k, 1080p, 720p, 480p, original). Default: 1080p.",
    "python_config.GHOSTSTREAM_DEFAULT_CODEC": "Default Codec: Video codec for transcoding (h264, h265, vp9). H.264 has best compatibility. Default: h264.",
    "python_config.GHOSTSTREAM_PREFER_ABR": "Prefer ABR: Use Adaptive Bitrate streaming (multiple quality variants) instead of single-quality HLS. Better for variable networks.",

    // JavaScript Config - main
    "javascript_config.main.socket_reconnectionAttempts": "Main Socket Reconnect Attempts (Client): Max reconnection attempts for the primary client-side WebSocket (used for chat/general events). Default: 5.",
    "javascript_config.main.socket_reconnectionDelay": "Main Socket Reconnect Delay (ms, Client): Initial delay for primary client WebSocket reconnection. Default: 2000.",
    "javascript_config.main.phase2_init_delay": "Phase 2 Init Delay (ms, Client): Delay before secondary application components are initialized. Default: 250.",
    "javascript_config.main.phase3_init_delay": "Phase 3 Init Delay (ms, Client): Delay before non-critical features (like chat) are initialized. Default: 500.",

    // JavaScript Config - core_app
    "javascript_config.core_app.media_per_page_desktop": "Media Per Page (Desktop, Client): Number of media items loaded at once when scrolling on desktop. Default: 5.",
    "javascript_config.core_app.media_per_page_mobile": "Media Per Page (Mobile, Client): Number of media items loaded at once when scrolling on mobile. Default: 3.",
    "javascript_config.core_app.load_more_threshold_desktop": "Load More Threshold (Desktop, Client): How many items from the end of the list to trigger loading more media on desktop. Default: 3.",
    "javascript_config.core_app.load_more_threshold_mobile": "Load More Threshold (Mobile, Client): How many items from the end of the list to trigger loading more media on mobile. Default: 2.",
    "javascript_config.core_app.render_window_size": "Render Window Size (Client): Number of off-screen media items to pre-render (0 means only the current item). Affects performance and memory. Default: 0.",
    "javascript_config.core_app.mobile_cleanup_interval": "Mobile Cleanup Interval (ms, Client): How often aggressive memory cleanup tasks run on mobile devices. Default: 60000.",
    "javascript_config.core_app.mobile_fetch_timeout": "Mobile Fetch Timeout (ms, Client): Timeout for media fetch operations on mobile devices. Default: 15000.",
    "javascript_config.core_app.fullscreen_check_interval": "Fullscreen Check Interval (ms, Client): How often to check and ensure fullscreen buttons are available on mobile. Default: 2000.",

    // JavaScript Config - sync_manager
    "javascript_config.sync_manager.socket_reconnectionAttempts": "Sync Socket Reconnect Attempts (Client): Max reconnection attempts for the Socket.IO client in sync mode. Default: 10.",
    "javascript_config.sync_manager.socket_reconnectionDelay": "Sync Socket Reconnect Delay (ms, Client): Initial delay for Socket.IO client reconnection in sync mode. Default: 1000.",
    "javascript_config.sync_manager.socket_reconnectionDelayMax": "Sync Socket Max Reconnect Delay (ms, Client): Maximum delay for Socket.IO client reconnection in sync mode. Default: 5000.",
    "javascript_config.sync_manager.socket_timeout": "Sync Socket Connection Timeout (ms, Client): Timeout for initial Socket.IO connection in sync mode. Default: 20000.",
    "javascript_config.sync_manager.socket_pingTimeout": "Sync Socket Ping Timeout (ms, Client): How long the client waits for a pong packet before closing the connection in sync mode. Default: 120000.",
    "javascript_config.sync_manager.socket_pingInterval": "Sync Socket Ping Interval (ms, Client): How often the client sends a ping packet in sync mode. Default: 10000.",
    "javascript_config.sync_manager.heartbeatInterval": "Sync Heartbeat Interval (ms, Client): How often the client sends a custom heartbeat event to the server in sync mode. Default: 30000.",
    "javascript_config.sync_manager.manual_maxReconnectAttempts": "Sync Manual Max Reconnect Attempts (Client): Max attempts for the custom manual reconnection logic after Socket.IO fails. Default: 10.",
    "javascript_config.sync_manager.manual_reconnectDelayBase": "Sync Manual Reconnect Base Delay (ms, Client): Base delay for custom manual reconnection logic. Default: 1000.",
    "javascript_config.sync_manager.manual_reconnectFactor": "Sync Manual Reconnect Factor (Client): Multiplier for custom manual reconnection delay. Default: 1.5.",
    "javascript_config.sync_manager.manual_reconnect_delay_max_mobile": "Sync Manual Max Reconnect Delay (Mobile, ms, Client): Max delay for custom manual reconnection on mobile. Default: 10000.",
    "javascript_config.sync_manager.manual_reconnect_delay_max_desktop": "Sync Manual Max Reconnect Delay (Desktop, ms, Client): Max delay for custom manual reconnection on desktop. Default: 30000.",
    "javascript_config.sync_manager.manual_reconnect_trigger_delay": "Sync Manual Reconnect Trigger Delay (ms, Client): Delay before attempting a manual reconnect after certain disconnect reasons. Default: 2000.",
    "javascript_config.sync_manager.connect_error_force_ui_timeout": "Sync Connect Error UI Timeout (ms, Client): Timeout after several connection errors before forcing UI to become responsive. Default: 5000."
};
