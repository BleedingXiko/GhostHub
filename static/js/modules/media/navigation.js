/**
 * Media Navigation Module
 * Orchestrates navigation between media items and renders the media window.
 * 
 * @module media/navigation
 */


import {
    getFromCache,
    hasInCache,
    addToCache
} from '../../utils/cacheManager.js';

import { loadMoreMedia, preloadNextMedia, clearResources } from './loader.js';
import { setupControls, toggleSpinner } from '../ui/controller.js';

// Import modularized media components
import {
    createVideoThumbnailElement,
    createImageElement,
    createPlaceholderElement,
    createSubfolderElement,
    updateMediaInfoOverlay
} from './elementFactory.js';

import { createActualVideoElement } from './videoPlayer.js';
import {
    initProgressSync,
    emitMyStateUpdate,
    updateMediaSession,
    isPlaybackProgressAllowed
} from './progressSync.js';
import {
    getVideoProgressSnapshot,
    persistPlaybackProgress,
    shouldMarkCompletedOnExit
} from './progressPersistence.js';
import {
    initThumbnailHandler,
    setupThumbnailClickListener,
    cleanupThumbnailHandler,
    activateThumbnailContainer
} from './thumbnailHandler.js';

// Import playback controls
import {
    initAutoPlayManager,
    isAutoPlayActive,
    cleanupAutoPlayManager
} from '../playback/autoPlay.js';
import { Module, attr, $, $$ } from '../../libs/ragot.esm.min.js';

// Import progress utilities
import {
    initProgressDB,
    saveLocalProgress,
    getLocalProgress,
    saveVideoLocalProgress,
    getVideoLocalProgress,
    getCategoryVideoLocalProgress,
    getAllVideoLocalProgress,
    isUserAdmin,
    isSessionProgressEnabled,
    isProgressDBReady
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';

// Import download manager
import {
    initDownloadManager,
    getCurrentMediaItem,
    downloadCurrentMedia,
    ensureDownloadButton,
    removeDownloadButton,
    cleanupDownloadManager
} from './download.js';

// Import quick actions manager (admin-only viewer actions)
import {
    initQuickActionsManager,
    ensureQuickActionsButton,
    removeQuickActionsButton
} from './quickActions.js';
import {
    initViewerUiController,
    cleanupViewerUiController,
    setViewerMode,
    syncViewerUi,
    VIEWER_MODES
} from './viewerUiController.js';

import { toggleAutoPlay } from '../playback/autoPlay.js';

import { setupLayoutNavigation, cleanupLayoutNavigation, onLayoutMediaRendered, onLayoutViewerClosed } from '../../utils/layoutUtils.js';

import {
    requestWakeLock,
    releaseWakeLock
} from '../../utils/wakeLock.js';
import { refreshAllLayouts } from '../../utils/liveVisibility.js';
import { setAppState, getAppState } from '../../utils/appStateUtils.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { selectParams, selectRecordAt, selectRecordsForView, selectView } from './selectors.js';
import {
    clearViewerSession,
    getCurrentViewerRecord,
    getKnownViewerCount,
    getViewerSession,
    setViewerSession,
} from './viewerState.js';

// Module state
let socket = null;
let navigationLifecycle = null;

function isModalOpen() {
    const viewerOpen = !!window.ragotModules?.appDom?.mediaViewer &&
        !window.ragotModules.appDom.mediaViewer.classList.contains('hidden');
    return Array.from($$('.modal:not(.hidden)')).some((modal) =>
        !(viewerOpen && modal.classList.contains('gallery-month-modal'))
    );
}

function getActiveViewer() {
    const viewer = getViewerSession();
    const view = viewer ? selectView(viewer.viewKey) : null;
    return { viewer, view, count: view?.orderedIds?.length || 0 };
}

function sendHostViewerUpdate(viewer, media) {
    if (!window.ragotModules.appState.syncModeEnabled || !window.ragotModules.appState.isHost || !viewer) return;
    const view = selectView(viewer.viewKey);
    window.ragotModules?.syncManager?.sendSyncUpdate?.({
        viewKey: viewer.viewKey,
        viewType: view?.viewType || null,
        viewParams: selectParams(viewer.viewKey),
        mediaId: media?.id || null,
        category_id: window.ragotModules.appState.currentCategoryId || null,
    });
}


function handleKeyDown(e) {
    // Only handle if viewer is open
    if (!window.ragotModules.appDom.mediaViewer || window.ragotModules.appDom.mediaViewer.classList.contains('hidden')) return;

    // Ignore if typing in an input (search or chat)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isModalOpen()) return;

    if (e.key === 'Escape') {
        // Safe check for photo viewer
        const pv = window.ragotModules?.photoViewer;
        if (pv && pv.isPhotoViewerOpen && pv.isPhotoViewerOpen()) {
            pv.closePhotoViewer();
        } else {
            goBackToCategories();
        }
        e.preventDefault();
        return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        navigateMedia('next');
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateMedia('prev');
    }
}

function handleWheel(e) {
    // Only handle if viewer is open
    if (!window.ragotModules.appDom.mediaViewer || window.ragotModules.appDom.mediaViewer.classList.contains('hidden')) return;
    if (isModalOpen()) return;
    if (window.ragotModules?.photoViewer?.isPhotoViewerOpen?.()) return;

    e.preventDefault();
    if (e.deltaY > 0) {
        navigateMedia('next');
    } else if (e.deltaY < 0) {
        navigateMedia('prev');
    }
}

/**
 * Navigate between media items with performance optimizations
 * @param {string} direction - 'next', 'prev', or undefined for play/pause
 * @param {Event} event - Optional event object
 */
function navigateMedia(direction, event) {
    const appState = getAppState();
    // Ignore events from chat container
    if (event?.target?.closest('#chat-container')) {
        return;
    }
    if (event?.target?.closest('.modal')) {
        return;
    }
    if (isModalOpen()) {
        return;
    }

    // Ignore during fullscreen exit cooldown
    if (window.ragotModules?.fullscreenManager?.hasRecentFullscreenExit?.()) {
        return;
    }

    // Ignore when command popup is open
    if (window.ragotModules?.commandPopup?.isPopupVisible?.()) {
        return;
    }

    // Ignore when navigation is disabled (sync mode) - but allow in Theme Builder Preview Mode
    const isPreviewMode = document.body.classList.contains('theme-builder-preview');
    if (appState.navigationDisabled && !isPreviewMode && (direction === 'next' || direction === 'prev')) {
        return;
    }

    const { viewer, view, count } = getActiveViewer();
    if (!viewer) return;
    let nextIndex = viewer.activeIndex;
    const currentMediaElement = $('.viewer-media.active', window.ragotModules.appDom.mediaViewer);

    // Cleanup old media elements
    cleanupOffscreenMedia(currentMediaElement, count);

    if (direction === 'next') {
        if (view?.hasMore && !appState.isLoading &&
            viewer.activeIndex >= count - window.ragotModules.appRuntime.LOAD_MORE_THRESHOLD) {
            setTimeout(() => loadMoreMedia(), 0);
        }

        if (viewer.activeIndex < count - 1) {
            nextIndex = viewer.activeIndex + 1;
        } else if (!view?.hasMore) {
            return;
        }
    } else if (direction === 'prev') {
        if (viewer.activeIndex > 0) {
            nextIndex = viewer.activeIndex - 1;
        } else {
            return;
        }
    } else {
        // Handle tap to play/pause
        handlePlayPause(currentMediaElement);
        return;
    }

    // Capture and save video progress before navigating
    const canSaveProgress = isPlaybackProgressAllowed(appState);
    const videoProgress = canSaveProgress ? captureVideoProgress(currentMediaElement) : null;
    if (canSaveProgress && videoProgress) {
        saveNavigationProgress(appState.currentCategoryId, viewer.activeIndex, videoProgress);
    }

    // Render new window if index changed
    if (nextIndex !== viewer.activeIndex) {
        setViewerSession(viewer.viewKey, nextIndex, { categoryId: viewer.categoryId || appState.currentCategoryId });
        renderMediaWindow(nextIndex);

        const currentRecord = selectRecordAt(viewer.viewKey, nextIndex);
        if (currentRecord) {
            updateMediaInfoOverlay(currentRecord);
            updateMediaSession(currentRecord);
        }

        // Save index progress after navigation
        if (canSaveProgress) {
            saveIndexProgress(appState.currentCategoryId, nextIndex, videoProgress);
        }
    }
}

/**
 * Cleanup media elements that are off-screen
 * @private
 */
function cleanupOffscreenMedia(currentMediaElement, listLength) {
    const viewer = getViewerSession();
    const activeIndex = viewer?.activeIndex || 0;
    const visibleIndices = new Set([activeIndex]);
    if (activeIndex > 0) visibleIndices.add(activeIndex - 1);
    if (activeIndex < listLength - 1) visibleIndices.add(activeIndex + 1);

    requestAnimationFrame(() => {
        $$('.viewer-media', window.ragotModules.appDom.mediaViewer).forEach(el => {
            const index = parseInt(el.getAttribute('data-index'), 10);
            if (!visibleIndices.has(index) && el !== currentMediaElement) {
                if (el.tagName === 'VIDEO') {
                    try {
                        el.pause();
                        el.removeAttribute('src');
                        el.srcObject = null;
                    } catch (e) { /* ignore */ }
                } else if (el.classList.contains('ghoststream-transcode-container')) {
                    const video = $('video', el);
                    if (video) {
                        try {
                            if (video._ghoststreamCleanup) video._ghoststreamCleanup();
                            video.pause();
                            video.removeAttribute('src');
                        } catch (e) { /* ignore */ }
                    }
                }
                el.remove();
            }
        });
    });
}

/**
 * Handle play/pause toggle
 * @private
 */
function handlePlayPause(currentMediaElement) {
    if (currentMediaElement && currentMediaElement.tagName === 'VIDEO') {
        if (!isAutoPlayActive()) {
            currentMediaElement.loop = true;
            currentMediaElement.setAttribute('loop', 'true');
        }

        if (currentMediaElement.paused) {
            currentMediaElement.play().catch(e => console.error("Resume play failed:", e));
            requestWakeLock();
        } else {
            currentMediaElement.pause();
            releaseWakeLock();
        }
    }
}

/**
 * Activate a thumbnail container using the shared thumbnail handler path.
 * Accepts a container element, numeric index, or defaults to current active thumbnail.
 * @param {HTMLElement|number|string|null} target
 * @returns {boolean}
 */
export function activateVideoThumbnail(target = null) {
    const mediaViewer = window.ragotModules?.appDom?.mediaViewer;
    if (!mediaViewer) return false;

    let thumbnailContainer = null;
    if (target && target.nodeType === 1 && target.classList?.contains('video-thumbnail-container')) {
        thumbnailContainer = target;
    } else if (typeof target === 'number' || (typeof target === 'string' && target.trim() !== '')) {
        const index = String(target).trim();
        thumbnailContainer = $(`.viewer-media.video-thumbnail-container[data-index="${index}"]`, mediaViewer);
    } else {
        thumbnailContainer = $('.viewer-media.active.video-thumbnail-container', mediaViewer) ||
            $('.video-thumbnail-container.active', mediaViewer) ||
            $('.video-thumbnail-container', mediaViewer);
    }

    return activateThumbnailContainer(thumbnailContainer);
}

/**
 * Check if a media element is fully loaded
 * @private
 * @param {HTMLElement} el - Media element (img, video, or container)
 * @returns {boolean} True if loaded
 */
function isActiveMediaLoaded(el) {
    if (!el) return true;

    // Check for nested media first
    const media = $('img, video', el);
    if (media) {
        if (media.tagName === 'IMG') {
            return media.complete && media.naturalWidth > 0;
        }
        if (media.tagName === 'VIDEO') {
            return media.readyState >= 3; // HAVE_FUTURE_DATA
        }
    }

    // Fallback for direct elements
    if (el.tagName === 'IMG') {
        return el.complete && el.naturalWidth > 0;
    }
    if (el.tagName === 'VIDEO') {
        return el.readyState >= 3;
    }

    // For other containers, assume loaded if no media inside
    return true;
}

/**
 * Hide the viewer loading spinner
 * @private
 */
function hideViewerSpinner() {
    toggleSpinner(false);
}

/**
 * Capture and save the current playback state (index and video timestamp)
 */
export async function saveCurrentState({ allowCompletionOnExit = false } = {}) {
    if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) return;

    const currentMediaElement = $('.viewer-media.active', window.ragotModules.appDom.mediaViewer);
    const videoProgress = captureVideoProgress(currentMediaElement);
    const viewer = getViewerSession();
    const index = viewer?.activeIndex ?? 0;
    const categoryId = window.ragotModules.appState.currentCategoryId;
    const videoCompleted = allowCompletionOnExit && shouldMarkCompletedOnExit(
        videoProgress?.video_timestamp,
        videoProgress?.video_duration
    );

    if (categoryId) {
        setAppState('savedVideoCategoryId', categoryId);
        setAppState('savedVideoIndex', index);

        const currentMedia = viewer ? selectRecordAt(viewer.viewKey, index) : null;
        const progressUpdate = {
            index: index,
            thumbnail_url: currentMedia?.thumbnailUrl || currentMedia?.url
        };

        if (videoProgress) {
            setAppState('savedVideoTimestamp', videoCompleted ? null : videoProgress.video_timestamp);
            setAppState('savedVideoDuration', videoProgress.video_duration);
            progressUpdate.video_timestamp = videoCompleted ? null : videoProgress.video_timestamp;
            progressUpdate.video_duration = videoProgress.video_duration;
        } else {
            progressUpdate.video_timestamp = 0;
            progressUpdate.video_duration = 0;
        }

        if (window.ragotModules?.streamingLayout?.updateCategoryProgressInState) {
            window.ragotModules.streamingLayout.updateCategoryProgressInState(categoryId, progressUpdate);
        } else if (window.ragotModules?.galleryLayout?.updateCategoryProgressInState) {
            window.ragotModules.galleryLayout.updateCategoryProgressInState(categoryId, progressUpdate);
        }
    }

    if (videoProgress) {
        await saveNavigationProgress(categoryId, index, videoProgress, videoCompleted);
    } else {
        await saveIndexProgress(categoryId, index, null, true);
    }
}

/**
 * Capture video progress before navigation
 * @private
 */
function captureVideoProgress(currentMediaElement) {
    const video = currentMediaElement?.tagName === 'VIDEO'
        ? currentMediaElement
        : $('video', currentMediaElement);
    if (video) {
        try {
            video.pause();
        } catch (e) { /* ignore */ }
    }
    return getVideoProgressSnapshot(video);
}

/**
 * Save progress during navigation
 * @private
 */
async function saveNavigationProgress(categoryId, index, videoProgress, videoCompleted = false) {
    if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) return;

    const viewer = getViewerSession();
    const currentMedia = viewer ? selectRecordAt(viewer.viewKey, viewer.activeIndex) : null;
    const thumbnailUrl = currentMedia?.thumbnailUrl || currentMedia?.url;
    const totalCount = getKnownViewerCount(window.ragotModules.appState);
    if (window.ragotModules.appState.syncModeEnabled) return;

    await persistPlaybackProgress({
        socket,
        categoryId,
        index,
        totalCount,
        mediaUrl: currentMedia?.url,
        thumbnailUrl,
        timestamp: videoProgress.video_timestamp,
        duration: videoProgress.video_duration,
        videoCompleted,
        isCritical: true,
        optimisticLayout: true
    });
}

/**
 * Save index progress after navigation
 */
async function saveIndexProgress(categoryId, nextIndex, videoProgress, critical = false) {
    if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) return;

    const viewer = getViewerSession();
    const totalCount = getKnownViewerCount(window.ragotModules.appState);
    const currentMedia = viewer ? selectRecordAt(viewer.viewKey, nextIndex) : null;
    const currentView = viewer ? selectView(viewer.viewKey) : null;
    const thumbnailUrl = currentMedia?.thumbnailUrl || currentMedia?.url;

    const payload = {
        category_id: categoryId,
        viewKey: viewer?.viewKey || null,
        viewType: currentView?.viewType || null,
        viewParams: viewer ? selectParams(viewer.viewKey) : {},
        mediaId: currentMedia?.id || null,
        index: nextIndex,
        total_count: totalCount,
        thumbnail_url: thumbnailUrl
    };

    if (videoProgress) {
        payload.video_timestamp = videoProgress.video_timestamp;
        payload.video_duration = videoProgress.video_duration;
    }

    if (critical) {
        payload.critical_save = true;
    }

    if (window.ragotModules.appState.syncModeEnabled) return;

    if (hasActiveProfile()) {
        if (socket?.connected) {
            socket.emit(SOCKET_EVENTS.UPDATE_MY_STATE, payload);
        }
    } else {
        if (!videoProgress) {
            const existing = getLocalProgress(categoryId);
            if (existing) {
                payload.video_timestamp = existing.video_timestamp;
                payload.video_duration = existing.video_duration;
            }
        }
        await saveLocalProgress(categoryId, nextIndex, totalCount, payload.video_timestamp, payload.video_duration, thumbnailUrl);
    }
}

/**
 * Render media window with optimized loading
 */
export function renderMediaWindow(index) {
    if (index === null || index === undefined) {
        index = getViewerSession()?.activeIndex || 0;
    }
    index = parseInt(index, 10);

    try {
        const viewer = getViewerSession();
        if (!viewer?.viewKey) {
            toggleSpinner(true);
            return;
        }
        const view = selectView(viewer.viewKey);
        const knownCount = view?.orderedIds?.length || 0;

        // CLEANUP: Reset UI state before rendering new item
        // This mirrors goBackToCategories behavior for a clean transition
        window.ragotModules?.videoControls?.detachControls?.();
        window.ragotModules?.photoViewer?.closePhotoViewer?.();
        setViewerMode(VIEWER_MODES.MEDIA);

        setupThumbnailClickListener();

        // Aggressive cleanup
        $$('.viewer-media', window.ragotModules.appDom.mediaViewer).forEach(el => el.remove());

        if (window.ragotModules.appState.loadingMessage?.parentNode) {
            window.ragotModules.appState.loadingMessage.remove();
            setAppState('loadingMessage', null);
        }

        // Spinner management
        if (knownCount === 0 || !selectRecordAt(viewer.viewKey, index)) {
            toggleSpinner(true);
        } else if (window.ragotModules.appState.isLoading) {
            toggleSpinner(true);
        }

        const previousIndex = viewer.activeIndex;
        setViewerSession(viewer.viewKey, index, { categoryId: viewer.categoryId || window.ragotModules.appState.currentCategoryId });
        const activeRecord = selectRecordAt(viewer.viewKey, index);

        if (activeRecord) {
            updateMediaInfoOverlay(activeRecord);
            updateMediaSession(activeRecord);
            if (window.ragotModules.appDom.mediaViewer) {
                window.ragotModules.appDom.mediaViewer.setAttribute('data-media-type', activeRecord.type || 'unknown');
            }
        } else if (window.ragotModules.appDom.mediaViewer) {
            window.ragotModules.appDom.mediaViewer.removeAttribute('data-media-type');
        }

        if (window.ragotModules.appState.currentCategoryId && isPlaybackProgressAllowed(window.ragotModules.appState)) {
            emitMyStateUpdate(window.ragotModules.appState.currentCategoryId, index);
        }

        // Render window
        const startIndex = Math.max(0, index - window.ragotModules.appRuntime.renderWindowSize);
        const endIndex = Math.min(knownCount - 1, index + window.ragotModules.appRuntime.renderWindowSize);

        // Sync-host broadcast
        if (window.ragotModules.appState.syncModeEnabled && window.ragotModules.appState.isHost) {
            sendHostViewerUpdate({ ...viewer, activeIndex: index }, activeRecord);
        }

        for (let i = startIndex; i <= endIndex; i++) {
            const file = selectRecordAt(viewer.viewKey, i);
            if (!file || file.type === 'error') continue;

            let mediaElement;
            let useCache = false;

            const isActiveVideo = file.type === 'video' && i === index;
            if (!isActiveVideo && hasInCache(file.url)) {
                const cached = getFromCache(file.url);
                if (!(file.type === 'video' && cached.tagName === 'IMG')) {
                    mediaElement = cached;
                    useCache = true;
                    if (mediaElement.tagName === 'VIDEO') {
                        mediaElement.muted = false;
                        if (!isAutoPlayActive()) {
                            mediaElement.loop = true;
                            mediaElement.setAttribute('loop', 'true');
                        } else {
                            mediaElement.loop = false;
                            mediaElement.removeAttribute('loop');
                            attr(mediaElement, {
                                onEnded: () => { if (isAutoPlayActive()) navigateMedia('next'); }
                            });
                        }
                    }
                }
            }

            if (!useCache) {
                if (file.isSubfolder) {
                    mediaElement = createSubfolderElement(file, handleSubfolderNavigate);
                } else if (file.type === 'video') {
                    mediaElement = createVideoThumbnailElement(file, i === index);
                } else if (file.type === 'image') {
                    mediaElement = createImageElement(file, i === index);
                } else {
                    mediaElement = createPlaceholderElement(file);
                }
                if (mediaElement?.classList.contains('video-thumbnail-container')) addToCache(file.url, mediaElement);
            }

            if (mediaElement) {
                if (!mediaElement.classList.contains('viewer-media')) mediaElement.classList.add('viewer-media');
                mediaElement.setAttribute('data-index', i);
                if (i === index) {
                    mediaElement.classList.add('active');
                    if (mediaElement.tagName === 'VIDEO') setTimeout(() => { if (mediaElement.parentNode) mediaElement.pause(); }, 0);
                }
                window.ragotModules.appDom.mediaViewer.appendChild(mediaElement);
            }
        }

        // Post-render chores
        const activeMedia = $('.viewer-media.active', window.ragotModules.appDom.mediaViewer);
        if ((activeMedia && !isActiveMediaLoaded(activeMedia)) || window.ragotModules.appState.isLoading || knownCount === 0) {
            if (window.ragotModules.appDom.spinnerContainer) {
                window.ragotModules.appDom.spinnerContainer.style.display = 'flex';
                if (!window.ragotModules.appDom.mediaViewer.contains(window.ragotModules.appDom.spinnerContainer)) window.ragotModules.appDom.mediaViewer.appendChild(window.ragotModules.appDom.spinnerContainer);
            }
            if (activeMedia && !isActiveMediaLoaded(activeMedia)) {
                const onLoaded = () => hideViewerSpinner();
                const nestedMedia = $('img, video', activeMedia);
                const target = nestedMedia || activeMedia;

                let called = false;
                const onceLoaded = () => {
                    if (called) return;
                    called = true;
                    onLoaded();
                };

                const spinnerAC = new AbortController();
                const { signal } = spinnerAC;

                target.addEventListener('load', onceLoaded, { once: true, signal });
                target.addEventListener('loadeddata', onceLoaded, { once: true, signal });
                target.addEventListener('error', onceLoaded, { once: true, signal });

                const spinnerFallbackId = navigationLifecycle.timeout(() => {
                    spinnerAC.abort();
                    hideViewerSpinner();
                }, 5000);

                const clearFallback = () => {
                    navigationLifecycle.clearTimeout(spinnerFallbackId);
                    spinnerAC.abort();
                };
                target.addEventListener('load', clearFallback, { once: true, signal });
                target.addEventListener('loadeddata', clearFallback, { once: true, signal });
                target.addEventListener('error', clearFallback, { once: true, signal });

                navigationLifecycle.addCleanup(() => spinnerAC.abort());
            }
        } else {
            hideViewerSpinner();
        }

        preloadNextMedia();
        setupControls();
        syncViewerUi();
    } catch (error) {
        console.error("Error rendering media window:", error);
    }
}

/**
 * Handle subfolder navigation from Media Viewer swipe view.
 * Closes the viewer and navigates the layout to the subfolder.
 * @param {string} categoryId - Category ID
 * @param {string} subfolderName - Subfolder path/name
 */
async function handleSubfolderNavigate(categoryId, subfolderName) {
    console.log(`[handleSubfolderNavigate] Navigating to subfolder: ${subfolderName} in category: ${categoryId}`);

    const currentLayout = document.documentElement.getAttribute('data-layout');
    let layoutModule = null;

    if (currentLayout === 'streaming') {
        layoutModule = window.ragotModules?.streamingLayout;
    } else if (currentLayout === 'gallery') {
        layoutModule = window.ragotModules?.galleryLayout;
    }

    // Get current subfolder from layout module for nested navigation support
    const currentSubfolder = (layoutModule && typeof layoutModule.getSubfolderFilter === 'function')
        ? layoutModule.getSubfolderFilter()
        : null;

    let newSubfolderPath = subfolderName;

    if (currentSubfolder && !subfolderName.startsWith(currentSubfolder)) {
        // Nested subfolder: append to current path
        newSubfolderPath = currentSubfolder.replace(/\/$/, '') + '/' + subfolderName;
    }

    // Close the viewer first
    await goBackToCategories();

    if (!layoutModule) return;

    // Auto categories: navigate to child category instead of subfolder filter
    if (categoryId && categoryId.startsWith('auto::') && typeof layoutModule.setCategoryFilter === 'function') {
        const pathParts = [];
        if (currentSubfolder) {
            currentSubfolder.split('/').filter(Boolean).forEach(p => pathParts.push(p));
        }
        pathParts.push(subfolderName);
        const derivedId = `${categoryId}::${pathParts.join('::')}`;
        const displayName = subfolderName
            ? subfolderName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            : subfolderName;
        layoutModule.setCategoryFilter(derivedId, displayName);
        return;
    }

    // Then apply the filter in the layout
    if (typeof layoutModule.setSubfolderFilterAction === 'function') {
        layoutModule.setSubfolderFilterAction(categoryId, newSubfolderPath);
    }
}


/**
 * Initializes the media navigation module.
 */
export function initMediaNavigation(socketInstance) {
    socket = socketInstance;

    if (navigationLifecycle) {
        navigationLifecycle.stop();
    }
    navigationLifecycle = new Module();
    navigationLifecycle.start();
    navigationLifecycle.on(document, 'keydown', handleKeyDown);
    navigationLifecycle.on(document, 'wheel', handleWheel, { passive: false });

    // Guest mode uses IndexedDB.
    if (!hasActiveProfile()) {
        initProgressDB();
    }
    initProgressSync(socket);
    initThumbnailHandler(socket, navigateMedia);
    initDownloadManager(window.ragotModules.appState, window.ragotModules.appDom.mediaViewer);
    initQuickActionsManager(window.ragotModules.appState, window.ragotModules.appDom.mediaViewer, { navigateMedia, goBackToCategories });
    initViewerUiController();
    initAutoPlayManager();

    // Bind global back button
    const backButton = $('#permanent-gh-back-btn');
    if (backButton) {
        // Clone to remove any existing listeners (defensive)
        const newBackButton = backButton.cloneNode(true);
        backButton.parentNode.replaceChild(newBackButton, backButton);

        const handleBack = (e) => {
            e.preventDefault();
            e.stopPropagation();
            goBackToCategories();
        };

        navigationLifecycle.on(newBackButton, 'click', handleBack);
        navigationLifecycle.on(newBackButton, 'touchend', (e) => {
            // Prevent ghost clicks
            e.preventDefault();
            e.stopPropagation();
            goBackToCategories();
        });
    }

    setupLayoutNavigation(window.ragotModules.appDom.mediaViewer, navigateMedia, goBackToCategories);
}

function cleanupMediaNavigation() {
    if (navigationLifecycle) {
        navigationLifecycle.stop();
        navigationLifecycle = null;
    }
    cleanupAutoPlayManager?.();
    cleanupDownloadManager?.();
    cleanupThumbnailHandler?.();
    cleanupViewerUiController?.();
}


/**
 * Navigates back to the category view.
 * If video is playing, first reverts to thumbnail view, then goes back.
 */
async function goBackToCategories() {
    console.log('[goBackToCategories] Going back to categories view');

    // NEW: If a video is playing (controls attached), revert to thumbnail view first
    if (window.ragotModules?.videoControls?.isControlsAttached?.()) {
        console.log('[goBackToCategories] Video is playing, reverting to thumbnail mode');
        try {
            await saveCurrentState({ allowCompletionOnExit: true });
        } catch (e) {
            console.warn('Non-critical error saving state before reverting to thumbnail:', e);
        }
        window.ragotModules.videoControls.detachControls();

        // Host locally reverts to thumbnail
        renderMediaWindow(getViewerSession()?.activeIndex || 0);

        // Sync: Notify guests to also revert to thumbnail (by re-sending current index)
        // Guests at this index will re-render, effectively closing the video player
        if (window.ragotModules.appState.syncModeEnabled && window.ragotModules.appState.isHost) {
            const viewer = getViewerSession();
            const currentMedia = getCurrentViewerRecord(window.ragotModules.appState);
            if (currentMedia) {
                console.log('[Sync] Host reverting to thumbnail, sending update to guests');
                sendHostViewerUpdate(viewer, currentMedia);
            }
        }
        return;
    }

    // Clean up photo viewer
    window.ragotModules?.photoViewer?.closePhotoViewer();
    removeDownloadButton();
    removeQuickActionsButton();
    setViewerMode(VIEWER_MODES.MEDIA);

    // Save current state (progress/index) before notifying layouts to refresh.
    // This guarantees Continue Watching rebuild sees the latest persisted progress.
    try {
        await saveCurrentState({ allowCompletionOnExit: true });
    } catch (e) {
        console.warn('Non-critical error saving state on back:', e);
    }

    // Stop auto-play
    toggleAutoPlay('stop');

    // Reset layout-specific state
    cleanupLayoutNavigation();

    // Clean up resources aggressively
    clearResources(true);

    // Capture category ID before clearing state
    const categoryId = window.ragotModules.appState.currentCategoryId;

    // Clear media elements from viewer
    if (window.ragotModules.appDom.mediaViewer) {
        $$('.viewer-media', window.ragotModules.appDom.mediaViewer).forEach(el => el.remove());
    }

    // Hide mobile back button overlay
    const mobileBackOverlay = $('#mobile-back-overlay');
    if (mobileBackOverlay) {
        mobileBackOverlay.style.display = 'none';
    }

    // Reset state
    clearViewerSession();
    setAppState('isLoading', false);
    window.ragotModules.appCache.clear();

    // Abort any pending fetches
    if (window.ragotModules.appState.currentFetchController) {
        window.ragotModules.appState.currentFetchController.abort();
        setAppState('currentFetchController', null);
    }

    // Sync: Notify guests that host has exited media viewer
    if (window.ragotModules.appState.syncModeEnabled && window.ragotModules.appState.isHost) {
        console.log('[Sync] Host going back to categories, notifying guests');
        window.ragotModules?.syncManager?.sendSyncUpdate?.({
            viewKey: null,
            viewType: null,
            viewParams: {},
            mediaId: null,
            category_id: null,
        });
    }

    // Notify layout to refresh cards (fixes "Page Reload" issue)
    if (categoryId) {
        onLayoutViewerClosed(categoryId);
    }

    // Reset current category ID since we're back at the list
    setAppState('currentCategoryId', null);

    // Hide the media viewer
    if (window.ragotModules.appDom.mediaViewer) {
        window.ragotModules.appDom.mediaViewer.classList.add('hidden');
        window.ragotModules.appDom.mediaViewer.removeAttribute('data-media-type');
    }

    // Consume deferred layout refresh flags now that the viewer is closed.
    const needsDeferredRefresh = !!window.ragotModules.appState.needsMediaRefresh;
    const forceDeferredRefresh = !!window.ragotModules.appState.forceMediaRefresh;
    setAppState('needsMediaRefresh', false);
    setAppState('forceMediaRefresh', false);

    if (needsDeferredRefresh) {
        refreshAllLayouts(forceDeferredRefresh).catch(e => {
            console.warn('[goBackToCategories] Deferred refresh failed:', e);
        });
    }

    return Promise.resolve();
}

// Re-export needed by other modules
export {
    navigateMedia,
    // Re-export from elementFactory
    updateMediaInfoOverlay,
    createVideoThumbnailElement as createVideoElement,
    createActualVideoElement,
    createImageElement,
    createPlaceholderElement,
    // Re-export from progressDB
    initProgressDB,
    getLocalProgress,
    getVideoLocalProgress,
    getCategoryVideoLocalProgress,
    getAllVideoLocalProgress,
    saveVideoLocalProgress,
    isSessionProgressEnabled,
    isUserAdmin,
    isProgressDBReady,
    goBackToCategories,
    // Re-export from downloadManager
    getCurrentMediaItem,
    downloadCurrentMedia,
    ensureDownloadButton,
    cleanupDownloadManager,
    removeDownloadButton,
    cleanupMediaNavigation,
    // Re-export from quickActionsManager
    ensureQuickActionsButton,
    removeQuickActionsButton,
    // Re-export from autoPlay
    toggleAutoPlay
};
