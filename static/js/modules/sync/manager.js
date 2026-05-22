/**
 * Sync Manager Module
 * Handles sync mode functionality for synchronized media viewing using WebSockets.
 */

import { updateSyncToggleButton, disableNavigationControls, enableNavigationControls } from '../ui/controller.js';
import { renderMediaWindow } from '../media/navigation.js';
import { getConfigValue } from '../../utils/configManager.js';
import { openCategoryViewer, openViewerFromView } from '../media/loader.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';
import { navigateToMedia, getCurrentLayout } from '../../utils/layoutUtils.js';
import { getCookieValue } from '../../utils/cookieUtils.js';
import { Module, $, attr } from '../../libs/ragot.esm.min.js';
import { setAppState, getAppState, createAppSelector } from '../../utils/appStateUtils.js';
import { toast } from '../../utils/notificationManager.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { selectIndexOf, selectParams, selectView } from '../media/selectors.js';
import { getCurrentViewerRecord, getViewerSession } from '../media/viewerState.js';

// Socket.IO instance (initialized later)
let socket = null;
let syncOwnsSocket = false;
let isWebSocketConnected = false;
let heartbeatInterval = null; // Module scope for proper cleanup
let playbackHeartbeatInterval = null; // Periodic sync for active video
const syncLifecycle = new Module().start();
let syncBeforeUnloadAttached = false;
let syncSocketHandlers = null;
const SYNC_STATUS_CACHE_TTL_MS = 5000;
let syncStatusCache = null;
let syncStatusCacheAt = 0;
let syncStatusInFlight = null;
const syncFlagsSelector = createAppSelector(
    [
        (state) => state.syncModeEnabled,
        (state) => state.isHost
    ],
    (syncModeEnabled, isHost) => ({ syncModeEnabled, isHost })
);

function getSyncFlags() {
    return syncFlagsSelector(getAppState());
}

function scheduleSyncTimeout(callback, delayMs) {
    return syncLifecycle.timeout(callback, delayMs);
}

function clearSyncTimeouts() {
    syncLifecycle.clearTimers();
}

function isSocketConnectPending(socketInstance) {
    if (!socketInstance) return false;
    if (socketInstance.connected) return true;
    if (socketInstance.active === true) return true;

    const manager = socketInstance.io;
    if (manager && typeof manager._readyState === 'string' && manager._readyState.includes('open')) {
        return true;
    }

    return false;
}

function requestSocketConnect(socketInstance, context = 'sync') {
    if (!socketInstance) return false;
    if (isSocketConnectPending(socketInstance)) {
        console.log(`[Sync] Skipping duplicate socket.connect() during ${context}; socket is already active/opening.`);
        return false;
    }

    socketInstance.connect();
    return true;
}

function detachSyncSocketListeners(socketInstance) {
    if (!socketInstance || !syncSocketHandlers) return;
    const entries = Object.entries(syncSocketHandlers);
    for (const [event, handler] of entries) {
        if (typeof handler === 'function') {
            syncLifecycle.offSocket(socketInstance, event, handler);
        }
    }
    syncSocketHandlers = null;
}

export function getSyncPlayMode({ hasUserActivation, prefersUnmuted }) {
    return hasUserActivation && prefersUnmuted ? 'unmuted-first' : 'muted-only';
}

// Variables for custom reconnection logic, initialized from config later
let currentReconnectAttempts = 0; // Renamed from reconnectAttempts to avoid conflict with socket.io option
let configuredMaxReconnectAttempts;
let configuredReconnectDelayBase;
let configuredReconnectFactor;

let isTogglePending = false; // Flag to prevent demotion broadcasts during toggle


// Add page unload handler to clean up socket connections
function handleSyncBeforeUnload() {
    disconnectWebSocket();
}
function ensureSyncBeforeUnloadListener() {
    if (syncBeforeUnloadAttached) return;
    syncLifecycle.on(window, 'beforeunload', handleSyncBeforeUnload);
    syncBeforeUnloadAttached = true;
}
ensureSyncBeforeUnloadListener();

// --- Status Display Management ---

/**
 * Update the sync status display with a specific state
 * @param {string} state - The state to display ('connecting', 'error', 'success', etc.)
 * @param {string} message - The message to display
 * @param {number} [timeout] - Optional timeout to reset to default state
 */
function updateSyncStatusDisplay(state, message, timeout = 0) {
    const syncHeaderDisplay = $('#sync-status-display');
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
        scheduleSyncTimeout(() => updateSyncToggleButton(), timeout);
    }
}

// --- WebSocket Management ---

/**
 * Setup core socket listeners and heartbeat.
 * @param {Object} socketInstance - The Socket.IO instance
 */
function setupSocketListeners(socketInstance) {
    if (!socketInstance) return;

    // Remove previously attached managed listeners before re-attaching.
    detachSyncSocketListeners(socketInstance);

    syncSocketHandlers = {};

    syncSocketHandlers[SOCKET_EVENTS.CONNECT] = () => {
        console.log('WebSocket connected successfully:', socketInstance.id);
        isWebSocketConnected = true;
        updateSyncToggleButton();

        currentReconnectAttempts = 0;

        if (getSyncFlags().syncModeEnabled) {
            console.log('Joining sync room via WebSocket...');
            socketInstance.emit(SOCKET_EVENTS.JOIN_SYNC);
        }

        if (heartbeatInterval) syncLifecycle.clearInterval(heartbeatInterval);
        const heartbeatIntervalDelay = getConfigValue('javascript_config.sync_manager.heartbeatInterval', 30000);
        heartbeatInterval = syncLifecycle.interval(() => {
            if (socketInstance && socketInstance.connected) {
                socketInstance.emit(SOCKET_EVENTS.HEARTBEAT);
            }
        }, heartbeatIntervalDelay);
    };

    syncSocketHandlers[SOCKET_EVENTS.DISCONNECT] = (reason) => {
        console.warn('WebSocket disconnected:', reason);
        isWebSocketConnected = false;
        updateSyncToggleButton();

        if (heartbeatInterval) {
            syncLifecycle.clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        if (reason === 'io server disconnect') {
            checkSyncMode();
        } else if (reason === 'transport close' || reason === 'ping timeout') {
            scheduleSyncTimeout(() => {
                if (socketInstance && !socketInstance.connected) {
                    requestSocketConnect(socketInstance, `disconnect:${reason}`);
                }
            }, getConfigValue('javascript_config.sync_manager.manual_reconnect_trigger_delay', 2000));
        }
    };

    syncSocketHandlers[SOCKET_EVENTS.CONNECTION_ERROR] = (error) => {
        console.error('WebSocket connection error:', error);
        isWebSocketConnected = false;
        updateSyncToggleButton();

        if (heartbeatInterval) {
            syncLifecycle.clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        const forceUiTimeoutDelay = getConfigValue('javascript_config.sync_manager.connect_error_force_ui_timeout', 5000);
        if (currentReconnectAttempts > 3) {
            scheduleSyncTimeout(() => {
                if (!isWebSocketConnected) {
                    enableNavigationControls();
                    updateSyncToggleButton();
                    const { syncModeEnabled, isHost } = getSyncFlags();
                    if (syncModeEnabled && !isHost) {
                        setAppState('syncModeEnabled', false);
                        updateSyncToggleButton();
                        updateSyncStatusDisplay('error', 'Sync: Connection Timed Out', forceUiTimeoutDelay);
                    }
                }
            }, forceUiTimeoutDelay);
        }

        currentReconnectAttempts++;
        const maxReconnects = configuredMaxReconnectAttempts || getConfigValue('javascript_config.sync_manager.manual_maxReconnectAttempts', 10);

        if (currentReconnectAttempts <= maxReconnects) {
            const jitter = Math.random() * 0.3 + 0.85;
            const maxDelay = window.ragotModules.appRuntime.MOBILE_DEVICE ? 10000 : 30000;
            const delayBase = configuredReconnectDelayBase || getConfigValue('javascript_config.sync_manager.manual_reconnectDelayBase', 1000);
            const factor = configuredReconnectFactor || getConfigValue('javascript_config.sync_manager.manual_reconnectFactor', 1.5);

            const delay = Math.min(
                delayBase * Math.pow(factor, currentReconnectAttempts - 1) * jitter,
                maxDelay
            );
            scheduleSyncTimeout(() => {
                if (socketInstance && !socketInstance.connected) {
                    requestSocketConnect(socketInstance, 'connect_error');
                }
            }, delay);
        }
    };

    syncSocketHandlers[SOCKET_EVENTS.HEARTBEAT_RESPONSE] = (data) => {
        console.log('Received heartbeat response:', data);
    };

    syncSocketHandlers[SOCKET_EVENTS.SYNC_ENABLED] = (data) => {
        console.log('Received sync_enabled via WebSocket:', data);

        // If we just requested a toggle, ignore broadcasts that might reflect a stale/racing state
        if (isTogglePending) {
            console.log('[Sync] Toggle in progress, ignoring demotion broadcast.');
            return;
        }

        const session_id = getCookieValue('session_id');
        const isMe = data.host_session_id === session_id;

        if (isMe) {
            console.log('Server confirmed WE are the host.');
            setAppState('syncModeEnabled', true);
            setAppState('isHost', true);
            updateSyncToggleButton();
            enableNavigationControls();
        } else {
            console.log('Host has enabled sync mode. Joining as guest...');
            setAppState('syncModeEnabled', true);
            setAppState('isHost', false);
            updateSyncToggleButton();
            disableNavigationControls();
            updateSyncStatusDisplay('success', 'Sync: Joined as Guest', 3000);
            socketInstance.emit(SOCKET_EVENTS.JOIN_SYNC);
            if (data.media && data.media.category_id) {
                handleSyncUpdate(data.media, true);
            }
        }
    };

    syncSocketHandlers[SOCKET_EVENTS.SYNC_STATE] = (data) => {
        if (window.ragotModules.appState.syncModeEnabled && !window.ragotModules.appState.isHost) {
            handleSyncUpdate(data);
        }
    };

    syncSocketHandlers[SOCKET_EVENTS.SYNC_DISABLED] = () => {
        if (window.ragotModules.appState.syncModeEnabled) {
            setAppState('syncModeEnabled', false);
            setAppState('isHost', false);
            updateSyncToggleButton();
            enableNavigationControls();
            updateSyncStatusDisplay('warning', 'Sync: Disabled by Host', 3000);
        }
    };

    syncSocketHandlers[SOCKET_EVENTS.SYNC_ERROR] = (error) => {
        console.error('Received sync_error via WebSocket:', error.message);
        updateSyncStatusDisplay('error', `Sync Error: ${error.message}`, 5000);
    };

    syncSocketHandlers[SOCKET_EVENTS.PLAYBACK_SYNC] = (data) => {
        console.log('[Sync] Received playback_sync event:', data);
        console.log('[Sync] syncModeEnabled:', window.ragotModules.appState.syncModeEnabled, 'isHost:', window.ragotModules.appState.isHost);

        if (window.ragotModules.appState.syncModeEnabled && !window.ragotModules.appState.isHost) {
            applyPlaybackSync(data);
        } else {
            console.log('[Sync] Ignoring playback_sync - conditions not met');
        }
    };

    Object.entries(syncSocketHandlers).forEach(([event, handler]) => {
        syncLifecycle.onSocket(socketInstance, event, handler);
    });
}

/**
 * Initialize WebSocket connection and event listeners.
 */
function initWebSocket() {
    if (socket && socket.connected) {
        console.log('WebSocket already connected.');
        return;
    }

    if (socket) {
        console.log('WebSocket exists but not connected. Evaluating reconnect...');
        requestSocketConnect(socket, 'initWebSocket(existing)');
        return;
    }

    // Prioritize using the main application socket if available
    const appSocket = window.ragotModules?.appStore?.get?.('socket', null);
    if (appSocket) {
        console.log('SyncManager: Using existing app socket');
        socket = appSocket;
        syncOwnsSocket = false;
        setupSocketListeners(socket);
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
        syncOwnsSocket = true;

        // Initialize parameters for custom reconnection logic from config
        configuredMaxReconnectAttempts = getConfigValue('javascript_config.sync_manager.manual_maxReconnectAttempts', 10);
        configuredReconnectDelayBase = getConfigValue('javascript_config.sync_manager.manual_reconnectDelayBase', 1000);
        configuredReconnectFactor = getConfigValue('javascript_config.sync_manager.manual_reconnectFactor', 1.5);

        setupSocketListeners(socket);
    } catch (error) {
        console.error('Fatal error initializing WebSocket:', error);
        updateSyncStatusDisplay('error', 'Sync: WS Init Failed!');
    }
}
;

/**
 * Disconnect WebSocket connection.
 */
function disconnectWebSocket() {
    clearSyncTimeouts();
    if (seekDebounceTimer) {
        clearTimeout(seekDebounceTimer);
        seekDebounceTimer = null;
    }

    if (socket) {
        console.log('Disconnecting WebSocket...');

        // Clear heartbeat interval
        if (heartbeatInterval) {
            syncLifecycle.clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        if (playbackHeartbeatInterval) {
            syncLifecycle.clearInterval(playbackHeartbeatInterval);
            playbackHeartbeatInterval = null;
        }

        detachSyncSocketListeners(socket);
        if (syncOwnsSocket) {
            socket.disconnect();
        }
        socket = null; // Ensure socket instance is cleared
        syncOwnsSocket = false;
        isWebSocketConnected = false;
        updateSyncToggleButton(); // Use the new function instead of updateSyncStatusIndicator
    }
}


// --- Sync State Management (HTTP + WebSocket Integration) ---

/**
 * Check if sync mode is enabled via HTTP (initial check or re-check).
 */
async function checkSyncMode(options = {}) {
    const { force = false } = options;
    const now = Date.now();
    if (!force && syncStatusCache && (now - syncStatusCacheAt) < SYNC_STATUS_CACHE_TTL_MS) {
        applySyncStatus(syncStatusCache);
        return syncStatusCache;
    }
    if (!force && syncStatusInFlight) {
        return syncStatusInFlight;
    }

    syncStatusInFlight = (async () => {
    try {
        console.log('Checking sync mode status via HTTP...');
        const response = await fetch('/api/sync/status');

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Sync status response:', data);
        syncStatusCache = data;
        syncStatusCacheAt = Date.now();
        applySyncStatus(data);
        return data;
    } catch (error) {
        console.error('Error checking sync mode:', error);

        // Reset sync state on error
        setAppState('syncModeEnabled', false);
        setAppState('isHost', false);
        updateSyncToggleButton();

        // Update sync status indicator to show error
        updateSyncStatusDisplay('error', 'Sync: Status Error');

        // Ensure controls are enabled and WS disconnected on error
        enableNavigationControls();
        disconnectWebSocket();

        return { active: false, is_host: false, error: error.message };
    } finally {
        syncStatusInFlight = null;
    }
    })();
    return syncStatusInFlight;
}

function applySyncStatus(data) {
        const wasSyncEnabled = window.ragotModules.appState.syncModeEnabled;
        const wasHost = window.ragotModules.appState.isHost;

        // Update app state
        setAppState('syncModeEnabled', data.active);
        setAppState('isHost', data.is_host);

        // Update toggle button UI (this now also updates the header status display)
        updateSyncToggleButton();
        // updateSyncStatusIndicator(); // No longer needed

        // Handle transitions based on new state
        if (window.ragotModules.appState.syncModeEnabled) {
            if (!window.ragotModules.appState.isHost) {
                // --- Guest Mode ---
                console.log('Sync active: Guest mode.');
                initWebSocket(); // Ensure WebSocket is connecting/connected
                // Also explicitly try to join sync immediately after initializing WS,
                // in case the 'connect' event fires before the state is fully set.
                // Socket.IO handles joining the same room multiple times.
                if (socket) { // Check if socket was successfully initialized
                    console.log('Explicitly emitting join_sync after initWebSocket for guest.');
                    socket.emit(SOCKET_EVENTS.JOIN_SYNC);
                }
                disableNavigationControls();
            } else {
                // --- Host Mode ---
                console.log('Sync active: Host mode.');
                // Host needs WebSocket to SEND playback sync events (play/pause/seek)
                initWebSocket();
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

}

/**
 * Toggle sync mode on/off via HTTP.
 * Hosts: Can enable/disable sync globally
 * Guests: Can join sync, or leave sync (without stopping the host)
 */
async function toggleSyncMode() {
    // Update header display immediately to show toggling state
    updateSyncStatusDisplay('toggling', 'Sync: Toggling...');

    // Check if user is currently a guest trying to leave
    const isGuestLeaving = window.ragotModules.appState.syncModeEnabled && !window.ragotModules.appState.isHost;
    const isEnabling = !window.ragotModules.appState.syncModeEnabled;

    // If enabling sync, check password first
    if (isEnabling) {
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            console.log("Password validation failed. Sync toggle aborted.");
            updateSyncToggleButton(); // Revert button to previous state
            updateSyncStatusDisplay('warning', 'Sync: Password Required', 3000);
            return { error: "Password validation failed for sync toggle." };
        }
    }

    // If guest is leaving, just emit leave_sync and clean up locally
    if (isGuestLeaving) {
        console.log('[Sync] Guest leaving sync session...');
        if (socket && socket.connected) {
            socket.emit(SOCKET_EVENTS.LEAVE_SYNC);
        }

        // Update local state to reflect leaving
        setAppState('syncModeEnabled', false);
        setAppState('isHost', false);
        updateSyncToggleButton();
        disconnectWebSocket();
        enableNavigationControls();
        updateSyncStatusDisplay('warning', 'Sync: Left Session', 3000);
        return { active: false, is_host: false };
    }

    try {
        console.log('Toggling sync mode via HTTP...');
        isTogglePending = true; // Mark as pending

        // Ensure we have a session ID before toggling
        const session_id = getCookieValue('session_id');
        console.log(`[Sync] Initiating toggle with Session ID: ${session_id}`);

        const viewer = getViewerSession(window.ragotModules.appState);
        const currentFile = getCurrentViewerRecord(window.ragotModules.appState);
        const currentView = viewer ? selectView(viewer.viewKey) : null;
        const mediaInfo = viewer && currentFile ? {
            category_id: window.ragotModules.appState.currentCategoryId,
            viewKey: viewer.viewKey,
            viewType: currentView?.viewType || null,
            viewParams: selectParams(viewer.viewKey),
            mediaId: currentFile.id || null,
        } : null;

        const newState = !window.ragotModules.appState.syncModeEnabled;
        console.log(`Requesting sync mode change to: ${newState ? 'ON' : 'OFF'}`);

        const response = await fetch('/api/sync/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: newState,
                media: mediaInfo,
                session_id: session_id // Explicitly pass session_id
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Server returned ${response.status}: ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        console.log('Sync toggle response:', data);
        syncStatusCache = data;
        syncStatusCacheAt = Date.now();

        // Update state based on response (important!)
        setAppState('syncModeEnabled', data.active);
        setAppState('isHost', data.is_host);

        // Update UI and WebSocket connection based on the *actual* new state
        updateSyncToggleButton(); // This handles both button and header display text
        // updateSyncStatusIndicator(); // No longer needed

        if (window.ragotModules.appState.syncModeEnabled) {
            if (!window.ragotModules.appState.isHost) {
                console.log('Guest mode enabled by toggle. Initializing WebSocket...');
                initWebSocket(); // Connect and join room
                disableNavigationControls();
                updateSyncStatusDisplay('success', 'Sync: Joined as Guest', 3000);
            } else {
                console.log('Host mode enabled by toggle. Initializing WebSocket for playback sync...');
                // Host needs WebSocket to SEND playback sync events
                initWebSocket();
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
        toast.error(`Failed to toggle sync mode: ${error.message}`);

        // Attempt to revert state based on a fresh check
        await checkSyncMode({ force: true }); // Re-check the actual status from server (this will call updateSyncToggleButton)

        // Update indicator to show error after re-check
        updateSyncStatusDisplay('error', 'Sync: Toggle Failed');
        // Let checkSyncMode handle resetting the text after re-check

        return { error: error.message };
    } finally {
        isTogglePending = false;
    }
}

// Throttle for index sync
let lastIndexSyncTime = 0;
const INDEX_SYNC_THROTTLE = 100; // Min ms between index updates

// --- UI Update --- (Removed updateSyncStatusIndicator and createSyncStatusIndicator)

// --- Sync Data Processing (Guest) ---

/**
 * Process sync update data received from the server (via WebSocket).
 * Uses layout wrapper to work across all layouts (default, streaming, gallery)
 * @param {Object} data - The sync data { category_id, viewKey, viewType, viewParams, mediaId, playback_state }
 * @param {boolean} force - Whether to force update regardless of current state
 */
async function handleSyncUpdate(data, force = false) {
    if (!window.ragotModules.appState.syncModeEnabled || window.ragotModules.appState.isHost) return;

    console.log('[SyncManager] handleSyncUpdate called with data:', JSON.stringify(data));

    // Special case: host exited media viewer (going back to categories)
    if (data.category_id === null || data.mediaId === null) {
        console.log('[SyncManager] Host exited media viewer, going back to categories');

        // Check if we're currently in the media viewer
        const mediaViewer = window.ragotModules?.appDom?.mediaViewer;
        if (mediaViewer && !mediaViewer.classList.contains('hidden')) {
            console.log('[SyncManager] Guest is in media viewer, going back to categories');

            // Go back to categories
            if (window.ragotModules?.mediaNavigation?.goBackToCategories) {
                window.ragotModules.mediaNavigation.goBackToCategories();
            }
        }

        return;
    }

    if (!data || !data.category_id) {
        console.warn('[SyncManager] Invalid sync data - missing category_id:', data);
        return;
    }

    const mediaId = data.mediaId || null;
    const receivedTimestamp = parseFloat(data.timestamp || data.video_timestamp || 0);

    // If host provided a timestamp (even 0), prioritize it for the guest
    if (!isNaN(receivedTimestamp)) {
        console.log(`[SyncManager] Host provided timestamp: ${receivedTimestamp}s`);
        setAppState('savedVideoTimestamp', receivedTimestamp);
        setAppState('savedVideoCategoryId', data.category_id);
    }

    // Check if host is currently playing (for new guests joining)
    // If playback_state is missing/null, Host is in Thumbnail Mode.
    const playbackState = data.playback_state;
    const hostIsPlaying = playbackState?.is_playing || false;
    const hostCurrentTime = playbackState?.current_time || 0;

    if (playbackState) {
        console.log(`[SyncManager] Host playback state: playing=${hostIsPlaying}, time=${hostCurrentTime}s`);
    } else {
        console.log(`[SyncManager] No playback state - Host likely in Thumbnail Mode`);
    }

    // Check if we are already at the correct state to avoid unnecessary re-renders (which destroy the video player)
    const isSameCategory = window.ragotModules.appState.currentCategoryId === data.category_id;
    const viewer = getViewerSession(window.ragotModules.appState);
    const currentMedia = getCurrentViewerRecord(window.ragotModules.appState);
    const isSameMedia = !!mediaId && currentMedia?.id === mediaId;

    // If we are already on the correct item, simply ensure the MODE (Video vs Thumbnail) is correct
    if (isSameCategory && isSameMedia) {
        console.log('[SyncManager] Already on correct media, checking playback mode...');
        const controlsAttached = window.ragotModules?.videoControls?.isControlsAttached?.();

        // Mode 1: Host is playing (Video Mode) -> Guest should be in Video Mode
        if (hostIsPlaying) {
            if (!controlsAttached) {
                console.log('[SyncManager] Host playing but guest in thumbnail mode. Switching to video...');
                applyPlaybackSync({ action: 'play', currentTime: hostCurrentTime });
            } else {
                // Already in video mode, maybe just sync time/state if needed
                // But generally playback_sync handles strict time.
                // We can ensure we aren't paused if host is playing
                // (Optional: this might be too aggressive if user paused locally, but it's sync mode)
                // Let playback_sync handle 'beat-by-beat'
            }
        }
        // Mode 2: Host is in Thumbnail Mode (no playback state) -> Guest should be in Thumbnail Mode
        else if (!playbackState) {
            if (controlsAttached) {
                console.log('[SyncManager] Host in thumbnail mode (no playback state), detaching guest controls');
                window.ragotModules.videoControls.detachControls();
                renderMediaWindow(viewer?.activeIndex || 0);
            }
        }
        // Mode 3: Host Paused (playbackState exists but !is_playing)
        // Guest stays in Video Mode (controls attached). Sync will handle pause state via distinct events.

        return; // Skip navigateToMedia
    }

    // Only navigate if we are on a different item
    const success = await navigateToState(data.category_id, mediaId, 'Sync', data);
    if (success !== false) {
        console.log(`[SyncManager] Successfully navigated to synced media`);

        // After navigation (which starts in Thumbnail Mode), checks if we need to auto-play
        if (hostIsPlaying) {
            console.log('[SyncManager] Host is playing, auto-starting guest playback');
            // Small delay to ensure DOM is ready after fresh render
            scheduleSyncTimeout(() => {
                applyPlaybackSync({ action: 'play', currentTime: hostCurrentTime });
            }, 500);
        }
    } else {
        console.warn(`[SyncManager] Layout handler navigation failed`);
    }
}

/**
 * Navigates the UI to a specific category and media id.
 * @param {string} categoryId - The target category ID.
 * @param {string} mediaId - The target media id.
 * @param {string} context - Context for status messages (e.g., 'Sync', 'View').
 * @returns {Promise<void>} - A promise that resolves when navigation is complete
 */
async function navigateToState(categoryId, mediaId, context = 'Navigation', viewInfo = {}) {
    try {
        if (!categoryId) {
            console.warn(`[SyncManager] navigateToState called with invalid categoryId: ${categoryId}`);
            return false;
        }

        const { viewKey, viewType, viewParams = {} } = viewInfo || {};
        if (viewKey && viewType) {
            const ordering = window.ragotModules?.mediaOrdering;
            if (ordering?.requestOrder) {
                try {
                    await ordering.requestOrder(viewKey, viewType, { ...viewParams, hydrate: 'true' });
                    let index = selectIndexOf(viewKey, mediaId);
                    if (index < 0) {
                        const manifest = window.ragotModules?.mediaManifest;
                        if (manifest) {
                            await manifest.hydrate([mediaId]);
                            const record = manifest.get(mediaId);
                            if (record) {
                                const view = selectView(viewKey);
                                if (view && !view.orderedIds.includes(mediaId)) {
                                    const nextOrderedIds = [...(view.orderedIds || []), mediaId];
                                    ordering.ingestView(viewKey, {
                                        ...view,
                                        orderedIds: nextOrderedIds,
                                    });
                                    index = nextOrderedIds.length - 1;
                                }
                            }
                        }
                    }
                    if (index >= 0) {
                        await openViewerFromView({ sourceViewKey: viewKey, categoryId, startIndex: index });
                        return true;
                    }
                    console.warn(`[SyncManager] Media ID ${mediaId} not found in view ${viewKey}, falling back to category-based loading.`);
                } catch (viewError) {
                    console.warn(`[SyncManager] View order request failed for ${viewKey}, falling back to category-based loading:`, viewError);
                }
            }
        }

        const viewerSession = getViewerSession(window.ragotModules.appState);
        const viewerHidden = !window.ragotModules.appDom.mediaViewer || window.ragotModules.appDom.mediaViewer.classList.contains('hidden');
        const needsCategorySwitch = categoryId !== window.ragotModules.appState.currentCategoryId;

        if (needsCategorySwitch || !viewerSession || viewerHidden) {
            window.ragotModules.mediaLoader.clearResources(false);
            await openCategoryViewer({ categoryId, startRecordId: mediaId });
            return true;
        }

        let viewer = getViewerSession(window.ragotModules.appState);
        let index = viewer?.viewKey ? selectIndexOf(viewer.viewKey, mediaId) : -1;
        if (index >= 0) {
            renderMediaWindow(index);
            return true;
        }

        // Fallback: if not found in current viewer page cache, load directly via startRecordId
        window.ragotModules.mediaLoader.clearResources(false);
        await openCategoryViewer({ categoryId, startRecordId: mediaId });
        return true;
    } catch (error) {
        console.error(`Error in ${context} navigation:`, error);
        return false;
    }
}

/**
 * Send a sync update to the server (Host only) - Uses WebSocket for speed.
 * Falls back to HTTP if WebSocket unavailable.
 * @param {Object} mediaInfo - The media info to sync { category_id, viewKey, viewType, viewParams, mediaId }
 * @returns {Promise<boolean>} - Whether the update was sent.
 */

async function sendSyncUpdate(mediaInfo) {
    if (!window.ragotModules.appState.syncModeEnabled || !window.ragotModules.appState.isHost) {
        return false;
    }

    if (!mediaInfo || typeof mediaInfo.category_id === 'undefined' || !mediaInfo.mediaId) {
        return false;
    }

    // Throttle rapid updates
    const now = Date.now();
    if (now - lastIndexSyncTime < INDEX_SYNC_THROTTLE) {
        return false;
    }
    lastIndexSyncTime = now;

    // Capture playback state if available
    const playbackState = window.ragotModules?.videoControls?.getPlaybackState?.();

    const payload = {
        category_id: mediaInfo.category_id,
        viewKey: mediaInfo.viewKey || null,
        viewType: mediaInfo.viewType || null,
        viewParams: mediaInfo.viewParams || {},
        mediaId: mediaInfo.mediaId,
        timestamp: now / 1000
    };

    if (playbackState) {
        payload.playback_state = playbackState;
    }

    // Try WebSocket first (faster)
    if (socket?.connected) {
        socket.emit(SOCKET_EVENTS.SYNC_UPDATE, payload);
        return true;
    }

    // Fallback to HTTP
    try {
        const response = await fetch('/api/sync/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return response.ok;
    } catch {
        return false;
    }
}

// --- Playback Sync Functions ---

// Playback sync state
let isApplyingPlaybackSync = false;
let lastPlaybackSyncTime = 0;
let seekDebounceTimer = null;
const PLAYBACK_SYNC_THROTTLE = 250; // Min ms between sync events

/**
 * Send a playback sync event to all guests (Host only).
 * @param {string} action - The playback action: 'play', 'pause', or 'seek'
 * @param {number} currentTime - The current playback position in seconds
 */
function sendPlaybackSync(action, currentTime, isPlaying = null) {
    // Only hosts in sync mode can send playback events
    if (!window.ragotModules.appState.syncModeEnabled || !window.ragotModules.appState.isHost) {
        return;
    }

    // Don't send if we're currently applying a sync (prevent loops)
    if (isApplyingPlaybackSync) {
        return;
    }

    // Clear any pending seek debounce when a new immediate event (play/pause) comes in
    if (action !== 'seek') {
        clearTimeout(seekDebounceTimer);
    }

    // Throttle to prevent spam (especially during seeking)
    const now = Date.now();
    if (now - lastPlaybackSyncTime < PLAYBACK_SYNC_THROTTLE && action === 'seek') {
        // Debounce seek events - only send the last one
        clearTimeout(seekDebounceTimer);
        seekDebounceTimer = scheduleSyncTimeout(() => {
            // Pass null for isPlaying so it re-calculates the actual DOM state when it fires
            sendPlaybackSync(action, currentTime, null);
        }, PLAYBACK_SYNC_THROTTLE);
        return;
    }
    lastPlaybackSyncTime = now;

    if (!socket) {
        initWebSocket();
    }

    if (!socket || !socket.connected) {
        console.log('[Sync] Cannot send playback_sync - socket not connected');
        return;
    }

    // Determine current playing state if not provided
    if (isPlaying === null) {
        const activeVideo = $('video.viewer-media.active, .viewer-media.active video');
        isPlaying = activeVideo ? !activeVideo.paused : (action === 'play');
    }

    const viewer = getViewerSession(window.ragotModules.appState);
    const currentMedia = getCurrentViewerRecord(window.ragotModules.appState);
    const currentView = viewer ? selectView(viewer.viewKey) : null;
    const payload = {
        action: action,
        currentTime: currentTime || 0,
        is_playing: isPlaying,
        timestamp: now / 1000
    };

    // Add media info if available (needed for thumbnail-to-video conversion on guests)
    if (window.ragotModules.appState.currentCategoryId && currentMedia && viewer) {
        payload.category_id = window.ragotModules.appState.currentCategoryId;
        payload.viewKey = viewer.viewKey;
        payload.viewType = currentView?.viewType || null;
        payload.viewParams = selectParams(viewer.viewKey);
        payload.mediaId = currentMedia.id || null;
        console.log(`[Sync] Sending playback_sync with media: ${currentMedia.name || currentMedia.url}, playing=${isPlaying}`);
    } else {
        console.log(`[Sync] Sending playback_sync without media info: action=${action}, time=${currentTime}, playing=${isPlaying}`);
    }

    socket.emit(SOCKET_EVENTS.PLAYBACK_SYNC, payload);

    // Manage periodic heartbeat
    if (action === 'play') {
        startPlaybackHeartbeat();
    } else if (action === 'pause') {
        stopPlaybackHeartbeat();
    }
}

/**
 * Start 10s heartbeat from Host to keep Guests in sync (Beat-by-Beat)
 */
function startPlaybackHeartbeat() {
    if (playbackHeartbeatInterval) return;

    console.log('[Sync] Starting periodic sync heartbeat (10s)');
    playbackHeartbeatInterval = syncLifecycle.interval(() => {
        const activeVideo = $('video.viewer-media.active, .viewer-media.active video');
        if (activeVideo && !activeVideo.paused) {
            sendPlaybackSync('seek', activeVideo.currentTime, true);
        } else {
            stopPlaybackHeartbeat();
        }
    }, 10000);
}

/**
 * Stop periodic heartbeat
 */
function stopPlaybackHeartbeat() {
    if (playbackHeartbeatInterval) {
        console.log('[Sync] Stopping periodic sync heartbeat');
        syncLifecycle.clearInterval(playbackHeartbeatInterval);
        playbackHeartbeatInterval = null;
    }
}

function findActiveVideoElement() {
    return $(
        'video.viewer-media.active, ' +
        '.viewer-media.active video, ' +
        '.ghoststream-transcode-container video, ' +
        'video.ghoststream-video'
    );
}

function findActiveThumbnailContainer() {
    return $('.viewer-media.active.video-thumbnail-container') ||
        $('.video-thumbnail-container.active') ||
        $('.video-thumbnail-container');
}

async function waitForActiveVideoElement(timeoutMs = 5000, intervalMs = 60) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const video = findActiveVideoElement();
        if (video) return video;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return null;
}

/**
 * Apply a playback sync event received from the host (Guest only).
 * If guest is showing a thumbnail, converts it to video first.
 * @param {Object} data - The playback sync data { action, currentTime, timestamp, category_id, mediaId }
 */
async function applyPlaybackSync(data) {
    console.log('[Sync] applyPlaybackSync called with data:', JSON.stringify(data));

    if (!data?.action) {
        console.log('[Sync] No action in playback_sync data, returning');
        return;
    }

    const action = data.action;
    const targetTime = data.currentTime || 0;

    isApplyingPlaybackSync = true;
    const finishSync = (delayMs = 0) => {
        if (delayMs > 0) {
            scheduleSyncTimeout(() => { isApplyingPlaybackSync = false; }, delayMs);
            return;
        }
        isApplyingPlaybackSync = false;
    };

    try {
        if (data.category_id && data.mediaId) {
            const currentMedia = getCurrentViewerRecord(window.ragotModules.appState);
            const needsNavigate = (
                window.ragotModules.appState.currentCategoryId !== data.category_id ||
                currentMedia?.id !== data.mediaId
            );

            if (needsNavigate) {
                console.log(`[Sync] Playback sync includes media info, navigating first: cat=${data.category_id}, media=${data.mediaId}`);
                const navSuccess = await navigateToState(data.category_id, data.mediaId, 'PlaybackSync', data);

                if (!navSuccess) {
                    console.warn('[Sync] Failed to navigate to media from playback_sync');
                    finishSync();
                    return;
                }

                // Allow the viewer render cycle to complete.
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }

        let thumbnailContainer = findActiveThumbnailContainer();
        let videoElement = findActiveVideoElement();

        console.log(`[Sync] applyPlaybackSync: action=${action}, thumbnail=${!!thumbnailContainer}, video=${!!videoElement}`);

        // If play arrives during a render transition, wait briefly for the viewer node to appear.
        if (!videoElement && action === 'play' && !thumbnailContainer) {
            await new Promise(resolve => setTimeout(resolve, 120));
            thumbnailContainer = findActiveThumbnailContainer();
            videoElement = findActiveVideoElement();
        }

        // Convert thumbnail to video on play by reusing the same click flow as a real user.
        if (!videoElement && action === 'play' && thumbnailContainer) {
            if (thumbnailContainer.classList.contains('loading-video')) {
                console.log('[Sync] Thumbnail already loading, waiting for active video element');
            } else {
                console.log('[Sync] Activating thumbnail for synced playback transition');
                const didActivate = window.ragotModules?.mediaNavigation?.activateVideoThumbnail?.(thumbnailContainer) === true;
                if (!didActivate) {
                    console.warn('[Sync] Failed to activate thumbnail for synced playback transition');
                }
            }
            videoElement = await waitForActiveVideoElement(5000);
        }

        if (!videoElement && action === 'play') {
            videoElement = await waitForActiveVideoElement(1500, 80);
        }

        if (!videoElement && action !== 'play') {
            videoElement = await waitForActiveVideoElement(1200, 80);
        }

        if (!videoElement) {
            if (action === 'play') {
                console.warn('[Sync] No video element found for playback sync action:', action);
            }
            finishSync();
            return;
        }

        // Helper to safely seek - for HLS streams, check seekable range first
        const safeSeek = (video, time) => {
            // Check if video is seekable (important for HLS)
            if (video.seekable && video.seekable.length > 0) {
                const seekableEnd = video.seekable.end(video.seekable.length - 1);
                if (time <= seekableEnd) {
                    video.currentTime = time;
                    return true;
                } else {
                    console.log(`[Sync] Target time ${time}s exceeds seekable range (0-${seekableEnd}s)`);
                    return false;
                }
            }
            // If no seekable info, try anyway (non-HLS)
            video.currentTime = time;
            return true;
        };


        const executePlay = () => {
            if (!videoElement) {
                finishSync();
                return;
            }

            // If already playing, don't force unmute here. Forced unmute can pause playback
            // on browsers requiring a direct gesture.
            if (!videoElement.paused) {
                finishSync();
                return;
            }

            // Browser policy is source-of-truth: attempt unmuted only after user activation,
            // otherwise start muted. Always fallback to muted if unmuted play is blocked.
            const attemptPlay = () => videoElement.play().then(() => {
                finishSync(100);
            }).catch((err) => {
                console.error('[Sync] Play failed:', err);
                finishSync();
            });

            const hasUserActivation = document.userActivation?.hasBeenActive === true;
            const prefersUnmuted = videoElement.muted === false;
            const playMode = getSyncPlayMode({ hasUserActivation, prefersUnmuted });

            if (playMode === 'unmuted-first') {
                console.log('[Sync] Attempting unmuted play after user activation');
                videoElement.muted = false;
                videoElement.play().then(() => {
                    finishSync(100);
                }).catch(() => {
                    console.log('[Sync] Unmuted play blocked; falling back to muted');
                    videoElement.muted = true;
                    attemptPlay();
                });
                return;
            }

            videoElement.muted = true;
            console.log('[Sync] Attempting muted play');
            attemptPlay();
        };

        switch (action) {
            case 'play':
                console.log(`[Sync] Applying play at time ${targetTime}s`);

                // Align time first
                if (Math.abs(videoElement.currentTime - targetTime) > 0.5) {
                    safeSeek(videoElement, targetTime);
                }

                // Policy: if browser reports user activation and element prefers unmuted,
                // try unmuted first; otherwise start muted and keep playback moving.

                if (videoElement.readyState >= 2) {
                    executePlay();
                } else {
                    console.log('[Sync] Video not ready, waiting for loadeddata...');
                    let loadedCalled = false;
                    attr(videoElement, {
                        onLoadedData: () => {
                            if (loadedCalled) return;
                            loadedCalled = true;
                            executePlay();
                        }
                    }, { additive: true });
                }

                // Guard against post-conversion timing races where play resolves late or gets interrupted.
                scheduleSyncTimeout(() => {
                    if (videoElement && videoElement.paused) {
                        if (videoElement.readyState >= 2) {
                            executePlay();
                        }
                    } else {
                        finishSync();
                    }
                }, 450);
                break;
            case 'pause':
                console.log('[Sync] Applying pause');
                videoElement.pause();
                finishSync(100);
                break;
            case 'seek':
                console.log(`[Sync] Applying seek to ${targetTime}s (host_playing=${data.is_playing})`);

                // Only seek if we are outside the desync threshold (e.g., 5.0s)
                // This prevents "flickering" loading spinners from the periodic heartbeat
                const desyncAmount = Math.abs(videoElement.currentTime - targetTime);
                let didSeek = false;
                if (desyncAmount > 5.0) {
                    console.log(`[Sync] Desync detected (${desyncAmount.toFixed(2)}s). Seeking to align with host.`);
                    didSeek = safeSeek(videoElement, targetTime);
                } else {
                    console.log(`[Sync] Within sync threshold (${desyncAmount.toFixed(2)}s). Skipping heartbeat seek.`);
                }

                // If host is playing, we MUST ensure we are also playing after the seek.
                // Many browsers pause or stay paused during a seek.
                if (data.is_playing === true && videoElement.paused) {
                    if (didSeek && videoElement.seeking) {
                        let seekedCalled = false;
                        attr(videoElement, {
                            onSeeked: () => {
                                if (seekedCalled) return;
                                seekedCalled = true;
                                executePlay();
                            }
                        }, { additive: true });
                    } else {
                        executePlay();
                    }
                } else if (data.is_playing === false && !videoElement.paused) {
                    videoElement.pause();
                    finishSync(100);
                } else {
                    finishSync(100);
                }
                break;
        }
    } catch (error) {
        console.error('[Sync] Error applying playback sync:', error);
        finishSync();
    }
}

/**
 * Check if we're currently applying a playback sync (to prevent feedback loops).
 * @returns {boolean}
 */
function isPlaybackSyncInProgress() {
    return isApplyingPlaybackSync;
}

/**
 * Initialize the sync manager with a socket instance.
 * @param {Object} socketInstance - The socket.io instance to use for sync.
 */
function initSync(socketInstance) {
    if (!socketInstance) {
        console.warn('initSync called without socket instance');
        return;
    }

    syncLifecycle.start();

    // If we have a DIFFERENT socket instance, detach from the old one
    if (socket && socket !== socketInstance) {
        console.log('SyncManager: Replacing existing socket instance to prevent dual-connection leaks.');
        detachSyncSocketListeners(socket);
        if (syncOwnsSocket) {
            socket.disconnect();
        }
    }

    socket = socketInstance;
    syncOwnsSocket = false;
    ensureSyncBeforeUnloadListener();
    isWebSocketConnected = socket.connected;

    // Load parameters for custom reconnection logic from config if possible
    configuredMaxReconnectAttempts = getConfigValue('javascript_config.sync_manager.manual_maxReconnectAttempts', 10);
    configuredReconnectDelayBase = getConfigValue('javascript_config.sync_manager.manual_reconnectDelayBase', 1000);
    configuredReconnectFactor = getConfigValue('javascript_config.sync_manager.manual_reconnectFactor', 1.5);

    setupSocketListeners(socket);

    // Check sync mode status on init
    checkSyncMode();
}

/**
 * Optional teardown for tests/hot-reload flows.
 */
function cleanupSyncManager() {
    disconnectWebSocket();
    clearSyncTimeouts();
    syncLifecycle.off(window, 'beforeunload', handleSyncBeforeUnload);
    syncBeforeUnloadAttached = false;
    syncLifecycle.stop();
}

// --- Exports ---

// Export functions needed by other modules
export {
    checkSyncMode,    // Initial check on page load
    toggleSyncMode,   // Called by UI button
    sendSyncUpdate,   // Called by media navigation when host changes media
    sendPlaybackSync, // Called by video event handlers for play/pause/seek sync
    navigateToState,  // Called by chat shared-view handlers
    isPlaybackSyncInProgress, // Check if we're applying a sync (prevent loops)
    initSync,         // Initialize with socket instance
    cleanupSyncManager
};
