/**
 * TV Player Modal Module
 * ----------------------
 * iOS-themed compact playback control modal for TV casting
 * Appears at top of screen when casting to TV
 */

import { xIcon, playIcon, rotateIcon } from '../../utils/icons.js';
import { Module, createElement, attr, $ } from '../../libs/ragot.esm.min.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { TV_EVENTS } from '../../core/socketEvents.js';
import { createFocusTrap } from '../../utils/focusTrap.js';
import { getCurrentViewerRecord, getViewerSession } from '../media/viewerState.js';
import { selectIndexOf, selectParams, selectRecordAt, selectView } from '../media/selectors.js';

// Module state
let socket = null;
let modalElement = null;
let isInitialized = false;
let isVisible = false;
let isMinimized = false;
let isDragging = false;
let canControl = true;
let socketListenersAttached = false;
let onTvPlaybackState = null;
let isLoading = false;
let hasReceivedFirstState = false;

// Seek debounce constants
const SEEK_DEBOUNCE_MS = 4000;
let lastSeekSentTime = 0;

// Playback state
let currentTime = 0;
let duration = 0;
let isPlaying = false;

// Stored cast info for guest sync fallback (independent of window.ragotModules.appState)
let storedCastInfo = {
    viewKey: null,
    viewType: null,
    viewParams: {},
    categoryId: null,
    mediaId: null,
    mediaUrl: null,
    thumbnailUrl: null
};

function resetStoredCastInfo() {
    storedCastInfo = {
        viewKey: null,
        viewType: null,
        viewParams: {},
        categoryId: null,
        mediaId: null,
        mediaUrl: null,
        thumbnailUrl: null
    };
}

// DOM element references
let thumbnailEl = null;
let titleEl = null;
let currentTimeEl = null;
let durationEl = null;
let progressFillEl = null;
let progressHandleEl = null;
let progressBarEl = null;
let playPauseBtn = null;
let playPauseSvg = null;
let subtitleEl = null;
let syncProgressBtn = null;
const managedTimeouts = new Set();
let modalFocusTrap = null;
let modalReturnFocusEl = null;

const ORDER_APPEND_GUARD = 20;

function normalizeViewParams(params) {
    return params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
}

function mergeStoredCastInfo(info = {}) {
    if (!info || typeof info !== 'object') return storedCastInfo;

    if (info.viewKey) storedCastInfo.viewKey = info.viewKey;
    if (info.viewType) storedCastInfo.viewType = info.viewType;
    if (info.viewParams !== undefined) storedCastInfo.viewParams = normalizeViewParams(info.viewParams);
    if (info.categoryId !== undefined) storedCastInfo.categoryId = info.categoryId;
    if (info.category_id !== undefined) storedCastInfo.categoryId = info.category_id;
    if (info.mediaId) storedCastInfo.mediaId = info.mediaId;
    if (info.mediaUrl) storedCastInfo.mediaUrl = info.mediaUrl;
    if (info.media_path) storedCastInfo.mediaUrl = info.media_path;
    if (info.thumbnailUrl) storedCastInfo.thumbnailUrl = info.thumbnailUrl;
    if (info.thumbnail_url) storedCastInfo.thumbnailUrl = info.thumbnail_url;

    return storedCastInfo;
}

function getCurrentViewerCastInfo() {
    const appState = window.ragotModules?.appState;
    const viewer = getViewerSession(appState);
    const view = viewer?.viewKey ? selectView(viewer.viewKey) : null;
    const currentMedia = getCurrentViewerRecord(appState);

    return {
        viewKey: viewer?.viewKey || null,
        viewType: view?.viewType || null,
        viewParams: viewer?.viewKey ? selectParams(viewer.viewKey) : {},
        categoryId: appState?.currentCategoryId || null,
        mediaId: currentMedia?.id || null,
        mediaUrl: currentMedia?.url || null,
        thumbnailUrl: currentMedia?.thumbnailUrl || null
    };
}

function mergeCurrentViewerFallback() {
    const fallback = getCurrentViewerCastInfo();
    mergeStoredCastInfo({
        viewKey: storedCastInfo.viewKey || fallback.viewKey,
        viewType: storedCastInfo.viewType || fallback.viewType,
        viewParams: Object.keys(storedCastInfo.viewParams || {}).length > 0
            ? storedCastInfo.viewParams
            : fallback.viewParams,
        categoryId: storedCastInfo.categoryId || fallback.categoryId,
        mediaId: storedCastInfo.mediaId || fallback.mediaId,
        mediaUrl: storedCastInfo.mediaUrl || fallback.mediaUrl,
        thumbnailUrl: storedCastInfo.thumbnailUrl || fallback.thumbnailUrl
    });
}

async function resolveStoredCastRecord() {
    mergeCurrentViewerFallback();

    const { viewKey, viewType, viewParams, mediaId } = storedCastInfo;
    const manifest = window.ragotModules?.mediaManifest;
    if (!mediaId || !manifest) {
        return storedCastInfo;
    }

    try {
        await manifest.hydrate([mediaId]);
        const record = manifest.get(mediaId);
        if (record) {
            mergeStoredCastInfo({
                mediaUrl: record.url,
                thumbnailUrl: record.thumbnailUrl || record.url
            });
        }
    } catch (error) {
        console.warn('[TV Player Modal] Failed to hydrate cast record', error);
    }

    return storedCastInfo;
}

function scheduleModalTimeout(callback, delayMs) {
    const timeoutId = tvPlayerModalLifecycle
        ? tvPlayerModalLifecycle.timeout(() => {
            managedTimeouts.delete(timeoutId);
            callback();
        }, delayMs)
        : setTimeout(() => {
            managedTimeouts.delete(timeoutId);
            callback();
        }, delayMs);
    managedTimeouts.add(timeoutId);
    return timeoutId;
}

function clearManagedTimeouts() {
    for (const timeoutId of managedTimeouts) {
        if (tvPlayerModalLifecycle) {
            tvPlayerModalLifecycle.clearTimeout(timeoutId);
        } else {
            clearTimeout(timeoutId);
        }
    }
    managedTimeouts.clear();
}

class TvPlayerModalLifecycle extends Module {
    onStart() {
        if (!modalElement) return;

        const closeBtn = $('.tv-player-btn-close', modalElement);
        if (closeBtn) this.on(closeBtn, 'click', handleClose, true);
        this.on(modalElement, 'click', handleModalClick);
        this.on(modalElement, 'touchstart', handleMinimizedTouch, { passive: false });
        if (playPauseBtn) this.on(playPauseBtn, 'click', handlePlayPause);

        if (syncProgressBtn) {
            this.on(syncProgressBtn, 'click', handleSyncProgress);
        }

        if (progressBarEl) {
            this.on(progressBarEl, 'mousedown', handleScrubStart);
            this.on(progressBarEl, 'touchstart', handleScrubStart, { passive: false });
        }

        this.on(document, 'mousemove', handleScrubMove);
        this.on(document, 'touchmove', handleScrubMove, { passive: false });
        this.on(document, 'mouseup', handleScrubEnd);
        this.on(document, 'touchend', handleScrubEnd);
        this.on(document, 'touchcancel', handleScrubCancel);
        this.on(document, 'pointercancel', handleScrubCancel);
        this.on(document, 'keydown', handleModalKeyDown);
    }

    onStop() {
        clearManagedTimeouts();
        stopProgressTracking();
        cleanupSocketListeners();
    }
}

let tvPlayerModalLifecycle = null;

/**
 * Initialize the TV player modal
 * @param {Object} socketInstance - Socket.IO instance
 */
function initTvPlayerModal(socketInstance) {
    console.log('[TV Player Modal] Initializing');
    if (isInitialized) {
        if (socket !== socketInstance) {
            cleanupSocketListeners();
            socket = socketInstance;
            setupSocketListeners();
        }
        return;
    }

    socket = socketInstance;

    createModalElement();
    setupEventListeners();
    isInitialized = true;
}

/**
 * Create the modal DOM structure
 */
function createModalElement() {
    // Check if modal already exists
    if ($('#tv-player-modal')) {
        modalElement = $('#tv-player-modal');
        cacheElementReferences();
        return;
    }

    // Create modal container
    modalElement = createElement('div', {
        id: 'tv-player-modal',
        className: 'tv-player-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'TV playback controls',
        innerHTML: `
        <button class="tv-player-btn tv-player-btn-close" aria-label="Stop casting" title="Stop Casting" data-gh-tooltip="Stop Casting">
            ${xIcon()}
        </button>

        <div class="tv-player-header">
            <img class="tv-player-thumbnail" src="" alt="Media thumbnail">
            <div class="tv-player-info">
                <div class="tv-player-title">Not playing</div>
                <div class="tv-player-subtitle">
                    <span class="tv-player-live-indicator">
                        <span class="tv-player-live-dot"></span>
                        Casting to TV
                    </span>
                </div>
            </div>
        </div>

        <div class="tv-player-controls">
            <div class="tv-player-scrubber">
                <div class="tv-player-progress-bar">
                    <div class="tv-player-progress-fill"></div>
                    <div class="tv-player-progress-handle"></div>
                </div>
                <div class="tv-player-time-display">
                    <span class="tv-player-current-time">0:00</span>
                    <span class="tv-player-duration">0:00</span>
                </div>
            </div>

            <div class="tv-player-buttons">
                <button class="tv-player-btn tv-player-btn-play-pause" aria-label="Play or pause TV playback" title="Play or Pause" data-gh-tooltip="Play or Pause">
                    <span class="tv-player-loading-spinner" aria-hidden="true"></span>
                    ${playIcon(24, null, 'currentColor')}
                </button>
                <button class="tv-player-btn tv-player-btn-sync-progress" aria-label="Sync Progress" style="display: none;" title="Save current progress to continue watching" data-gh-tooltip="Save Progress">
                    ${rotateIcon(24)}
                </button>
            </div>
        </div>
    ` });

    document.body.appendChild(modalElement);
    cacheElementReferences();

    // CRITICAL: Prevent touch events from passing through modal on mobile
    preventTouchPassthrough();
}

/**
 * Prevent touch events from passing through the modal to content below
 * CRITICAL: Prevent browser swipe navigation gestures on progress bar
 */
function preventTouchPassthrough() {
    if (!modalElement || !tvPlayerModalLifecycle) return;

    // Block ALL touch events on modal from passing through
    tvPlayerModalLifecycle.on(modalElement, 'touchstart', (e) => {
        e.stopPropagation();
    }, { passive: true });

    tvPlayerModalLifecycle.on(modalElement, 'touchmove', (e) => {
        // Allow scrubbing on progress bar
        if (e.target.closest('.tv-player-progress-bar')) {
            return;
        }

        // CRITICAL: Prevent browser swipe gestures (back/forward navigation)
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false }); // passive: false allows preventDefault()

    tvPlayerModalLifecycle.on(modalElement, 'touchcancel', (e) => {
        e.stopPropagation();
    }, { passive: true });
}

/**
 * Cache DOM element references for performance
 */
function cacheElementReferences() {
    thumbnailEl = $('.tv-player-thumbnail', modalElement);
    titleEl = $('.tv-player-title', modalElement);
    subtitleEl = $('.tv-player-subtitle', modalElement);
    currentTimeEl = $('.tv-player-current-time', modalElement);
    durationEl = $('.tv-player-duration', modalElement);
    progressFillEl = $('.tv-player-progress-fill', modalElement);
    progressHandleEl = $('.tv-player-progress-handle', modalElement);
    progressBarEl = $('.tv-player-progress-bar', modalElement);
    playPauseBtn = $('.tv-player-btn-play-pause', modalElement);
    playPauseSvg = $('svg', playPauseBtn);
    syncProgressBtn = $('.tv-player-btn-sync-progress', modalElement);
}

/**
 * Update subtitle text and spinning indicator based on TV connection state
 * @param {boolean} connected
 * @param {boolean} isBooting
 */
function updateSubtitleState(connected, isBooting) {
    if (!subtitleEl) return;

    if (isBooting || !connected) {
        subtitleEl.innerHTML = `
            <span class="tv-player-live-indicator" style="color: var(--text-secondary);">
                <span class="tv-player-subtitle-spinner" aria-hidden="true"></span>
                Starting TV...
            </span>
        `;
    } else if (!hasReceivedFirstState) {
        subtitleEl.innerHTML = `
            <span class="tv-player-live-indicator" style="color: var(--text-secondary);">
                <span class="tv-player-subtitle-spinner" aria-hidden="true"></span>
                Loading media...
            </span>
        `;
    } else {
        subtitleEl.innerHTML = `
            <span class="tv-player-live-indicator">
                <span class="tv-player-live-dot"></span>
                Casting to TV
            </span>
        `;
    }
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
    if (!tvPlayerModalLifecycle) {
        tvPlayerModalLifecycle = new TvPlayerModalLifecycle();
    }
    tvPlayerModalLifecycle.start();

    // Socket events (will be set up when socket is available)
    if (socket) {
        setupSocketListeners();
    }
}

/**
 * Handle clicks/taps on the modal (for restoring from minimized state)
 * @param {MouseEvent|TouchEvent} e
 */
function handleModalClick(e) {
    // Only restore if minimized
    if (!isMinimized) return;

    // Don't restore if clicking close button (prevent stopping cast accidentally)
    if (e.target.closest('.tv-player-btn-close')) {
        return;
    }

    // CRITICAL: Stop propagation so click doesn't bubble to other handlers
    e.stopPropagation();
    e.preventDefault();

    console.log('[TV Player Modal] Restoring from minimized state');
    restoreTvPlayerModal();
}

/**
 * Handle touch start on minimized modal (for better mobile responsiveness)
 * @param {TouchEvent} e
 */
function handleMinimizedTouch(e) {
    // Only handle if minimized
    if (!isMinimized) return;

    // Don't restore if touching close button
    if (e.target.closest('.tv-player-btn-close')) {
        return;
    }

    // Stop propagation to prevent other touch handlers
    e.stopPropagation();

    console.log('[TV Player Modal] Touch on minimized modal - preparing to restore');
}

/**
 * Set up socket event listeners
 */
function setupSocketListeners() {
    if (!socket || socketListenersAttached) return;
    if (!tvPlayerModalLifecycle) return;

    // Listen for playback state updates from server
    onTvPlaybackState = (data) => {
        console.log('[TV Player Modal] Received playback state:', data);
        updatePlaybackState(data);
    };
    tvPlayerModalLifecycle.onSocket(socket, TV_EVENTS.TV_PLAYBACK_STATE, onTvPlaybackState);

    socketListenersAttached = true;
}

function cleanupSocketListeners() {
    if (!socket || !socketListenersAttached) return;

    if (onTvPlaybackState && tvPlayerModalLifecycle) {
        tvPlayerModalLifecycle.offSocket(socket, TV_EVENTS.TV_PLAYBACK_STATE, onTvPlaybackState);
    }

    onTvPlaybackState = null;
    socketListenersAttached = false;
}

/**
 * Show the modal with media info
 * @param {Object} options - Media options
 * @param {string} options.title - Media title
 * @param {string} options.thumbnailUrl - Thumbnail URL
 * @param {number} options.duration - Media duration in seconds
 * @param {number} options.startTime - Starting position in seconds
 */
function showTvPlayerModal(options = {}) {
    console.log('[TV Player Modal] Showing modal:', options);
    modalReturnFocusEl = document.activeElement;

    const title = options.title || 'Now Playing';
    const thumbnailUrl = options.thumbnailUrl || '';
    duration = options.duration || 0;
    currentTime = options.startTime || 0;
    isPlaying = false; // FIXED: Don't assume playing until TV confirms
    
    // Reset first state flag and always start in loading/waiting mode until TV responds
    hasReceivedFirstState = false;
    setModalLoading(true);

    // Populate canonical cast identity first so restore/sync does not depend on active viewer state.
    mergeStoredCastInfo({
        ...options,
        thumbnailUrl: options.thumbnailUrl || thumbnailUrl
    });
    console.log('[TV Player Modal] Stored cast info from options:', storedCastInfo);

    // Fallback to window.ragotModules.appState (for non-restoration cases)
    if (window.ragotModules.appState && (!storedCastInfo.viewKey || !storedCastInfo.mediaId)) {
        mergeCurrentViewerFallback();
        console.log('[TV Player Modal] Stored cast info from window.ragotModules.appState:', storedCastInfo);
    }

    // Update DOM
    titleEl.textContent = title;
    thumbnailEl.src = thumbnailUrl;
    attr(thumbnailEl, {
        onError: () => {
            console.warn('[TV Player Modal] Thumbnail failed to load:', thumbnailUrl);
            attr(thumbnailEl, { onError: null });
            thumbnailEl.src = '/static/icons/Ghosthub192.png';
        }
    });
    durationEl.textContent = formatTime(duration);
    currentTimeEl.textContent = formatTime(currentTime);

    updateProgressBar();
    updatePlayPauseIcon(true);
    updateSyncButtonVisibility(); // Ensure sync button visibility is set on show

    // Show modal with animation
    scheduleModalTimeout(() => {
        modalElement.classList.add('visible');
        isVisible = true;
        activateModalFocusTrap();

        // Show connecting status if needed
        updateSubtitleState(options.connected !== false, options.isBooting === true);
    }, 50);

    // DO NOT start progress tracking here - wait for TV to confirm playback
    // Progress tracking will start when updatePlaybackState receives real data
}

/**
 * Update the connection/boot status subtitle without waiting for playback state.
 * @param {Object} status
 * @param {boolean} status.connected
 * @param {boolean} [status.isBooting]
 */
function updateConnectionStatus(status = {}) {
    if (!modalElement || !isVisible) return;

    const isBooting = status.isBooting === true;
    const connected = status.connected === true;
    
    // Remain in loading state if first state hasn't been received yet
    setModalLoading(isBooting || !connected || !hasReceivedFirstState);
    updateSubtitleState(connected, isBooting);
}

/**
 * Hide the modal
 */
function hideTvPlayerModal() {
    console.log('[TV Player Modal] Hiding modal');

    deactivateModalFocusTrap();
    modalElement.classList.remove('visible');
    modalElement.classList.remove('minimized');
    modalElement.classList.remove('show');
    isVisible = false;
    isMinimized = false;
    clearManagedTimeouts();

    stopProgressTracking();
}

/**
 * Update playback state from external source
 * @param {Object} state - Playback state
 */
function updatePlaybackState(state) {
    // CRITICAL: Do not update position while user is actively scrubbing
    // This prevents TV from overwriting scrubbed position
    if (isDragging) {
        console.log('[TV Player Modal] Blocked - user is scrubbing');
        return;
    }

    // Ignore updates if we recently sent a seek (prevents TV from overwriting our scrub)
    // BUT allow updates once TV catches up to our scrubbed time (tight tolerance).
    if (state.currentTime !== undefined && lastSeekSentTime > 0) {
        const timeSinceSeek = Date.now() - lastSeekSentTime;
        const nextTime = Number(state.currentTime);
        const tvCaughtUp = Number.isFinite(nextTime) && Number.isFinite(currentTime)
            && Math.abs(nextTime - currentTime) < 0.75;
        const playbackFlagChanged = state.isPlaying !== undefined && state.isPlaying !== isPlaying;

        if (timeSinceSeek < SEEK_DEBOUNCE_MS && !tvCaughtUp && !playbackFlagChanged) {
            console.log('[TV Player Modal] Blocked - seek debounce', timeSinceSeek, 'ms ago');
            return;
        }
        // Reset timer once TV is aligned or debounce expires
        if (timeSinceSeek >= SEEK_DEBOUNCE_MS || tvCaughtUp || playbackFlagChanged) {
            lastSeekSentTime = 0;
        }
    }

    if (state.currentTime !== undefined) {
        const nextTime = Number(state.currentTime);
        if (Number.isFinite(nextTime) && nextTime >= 0) {
            currentTime = nextTime;
            currentTimeEl.textContent = formatTime(currentTime);
            updateProgressBar();
        }
    }

    if (state.duration !== undefined) {
        const nextDuration = Number(state.duration);
        if (Number.isFinite(nextDuration) && nextDuration >= 0) {
            duration = nextDuration;
            durationEl.textContent = formatTime(duration);
        }
    }

    if (state.isPlaying !== undefined) {
        isPlaying = state.isPlaying;
        updatePlayPauseIcon(isPlaying);

        // FIXED: Start/stop progress tracking based on actual playback state from TV
        if (isPlaying && duration > 0) {
            startProgressTracking();
        } else {
            stopProgressTracking();
        }
    }

    if (state.title !== undefined) {
        titleEl.textContent = state.title;
    }

    if (state.thumbnailUrl !== undefined) {
        thumbnailEl.src = state.thumbnailUrl;
    }

    if (state.is_guest_cast !== undefined) {
        // Re-evaluate progress ownership when cast metadata changes.
        updateSyncButtonVisibility();
    }

    // Store cast info for guest sync (independent of window.ragotModules.appState)
    mergeStoredCastInfo(state);

    // Mark first state as received once the TV starts reporting active play time or state
    if (state.currentTime !== undefined || state.isPlaying !== undefined) {
        hasReceivedFirstState = true;
        setModalLoading(false);
        updateSubtitleState(true, false);
    }
}

/**
 * Handle close button click - minimizes modal (or stops cast if already minimized)
 * @param {MouseEvent} e
 */
function handleClose(e) {
    // CRITICAL: Stop propagation to prevent handleModalClick from interfering
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }

    // If already minimized, close button should stop casting entirely
    if (isMinimized) {
        console.log('[TV Player Modal] Close button clicked while minimized - stopping cast');
        if (socket) {
            socket.emit(TV_EVENTS.TV_STOP_CASTING, {
                currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
                duration: Number.isFinite(duration) && duration > 0 ? duration : 0
            });
        }
        return;
    }

    console.log('[TV Player Modal] Close button clicked - minimizing modal');
    minimizeTvPlayerModal();
}

/**
 * Minimize the modal (keeps casting active)
 */
function minimizeTvPlayerModal() {
    if (isMinimized) {
        console.log('[TV Player Modal] Already minimized');
        return;
    }

    console.log('[TV Player Modal] Minimizing modal');
    deactivateModalFocusTrap({ restoreFocus: false });

    // Remove visible class to hide full modal
    modalElement.classList.remove('visible');

    // Add minimized class and show it after animation
    scheduleModalTimeout(() => {
        modalElement.classList.add('minimized');
        scheduleModalTimeout(() => {
            modalElement.classList.add('show');
            isMinimized = true;
            isVisible = false;
        }, 50);
    }, 300); // Wait for full modal to fade out
}

/**
 * Restore the modal from minimized state
 */
function restoreTvPlayerModal() {
    if (!isMinimized) {
        console.log('[TV Player Modal] Already restored');
        return;
    }

    console.log('[TV Player Modal] Restoring modal from minimized state');

    // Remove show class to hide minimized pill
    modalElement.classList.remove('show');

    // Remove minimized class and show full modal after animation
    scheduleModalTimeout(() => {
        modalElement.classList.remove('minimized');
        scheduleModalTimeout(() => {
            modalElement.classList.add('visible');
            isMinimized = false;
            isVisible = true;
            activateModalFocusTrap();
        }, 50);
    }, 200); // Wait for minimized pill to fade out
}

function activateModalFocusTrap() {
    if (!modalElement || isMinimized) return;
    modalFocusTrap?.deactivate({ restoreFocus: false });
    modalFocusTrap = createFocusTrap(modalElement, {
        initialFocus: () => playPauseBtn,
        returnFocusTo: modalReturnFocusEl
    });
    requestAnimationFrame(() => modalFocusTrap?.activate());
}

function deactivateModalFocusTrap(options = {}) {
    modalFocusTrap?.deactivate(options);
    modalFocusTrap = null;
}

function handleModalKeyDown(e) {
    if (!isVisible || isMinimized) return;
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;

    if (e.key === ' ') {
        e.preventDefault();
        handlePlayPause();
        return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 10 : -10;
        currentTime = Math.max(0, Math.min(duration || 0, currentTime + delta));
        currentTimeEl.textContent = formatTime(currentTime);
        updateProgressBar();
        if (socket) {
            socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, {
                action: 'seek',
                currentTime
            });
            lastSeekSentTime = Date.now();
        }
    }
}

/**
 * Handle play/pause button click
 */
function handlePlayPause() {
    if (!canControl) {
        console.log('[TV Player Modal] Play/pause blocked - no control permission');
        return;
    }

    // Emit playback control event (UI waits for TV state)
    if (socket) {
        socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, {
            action: isPlaying ? 'pause' : 'play',
            currentTime: currentTime
        });
    }
}

/**
 * Update sync button visibility based on progress ownership.
 * Guest mode shows a manual sync button for IndexedDB saves.
 * Active profiles auto-save through the server, so no button is needed.
 */
function updateSyncButtonVisibility() {
    if (!syncProgressBtn) return;

    if (hasActiveProfile()) {
        syncProgressBtn.style.display = 'none';
        return;
    }

    syncProgressBtn.style.display = 'block';
    syncProgressBtn.title = 'Save current progress to continue watching';
    syncProgressBtn.dataset.ghTooltip = 'Save Progress';
}

/**
 * Handle sync progress button click
 * Guest mode saves progress to IndexedDB.
 */
async function handleSyncProgress() {
    console.log('[TV Player Modal] Sync progress clicked');

    const castInfo = await resolveStoredCastRecord();
    const categoryId = castInfo.categoryId;
    const mediaId = castInfo.mediaId;
    const videoUrl = castInfo.mediaUrl;
    const thumbnailUrl = castInfo.thumbnailUrl;

    if (!categoryId || !mediaId || !videoUrl) {
        console.warn('[TV Player Modal] Cannot sync - missing cast state');
        showSyncFeedback(false, 'No media to sync');
        return;
    }

    if (hasActiveProfile()) {
        showSyncFeedback(false, 'Profiles auto-save');
        return;
    }

    import('../../utils/progressDB.js').then(({ saveVideoLocalProgress, saveLocalProgress }) => {
        const totalCount = 1; // We don't know the total count for guest sync

        if (videoUrl && currentTime > 0 && duration > 0) {
            saveVideoLocalProgress(videoUrl, categoryId, currentTime, duration, thumbnailUrl);
            console.log(`[Guest Sync] Saved video progress to IndexedDB: ${videoUrl} at ${currentTime.toFixed(1)}s`);
        }

        if (currentTime > 0) {
            saveLocalProgress(categoryId, 0, totalCount, currentTime, duration, thumbnailUrl);
            console.log(`[Guest Sync] Saved category progress to IndexedDB: cat=${categoryId}, media=${mediaId}, time=${currentTime.toFixed(1)}s`);
        }

        showSyncFeedback(true, 'Progress saved!');
    }).catch((error) => {
        console.error('[TV Player Modal] Failed to sync progress:', error);
        showSyncFeedback(false, 'Sync failed');
    });
}

/**
 * Show visual feedback for sync button
 * @param {boolean} success - Whether sync succeeded
 * @param {string} message - Feedback message
 */
function showSyncFeedback(success, message) {
    if (!syncProgressBtn) return;

    // Add visual feedback class
    syncProgressBtn.classList.add(success ? 'sync-success' : 'sync-error');

    // Update button title temporarily
    const originalTitle = syncProgressBtn.title;
    const originalTooltip = syncProgressBtn.dataset.ghTooltip;
    syncProgressBtn.title = message;
    syncProgressBtn.dataset.ghTooltip = message;

    // Remove feedback after 2 seconds
    scheduleModalTimeout(() => {
        syncProgressBtn.classList.remove('sync-success', 'sync-error');
        syncProgressBtn.title = originalTitle;
        syncProgressBtn.dataset.ghTooltip = originalTooltip || originalTitle;
    }, 2000);
}

/**
 * Set loading state for the modal (disables controls + shows spinner)
 * @param {boolean} loading
 */
function setModalLoading(loading) {
    if (!modalElement) return;
    const nextLoading = loading === true;
    if (isLoading === nextLoading) return;
    isLoading = nextLoading;
    modalElement.classList.toggle('loading', isLoading);
}

/**
 * Update play/pause button icon
 * @param {boolean} playing - Whether media is playing
 */
function updatePlayPauseIcon(playing) {
    if (!playPauseSvg) return;
    if (playing) {
        // Pause icon
        playPauseSvg.innerHTML = `
            <rect x="6" y="4" width="4" height="16" rx="1"></rect>
            <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        `;
    } else {
        // Play icon
        playPauseSvg.innerHTML = `
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
        `;
    }
}

/**
 * Handle scrubbing start
 * @param {MouseEvent|TouchEvent} e
 */
function handleScrubStart(e) {
    if (!canControl) {
        console.log('[TV Player Modal] Scrubbing blocked - no control permission');
        return;
    }

    e.preventDefault();
    e.stopPropagation(); // CRITICAL: Prevent browser navigation gestures
    isDragging = true;
    progressBarEl.classList.add('scrubbing');
    stopProgressTracking(); // Stop progress updates during scrub

    handleScrubMove(e);
}

/**
 * Handle scrubbing move
 * @param {MouseEvent|TouchEvent} e
 */
function handleScrubMove(e) {
    if (!isDragging) return;

    e.preventDefault();
    e.stopPropagation(); // CRITICAL: Prevent browser navigation gestures

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const rect = progressBarEl.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const percentage = offsetX / rect.width;

    currentTime = percentage * duration;
    currentTimeEl.textContent = formatTime(currentTime);
    updateProgressBar();
}

/**
 * Handle scrubbing end
 * @param {MouseEvent|TouchEvent} e
 */
function handleScrubEnd(e) {
    if (!isDragging) return;

    if (e) {
        e.stopPropagation(); // Prevent event from bubbling
    }

    isDragging = false;
    progressBarEl.classList.remove('scrubbing');

    // Emit seek event
    if (socket) {
        socket.emit(TV_EVENTS.TV_PLAYBACK_CONTROL, {
            action: 'seek',
            currentTime: currentTime
        });
        lastSeekSentTime = Date.now(); // Track when we sent seek
    }

    // Resume progress tracking if still playing
    if (isPlaying) {
        startProgressTracking();
    }
}

/**
 * Handle scrubbing cancel (touchcancel/pointercancel)
 * Ensures we don't get stuck in dragging state on mobile.
 * @param {Event} e
 */
function handleScrubCancel(e) {
    if (!isDragging) return;
    if (e) {
        e.stopPropagation();
    }
    isDragging = false;
    progressBarEl.classList.remove('scrubbing');
    if (isPlaying) {
        startProgressTracking();
    }
}

/**
 * Update progress bar visual state
 */
function updateProgressBar() {
    const percentage = duration > 0 ? (currentTime / duration) * 100 : 0;
    progressFillEl.style.width = `${percentage}%`;
    progressHandleEl.style.left = `${percentage}%`;
    if (progressBarEl) {
        const indeterminate = duration <= 0 && isPlaying;
        progressBarEl.classList.toggle('indeterminate', indeterminate);
    }
}

/**
 * Format time in seconds to MM:SS or H:MM:SS
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// Progress tracking interval
let progressInterval = null;

/**
 * Start tracking progress (increment currentTime while playing)
 */
function startProgressTracking() {
    stopProgressTracking();

    progressInterval = tvPlayerModalLifecycle
        ? tvPlayerModalLifecycle.interval(() => {
            if (isPlaying && duration > 0) {
                currentTime = Math.min(currentTime + 0.5, duration);
                currentTimeEl.textContent = formatTime(currentTime);
                updateProgressBar();
            }
        }, 500)
        : setInterval(() => {
        if (isPlaying && duration > 0) {
            currentTime = Math.min(currentTime + 0.5, duration);
            currentTimeEl.textContent = formatTime(currentTime);
            updateProgressBar();
        }
    }, 500);
}

/**
 * Stop tracking progress
 */
function stopProgressTracking() {
    if (progressInterval) {
        if (tvPlayerModalLifecycle) {
            tvPlayerModalLifecycle.clearInterval(progressInterval);
        } else {
            clearInterval(progressInterval);
        }
        progressInterval = null;
    }
}

/**
 * Update media info while modal is visible or minimized
 * @param {Object} mediaInfo - Media information
 */
function updateMediaInfo(mediaInfo) {
    if (!modalElement) return;

    if (mediaInfo.title) {
        titleEl.textContent = mediaInfo.title;
    }

    if (mediaInfo.thumbnailUrl) {
        thumbnailEl.src = mediaInfo.thumbnailUrl;
    }

    if (mediaInfo.duration !== undefined) {
        duration = mediaInfo.duration;
        durationEl.textContent = formatTime(duration);
    }
}

/**
 * Set control permission for modal
 * @param {boolean} control - Whether controls should be enabled
 */
function setControlPermission(control) {
    canControl = control;
    console.log('[TV Player Modal] Control permission set to:', canControl);

    if (!modalElement) return;

    // Use specific selectors to handle both full and minimized states
    const interactiveElements = [
        $('.tv-player-btn-play-pause', modalElement),
        $('.tv-player-progress-bar', modalElement),
        $('.tv-player-btn-close', modalElement) // Optional: hide close if no control?
    ];

    interactiveElements.forEach(el => {
        if (el) {
            el.style.opacity = canControl ? '1' : '0.5';
            el.style.pointerEvents = canControl ? 'auto' : 'none';
        }
    });

    // Update sync button visibility (depends on user role and cast type)
    updateSyncButtonVisibility();
}

/**
 * Sync with video element playback
 * @param {HTMLVideoElement} videoElement - Video element to sync with
 */
function syncWithVideoElement(videoElement) {
    if (!videoElement || !isVisible) return;

    // Update state from video element
    currentTime = videoElement.currentTime;
    duration = videoElement.duration;
    isPlaying = !videoElement.paused;

    currentTimeEl.textContent = formatTime(currentTime);
    durationEl.textContent = formatTime(duration);
    updateProgressBar();
    updatePlayPauseIcon(isPlaying);
}

/**
 * Check if modal is currently visible
 * @returns {boolean}
 */
function isTvPlayerModalVisible() {
    return isVisible;
}

/**
 * Fully destroy the modal and all scoped listeners/timers.
 * Useful for teardown in tests or hard module reset flows.
 */
function destroyTvPlayerModal() {
    clearManagedTimeouts();
    stopProgressTracking();
    cleanupSocketListeners();
    deactivateModalFocusTrap({ restoreFocus: false });

    if (tvPlayerModalLifecycle) {
        tvPlayerModalLifecycle.stop();
        tvPlayerModalLifecycle = null;
    }

    if (modalElement && modalElement.parentNode) {
        modalElement.parentNode.removeChild(modalElement);
    }

    modalElement = null;
    isInitialized = false;
    isVisible = false;
    isMinimized = false;
    isDragging = false;
    resetStoredCastInfo();
}

export {
    initTvPlayerModal,
    showTvPlayerModal,
    hideTvPlayerModal,
    minimizeTvPlayerModal,
    restoreTvPlayerModal,
    updatePlaybackState,
    updateMediaInfo,
    updateConnectionStatus,
    syncWithVideoElement,
    isTvPlayerModalVisible,
    setControlPermission,
    setModalLoading,
    destroyTvPlayerModal
};
