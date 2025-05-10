/**
 * Sync Manager Module
 * Handles sync mode functionality for synchronized media viewing using WebSockets.
 */

import { app, getMediaPerPage, MOBILE_DEVICE } from '../core/app.js'; // Changed MEDIA_PER_PAGE to getMediaPerPage
import { updateSyncToggleButton, disableNavigationControls, enableNavigationControls } from './uiController.js';
import { renderMediaWindow } from './mediaNavigation.js';
import { getConfigValue } from '../utils/configManager.js'; // Import getConfigValue
import { viewCategory } from './mediaLoader.js';
import { ensureFeatureAccess } from '../utils/authManager.js'; // Import the new auth utility

// Socket.IO instance (initialized later)
let socket = null;
let isWebSocketConnected = false;
let heartbeatInterval = null; // Module scope for proper cleanup

// Variables for custom reconnection logic, initialized from config later
let currentReconnectAttempts = 0; // Renamed from reconnectAttempts to avoid conflict with socket.io option
let configuredMaxReconnectAttempts;
let configuredReconnectDelayBase;
let configuredReconnectFactor;


// Add page unload handler to clean up socket connections
window.addEventListener('beforeunload', () => {
    disconnectWebSocket();
});

// --- Status Display Management ---

/**
 * Update the sync status display with a specific state
 * @param {string} state - The state to display ('connecting', 'error', 'success', etc.)
 * @param {string} message - The message to display
 * @param {number} [timeout] - Optional timeout to reset to default state
 */
function updateSyncStatusDisplay(state, message, timeout = 0) {
    const syncHeaderDisplay = document.getElementById('sync-status-display');
    if (!syncHeaderDisplay) return;
    
    let color = '#FFFFFF'; // Default white
    
    switch (state) {
        case 'connecting':
        case 'sending':
        case 'loading':
        case 'toggling':
            color = '#FFC107'; // Yellow
            break;
        case 'error':
        case 'failed':
            color = '#F44336'; // Red
            break;
        case 'success':
            color = '#4CAF50'; // Green
            break;
        case 'warning':
            color = '#FF9800'; // Orange
            break;
        case 'default':
            // Use the default color based on sync state
            updateSyncToggleButton();
            return;
    }
    
    syncHeaderDisplay.textContent = message;
    syncHeaderDisplay.style.color = color;
    
    // Reset to default state after timeout if specified
    if (timeout > 0) {
        setTimeout(() => updateSyncToggleButton(), timeout);
    }
}

// --- WebSocket Management ---

/**
 * Initialize WebSocket connection and event listeners.
 */
function initWebSocket() {
    if (socket) {
        console.log('WebSocket already initialized or connecting.');
        return;
    }

    try {
        console.log('Initializing WebSocket connection...');

        // Load Socket.IO client options from config
        const socketIoOptions = {
            reconnectionAttempts: getConfigValue('javascript_config.sync_manager.socket_reconnectionAttempts', 10),
            reconnectionDelay: getConfigValue('javascript_config.sync_manager.socket_reconnectionDelay', 1000),
            reconnectionDelayMax: getConfigValue('javascript_config.sync_manager.socket_reconnectionDelayMax', 5000),
            timeout: getConfigValue('javascript_config.sync_manager.socket_timeout', 20000),
            pingTimeout: getConfigValue('javascript_config.sync_manager.socket_pingTimeout', 120000),
            pingInterval: getConfigValue('javascript_config.sync_manager.socket_pingInterval', 10000),
            transports: ['websocket', 'polling']
        };
        console.log("SyncManager: Initializing Socket.IO with options:", socketIoOptions);
        socket = io(socketIoOptions);

        // Initialize parameters for custom reconnection logic from config
        configuredMaxReconnectAttempts = getConfigValue('javascript_config.sync_manager.manual_maxReconnectAttempts', 10);
        configuredReconnectDelayBase = getConfigValue('javascript_config.sync_manager.manual_reconnectDelayBase', 1000);
        configuredReconnectFactor = getConfigValue('javascript_config.sync_manager.manual_reconnectFactor', 1.5);
        
        // Socket connected successfully

        // --- Connection Events ---
        socket.on('connect', () => {
            console.log('WebSocket connected successfully:', socket.id);
            isWebSocketConnected = true;
            updateSyncToggleButton(); // Update header display

            // Reset custom reconnection attempts on successful connection
            currentReconnectAttempts = 0;
            // configuredReconnectDelayBase is already set from config, no need to reset to hardcoded 1000

            // If we are a guest in sync mode, join the sync room
            if (app.state.syncModeEnabled && !app.state.isHost) {
                console.log('Joining sync room via WebSocket...');
                socket.emit('join_sync');
            }
            
            // Start heartbeat to keep connection alive
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }
            
            const heartbeatIntervalDelay = getConfigValue('javascript_config.sync_manager.heartbeatInterval', 30000);
            heartbeatInterval = setInterval(() => {
                if (socket && socket.connected) {
                    console.log('Sending heartbeat to keep connection alive');
                    socket.emit('heartbeat');
                }
            }, heartbeatIntervalDelay);
        });

        socket.on('disconnect', (reason) => {
            console.warn('WebSocket disconnected:', reason);
            isWebSocketConnected = false;
            updateSyncToggleButton(); // Update header display

            // Clear heartbeat interval on disconnect
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }

            if (reason === 'io server disconnect') {
                // The server intentionally disconnected the socket, maybe sync stopped?
                console.log('Server disconnected socket. Checking sync status.');
                checkSyncMode(); // Re-check status
            } else if (reason === 'transport close' || reason === 'ping timeout') {
                // Connection was closed or timed out - try to reconnect more aggressively
                console.log('Connection lost due to transport close or timeout. Attempting reconnect...');
                // Socket.IO will attempt to reconnect automatically based on options
                // But we can also manually trigger a reconnect after a short delay
                setTimeout(() => {
                    if (socket && !socket.connected) {
                        console.log('Manually triggering reconnect...');
                        socket.connect();
                    }
                }, getConfigValue('javascript_config.sync_manager.manual_reconnect_trigger_delay', 2000));
            }
            // Socket.IO will attempt to reconnect automatically based on options
        });

        socket.on('connect_error', (error) => {
            console.error('WebSocket connection error:', error);
            isWebSocketConnected = false;
            updateSyncToggleButton(); // Update header display
            
            // Clear heartbeat interval on connection error
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            
            const forceUiTimeoutDelay = getConfigValue('javascript_config.sync_manager.connect_error_force_ui_timeout', 5000);
            // Add timeout to prevent indefinite hanging on mobile (or any device after several attempts)
            if (currentReconnectAttempts > 3) { // Using currentReconnectAttempts
                setTimeout(() => {
                    if (!isWebSocketConnected) {
                        console.log('Forcing application to continue despite WebSocket issues');
                        enableNavigationControls();
                        updateSyncToggleButton();
                        if (app.state.syncModeEnabled && !app.state.isHost) {
                            console.log('Resetting sync state due to connection timeout');
                            app.state.syncModeEnabled = false;
                            updateSyncToggleButton();
                            updateSyncStatusDisplay('error', 'Sync: Connection Timed Out', forceUiTimeoutDelay);
                        }
                    }
                }, forceUiTimeoutDelay);
            }
            
            // Implement exponential backoff for reconnection using configured values
            currentReconnectAttempts++;
            if (currentReconnectAttempts <= configuredMaxReconnectAttempts) {
                const jitter = Math.random() * 0.3 + 0.85; 
                const maxDelay = MOBILE_DEVICE ? 
                    getConfigValue('javascript_config.sync_manager.manual_reconnect_delay_max_mobile', 10000) :
                    getConfigValue('javascript_config.sync_manager.manual_reconnect_delay_max_desktop', 30000);
                
                const delay = Math.min(
                    configuredReconnectDelayBase * Math.pow(configuredReconnectFactor, currentReconnectAttempts - 1) * jitter,
                    maxDelay
                );
                
                console.log(`Connection attempt ${currentReconnectAttempts}/${configuredMaxReconnectAttempts} failed. Retrying in ${Math.round(delay)}ms...`);
                updateSyncStatusDisplay('connecting', `Sync: Reconnecting (${currentReconnectAttempts}/${configuredMaxReconnectAttempts})`);
                
                setTimeout(() => {
                    if (socket && !socket.connected) {
                        console.log(`Attempting reconnection #${currentReconnectAttempts}...`);
                        socket.connect();
                    }
                }, delay);
            } else {
                console.error(`Maximum reconnection attempts (${configuredMaxReconnectAttempts}) reached. Giving up.`);
                updateSyncStatusDisplay('error', 'Sync: Connection Failed');
                
                // If we're in sync mode as a guest, we need to reset the state
                if (app.state.syncModeEnabled && !app.state.isHost) {
                    console.log('Resetting sync state due to connection failure');
                    app.state.syncModeEnabled = false;
                    updateSyncToggleButton();
                    enableNavigationControls();
                }
            }
        });
        
        // Handle heartbeat responses
        socket.on('heartbeat_response', (data) => {
            console.log('Received heartbeat response:', data);
            // Could update UI to show connection is healthy if needed
        });
        
        // Handle connection status updates
        socket.on('connection_status', (data) => {
            console.log('Received connection status update:', data);
            if (data.status === 'connected') {
                console.log('Server confirmed connection is established');
            }
        });
        
        // Handle connection errors
        socket.on('connection_error', (data) => {
            console.error('Server reported connection error:', data);
            // Could show an error message to the user
        });

        // --- Custom Sync Events ---
        socket.on('sync_enabled', (data) => {
            console.log('Received sync_enabled via WebSocket:', data);
            
        // Only handle if we're not the host (the host already knows sync is enabled)
        const session_id = getCookieValue('session_id');
        if (data.host_session_id !== session_id) {
            console.log('Host has enabled sync mode. Joining as guest...');
            
            // Update local state
            app.state.syncModeEnabled = true;
            app.state.isHost = false;
            
            // Update UI
            updateSyncToggleButton();
            disableNavigationControls();
            
            // Show notification that sync mode was enabled
            updateSyncStatusDisplay('success', 'Sync: Joined as Guest', 3000);

            // Join the sync room
            socket.emit('join_sync');
            
            // If media state is provided, handle it
            if (data.media && data.media.category_id) {
                // Force handling of sync update regardless of current state
                console.log('Forcing sync update with host media state (via sync_enabled event):', data.media);
                // Let handleSyncUpdate perform the password check
                handleSyncUpdate(data.media, true); 
            }
        }
        });
        
        socket.on('sync_state', (data) => {
            console.log('Received sync_state via WebSocket:', data);
            if (app.state.syncModeEnabled && !app.state.isHost) {
                handleSyncUpdate(data); // Process the received state
            } else {
                console.log('Ignoring sync_state update (not guest or sync disabled)');
            }
        });

        socket.on('sync_disabled', (data) => {
            console.log('Received sync_disabled via WebSocket:', data);
            
            // Only update if we're currently in sync mode
            if (app.state.syncModeEnabled) {
                console.log('Host has disabled sync mode. Updating local state...');
                
                // Update local state
                app.state.syncModeEnabled = false;
                app.state.isHost = false;
                
                // Update UI
                updateSyncToggleButton();
                // updateSyncStatusIndicator(); // updateSyncToggleButton handles this now
                enableNavigationControls();

                // Show notification to user that sync was disabled by host
                updateSyncStatusDisplay('warning', 'Sync: Disabled by Host', 3000);
            }
        });

        socket.on('sync_error', (error) => {
            console.error('Received sync_error via WebSocket:', error.message);
            alert(`Sync Error: ${error.message}`);
            // Potentially disable sync mode locally or take other action
            updateSyncStatusDisplay('error', `Sync Error: ${error.message}`, 5000);
        });

        // Helper function to get cookie value
        function getCookieValue(name) {
            const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
            return match ? match[2] : null;
        }

    } catch (error) {
            console.error('Fatal error initializing WebSocket:', error);
            // Fallback or notification needed if io() itself fails
            updateSyncStatusDisplay('error', 'Sync: WS Init Failed!');
       }
};

/**
 * Disconnect WebSocket connection.
 */
function disconnectWebSocket() {
    if (socket) {
        console.log('Disconnecting WebSocket...');
        
        // Clear heartbeat interval
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        // Remove all event listeners to prevent memory leaks
        socket.off('connect');
        socket.off('disconnect');
        socket.off('connect_error');
        socket.off('heartbeat_response');
        socket.off('connection_status');
        socket.off('connection_error');
        socket.off('sync_enabled');
        socket.off('sync_state');
        socket.off('sync_disabled');
        socket.off('sync_error');
        socket.off('receive_view_state');
        
        socket.disconnect();
        socket = null; // Ensure socket instance is cleared
        isWebSocketConnected = false;
        updateSyncToggleButton(); // Use the new function instead of updateSyncStatusIndicator
    }
}


// --- Sync State Management (HTTP + WebSocket Integration) ---

/**
 * Check if sync mode is enabled via HTTP (initial check or re-check).
 */
async function checkSyncMode() {
    try {
        console.log('Checking sync mode status via HTTP...');
        const response = await fetch('/api/sync/status');

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Sync status response:', data);

        const wasSyncEnabled = app.state.syncModeEnabled;
        const wasHost = app.state.isHost;

        // Update app state
        app.state.syncModeEnabled = data.active;
        app.state.isHost = data.is_host;

        // Update toggle button UI (this now also updates the header status display)
        updateSyncToggleButton();
        // updateSyncStatusIndicator(); // No longer needed

        // Handle transitions based on new state
        if (app.state.syncModeEnabled) {
            if (!app.state.isHost) {
                // --- Guest Mode ---
                console.log('Sync active: Guest mode.');
                initWebSocket(); // Ensure WebSocket is connecting/connected
                // Also explicitly try to join sync immediately after initializing WS,
                // in case the 'connect' event fires before the state is fully set.
                // Socket.IO handles joining the same room multiple times.
                if (socket) { // Check if socket was successfully initialized
                    console.log('Explicitly emitting join_sync after initWebSocket for guest.');
                    socket.emit('join_sync');
                }
                disableNavigationControls();
            } else {
                // --- Host Mode ---
                console.log('Sync active: Host mode.');
                disconnectWebSocket(); // Host doesn't need to listen via WebSocket
                enableNavigationControls();
            }
        } else {
            // --- Sync Disabled ---
            if (wasSyncEnabled) { // Only log/disconnect if it *was* enabled
                 console.log('Sync is now disabled.');
                 disconnectWebSocket();
            }
            enableNavigationControls();
        }

        return data;
    } catch (error) {
        console.error('Error checking sync mode:', error);

        // Reset sync state on error
        app.state.syncModeEnabled = false;
        app.state.isHost = false;
        updateSyncToggleButton();

        // Update sync status indicator to show error
        updateSyncStatusDisplay('error', 'Sync: Status Error');

        // Ensure controls are enabled and WS disconnected on error
        enableNavigationControls();
        disconnectWebSocket();

        return { active: false, is_host: false, error: error.message };
    }
}

/**
 * Toggle sync mode on/off via HTTP.
 */
async function toggleSyncMode() {
    // Update header display immediately to show toggling state
    updateSyncStatusDisplay('toggling', 'Sync: Toggling...');

    // If enabling sync, check password first
    const newDesiredState = !app.state.syncModeEnabled;
    if (newDesiredState) { // If attempting to enable sync
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            console.log("Password validation failed. Sync toggle aborted.");
            updateSyncToggleButton(); // Revert button to previous state
            updateSyncStatusDisplay('warning', 'Sync: Password Required', 3000);
            return { error: "Password validation failed for sync toggle." };
        }
    }

    try {
        console.log('Toggling sync mode via HTTP...');

        // Get current media info if viewing media
        let mediaInfo = null;
        if (app.state.currentCategoryId && app.state.fullMediaList.length > 0 && app.state.currentMediaIndex >= 0) {
            const currentFile = app.state.fullMediaList[app.state.currentMediaIndex];
            mediaInfo = {
                category_id: app.state.currentCategoryId,
                file_url: currentFile.url, // Note: file_url might not be strictly needed by backend here
                index: app.state.currentMediaIndex
            };
        }

        const newState = !app.state.syncModeEnabled;
        console.log(`Requesting sync mode change to: ${newState ? 'ON' : 'OFF'}`);

        const response = await fetch('/api/sync/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newState, media: mediaInfo })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Server returned ${response.status}: ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        console.log('Sync toggle response:', data);

        // Update state based on response (important!)
        app.state.syncModeEnabled = data.active;
        app.state.isHost = data.is_host;

        // Update UI and WebSocket connection based on the *actual* new state
        updateSyncToggleButton(); // This handles both button and header display text
        // updateSyncStatusIndicator(); // No longer needed

        if (app.state.syncModeEnabled) {
            if (!app.state.isHost) {
                console.log('Guest mode enabled by toggle. Initializing WebSocket...');
                initWebSocket(); // Connect and join room
                disableNavigationControls();
                updateSyncStatusDisplay('success', 'Sync: Joined as Guest', 3000);
            } else {
                console.log('Host mode enabled by toggle. Disconnecting WebSocket.');
                disconnectWebSocket();
                enableNavigationControls();
                updateSyncStatusDisplay('success', 'Sync: Started as Host', 3000);
            }
        } else {
            console.log('Sync mode disabled by toggle. Disconnecting WebSocket.');
            disconnectWebSocket();
            enableNavigationControls();
            updateSyncStatusDisplay('warning', 'Sync: Disabled', 3000);
        }

        return data;

    } catch (error) {
        console.error('Error toggling sync mode:', error);
        alert(`Failed to toggle sync mode: ${error.message}`);

        // Attempt to revert state based on a fresh check
        await checkSyncMode(); // Re-check the actual status from server (this will call updateSyncToggleButton)

        // Update indicator to show error after re-check
        updateSyncStatusDisplay('error', 'Sync: Toggle Failed');
        // Let checkSyncMode handle resetting the text after re-check

       return { error: error.message };
    }
}

/**
 * Send a sync update to the server (Host only) - Still uses HTTP POST.
 * The backend service will then emit the WebSocket event.
 * @param {Object} mediaInfo - The media info to sync { category_id, file_url, index }
 * @returns {Promise<boolean>} - Whether the HTTP update was accepted by the server.
 */
async function sendSyncUpdate(mediaInfo) {
    // Only hosts in sync mode can send updates
    if (!app.state.syncModeEnabled || !app.state.isHost) {
        // console.log('sendSyncUpdate skipped: Not host or sync disabled.'); // Reduce noise
        return false;
    }

    // Basic validation
    if (!mediaInfo || typeof mediaInfo.category_id === 'undefined' || typeof mediaInfo.index === 'undefined') {
        console.error('sendSyncUpdate error: Invalid mediaInfo provided', mediaInfo);
        return false;
    }

    // Update header display to show sending state
    updateSyncStatusDisplay('sending', 'Sync: Sending...');

    try {
        console.log('Sending sync update via HTTP:', mediaInfo);
        const response = await fetch('/api/sync/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mediaInfo)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Server returned ${response.status}: ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        console.log('Sync update HTTP response:', data); // Should just be {success: true}

        // Update header display to show success, then reset via updateSyncToggleButton
        updateSyncStatusDisplay('success', 'Sync: Sent ✓', 2000);

        return true; // Indicate HTTP request was successful

    } catch (error) {
        console.error('Error sending sync update via HTTP:', error);

        // Update header display to show error
        updateSyncStatusDisplay('error', 'Sync: Send Failed ✗');
        // Let checkSyncMode handle resetting if needed below

        // Check if the error indicates we are no longer the host
        if (error.message.includes('Only the host')) {
            console.warn('Sync update failed: No longer the host? Checking status...');
            checkSyncMode(); // Re-check status to update UI if necessary
        }

        return false; // Indicate HTTP request failed
    }
}


// --- UI Update --- (Removed updateSyncStatusIndicator and createSyncStatusIndicator)

// --- Sync Data Processing (Guest) ---

/**
 * Process sync update data received from the server (via WebSocket).
 * @param {Object} data - The sync data { category_id, file_url, index }
 * @param {boolean} force - Whether to force the update regardless of current state
 */
async function handleSyncUpdate(data, force = false) {
    // Skip if sync mode is disabled or we're the host
    // This initial check is fine, but the crucial password check is *before acting* on the data.
    if (!app.state.syncModeEnabled || app.state.isHost) {
        // console.log('Ignoring sync update (sync disabled or is host)'); // Can be noisy
        return;
    }

    // Password check before acting on received sync data
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        console.log("Password validation failed. Sync update ignored by guest.");
        updateSyncStatusDisplay('warning', 'Sync: Password Required to View', 3000);
        // Potentially disconnect from sync or show a persistent message
        return;
    }

    // Only process if we have valid data
    if (!data || data.error || typeof data.category_id === 'undefined' || typeof data.index === 'undefined') {
        console.error('Invalid sync data received via WebSocket:', data);
        updateSyncToggleButton(); // Update the header display
        return;
    }

    // Check if we need to update the view
    const needsCategorySwitch = data.category_id !== app.state.currentCategoryId;
    // Ensure index is treated as a number for comparison
    const receivedIndex = parseInt(data.index, 10);
    const needsIndexUpdate = !isNaN(receivedIndex) && receivedIndex !== app.state.currentMediaIndex;

    // If force is true, we'll proceed with the update regardless
    if (!force && !needsCategorySwitch && !needsIndexUpdate) {
        console.log('No sync update needed (data is the same or irrelevant)');
        updateSyncToggleButton(); // Ensure header display is correct
        return;
    }

    console.log(`Processing sync update: Category ${data.category_id}, Index ${receivedIndex}`);
    
    // Use the refactored navigation function
    await navigateToState(data.category_id, receivedIndex, 'Sync');
}

/**
 * Navigates the UI to a specific category and index.
 * @param {string} categoryId - The target category ID.
 * @param {number} index - The target media index.
 * @param {string} context - Context for status messages (e.g., 'Sync', 'View').
 * @returns {Promise<void>} - A promise that resolves when navigation is complete
 */
async function navigateToState(categoryId, index, context = 'Navigation') {
    try {
        const needsCategorySwitch = categoryId !== app.state.currentCategoryId;
        const receivedIndex = parseInt(index, 10); // Ensure index is a number

        if (needsCategorySwitch) {
            // --- Different category ---
            console.log(`[${context}] Switching to category ${categoryId}...`);
            updateSyncStatusDisplay('loading', `${context}: Changing Category...`);

            window.appModules.mediaLoader.clearResources(false); // Non-aggressive clear
            await viewCategory(categoryId); // Load the new category

            // After category loads, render the specific index
            console.log(`[${context}] Rendering index ${receivedIndex} after category switch`);
            await ensureMediaLoadedForIndex(receivedIndex); // Ensure media page is loaded
            renderMediaWindow(receivedIndex); // Render the specific item

            updateSyncStatusDisplay('success', `${context}: Updated ✓`, 2000);

        } else {
            // --- Same category, different index ---
            console.log(`[${context}] Updating to index ${receivedIndex}...`);
            updateSyncStatusDisplay('loading', `${context}: Navigating...`);

            await ensureMediaLoadedForIndex(receivedIndex); // Pass only index

            // Only render if the index is valid within the *now potentially updated* list
            if (receivedIndex < app.state.fullMediaList.length) {
                renderMediaWindow(receivedIndex);
                updateSyncStatusDisplay('success', `${context}: Updated ✓`, 2000);
            } else {
                console.warn(`[${context}] Cannot render index ${receivedIndex}, only have ${app.state.fullMediaList.length} items loaded after attempting load.`);
                updateSyncStatusDisplay('warning', `${context}: Media Not Available`, 3000);
            }
        }
    } catch (error) {
        console.error(`Error processing ${context} navigation:`, error);
        updateSyncStatusDisplay('error', `${context}: Update Error`, 3000);
    }
}

/**
 * Helper function to ensure media for a specific index is loaded, loading more if necessary.
 * Enhanced to handle async loading scenarios during sync mode.
 * @param {number} index - The target media index.
 */
async function ensureMediaLoadedForIndex(index) {
    // Check if index is out of bounds and if more media *can* be loaded
    if (index >= app.state.fullMediaList.length && app.state.hasMoreMedia) {
        console.log(`Index ${index} is beyond current loaded media (${app.state.fullMediaList.length}), calculating target page...`);

        const itemsPerPage = getMediaPerPage() || 10; // Call getMediaPerPage()
        const targetPage = Math.floor(index / itemsPerPage) + 1;
        const currentPage = Math.floor(app.state.fullMediaList.length / itemsPerPage); // Current max page loaded

        // Only load if target page is beyond currently loaded pages
        if (targetPage > currentPage) {
            console.log(`Target index ${index} is on page ${targetPage}. Loading page...`);
            try {
                updateSyncStatusDisplay('loading', 'Sync: Loading Media...');
                
                // First try to load the specific page containing the target index
                await window.appModules.mediaLoader.loadMoreMedia(null, null, false, targetPage);
                console.log(`Finished loading media up to page ${targetPage}. Total items: ${app.state.fullMediaList.length}`);
                
                // If we still don't have the index after loading the page, try a direct index request
                // This is especially important for async loading scenarios
                if (index >= app.state.fullMediaList.length && app.state.hasMoreMedia) {
                    console.log(`Index ${index} still not loaded after page load, trying direct index request...`);
                    updateSyncStatusDisplay('loading', 'Sync: Requesting Specific Media...');
                    
                    // Use a special parameter to request a specific index directly
                    // This will be handled by the server to prioritize loading this specific index
                    const cacheBuster = Date.now();
                    const syncParam = '&sync=true';
                    const indexParam = `&target_index=${index}`;
                    
                    try {
                        const response = await fetch(`/api/categories/${app.state.currentCategoryId}/media?page=1&limit=1${syncParam}${indexParam}&_=${cacheBuster}`);
                        
                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        
                        const data = await response.json();
                        
                        // If we got a specific file for the requested index
                        if (data.target_file && data.target_index === index) {
                            console.log(`Received specific file for index ${index}:`, data.target_file);
                            
                            // Add the file to our list at the correct index
                            // We might need to pad the array with placeholders
                            while (app.state.fullMediaList.length <= index) {
                                app.state.fullMediaList.push(null); // Add placeholders
                            }
                            
                            // Replace the placeholder with the actual file
                            app.state.fullMediaList[index] = data.target_file;
                            console.log(`Added specific file at index ${index}, list length now: ${app.state.fullMediaList.length}`);
                        } else if (data.files && data.files.length > 0) {
                            // If we just got regular files, append them
                            console.log(`Received ${data.files.length} regular files in direct index request`);
                            const existingUrls = new Set(app.state.fullMediaList.map(f => f && f.url));
                            const newFiles = data.files.filter(f => !existingUrls.has(f.url));
                            
                            if (newFiles.length > 0) {
                                app.state.fullMediaList.push(...newFiles);
                                console.log(`Added ${newFiles.length} new files, list length now: ${app.state.fullMediaList.length}`);
                            }
                        }
                    } catch (directIndexError) {
                        console.error(`Error in direct index request:`, directIndexError);
                        // Continue with what we have - don't throw here
                    }
                }
                
            } catch (loadError) {
                console.error(`Error loading target page ${targetPage} during sync:`, loadError);
                updateSyncStatusDisplay('error', 'Sync: Error Loading Media', 3000);
                throw loadError; // Re-throw to stop further processing in handleSyncUpdate
            }
        } else {
             console.log(`Target index ${index} is on page ${targetPage}, which should already be loaded.`);
        }
    }
}


// --- Exports ---

// Export functions needed by other modules
export {
    checkSyncMode,    // Initial check on page load
    toggleSyncMode,   // Called by UI button
    sendSyncUpdate,   // Called by media navigation when host changes media
    ensureMediaLoadedForIndex // Needed by chatManager for /myview links
};
