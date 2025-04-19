/**
 * Sync Manager Module
 * Handles sync mode functionality for synchronized media viewing using WebSockets.
 */

import { app, MEDIA_PER_PAGE } from '../core/app.js';
import { updateSyncToggleButton, disableNavigationControls, enableNavigationControls } from './uiController.js';
import { renderMediaWindow } from './mediaNavigation.js';
import { viewCategory } from './mediaLoader.js';

// Socket.IO instance (initialized later)
let socket = null;
let isWebSocketConnected = false;

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
        // The 'io' function is globally available from the script tag in index.html
        socket = io({
            reconnectionAttempts: 10,        // Increased from 5 to 10
            reconnectionDelay: 1000,         // Decreased from 2000 to 1000
            timeout: 20000,                  // Increased connection timeout
            pingTimeout: 120000,             // Increased ping timeout to match server
            pingInterval: 10000,             // Increased ping interval to match server
            transports: ['websocket', 'polling'] // Try WebSocket first, fallback to polling
        });
        
        // Set up heartbeat interval to keep connection alive
        let heartbeatInterval = null;

        // --- Connection Events ---
        socket.on('connect', () => {
            console.log('WebSocket connected successfully:', socket.id);
            isWebSocketConnected = true;
            updateSyncToggleButton(); // Update header display

            // If we are a guest in sync mode, join the sync room
            if (app.state.syncModeEnabled && !app.state.isHost) {
                console.log('Joining sync room via WebSocket...');
                socket.emit('join_sync');
            }
            
            // Start heartbeat to keep connection alive
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }
            
            heartbeatInterval = setInterval(() => {
                if (socket && socket.connected) {
                    console.log('Sending heartbeat to keep connection alive');
                    socket.emit('heartbeat');
                }
            }, 30000); // Send heartbeat every 30 seconds
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
                }, 2000);
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
            
            // Consider fallback or user notification if connection fails persistently
            // Maybe show a more permanent error in the indicator after several failed attempts
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
                // updateSyncStatusIndicator(); // updateSyncToggleButton handles this now
                disableNavigationControls();

                // Join the sync room
                socket.emit('join_sync');
                
                // If media state is provided, handle it
                if (data.media && data.media.category_id) {
                    handleSyncUpdate(data.media);
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

                // Show notification to user (This part still uses the old indicator ID - remove or adapt)
                /* // Old notification logic using removed indicator:
                // const syncStatus = document.getElementById('sync-status-indicator') // || createSyncStatusIndicator();
                // if (syncStatus) {
                //     syncStatus.textContent = 'Sync: Disabled by Host';
                //     syncStatus.style.color = '#FF9800'; // Orange
                //     setTimeout(() => updateSyncToggleButton(), 3000); // Use new function
                // }
                */
                 // We can rely on the header display updated by updateSyncToggleButton
            }
        });

        socket.on('sync_error', (error) => {
            console.error('Received sync_error via WebSocket:', error.message);
            alert(`Sync Error: ${error.message}`);
            // Potentially disable sync mode locally or take other action
            updateSyncToggleButton(); // Update header display to reflect potential state change
            /* // Old notification logic using removed indicator:
            // const syncStatus = document.getElementById('sync-status-indicator');
            // if (syncStatus) {
            //     syncStatus.textContent = `Sync Error: ${error.message}`;
            //     syncStatus.style.color = '#F44336'; // Red
            //     setTimeout(() => updateSyncToggleButton(), 5000); // Use new function
            // }
            */
        });

        // Helper function to get cookie value
        function getCookieValue(name) {
            const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
            return match ? match[2] : null;
        }

    } catch (error) {
            console.error('Fatal error initializing WebSocket:', error);
            // Fallback or notification needed if io() itself fails
            // Update the header display instead
            const syncHeaderDisplay = document.getElementById('sync-status-display');
            if (syncHeaderDisplay) {
                 syncHeaderDisplay.textContent = 'Sync: WS Init Failed!';
                 syncHeaderDisplay.style.color = '#F44336'; // Red
            }
       }
}

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

        // Update sync status indicator to show error (update header display instead)
        const syncHeaderDisplay = document.getElementById('sync-status-display');
         if (syncHeaderDisplay) {
             syncHeaderDisplay.textContent = 'Sync: Status Error';
             syncHeaderDisplay.style.color = '#F44336'; // Red
        }

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
    const syncHeaderDisplay = document.getElementById('sync-status-display');
    if (syncHeaderDisplay) {
        syncHeaderDisplay.textContent = 'Sync: Toggling...';
        syncHeaderDisplay.style.color = '#FFC107'; // Yellow
    }
    // const syncStatus = document.getElementById('sync-status-indicator') // || createSyncStatusIndicator(); // Remove old indicator logic

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
            } else {
                console.log('Host mode enabled by toggle. Disconnecting WebSocket.');
                disconnectWebSocket();
                enableNavigationControls();
            }
        } else {
            console.log('Sync mode disabled by toggle. Disconnecting WebSocket.');
            disconnectWebSocket();
            enableNavigationControls();
        }

        return data;

    } catch (error) {
        console.error('Error toggling sync mode:', error);
        alert(`Failed to toggle sync mode: ${error.message}`);

        // Attempt to revert state based on a fresh check
        await checkSyncMode(); // Re-check the actual status from server (this will call updateSyncToggleButton)

        // Update indicator to show error after re-check (update header display)
        if (syncHeaderDisplay) {
             syncHeaderDisplay.textContent = 'Sync: Toggle Failed';
             syncHeaderDisplay.style.color = '#F44336'; // Red
             // Let checkSyncMode handle resetting the text after re-check
        }

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
    const syncHeaderDisplay = document.getElementById('sync-status-display');
     if (syncHeaderDisplay) {
        syncHeaderDisplay.textContent = 'Sync: Sending...';
        syncHeaderDisplay.style.color = '#FFC107'; // Yellow
    }
    // const syncStatus = document.getElementById('sync-status-indicator') // || createSyncStatusIndicator(); // Remove old indicator logic

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
        if (syncHeaderDisplay) {
            syncHeaderDisplay.textContent = 'Sync: Sent ✓';
            syncHeaderDisplay.style.color = '#4CAF50'; // Green
        }
        setTimeout(() => updateSyncToggleButton(), 2000); // Reset header display

        return true; // Indicate HTTP request was successful

    } catch (error) {
        console.error('Error sending sync update via HTTP:', error);

        // Update header display to show error
         if (syncHeaderDisplay) {
            syncHeaderDisplay.textContent = 'Sync: Send Failed ✗';
            syncHeaderDisplay.style.color = '#F44336'; // Red
        }
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
 */
async function handleSyncUpdate(data) {
    // Skip if sync mode is disabled or we're the host
    if (!app.state.syncModeEnabled || app.state.isHost) {
        console.log('Ignoring sync update (sync disabled or is host)');
        return;
    }

    // const syncStatus = document.getElementById('sync-status-indicator') || createSyncStatusIndicator(); // Don't need the old indicator

    // Only process if we have valid data
    if (!data || data.error || typeof data.category_id === 'undefined' || typeof data.index === 'undefined') {
        console.error('Invalid sync data received via WebSocket:', data);
        // syncStatus.textContent = 'Sync: Invalid Data'; // Update the new display if needed, or rely on uiController
        // syncStatus.style.color = '#FF9800'; // Orange
        // setTimeout(() => updateSyncStatusIndicator(), 3000);
        updateSyncToggleButton(); // Update the header display
        return;
    }

    // Check if we need to update the view
    const needsCategorySwitch = data.category_id !== app.state.currentCategoryId;
    // Ensure index is treated as a number for comparison
    const receivedIndex = parseInt(data.index, 10);
    const needsIndexUpdate = !isNaN(receivedIndex) && receivedIndex !== app.state.currentMediaIndex;

    if (!needsCategorySwitch && !needsIndexUpdate) {
        console.log('No sync update needed (data is the same or irrelevant)');
        // updateSyncStatusIndicator(); // Ensure indicator is normal - No longer needed
        updateSyncToggleButton(); // Ensure header display is correct
        return;
    }

    console.log(`Processing sync update: Category ${data.category_id}, Index ${receivedIndex}`);

    try {
        if (needsCategorySwitch) {
            // --- Different category ---
            console.log(`Switching to category ${data.category_id}...`);
            // syncStatus.textContent = 'Sync: Changing Category...'; // Update the new display if needed
            // syncStatus.style.color = '#FFC107'; // Yellow
            updateSyncToggleButton(); // Update the header display

            window.appModules.mediaLoader.clearResources(false); // Non-aggressive clear
            await viewCategory(data.category_id); // Load the new category

            // After category loads, render the specific index
            console.log(`Rendering index ${receivedIndex} after category switch`);
            await ensureMediaLoadedForIndex(receivedIndex, syncStatus); // Ensure media page is loaded
            renderMediaWindow(receivedIndex); // Render the specific item

            // syncStatus.textContent = 'Sync: Updated ✓'; // Update the new display if needed
            // syncStatus.style.color = '#4CAF50'; // Green
            // setTimeout(() => updateSyncStatusIndicator(), 2000);
            updateSyncToggleButton(); // Update the header display

        } else if (needsIndexUpdate) {
            // --- Same category, different index ---
            console.log(`Updating to index ${receivedIndex}...`);
            // syncStatus.textContent = 'Sync: Navigating...'; // Update the new display if needed
            // syncStatus.style.color = '#FFC107'; // Yellow
            updateSyncToggleButton(); // Update the header display

            await ensureMediaLoadedForIndex(receivedIndex); // Pass only index, syncStatus removed

            // Only render if the index is valid within the *now potentially updated* list
            if (receivedIndex < app.state.fullMediaList.length) {
                renderMediaWindow(receivedIndex);
                // syncStatus.textContent = 'Sync: Updated ✓'; // Update the new display if needed
                // syncStatus.style.color = '#4CAF50'; // Green
                // setTimeout(() => updateSyncStatusIndicator(), 2000);
                updateSyncToggleButton(); // Update the header display
            } else {
                console.warn(`Cannot render index ${receivedIndex}, only have ${app.state.fullMediaList.length} items loaded after attempting load.`);
                // syncStatus.textContent = 'Sync: Media Not Available'; // Update the new display if needed
                // syncStatus.style.color = '#FF9800'; // Orange
                // setTimeout(() => updateSyncStatusIndicator(), 3000);
                updateSyncToggleButton(); // Update the header display
            }
        }
    } catch (error) {
        console.error('Error processing sync update:', error);
        // syncStatus.textContent = 'Sync: Update Error'; // Update the new display if needed
        // syncStatus.style.color = '#F44336'; // Red
        // setTimeout(() => updateSyncStatusIndicator(), 3000);
        updateSyncToggleButton(); // Update the header display
    }
}

/**
 * Helper function to ensure media for a specific index is loaded, loading more if necessary.
 * @param {number} index - The target media index.
 * // @param {HTMLElement} syncStatus - The status indicator element. (Removed)
 */
async function ensureMediaLoadedForIndex(index /*, syncStatus */) { // syncStatus parameter removed
    // Check if index is out of bounds and if more media *can* be loaded
    if (index >= app.state.fullMediaList.length && app.state.hasMoreMedia) {
        console.log(`Index ${index} is beyond current loaded media (${app.state.fullMediaList.length}), calculating target page...`);

        const itemsPerPage = MEDIA_PER_PAGE || 10; // Use constant or default
        const targetPage = Math.floor(index / itemsPerPage) + 1;
        const currentPage = Math.floor(app.state.fullMediaList.length / itemsPerPage); // Current max page loaded

        // Only load if target page is beyond currently loaded pages
        if (targetPage > currentPage) {
            console.log(`Target index ${index} is on page ${targetPage}. Loading page...`);
            try {
                // syncStatus.textContent = 'Sync: Loading Media...'; // Update the new display if needed
                // syncStatus.style.color = '#FFC107'; // Yellow
                updateSyncToggleButton(); // Update the header display
                // Load the specific page containing the target index
                await window.appModules.mediaLoader.loadMoreMedia(null, null, false, targetPage);
                console.log(`Finished loading media up to page ${targetPage}. Total items: ${app.state.fullMediaList.length}`);
            } catch (loadError) {
                console.error(`Error loading target page ${targetPage} during sync:`, loadError);
                // syncStatus.textContent = 'Sync: Error Loading Media'; // Update the new display if needed
                // syncStatus.style.color = '#F44336'; // Red
                // setTimeout(() => updateSyncStatusIndicator(), 3000);
                updateSyncToggleButton(); // Update the header display
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
    sendSyncUpdate    // Called by media navigation when host changes media
};
