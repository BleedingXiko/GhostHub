/**
 * TV Cast Manager Module
 * ---------------------
 * Handles casting media from GhostHub to the TV display server.
 * Integrates with mediaNavigation and fullscreenManager.
 */

import { getConfigValue } from '../../utils/configManager.js';
import { castIcon } from '../../utils/icons.js';
import { Module, Component, createElement, append, insertBefore, remove, $, $$ } from '../../libs/ragot.esm.min.js';
import { toast } from '../../utils/notificationManager.js';
import { showStatusLane, hideStatusLane } from '../../utils/statusLane.js';
import {
    getLocalProgress,
    getVideoLocalProgress,
    saveLocalProgress,
    saveVideoLocalProgress,
    isUserAdmin
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import {
    initTvPlayerModal,
    showTvPlayerModal,
    hideTvPlayerModal,
    updateMediaInfo,
    updatePlaybackState,
    syncWithVideoElement,
    isTvPlayerModalVisible,
    setControlPermission,
    updateConnectionStatus
} from './tvPlayerModal.js';
import { TV_EVENTS } from '../../core/socketEvents.js';
import { getCurrentViewerRecord, getViewerSession } from '../media/viewerState.js';
import { selectParams, selectRecordAt, selectView } from '../media/selectors.js';

// Store references
let socket = null;
let headerCastButton = null;
let isTvConnected = false;
let hdmiConnected = false;
let kioskRunning = false;
let isCasting = false;
let castingViewKey = null;
let castingViewType = null;
let castingViewParams = {};
let castingCategoryId = null;
let castingMediaId = null;
let castingVideoElement = null;
let currentPlaybackTime = 0;
let lastPlaybackSyncTime = 0;
let tvDisplayPort = 5001;
let shutdownCountdown = null; // Timer for shutdown countdown UI
let kioskBooting = false; // Track if kiosk is currently booting
let bootTimeoutTimer = null; // Timeout for boot notification
const PLAYBACK_SYNC_THROTTLE = 250; // Min ms between sync events
const TV_CAST_STORAGE_KEY = 'ghosthub_tv_cast_state'; // SessionStorage key for modal persistence
const ALLOW_EXTERNAL_TV_SYNC = false; // Only the TV modal should send sync events
const TV_KIOSK_STATUS_KEY = 'tv-kiosk-status';
let pendingMediaWaitTimer = null;
let pendingCastKey = null;
let isCastInitiator = false; // Track if THIS client initiated the current cast
let pendingPlaybackSync = null;
let hdmiStatusInterval = null;
let restoreModalTimeout = null;
let postCastSyncTimeout = null;
let socketListenersBound = false;
let activeSocketRef = null;
let tvCastLifecycle = null;
let tvCastButtonComponent = null;
let pendingShutdownNotified = false;
let castStopRequested = false;
let tvStatusRequestTimer = null;

function showTvKioskStatus(title, meta = '', options = {}) {
    showStatusLane(TV_KIOSK_STATUS_KEY, {
        title,
        meta,
        tone: options.tone || 'info',
        busy: options.busy !== false,
        priority: 30
    });
}

function hideTvKioskStatus() {
    hideStatusLane(TV_KIOSK_STATUS_KEY);
}

function clearTvCastInterval(intervalId) {
    if (!intervalId) return;
    if (tvCastLifecycle) {
        tvCastLifecycle.clearInterval(intervalId);
        return;
    }
    clearInterval(intervalId);
}

function clearTvCastTimeout(timeoutId) {
    if (!timeoutId) return;
    if (tvCastLifecycle) {
        tvCastLifecycle.clearTimeout(timeoutId);
        return;
    }
    clearTimeout(timeoutId);
}

class TvCastButtonComponent extends Component {
    constructor() {
        super();
        this.buttonContainer = null;
        this.lastActivateAt = 0;
        this.lastPointerUpAt = 0;
        this.lastTouchEndAt = 0;
        this.onActivate = this.onActivate.bind(this);
    }

    render() {
        return createElement('div', { className: 'tv-cast-ui-root', style: { display: 'none' } });
    }

    start() {
        if (this._isMounted) return this;
        this.mount(document.body);
        return this;
    }

    stop() {
        if (!this._isMounted) return this;
        this.unmount();
        return this;
    }

    onStart() {
        if ($('#gh-header-cast-button')) {
            headerCastButton = $('#gh-header-cast-button');
            return;
        }

        this.buttonContainer = createElement('div', { className: 'gh-header__cast' });
        headerCastButton = createElement('button', {
            id: 'gh-header-cast-button',
            className: 'btn btn--icon gh-header__btn',
            'aria-label': 'Cast to TV Display',
            title: 'Cast to TV Display',
            'data-gh-tooltip': 'Cast to TV Display',
            'data-gh-tooltip-position': 'bottom',
            innerHTML: castIcon(24)
        });
        headerCastButton.style.display = 'none';

        const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
        if (supportsPointer) {
            this.on(headerCastButton, 'pointerup', this.onActivate);
        } else {
            this.on(headerCastButton, 'touchend', this.onActivate, { passive: false });
        }
        this.on(headerCastButton, 'click', this.onActivate);

        append(this.buttonContainer, headerCastButton);

        const headerConfigElement = $('.gh-header__config');
        if (headerConfigElement?.parentNode) {
            insertBefore(headerConfigElement.parentNode, this.buttonContainer, headerConfigElement);
        } else {
            const appHeader = $('.gh-header');
            if (appHeader) append(appHeader, this.buttonContainer);
        }
    }

    onStop() {
        remove(this.buttonContainer);
        this.buttonContainer = null;
        headerCastButton = null;
    }

    syncFromModule(state) {
        if (!headerCastButton) return;
        const {
            isCasting: casting = false,
            hdmiConnected: hdmi = false,
            kioskRunning: kiosk = false,
            kioskBooting: booting = false
        } = state || {};

        headerCastButton.style.display = (hdmi || casting) ? 'block' : 'none';
        headerCastButton.classList.toggle('casting-pending', casting && (!isTvConnected || booting));

        if (casting) {
            headerCastButton.classList.add('casting');
            headerCastButton.classList.remove('kiosk-idle');
            headerCastButton.title = 'Stop Casting to TV';
            headerCastButton.style.color = '#fe2c55';
            return;
        }

        headerCastButton.classList.remove('casting');
        if (hdmi && !kiosk) {
            headerCastButton.classList.add('kiosk-idle');
            headerCastButton.title = 'Cast to TV (kiosk will start)';
            headerCastButton.style.color = 'var(--text-secondary, #888)';
        } else {
            headerCastButton.classList.remove('kiosk-idle');
            headerCastButton.title = 'Cast to TV Display';
            headerCastButton.style.color = '';
        }
    }

    isDuplicateActivationEvent(e) {
        const now = Date.now();
        const type = e?.type || '';

        if (now - this.lastActivateAt < 350) return true;

        if (type === 'click') {
            const isKeyboardClick = e && typeof e.detail === 'number' && e.detail === 0;
            if (!isKeyboardClick) {
                if (now - this.lastPointerUpAt < 900 || now - this.lastTouchEndAt < 900) {
                    return true;
                }
            }
        }

        if (type === 'pointerup') this.lastPointerUpAt = now;
        if (type === 'touchend') this.lastTouchEndAt = now;
        this.lastActivateAt = now;
        return false;
    }

    onActivate(e) {
        if (this.isDuplicateActivationEvent(e)) return;
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        if (!socket || !socket.connected) {
            console.warn('[TV Cast] Cast requested but socket not ready');
            showCastNotification('TV connection not ready', true);
            return;
        }

        if (isCasting) {
            stopCasting();
            return;
        }

        const currentFile = getActiveViewerCastFile();
        if (!currentFile) {
            console.error('No media currently selected to cast');
            showCastNotification('No media selected', true);
            return;
        }

        if (currentFile && currentFile.url) {
            castMediaToTv(currentFile);
        } else {
            console.error('Current media file is invalid:', currentFile);
            showCastNotification('Cannot cast this media', true);
        }
    }
}

function ensureTvCastLifecycle() {
    if (!tvCastLifecycle) {
        tvCastLifecycle = new Module();
        tvCastLifecycle.addCleanup(() => {
            teardownSocketListeners();
            cleanupVideoPlaybackSync();
            clearPendingMediaWait();
            hideKioskBootNotification();
            if (shutdownCountdown) {
                clearTvCastInterval(shutdownCountdown);
                shutdownCountdown = null;
            }
            if (hdmiStatusInterval) {
                clearTvCastInterval(hdmiStatusInterval);
                hdmiStatusInterval = null;
            }
            if (restoreModalTimeout) {
                clearTvCastTimeout(restoreModalTimeout);
                restoreModalTimeout = null;
            }
            if (postCastSyncTimeout) {
                clearTvCastTimeout(postCastSyncTimeout);
                postCastSyncTimeout = null;
            }
            socket = null;
        });
    }
    tvCastLifecycle.start();
    return tvCastLifecycle;
}

function syncTvCastButtonState() {
    if (!tvCastLifecycle) return;
    tvCastLifecycle.setState({
        isCasting,
        hdmiConnected,
        kioskRunning,
        kioskBooting
    });
}

function getActiveVideoElement() {
    return $('.viewer-media.active video, video.viewer-media.active');
}

function queueInitialPlaybackSync(action, time) {
    if (action !== 'play' && action !== 'pause') return;
    if (!isFinite(time) || time < 0) return;
    pendingPlaybackSync = { action, time, sent: false };
}

function flushInitialPlaybackSync(reason = '') {
    if (!pendingPlaybackSync || pendingPlaybackSync.sent || !socket || !isTvConnected) return;
    console.log(`[TV Cast] Syncing initial playback state (${pendingPlaybackSync.action}) after cast`, reason);
    socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, {
        action: pendingPlaybackSync.action,
        currentTime: pendingPlaybackSync.time
    });
    pendingPlaybackSync.sent = true;
}

function getCastFallbackInfo(castingInfo) {
    if (!castingInfo) {
        return { title: 'Now Playing', thumbnailUrl: '' };
    }

    const mediaPath = castingInfo.media_path || '';
    const cleanPath = mediaPath.split('?')[0];
    const derivedTitle = cleanPath ? cleanPath.split('/').pop() : 'Now Playing';
    const thumbnailUrl = castingInfo.thumbnail_url ||
        (castingInfo.media_type === 'image' ? mediaPath : '');

    return {
        title: derivedTitle || 'Now Playing',
        thumbnailUrl: thumbnailUrl || ''
    };
}

function normalizeViewParams(params) {
    return params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
}

function getCanonicalCastIdentity(file) {
    const appState = window.ragotModules?.appState;
    const viewer = getViewerSession(appState);
    const viewKey = viewer?.viewKey || null;
    const view = viewKey ? selectView(viewKey) : null;
    const fallbackRecord = viewer ? selectRecordAt(viewKey, viewer.activeIndex) : null;
    const currentRecord = file?.id ? file : getCurrentViewerRecord(appState) || fallbackRecord;
    const mediaId = file?.id || currentRecord?.id || null;
    const viewType = view?.viewType || null;
    const viewParams = viewKey ? normalizeViewParams(selectParams(viewKey)) : {};
    const categoryId = appState?.currentCategoryId || viewParams.category_id || viewParams.categoryId || null;

    if (!viewKey || !viewType || !mediaId) {
        console.warn('[TV Cast] Cannot cast without canonical view identity', {
            viewKey,
            viewType,
            mediaId
        });
        return null;
    }

    return {
        viewKey,
        viewType,
        viewParams,
        categoryId,
        mediaId
    };
}

function getActiveViewerCastFile() {
    const appState = window.ragotModules?.appState;
    const viewer = getViewerSession(appState);
    const activeElement = $('.viewer-media.active', window.ragotModules?.appDom?.mediaViewer);
    const activeIndex = Number.parseInt(activeElement?.getAttribute('data-index') || '', 10);

    if (viewer?.viewKey && Number.isInteger(activeIndex) && activeIndex >= 0) {
        const activeRecord = selectRecordAt(viewer.viewKey, activeIndex);
        if (activeRecord?.url) {
            return activeRecord;
        }
    }

    return getCurrentViewerRecord(appState);
}

/**
 * Save casting state to sessionStorage with FULL media info
 * This allows modal to restore without needing the active viewer state.
 */
function saveCastingState(mediaInfo = null) {
    if (isCasting && castingViewKey && castingViewType && castingMediaId) {
        const state = {
            isCasting: true,
            viewKey: castingViewKey,
            viewType: castingViewType,
            viewParams: castingViewParams || {},
            categoryId: castingCategoryId,
            mediaId: castingMediaId,
            mediaUrl: mediaInfo?.mediaUrl || currentMediaUrl || '',
            // Save full media info so modal can restore without window.ragotModules.appState
            title: mediaInfo?.title || currentMediaTitle || 'Now Playing',
            thumbnailUrl: mediaInfo?.thumbnailUrl || currentThumbnailUrl || '',
            duration: mediaInfo?.duration || currentDuration || 0,
            currentTime: mediaInfo?.currentTime || 0,
            is_guest_cast: mediaInfo?.is_guest_cast ?? true
        };
        sessionStorage.setItem(TV_CAST_STORAGE_KEY, JSON.stringify(state));
        console.log('[TV Cast] Saved state to sessionStorage:', state);
    } else {
        sessionStorage.removeItem(TV_CAST_STORAGE_KEY);
    }
}

// Track current media info for saving to sessionStorage
let currentMediaTitle = '';
let currentThumbnailUrl = '';
let currentDuration = 0;
let currentMediaUrl = '';

/**
 * Restore casting state from sessionStorage
 */
function restoreCastingState() {
    const saved = sessionStorage.getItem(TV_CAST_STORAGE_KEY);
    if (!saved) return false;

    try {
        const state = JSON.parse(saved);
        if (!state?.viewKey || !state?.viewType || !state?.mediaId) {
            sessionStorage.removeItem(TV_CAST_STORAGE_KEY);
            return false;
        }
        // No expiration check - sessionStorage clears on tab close anyway
        // Server is source of truth and will correct state if needed
        return state;
    } catch (e) {
        console.error('Failed to restore casting state:', e);
        sessionStorage.removeItem(TV_CAST_STORAGE_KEY);
        return false;
    }
}

function clearPendingMediaWait() {
    if (pendingMediaWaitTimer) {
        clearTvCastInterval(pendingMediaWaitTimer);
        pendingMediaWaitTimer = null;
    }
    pendingCastKey = null;
}

/**
 * Reset all casting state to clean defaults.
 * Consolidates state cleanup logic that was previously duplicated in multiple handlers.
 * @param {Object} options - Cleanup options
 * @param {boolean} options.hideModal - Whether to hide the TV player modal (default: true)
 * @param {boolean} options.clearStorage - Whether to clear sessionStorage (default: true)
 */
function resetCastingState(options = {}) {
    const { hideModal = true, clearStorage = true, preserveStopRequest = false } = options;

    console.log('[TV Cast] Resetting casting state', { hideModal, clearStorage });

    // Reset all casting flags
    isCasting = false;
    isCastInitiator = false;
    castingViewKey = null;
    castingViewType = null;
    castingViewParams = {};
    castingCategoryId = null;
    castingMediaId = null;
    currentPlaybackTime = 0;
    pendingPlaybackSync = null;
    kioskBooting = false;
    if (!preserveStopRequest) {
        castStopRequested = false;
    }

    // Clear pending operations
    clearPendingMediaWait();

    // Clear storage if requested
    if (clearStorage) {
        sessionStorage.removeItem(TV_CAST_STORAGE_KEY);
    }

    // Hide modal if requested
    if (hideModal) {
        hideTvPlayerModal();
    }

    // Reset control permission
    setControlPermission(false);

    // Update UI state
    updateCastButtonState();
}

/**
 * Create the TV Cast UI (button). Call this early, before socket is available.
 * This ensures button exists when admin status is checked.
 */
function createTvCastUI() {
    console.log('Creating TV Cast UI');
    ensureTvCastLifecycle();

    // Get TV Display port from config
    tvDisplayPort = getConfigValue('python_config.TV_DISPLAY_PORT', 5001);
    console.log('TV Display port:', tvDisplayPort);

    // Create the header cast button (starts visible by default)
    createHeaderCastButton();

    // Show button immediately - HDMI status check will update visibility if needed
    if (headerCastButton) {
        headerCastButton.style.display = 'block';
        console.log('[TV Cast] Cast button shown by default on creation');
    }

    // Check HDMI status (doesn't need socket) - this will update visibility
    checkHdmiStatus();
}

/**
 * Initialize the TV Cast manager with socket. Call after socket is created.
 * @param {Object} socketInstance - The Socket.IO instance
 */
function initTvCastManager(socketInstance) {
    console.log('Initializing TV Cast Manager with socket');
    ensureTvCastLifecycle();
    if (socket !== socketInstance) {
        socketListenersBound = false;
    }
    socket = socketInstance;

    // Clean up any stale notifications from previous session (page refresh during boot)
    hideKioskBootNotification();

    // Initialize TV player modal
    initTvPlayerModal(socket);

    // Set up socket event listeners
    setupSocketListeners();

    // Request current TV status (now that we have socket)
    requestTvStatus();

    // CRITICAL: Try to restore modal from sessionStorage (persists across page refresh)
    // Check and set casting state IMMEDIATELY to prevent race conditions with tv_status_update
    const savedState = restoreCastingState();
    if (savedState && savedState.isCasting) {
        // Set state immediately to prevent race condition with tv_status_update event
        isCasting = true;
        castingViewKey = savedState.viewKey;
        castingViewType = savedState.viewType;
        castingViewParams = normalizeViewParams(savedState.viewParams);
        castingCategoryId = savedState.categoryId;
        castingMediaId = savedState.mediaId;
        console.log('[TV Cast] Restored casting state from sessionStorage (immediate):', savedState);
    }

    // Use setTimeout to ensure DOM is ready and modal element is created
    restoreModalTimeout = ensureTvCastLifecycle().timeout(() => {
        if (savedState && savedState.isCasting) {
            // CRITICAL: Check if modal is already shown to prevent duplicate displays
            if (!isTvPlayerModalVisible()) {
                // Show modal with saved media info (no need to wait for window.ragotModules.appState)
                console.log('[TV Cast] Showing restored modal from timeout:', savedState);
                showTvPlayerModal({
                    title: savedState.title || 'Now Playing',
                    thumbnailUrl: savedState.thumbnailUrl || '',
                    duration: savedState.duration || 0,
                    startTime: savedState.currentTime || 0,
                    mediaUrl: savedState.mediaUrl || '',
                    viewKey: savedState.viewKey,
                    viewType: savedState.viewType,
                    viewParams: savedState.viewParams || {},
                    categoryId: savedState.categoryId,
                    mediaId: savedState.mediaId
                });
            }

            // Save current media info for future updates
            currentMediaTitle = savedState.title || '';
            currentThumbnailUrl = savedState.thumbnailUrl || '';
            currentDuration = savedState.duration || 0;
            currentMediaUrl = savedState.mediaUrl || '';

            // CRITICAL: DO NOT sync with main video player - TV modal controls TV only
            // setupVideoPlaybackSync();

            // CRITICAL: Update button state immediately after restoring casting state
            updateCastButtonVisibility();
            updateCastButtonState();
        } else {
            // Update visibility now that we have TV status info
            updateCastButtonVisibility();
            updateCastButtonState();
        }
    }, 100);

    // CRITICAL FIX: Start polling fallback for HDMI status (handles pyudev failures)
    // Without this, frontend has no fallback when backend udev events fail
    startStatusChecks();
}

/**
 * Request current TV connection status from server
 */
function requestTvStatus() {
    if (!socket) return;
    if (tvStatusRequestTimer) return;
    tvStatusRequestTimer = ensureTvCastLifecycle().timeout(() => {
        tvStatusRequestTimer = null;
        if (socket) {
            socket.emit(TV_EVENTS.REQUEST_TV_STATUS);
        }
    }, 0);
}

/**
 * Set up Socket.IO event listeners
 */
function setupSocketListeners() {
    if (!socket) {
        console.error('Socket not available for TV Cast Manager');
        return;
    }

    if (socketListenersBound && activeSocketRef === socket) {
        return;
    }

    const lifecycle = ensureTvCastLifecycle();
    lifecycle.onSocket(socket, TV_EVENTS.TV_STATUS_UPDATE, handleTvStatusUpdate);
    lifecycle.onSocket(socket, TV_EVENTS.TV_PLAYBACK_STATE, handleTvPlaybackState);
    lifecycle.onSocket(socket, TV_EVENTS.KIOSK_BOOTING, handleKioskBooting);
    lifecycle.onSocket(socket, TV_EVENTS.KIOSK_BOOT_COMPLETE, handleKioskBootComplete);
    lifecycle.onSocket(socket, TV_EVENTS.KIOSK_BOOT_TIMEOUT, handleKioskBootTimeout);
    lifecycle.onSocket(socket, TV_EVENTS.CAST_SUCCESS, handleCastSuccess);
    lifecycle.onSocket(socket, TV_EVENTS.TV_ERROR, handleTvError);
    lifecycle.onSocket(socket, TV_EVENTS.HDMI_STATUS, handleHdmiStatus);
    lifecycle.onSocket(socket, TV_EVENTS.KIOSK_STATUS, handleKioskStatus);
    socketListenersBound = true;
    activeSocketRef = socket;

    // Guest casts no longer auto-sync progress to IndexedDB
    // Guests now use manual sync button in TV modal (simpler UX)

    // NOTE: admin_status_update is handled by main.js which calls 
    // fetchAdminStatusAndUpdateUI() -> applyUIState() -> refreshCastButtonVisibility()
    // No duplicate listener needed here - it causes race conditions
}

function teardownSocketListeners() {
    if (!activeSocketRef || !socketListenersBound) return;
    activeSocketRef.off?.(TV_EVENTS.TV_STATUS_UPDATE, handleTvStatusUpdate);
    activeSocketRef.off?.(TV_EVENTS.TV_PLAYBACK_STATE, handleTvPlaybackState);
    activeSocketRef.off?.(TV_EVENTS.KIOSK_BOOTING, handleKioskBooting);
    activeSocketRef.off?.(TV_EVENTS.KIOSK_BOOT_COMPLETE, handleKioskBootComplete);
    activeSocketRef.off?.(TV_EVENTS.KIOSK_BOOT_TIMEOUT, handleKioskBootTimeout);
    activeSocketRef.off?.(TV_EVENTS.CAST_SUCCESS, handleCastSuccess);
    activeSocketRef.off?.(TV_EVENTS.TV_ERROR, handleTvError);
    activeSocketRef.off?.(TV_EVENTS.HDMI_STATUS, handleHdmiStatus);
    activeSocketRef.off?.(TV_EVENTS.KIOSK_STATUS, handleKioskStatus);
    socketListenersBound = false;
    activeSocketRef = null;
}

function handleTvStatusUpdate(data) {
    console.log('Received TV display status:', data);
    isTvConnected = data.connected;

    if (castStopRequested) {
        if (data.is_casting && socket) {
            socket.emit(TV_EVENTS.TV_STOP_CASTING, getStopCastPayload());
        }
        if (!data.is_casting) {
            castStopRequested = false;
        }
        if (isTvPlayerModalVisible()) {
            hideTvPlayerModal();
        }
        updateCastButtonVisibility();
        updateCastButtonState();
        return;
    }

    if (data.hdmi_connected !== undefined) {
        hdmiConnected = data.hdmi_connected;
        console.log('[TV Cast] Updated hdmiConnected from tv_status_update:', hdmiConnected);
    }

    if (data.is_casting && data.casting_info) {
        isCasting = true;
        castingViewKey = data.casting_info.viewKey || null;
        castingViewType = data.casting_info.viewType || null;
        castingViewParams = normalizeViewParams(data.casting_info.viewParams);
        castingCategoryId = data.casting_info.category_id;
        castingMediaId = data.casting_info.mediaId;
        console.log('[TV Cast] Restored casting state from server:', castingCategoryId);
        hideKioskBootNotification();

        const isGuestCast = data.casting_info.is_guest_cast === true;
        const isAdmin = isUserAdmin();

        if (isCastInitiator) {
            console.log('[TV Cast] This client initiated the cast - keeping modal visible with full control');
            setControlPermission(true);
        } else {
            const canControl = isGuestCast || isAdmin;
            setControlPermission(canControl);
            console.log('[TV Cast] Control permission:', canControl, '(guest cast:', isGuestCast, ', is admin:', isAdmin, ')');
        }

        updatePlaybackState({
            currentTime: Number(data.casting_info.current_time) || 0,
            duration: Number(data.casting_info.duration) || 0,
            isPlaying: data.casting_info.paused === true ? false : true,
            category_id: data.casting_info.category_id,
            viewKey: castingViewKey,
            viewType: castingViewType,
            viewParams: castingViewParams,
            mediaId: castingMediaId,
            media_path: data.casting_info.media_path,
            thumbnail_url: data.casting_info.thumbnail_url,
            is_guest_cast: data.casting_info.is_guest_cast === true
        });

        if (!isTvPlayerModalVisible() && (data.connected || data.is_casting)) {
            const saved = restoreCastingState();
            const currentRecord = getCurrentViewerRecord(window.ragotModules.appState);
            const fallbackInfo = getCastFallbackInfo(data.casting_info);
            const serverDuration = Number(data.casting_info.duration) || 0;
            const serverCurrentTime = Number(data.casting_info.current_time) || 0;

            let mediaInfo = {
                title: 'Now Playing',
                thumbnailUrl: '',
                duration: serverDuration,
                currentTime: serverCurrentTime,
                mediaUrl: data.casting_info.media_path || ''
            };

            if (saved) {
                mediaInfo.title = saved.title || 'Now Playing';
                mediaInfo.thumbnailUrl = saved.thumbnailUrl || '';
                mediaInfo.duration = saved.duration || serverDuration || 0;
                mediaInfo.currentTime = saved.currentTime || serverCurrentTime || 0;
                mediaInfo.mediaUrl = saved.mediaUrl || mediaInfo.mediaUrl;
                if (!mediaInfo.thumbnailUrl && fallbackInfo.thumbnailUrl) {
                    mediaInfo.thumbnailUrl = fallbackInfo.thumbnailUrl;
                }
                if (!mediaInfo.title || mediaInfo.title === 'Now Playing') {
                    mediaInfo.title = fallbackInfo.title || mediaInfo.title;
                }
            } else if (currentRecord && (!castingMediaId || currentRecord.id === castingMediaId)) {
                const file = currentRecord;
                mediaInfo.title = file.name || 'Now Playing';
                mediaInfo.thumbnailUrl = file.thumbnailUrl || file.url;
                mediaInfo.duration = file.duration || serverDuration || 0;
                mediaInfo.mediaUrl = file.url || mediaInfo.mediaUrl;
            } else if (fallbackInfo.title || fallbackInfo.thumbnailUrl) {
                mediaInfo.title = fallbackInfo.title || mediaInfo.title;
                mediaInfo.thumbnailUrl = fallbackInfo.thumbnailUrl || mediaInfo.thumbnailUrl;
                mediaInfo.duration = serverDuration || mediaInfo.duration || 0;
                mediaInfo.currentTime = serverCurrentTime || mediaInfo.currentTime || 0;
            }

            showTvPlayerModal({
                ...mediaInfo,
                startTime: mediaInfo.currentTime || 0,
                mediaUrl: mediaInfo.mediaUrl || data.casting_info.media_path || '',
                viewKey: castingViewKey,
                viewType: castingViewType,
                viewParams: castingViewParams,
                categoryId: castingCategoryId,
                mediaId: castingMediaId,
                connected: data.connected === true,
                isBooting: kioskBooting === true,
                loading: kioskBooting === true || data.connected !== true
            });
            currentMediaTitle = mediaInfo.title;
            currentThumbnailUrl = mediaInfo.thumbnailUrl;
            currentDuration = mediaInfo.duration;
            currentMediaUrl = mediaInfo.mediaUrl || data.casting_info.media_path || '';
            saveCastingState({
                ...mediaInfo,
                currentTime: mediaInfo.currentTime || serverCurrentTime || 0
            });
        } else if (isTvPlayerModalVisible()) {
            updateConnectionStatus({ connected: data.connected === true, isBooting: kioskBooting === true });
        }
    } else if (!data.is_casting && isCasting) {
        console.log('[TV Cast] Server reports casting stopped');
        resetCastingState();
    }

    updateCastButtonVisibility();
    updateCastButtonState();
}

function handleTvPlaybackState(data) {
    if (!isCasting || !data) return;
    kioskBooting = false;
    hideKioskBootNotification();
    flushInitialPlaybackSync('tv_playback_state');
    updateConnectionStatus({ connected: true, isBooting: false });

    const nextTime = Number(data.currentTime);
    const nextDuration = Number(data.duration);
    if (isFinite(nextTime) && nextTime >= 0) {
        currentPlaybackTime = nextTime;
    }
    if (isFinite(nextDuration) && nextDuration > 0) {
        currentDuration = nextDuration;
    }

    if (data.thumbnailUrl && !currentThumbnailUrl) currentThumbnailUrl = data.thumbnailUrl;
    if (data.thumbnail_url && !currentThumbnailUrl) currentThumbnailUrl = data.thumbnail_url;
    if (data.media_path && !currentMediaUrl) currentMediaUrl = data.media_path;

    saveCastingState({
        title: currentMediaTitle || 'Now Playing',
        thumbnailUrl: currentThumbnailUrl || '',
        duration: currentDuration || 0,
        currentTime: isFinite(nextTime) && nextTime >= 0 ? nextTime : 0,
        mediaUrl: currentMediaUrl || ''
    });
}

function handleKioskBooting(data) {
    console.log('Kiosk boot started:', data);
    kioskBooting = true;
    showKioskBootNotification(
        data.message || 'Starting TV kiosk... This may take a few seconds.',
        data.estimated_time || 3
    );
    updateConnectionStatus({ connected: false, isBooting: true });
}

function handleKioskBootComplete(data) {
    console.log('Kiosk boot completed:', data);
    if (castStopRequested) {
        hideKioskBootNotification();
        if (socket) socket.emit(TV_EVENTS.TV_STOP_CASTING, getStopCastPayload());
        resetCastingState({ preserveStopRequest: true });
        return;
    }
    kioskBooting = false;
    hideKioskBootNotification();
    flushInitialPlaybackSync('kiosk_boot_complete');
    updateConnectionStatus({ connected: true, isBooting: false });

    if (isCasting && !isTvPlayerModalVisible() && currentMediaUrl) {
        const mediaInfo = {
            title: currentMediaTitle || 'Now Playing',
            thumbnailUrl: currentThumbnailUrl || '',
            duration: currentDuration || 0,
            startTime: 0,
            currentTime: 0,
            mediaUrl: currentMediaUrl,
            viewKey: castingViewKey,
            viewType: castingViewType,
            viewParams: castingViewParams,
            categoryId: castingCategoryId,
            mediaId: castingMediaId,
            connected: true,
            isBooting: false,
            loading: false
        };
        showTvPlayerModal(mediaInfo);
        setControlPermission(true);
        saveCastingState(mediaInfo);
    }
}

function handleKioskBootTimeout(data) {
    console.error('Kiosk boot timeout:', data);
    kioskBooting = false;
    hideKioskBootNotification();
    resetCastingState();
    showCastNotification(
        data.message || 'Kiosk boot timed out. Please check HDMI connection.',
        true
    );
    updateConnectionStatus({ connected: false, isBooting: false });
}

function handleCastSuccess(data) {
    console.log('Cast successful:', data.message);
    if (castStopRequested) {
        if (socket) socket.emit(TV_EVENTS.TV_STOP_CASTING, getStopCastPayload());
        resetCastingState({ preserveStopRequest: true });
        return;
    }
    isCasting = true;
    hideTvKioskStatus();
    flushInitialPlaybackSync('cast_success');
    updateCastButtonState();
}

function handleTvError(data) {
    console.error('TV cast error:', data.message);
    resetCastingState();
    showCastNotification(data.message || 'Cast error', true);
}

function handleHdmiStatus(data) {
    console.log('Received HDMI status:', data);
    hdmiConnected = data.connected;
    kioskRunning = data.kiosk_running || false;
    updateCastButtonVisibility();
    updateCastButtonState();
}

function handleKioskStatus(data) {
    console.log('[TV Cast] Received kiosk status:', data);
    kioskRunning = data.running;

    if (shutdownCountdown) {
        clearTvCastInterval(shutdownCountdown);
        shutdownCountdown = null;
    }

    if (data.casting || data.idle_mode) {
        hideTvKioskStatus();
    } else if (data.shutdown_in !== undefined && data.shutdown_in !== null && !data.casting) {
        showKioskShutdownCountdown(data.shutdown_in);
    } else if (data.reason === 'inactivity_timeout') {
        hideTvKioskStatus();
        showCastNotification('TV kiosk powered down (idle)', true);
    }

    updateCastButtonVisibility();
    updateCastButtonState();
}




/**
 * Check if HDMI is connected and get kiosk status
 */
function checkHdmiStatus() {
    // Use the internal API endpoint
    fetch('/api/hdmi/status')
        .then(response => response.json())
        .then(data => {
            console.log('[TV Cast] HDMI status:', data);
            hdmiConnected = data.connected;
            kioskRunning = data.kiosk_running || false;

            // If there's a pending shutdown countdown, show it
            if (data.in_shutdown_countdown && data.shutdown_remaining && kioskRunning && !isCasting) {
                showKioskShutdownCountdown(data.shutdown_remaining);
            } else if (data.in_idle_mode && kioskRunning && !isCasting) {
                // In idle mode - kiosk running but waiting for activity
                console.log('[TV Cast] Kiosk in idle mode, waiting before shutdown');
            }

            updateCastButtonVisibility();
            updateCastButtonState();
        })
        .catch(error => {
            console.error('Error checking HDMI status:', error);
            // Don't change hdmiConnected on error - keep previous state
        });
}

/**
 * Show notification that kiosk shutdown is pending (after page refresh)
 */
function showPendingShutdownNotification() {
    // Only show once per session
    if (pendingShutdownNotified) return;
    pendingShutdownNotified = true;
    toast.info('TV kiosk will shut down soon (power saving)');
}

/**
 * Start periodic status checks
 */
function startStatusChecks() {
    const lifecycle = ensureTvCastLifecycle();
    if (hdmiStatusInterval) {
        lifecycle.clearInterval(hdmiStatusInterval);
    }
    hdmiStatusInterval = lifecycle.interval(checkHdmiStatus, 60000);
}

/**
 * Create a cast button in the app header
 */
function createHeaderCastButton() {
    const lifecycle = ensureTvCastLifecycle();
    if (!tvCastButtonComponent) {
        tvCastButtonComponent = new TvCastButtonComponent();
        lifecycle.adoptComponent(tvCastButtonComponent, {
            startMethod: 'start',
            stopMethod: 'stop',
            sync: (component, state) => component.syncFromModule(state)
        });
    } else {
        tvCastButtonComponent.start();
    }
    syncTvCastButtonState();
}

/**
 * Update cast button visibility based on TV/HDMI status and casting state
 * Any user can cast to TV (guests use IndexedDB, admin uses SQLite)
 */
function updateCastButtonVisibility() {
    syncTvCastButtonState();
}

/**
 * Get local progress from IndexedDB (guest only)
 * @param {string} categoryId
 * @returns {Object|null}
 */
function getGuestProgress(categoryId) {
    return getLocalProgress(categoryId);
}

/**
 * Fetch per-video progress from server
 * @param {string} videoPath
 * @returns {Promise<Object|null>}
 */
async function fetchVideoProgress(videoPath) {
    try {
        const response = await fetch(`/api/progress/video?video_path=${encodeURIComponent(videoPath)}`);
        if (response.ok) {
            const data = await response.json();
            return data;
        }
    } catch (e) {
        console.warn('Failed to fetch video progress:', e);
    }
    return null;
}

/**
 * Cast media to the TV display
 * @param {Object} file - The media file to cast (needs url and optionally type, name)
 */
async function castMediaToTv(file) {
    if (!socket) {
        console.error('Cannot cast to TV: socket not available');
        return;
    }

    castStopRequested = false;

    // CRITICAL: Clear all old state BEFORE starting new cast
    // This prevents state bleed from previous cast
    currentMediaTitle = '';
    currentThumbnailUrl = '';
    currentDuration = 0;
    currentMediaUrl = '';
    currentPlaybackTime = 0;
    clearPendingMediaWait();

    // We now allow casting even if the TV isn't connected yet
    // The server will start the kiosk and the TV will pick up the cast upon connection
    if (!isTvConnected && !hdmiConnected) {
        console.warn('Casting while TV/HDMI not detected - attempting to start kiosk');
    }

    if (!file || !file.url) {
        console.error('Cannot cast to TV: invalid file object', file);
        return;
    }

    console.log('Casting media to TV:', file);

    // Use file.type if available, otherwise detect from URL
    let mediaType = file.type;
    if (!mediaType || (mediaType !== 'video' && mediaType !== 'image')) {
        // Fallback: detect from URL extension
        mediaType = /\.(mp4|webm|mov|mkv|avi)$/i.test(file.url) ? 'video' : 'image';
    }

    const identity = getCanonicalCastIdentity(file);
    if (!identity) {
        showCastNotification('Cannot cast without active media view', true);
        return;
    }
    const { viewKey, viewType, viewParams, categoryId, mediaId } = identity;

    // Store casting state for progress blocking
    castingViewKey = viewKey;
    castingViewType = viewType;
    castingViewParams = viewParams;
    castingCategoryId = categoryId;
    castingMediaId = mediaId;

    // Determine starting position for TV playback
    let startTime = 0;
    let resumeDuration = 0;
    let hasActiveVideoTime = false;
    let initialPlaybackAction = null;
    const usingProfileProgress = hasActiveProfile();

    if (mediaType === 'video') {
        const activeVideo = getActiveVideoElement();
        if (activeVideo && isFinite(activeVideo.currentTime) && !activeVideo.seeking) {
            const actualTime = getActualVideoPosition(activeVideo);
            const hasPlayableState = activeVideo.readyState >= 2 && (actualTime > 0 || !activeVideo.paused);
            if (isFinite(actualTime) && hasPlayableState) {
                startTime = Math.max(0, actualTime);
                hasActiveVideoTime = true;
                initialPlaybackAction = activeVideo.paused ? 'pause' : 'play';
                console.log(`[TV Cast] Priority 0: Using active video time: ${startTime}s (paused: ${activeVideo.paused})`);
            }
        }
    }

    if (mediaType === 'video') {
        // Priority 1: Check in-memory video timestamp scoped to the active media id.
        const savedCategoryId = window.ragotModules.appState?.savedVideoCategoryId;
        const savedTimestamp = window.ragotModules.appState?.savedVideoTimestamp;
        if (!hasActiveVideoTime && typeof savedTimestamp === 'number' && savedTimestamp > 0 &&
            savedCategoryId === categoryId) {
            startTime = savedTimestamp;
            console.log(`[TV Cast] Priority 1: Using savedVideoTimestamp: ${startTime}s for ${categoryId}:${mediaId}`);
        }

        // Priority 2: Fetch per-video progress for the active profile.
        // Guest mode falls back to local IndexedDB instead.
        if (!hasActiveVideoTime && startTime === 0 && file.url && usingProfileProgress) {
            const videoProgress = await fetchVideoProgress(file.url);
            if (videoProgress && videoProgress.video_timestamp > 0) {
                startTime = videoProgress.video_timestamp;
                if (videoProgress.video_duration && videoProgress.video_duration > 0) {
                    resumeDuration = videoProgress.video_duration;
                }
                console.log(`[TV Cast] Priority 2: Using per-video progress: ${startTime}s for ${file.url}`);
            }
        }

        // Priority 3: Look in local IndexedDB for Guest mode.
        if (!hasActiveVideoTime && startTime === 0) {
            // Check video-level first
            if (file.url) {
                const videoLocalProgress = getVideoLocalProgress(file.url);
                if (videoLocalProgress && videoLocalProgress.video_timestamp > 0) {
                    startTime = videoLocalProgress.video_timestamp;
                    if (videoLocalProgress.video_duration && videoLocalProgress.video_duration > 0) {
                        resumeDuration = videoLocalProgress.video_duration;
                    }
                    console.log(`[TV Cast] Priority 4: Using local video progress: ${startTime}s`);
                }
            }

            // Then category-level
            if (startTime === 0 && categoryId) {
                const categoryLocalProgress = getGuestProgress(categoryId);
                if (categoryLocalProgress && categoryLocalProgress.video_timestamp > 0) {
                    startTime = categoryLocalProgress.video_timestamp;
                    if (categoryLocalProgress.video_duration && categoryLocalProgress.video_duration > 0) {
                        resumeDuration = categoryLocalProgress.video_duration;
                    }
                    console.log(`[TV Cast] Priority 4: Using local category progress: ${startTime}s`);
                }
            }
        }
    }

    // Determine duration for modal + TV state (prefer finite duration)
    let videoDuration = 0;
    if (mediaType === 'video') {
        // Use resume duration if we have it (progress store is authoritative for HLS)
        if (resumeDuration && isFinite(resumeDuration) && resumeDuration > 0) {
            videoDuration = resumeDuration;
        }

        // Prefer the active video element if it exposes a finite duration
        const videoEl = getActiveVideoElement();
        if (videoEl && isFinite(videoEl.duration) && videoEl.duration > 0) {
            videoDuration = videoEl.duration;
        }

        // Fall back to file.duration if present (some feeds include it)
        if ((!videoDuration || videoDuration <= 0) && isFinite(file.duration) && file.duration > 0) {
            videoDuration = file.duration;
        }
    }

    // Prepare data for casting - include start_time for resume
    const castData = {
        media_type: mediaType,
        media_path: file.url,
        loop: true,
        viewKey,
        viewType,
        viewParams,
        mediaId,
        category_id: categoryId,
        thumbnail_url: file.thumbnailUrl || file.url,
        start_time: parseFloat(startTime.toFixed(2)),  // TV will seek to this position
        duration: videoDuration
    };

    if (mediaType === 'video' && initialPlaybackAction) {
        queueInitialPlaybackSync(initialPlaybackAction, startTime);
    }

    // CRITICAL FIX: Fetch subtitles BEFORE casting so they arrive with the video
    // Previously, subtitles were fetched async after cast, causing race conditions
    // where subtitles arrived after video started playing
    if (mediaType === 'video' && window.ragotModules?.appStore?.get?.('config', {})?.ENABLE_SUBTITLES) {
        try {
            console.log('[TV Cast] Fetching subtitles before cast...');
            const response = await fetch(`/api/subtitles/video?video_url=${encodeURIComponent(file.url)}`);
            const subtitles = await response.json();

            if (subtitles && subtitles.length > 0) {
                // Find first supported subtitle (prefer default)
                const supportedSubs = subtitles.filter(s => s.supported !== false && s.url);
                if (supportedSubs.length > 0) {
                    const defaultSub = supportedSubs.find(s => s.default) || supportedSubs[0];
                    // Include subtitle URL in cast data - TV runtime will load it with the video
                    // Use relative URL - TV runtime will prepend server URL
                    castData.subtitle_url = defaultSub.url;
                    castData.subtitle_label = defaultSub.label;
                    console.log(`[TV Cast] Including subtitle in cast: ${defaultSub.label}`);
                }
            }
        } catch (err) {
            console.warn('[TV Cast] Failed to fetch subtitles (continuing without):', err);
            // Continue casting without subtitles - don't block the cast
        }
    }

    console.log(`[TV Cast] Initiating cast with start_time: ${castData.start_time}s`);

    // Send the cast event to the server
    socket.emit(TV_EVENTS.CAST_MEDIA_TO_TV, castData);
    if (pendingPlaybackSync) {
        if (postCastSyncTimeout) {
            clearTvCastTimeout(postCastSyncTimeout);
        }
        postCastSyncTimeout = ensureTvCastLifecycle().timeout(() => {
            flushInitialPlaybackSync('post-cast delay');
        }, 300);
    }

    // Track casting state
    isCasting = true;
    isCastInitiator = true; // This client initiated the cast - prevents tv_status_update from hiding modal
    kioskBooting = !isTvConnected;
    clearPendingMediaWait();

    // Clear old sessionStorage to prevent stale start time from previous cast
    sessionStorage.removeItem(TV_CAST_STORAGE_KEY);

    // CRITICAL: Hide modal if it's already showing (prevents duplicate displays)
    if (isTvPlayerModalVisible()) {
        console.log('[TV Cast] Modal already visible, updating for new cast');
        // Modal will be updated below with new media info
    }

    // CRITICAL: DO NOT sync with main video player - TV modal controls TV only
    // If casting a video, set up playback sync
    // if (mediaType === 'video') {
    //     setupVideoPlaybackSync();
    // }

    // Update header button to show casting state
    updateCastButtonState();

    // Don't show notification on cast initiate - kiosk boot notification will show if needed
    // Modal appearance is sufficient visual feedback

    // Save current media info for sessionStorage persistence (BEFORE showing modal)
    currentMediaTitle = file.name || 'Now Playing';
    currentThumbnailUrl = file.thumbnailUrl || file.url;
    currentDuration = videoDuration;
    currentMediaUrl = file.url;
    currentPlaybackTime = startTime;

    // Show modal immediately for premium feedback, even if TV is still booting
    const mediaInfo = {
        title: currentMediaTitle,
        thumbnailUrl: currentThumbnailUrl,
        duration: videoDuration,
        startTime: startTime,
        currentTime: startTime,
        mediaUrl: file.url,
        viewKey,
        viewType,
        viewParams,
        categoryId,
        mediaId,
        connected: isTvConnected,
        isBooting: !isTvConnected,
        loading: !isTvConnected
    };

    if (!isTvPlayerModalVisible()) {
        showTvPlayerModal(mediaInfo);
    } else {
        updateMediaInfo(mediaInfo);
        updateConnectionStatus({ connected: isTvConnected, isBooting: !isTvConnected });
    }

    // Controls should be enabled once TV confirms playback state
    setControlPermission(isTvConnected);
    saveCastingState(mediaInfo);
}

/**
 * Stop casting to TV
 */
function stopCasting() {
    if (!socket || !isCasting) return;

    console.log('[TV Cast] Stopping TV cast');
    castStopRequested = true;
    socket.emit(TV_EVENTS.TV_STOP_CASTING, getStopCastPayload());

    // Clean up casting state using centralized reset
    cleanupVideoPlaybackSync();
    resetCastingState({ preserveStopRequest: true });

    hideTvKioskStatus();
    toast.info('Stopped casting');
}

function getStopCastPayload() {
    return {
        currentTime: Number.isFinite(currentPlaybackTime) && currentPlaybackTime >= 0 ? currentPlaybackTime : 0,
        duration: Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 0
    };
}

/**
 * Get the currently casting category ID
 * @returns {string|null}
 */
function getCastingCategoryId() {
    return isCasting ? castingCategoryId : null;
}

/**
 * Check if admin is currently casting to this category
 * Used by other modules to block progress saves
 * @param {string} categoryId 
 * @returns {boolean}
 */
function isCastingToCategory(categoryId) {
    return isCasting && castingCategoryId === categoryId;
}

// Store bound handlers for cleanup
let boundPlayHandler = null;
let boundPauseHandler = null;
let boundSeekedHandler = null;
let modalSyncInterval = null;

/**
 * Get actual video position accounting for HLS time offset
 * @param {HTMLVideoElement} video 
 * @returns {number} Actual position in original video
 */
function getActualVideoPosition(video) {
    const hlsOffset = parseFloat(video.dataset?.hlsTimeOffset) || 0;
    return video.currentTime + hlsOffset;
}

/**
 * Set up video playback sync by attaching listeners to current video
 * CRITICAL: This is OPTIONAL - modal controls work independently
 * This only syncs the admin page video WITH the modal, not required for casting
 */
function setupVideoPlaybackSync() {
    if (!ALLOW_EXTERNAL_TV_SYNC) {
        console.log('[TV Cast] External sync disabled - modal is the only control source');
        return;
    }
    cleanupVideoPlaybackSync();

    // Find the active video element (may not exist if user navigated away)
    const video = $('.viewer-media.active video, video.viewer-media.active, #tv-video, video');
    if (video) {
        castingVideoElement = video;

        // Create bound handlers - use actual position for HLS videos
        boundPlayHandler = () => {
            if (isCasting && socket) {
                const actualTime = getActualVideoPosition(video);
                console.log('TV Cast: play event at', actualTime, '(HLS offset:', video.dataset?.hlsTimeOffset || 0, ')');
                socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'play', currentTime: actualTime });
            }
        };
        boundPauseHandler = () => {
            if (isCasting && socket) {
                const actualTime = getActualVideoPosition(video);
                console.log('TV Cast: pause event at', actualTime);
                socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'pause', currentTime: actualTime });
            }
        };
        boundSeekedHandler = () => {
            if (isCasting && socket) {
                const actualTime = getActualVideoPosition(video);
                console.log('TV Cast: seeked event at', actualTime);
                socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'seek', currentTime: actualTime });
            }
        };

        // Attach listeners via managed lifecycle
        const lifecycle = ensureTvCastLifecycle();
        lifecycle.on(video, 'play', boundPlayHandler);
        lifecycle.on(video, 'pause', boundPauseHandler);
        lifecycle.on(video, 'seeked', boundSeekedHandler);

        console.log('TV Cast: Attached managed playback listeners to video element');

        // Start periodic sync with TV player modal
        startModalSync();
    } else {
        console.log('TV Cast: No video element found (modal controls work independently)');
        // Modal still works! Its controls send events directly via socket
    }

    // Always start observer to detect video element changes during casting
    setupVideoObserver();
}

/**
 * Watch for video elements and attach listeners when found or changed
 */
let videoObserver = null;

function setupVideoObserver() {
    if (videoObserver) videoObserver.disconnect();

    videoObserver = new MutationObserver((mutations) => {
        if (!isCasting) {
            videoObserver.disconnect();
            return;
        }

        const video = $('.viewer-media.active video, video.viewer-media.active, video');
        if (video && video !== castingVideoElement) {
            console.log('TV Cast: New video element detected, re-attaching listeners');
            // Clean up old listeners but keep observer running
            if (castingVideoElement) {
                const lifecycle = ensureTvCastLifecycle();
                if (boundPlayHandler) lifecycle.off(castingVideoElement, 'play', boundPlayHandler);
                if (boundPauseHandler) lifecycle.off(castingVideoElement, 'pause', boundPauseHandler);
                if (boundSeekedHandler) lifecycle.off(castingVideoElement, 'seeked', boundSeekedHandler);
            }

            castingVideoElement = video;

            // Create new bound handlers - use actual position for HLS videos
            boundPlayHandler = () => {
                if (isCasting && socket) {
                    const actualTime = getActualVideoPosition(video);
                    console.log('TV Cast: play event at', actualTime);
                    socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'play', currentTime: actualTime });
                }
            };
            boundPauseHandler = () => {
                if (isCasting && socket) {
                    const actualTime = getActualVideoPosition(video);
                    console.log('TV Cast: pause event at', actualTime);
                    socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'pause', currentTime: actualTime });
                }
            };
            boundSeekedHandler = () => {
                if (isCasting && socket) {
                    const actualTime = getActualVideoPosition(video);
                    console.log('TV Cast: seeked event at', actualTime);
                    socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, { action: 'seek', currentTime: actualTime });
                }
            };

            const lifecycle = ensureTvCastLifecycle();
            lifecycle.on(video, 'play', boundPlayHandler);
            lifecycle.on(video, 'pause', boundPauseHandler);
            lifecycle.on(video, 'seeked', boundSeekedHandler);
        }
    });

    videoObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Start periodic sync with TV player modal
 * IMPORTANT: Modal should work even without a video element (standalone controls)
 */
function startModalSync() {
    stopModalSync();

    modalSyncInterval = ensureTvCastLifecycle().interval(() => {
        // Only sync if video element exists on page
        // Modal controls work independently via socket events
        if (isCasting && castingVideoElement) {
            syncWithVideoElement(castingVideoElement);
        }
    }, 500);
}

/**
 * Stop periodic sync with TV player modal
 */
function stopModalSync() {
    if (modalSyncInterval) {
        clearTvCastInterval(modalSyncInterval);
        modalSyncInterval = null;
    }
}

/**
 * Clean up video playback sync state
 */
function cleanupVideoPlaybackSync() {
    if (castingVideoElement) {
        const lifecycle = ensureTvCastLifecycle();
        if (boundPlayHandler) lifecycle.off(castingVideoElement, 'play', boundPlayHandler);
        if (boundPauseHandler) lifecycle.off(castingVideoElement, 'pause', boundPauseHandler);
        if (boundSeekedHandler) lifecycle.off(castingVideoElement, 'seeked', boundSeekedHandler);
        console.log('TV Cast: Removed managed playback listeners from video element');
    }
    if (videoObserver) {
        videoObserver.disconnect();
        videoObserver = null;
    }
    stopModalSync();
    castingVideoElement = null;
    boundPlayHandler = null;
    boundPauseHandler = null;
    boundSeekedHandler = null;
}

/**
 * Send a playback control command to the TV
 * Caster can control their own cast
 * @param {string} action - The action: 'play', 'pause', 'seek', or 'sync'
 * @param {number} currentTime - The current playback position
 */
function sendTvPlaybackControl(action, currentTime) {
    if (!ALLOW_EXTERNAL_TV_SYNC) {
        console.log('[TV Cast] Ignoring external playback sync - modal only');
        return;
    }
    // Only caster can control their cast
    if (!isCasting || !socket) return;

    // Throttle seek events to prevent spam
    const now = Date.now();
    if (now - lastPlaybackSyncTime < PLAYBACK_SYNC_THROTTLE && action === 'seek') {
        return;
    }
    lastPlaybackSyncTime = now;

    socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, {
        action: action,
        currentTime: currentTime
    });
}

/**
 * Update the cast button to reflect casting state and kiosk status
 */
function updateCastButtonState() {
    syncTvCastButtonState();
}

/**
 * Show a notification that media is being cast to TV
 * @param {string} mediaName - Name of the media being cast
 * @param {boolean} isStopping - True if this is a stop notification
 */
function showCastNotification(mediaName, isStopping = false) {
    const message = isStopping ? mediaName : `Casting "${mediaName}" to TV Display`;
    if (!isStopping) {
        toast.success(message);
        return;
    }

    if (/(error|cannot|timed out|not ready|no media|failed)/i.test(message)) {
        toast.error(message);
        return;
    }

    toast.info(message);
}

/**
 * Show countdown notification for kiosk shutdown (power saving)
 * @param {number} seconds - Seconds until shutdown
 */
function showKioskShutdownCountdown(seconds) {
    // Clear any existing interval to prevent leaks
    if (shutdownCountdown) {
        ensureTvCastLifecycle().clearInterval(shutdownCountdown);
        shutdownCountdown = null;
    }

    let remaining = seconds;
    showTvKioskStatus('TV kiosk idle', `Shutting down in ${remaining}s (power saving)`, {
        tone: 'warning',
        busy: false
    });

    // Update countdown
    shutdownCountdown = ensureTvCastLifecycle().interval(() => {
        remaining--;
        if (remaining <= 0) {
            ensureTvCastLifecycle().clearInterval(shutdownCountdown);
            shutdownCountdown = null;
            hideTvKioskStatus();
        } else {
            showTvKioskStatus('TV kiosk idle', `Shutting down in ${remaining}s (power saving)`, {
                tone: 'warning',
                busy: false
            });
        }
    }, 1000);
}

/**
 * Shows a notification that kiosk is booting up
 * Bottom notification matching shutdown countdown style
 * @param {string} message - Message to display
 * @param {number} estimatedTime - Estimated boot time in seconds
 */
function showKioskBootNotification(message, estimatedTime = 3) {
    // Remove existing notification if any
    hideKioskBootNotification();

    kioskBooting = true;
    if (isCasting || isCastInitiator) {
        return;
    }
    showTvKioskStatus('Starting TV kiosk', message, { tone: 'info', busy: true });

    // Set timeout in case boot takes too long
    bootTimeoutTimer = ensureTvCastLifecycle().timeout(() => {
        if (kioskBooting) {
            console.warn('[TV Cast] Kiosk boot notification local timeout reached');
            hideKioskBootNotification();
        }
    }, 15000);  // 15 seconds absolute maximum for UI notification
}


/**
 * Updates the boot notification message
 */
function updateBootNotificationMessage(message) {
    if (!kioskBooting) return;
    showTvKioskStatus('Starting TV kiosk', message, { tone: 'info', busy: true });
}

/**
 * Hides the boot notification
 */
function hideKioskBootNotification() {
    kioskBooting = false;

    if (bootTimeoutTimer) {
        clearTvCastTimeout(bootTimeoutTimer);
        bootTimeoutTimer = null;
    }

    hideTvKioskStatus();
}

/**
 * Check if currently casting to TV
 * @returns {boolean}
 */
function isCastingToTv() {
    return isCasting;
}

/**
 * Refresh cast button visibility - called by adminController after config update
 */
function refreshCastButtonVisibility() {
    console.log('[TV Cast] refreshCastButtonVisibility called, buttonExists:', !!headerCastButton);

    // Guard: button might not exist yet during early initialization
    if (!headerCastButton) {
        console.log('[TV Cast] Button not created yet, skipping refresh');
        return;
    }

    updateCastButtonVisibility();
    updateCastButtonState();

    // Request TV status to get current casting state
    requestTvStatus();
}

function destroyTvCastManager() {
    if (tvCastButtonComponent) {
        tvCastButtonComponent.stop();
        tvCastButtonComponent = null;
    }
    if (tvCastLifecycle) {
        tvCastLifecycle.stop();
        tvCastLifecycle = null;
    } else {
        teardownSocketListeners();
        cleanupVideoPlaybackSync();
        clearPendingMediaWait();
        hideKioskBootNotification();
        socket = null;
    }
}

export {
    createTvCastUI,
    initTvCastManager,
    castMediaToTv,
    stopCasting,
    sendTvPlaybackControl,
    isCastingToTv,
    getCastingCategoryId,
    isCastingToCategory,
    refreshCastButtonVisibility,
    destroyTvCastManager
};
