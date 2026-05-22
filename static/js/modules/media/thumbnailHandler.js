/**
 * Thumbnail Handler Module
 * Handles delegated click events for video thumbnails and resume logic.
 * 
 * @module media/thumbnailHandler
 */

import {
    getVideoLocalProgress
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { isAutoPlayActive } from '../playback/autoPlay.js';
import * as subtitleManager from '../playback/subtitles.js';
import { createTranscodingVideoElement } from './transcodingPlayer.js';
import { createActualVideoElement } from './videoPlayer.js';
import { isScrubPreviewActive } from './scrubPreviewState.js';
import {
    persistPlaybackProgress,
    shouldMarkCompletedOnExit
} from './progressPersistence.js';
import { isPlaybackProgressAllowed } from './progressSync.js';
import { toggleSpinner } from '../ui/controller.js';
import { Module, css, attr, $$ } from '../../libs/ragot.esm.min.js';
import { setAppState, getAppState } from '../../utils/appStateUtils.js';
import { selectRecordAt } from './selectors.js';
import { getKnownViewerCount, getViewerSession } from './viewerState.js';

// Module state
let socket = null;
let thumbnailClickListenerAttached = false;
let navigateMediaFn = null;
let thumbnailLifecycle = null;

/**
 * Initialize the thumbnail handler
 * @param {Object} socketInstance - Socket.IO instance
 * @param {Function} navigateMedia - Navigation function reference
 */
export function initThumbnailHandler(socketInstance, navigateMedia) {
    socket = socketInstance;
    navigateMediaFn = navigateMedia;
}

/**
 * Sets up a delegated event listener on the main container for thumbnail clicks.
 */
export function setupThumbnailClickListener() {
    const mediaViewer = window.ragotModules?.appDom?.mediaViewer;
    if (thumbnailClickListenerAttached || !mediaViewer) return;

    if (!thumbnailLifecycle) thumbnailLifecycle = new Module();
    thumbnailLifecycle.start();
    thumbnailLifecycle.on(mediaViewer, 'click', handleThumbnailClick);

    thumbnailClickListenerAttached = true;
}

export function cleanupThumbnailHandler() {
    if (thumbnailLifecycle) {
        thumbnailLifecycle.stop();
        thumbnailLifecycle = null;
    }
    thumbnailClickListenerAttached = false;
}

/**
 * Handle thumbnail click event
 * @param {Event} e - Click event
 */
function handleThumbnailClick(e) {
    const thumbnailContainer = e.target.closest('.video-thumbnail-container');

    if (!thumbnailContainer) return;

    e.preventDefault();
    e.stopPropagation();
    activateThumbnailContainer(thumbnailContainer);
}

/**
 * Convert a video thumbnail container into an active video element.
 * @param {HTMLElement|null} thumbnailContainer
 * @returns {boolean} True when activation starts
 */
export function activateThumbnailContainer(thumbnailContainer) {
    if (!thumbnailContainer || !thumbnailContainer.classList?.contains('video-thumbnail-container')) {
        return false;
    }

    // Prevent multiple rapid clicks
    if (thumbnailContainer.classList.contains('loading-video')) {
        return false;
    }
    thumbnailContainer.classList.add('loading-video');
    toggleSpinner(true);

    const currentDataIndex = thumbnailContainer.dataset.index;
    let fileInfo;
    try {
        if (thumbnailContainer.dataset.fileInfo) {
            fileInfo = JSON.parse(thumbnailContainer.dataset.fileInfo);
        } else if (currentDataIndex !== undefined) {
            const viewer = getViewerSession(getAppState());
            fileInfo = viewer ? selectRecordAt(viewer.viewKey, Number.parseInt(currentDataIndex, 10)) : null;
        }
    } catch (err) {
        console.error('[ThumbnailHandler] Failed to get file info:', err);
    }

    if (!fileInfo) {
        console.warn('[ThumbnailHandler] No file info found for thumbnail at index:', currentDataIndex);
        thumbnailContainer.classList.remove('loading-video');
        toggleSpinner(false);
        return false;
    }

    try {
        // Create the actual video element
        const videoElement = createActualVideoElement(fileInfo, true); // Use true for isActive

        const isTranscodingContainer = videoElement.dataset?.transcoding === 'true';

        videoElement.classList.add('viewer-media', 'active');
        if (currentDataIndex) {
            videoElement.setAttribute('data-index', currentDataIndex);
        }

        // Replace the thumbnail container
        if (thumbnailContainer.parentNode) {
            thumbnailContainer.parentNode.replaceChild(videoElement, thumbnailContainer);

            // Sync Mode: If host clicks thumbnail, notify guests to start playback
            const appState = getAppState();
            const isHostInSync = appState.syncModeEnabled && appState.isHost;
            if (isHostInSync) {
                console.log('[Sync] Host clicked thumbnail, notifying guests to start playback');
                // Important: Send sync AFTER video element is in DOM, so it can fire 'play' event
                // The sync will be sent when video starts playing via its 'play' event listener
            }

            // Start playback flow. Controls are attached after first rendered frame.
            // Use thumbnailLifecycle.timeout so the defer is cancelled if the
            // handler module is stopped before the 100 ms elapses.
            if (!thumbnailLifecycle) thumbnailLifecycle = new Module();
            if (!thumbnailLifecycle._isMounted) thumbnailLifecycle.start();
            thumbnailLifecycle.timeout(() => {
                setupVideoPlayback(videoElement, fileInfo, currentDataIndex);
            }, 100);
        } else {
            console.error("Cannot replace thumbnail container - no parent node found.");
            thumbnailContainer.classList.remove('loading-video');
            toggleSpinner(false);
            return false;
        }
    } catch (error) {
        console.error(`Error creating video for ${fileInfo.name}:`, error);
        thumbnailContainer.classList.remove('loading-video');
        toggleSpinner(false);
        return false;
    }

    return true;
}

/**
 * Setup video playback with resume support
 * @param {HTMLVideoElement} videoElement - The video element
 * @param {Object} fileInfo - File information
 * @param {string} currentDataIndex - Current data index
 */
function setupVideoPlayback(videoElement, fileInfo, currentDataIndex) {
    videoElement.preload = 'auto';
    videoElement.muted = false;
    let playbackStarted = false;
    let hasShownFirstFrame = false;

    // Per-video lifecycle module declared first so helpers below can reference it.
    // Stopped automatically when the video element fires 'emptied'.
    const videoLifecycle = new Module().start();

    // Handle auto-play mode
    if (isAutoPlayActive()) {
        videoElement.loop = false;
        videoElement.removeAttribute('loop');
        attr(videoElement, {
            onEnded: () => {
                if (isAutoPlayActive() && navigateMediaFn) {
                    navigateMediaFn('next');
                }
            }
        });
    }

    // Get resume timestamp
    const resumeTimestamp = getResumeTimestamp(fileInfo, currentDataIndex);

    // Helper to load subtitles
    const loadSubtitlesAfterReady = () => {
        const videoControls = window.ragotModules?.videoControls;
        if (!videoControls?.updateSubtitleState) return;

        subtitleManager.loadSubtitlesForVideo(videoElement, fileInfo.url)
            .then((loaded) => {
                const syncSubtitleUi = () => {
                    const hasTracks = $$('track', videoElement).length > 0 ||
                        (videoElement.textTracks && videoElement.textTracks.length > 0);
                    videoControls.updateSubtitleState(Boolean(loaded) || hasTracks, videoElement.textTracks);
                };

                // Browser textTracks update asynchronously after track injection.
                // Use videoLifecycle.timeout so these are cancelled if the video is torn down.
                videoLifecycle.timeout(syncSubtitleUi, 0);
                videoLifecycle.timeout(syncSubtitleUi, 120);
            })
            .catch(err => console.warn('[Subtitles] Failed to load:', err));
    };

    // Handle resume
    if (resumeTimestamp && resumeTimestamp > 0) {
        console.log(`[ContinueWatching] Will resume video from ${resumeTimestamp}s`);
        let metadataCalled = false;
        const onMetadata = () => {
            if (metadataCalled) return;
            metadataCalled = true;
            if (resumeTimestamp < videoElement.duration) {
                videoElement.currentTime = resumeTimestamp;
            }
            // Clear saved timestamp for category mode
            if (getAppState().trackingMode !== 'video') {
                setAppState('savedVideoTimestamp', null);
                setAppState('savedVideoIndex', null);
                setAppState('savedVideoCategoryId', null);
            }
            loadSubtitlesAfterReady();
        };
        videoLifecycle.on(videoElement, 'loadedmetadata', onMetadata);
    } else {
        let metadataCalled = false;
        videoLifecycle.on(videoElement, 'loadedmetadata', () => {
            if (metadataCalled) return;
            metadataCalled = true;
            loadSubtitlesAfterReady();
        });
    }

    // Hide video until ready to show (so we see the black background and spinner)
    css(videoElement, { opacity: '0', transition: 'opacity 0.3s ease' });

    // Hide spinner when video is actually ready to show something
    const showVideo = () => {
        if (hasShownFirstFrame) return;
        hasShownFirstFrame = true;
        console.log(`[ThumbnailHandler] Showing video for index: ${currentDataIndex}`);
        toggleSpinner(false);
        css(videoElement, { opacity: '1' });
        if (window.ragotModules?.videoControls) {
            window.ragotModules.videoControls.attachControls(videoElement, fileInfo);
        }
    };

    const showOnFirstRenderedFrame = () => {
        if (hasShownFirstFrame) return;
        if (typeof videoElement.requestVideoFrameCallback === 'function') {
            videoElement.requestVideoFrameCallback(() => showVideo());
            return;
        }
        if (videoElement.readyState >= 2 && (videoElement.currentTime > 0 || !videoElement.paused)) {
            showVideo();
        }
    };

    attr(videoElement, {
        onPlaying: showOnFirstRenderedFrame,
        onTimeUpdate: () => {
            if (videoElement.currentTime > 0) showOnFirstRenderedFrame();
        }
    });
    // Safety fallback to avoid spinner getting stuck forever on broken streams.
    videoLifecycle.timeout(() => {
        if (!hasShownFirstFrame && videoElement.readyState >= 2) {
            showVideo();
        }
    }, 8000);

    // Fallback: hide spinner if load fails
    attr(videoElement, {
        onError: () => {
            console.error(`[ThumbnailHandler] Video error at index ${currentDataIndex}`);
            toggleSpinner(false);
        }
    });

    // Setup progress saving
    setupProgressSaving(videoElement, fileInfo);

    // Start playback (only for actual video elements). Retry across readiness events to avoid
    // "converted but paused" races on slower devices or stricter autoplay timing.
    if (videoElement.tagName === 'VIDEO') {
        const isSyncGuest = getAppState().syncModeEnabled && !getAppState().isHost;
        if (!isSyncGuest) {
            const attemptPlayback = () => {
                if (playbackStarted || !videoElement.isConnected || !videoElement.paused) {
                    if (!videoElement.paused) playbackStarted = true;
                    return;
                }

                videoElement.play().then(() => {
                    playbackStarted = true;
                    console.log(`Video playback started for index: ${currentDataIndex}`);
                }).catch(() => {
                    videoElement.muted = true;
                    videoElement.play().then(() => {
                        playbackStarted = true;
                        console.log(`Video playback started muted for index: ${currentDataIndex}`);
                    }).catch(() => { });
                });
            };

            attemptPlayback();
            attr(videoElement, {
                onCanPlay: attemptPlayback,
                onLoadedData: attemptPlayback
            });
            videoLifecycle.on(videoElement, 'loadedmetadata', attemptPlayback);
        }
    }

    // Stop the per-video lifecycle when the element is emptied (src cleared / navigated away).
    // This removes loadedmetadata and playback listeners registered above.
    videoLifecycle.on(videoElement, 'emptied', () => videoLifecycle.stop());
}

/**
 * Get resume timestamp based on tracking mode
 * @param {Object} fileInfo - File information
 * @param {string} currentDataIndex - Current index as string
 * @returns {number|null} Resume timestamp or null
 */
function getResumeTimestamp(fileInfo, currentDataIndex) {
    const appState = getAppState();
    if (!isPlaybackProgressAllowed(appState)) return null;

    const trackingMode = appState.trackingMode || 'category';
    const clickedIndex = parseInt(currentDataIndex, 10);
    let resumeTimestamp = null;

    if (trackingMode === 'video') {
        const videoUrl = fileInfo.url;
        let videoProgress = appState.videoProgressMap?.[videoUrl];
        if (!videoProgress) {
            try {
                const encoded = encodeURI(videoUrl);
                videoProgress = appState.videoProgressMap?.[encoded];
            } catch (e) {
                // ignore
            }
        }
        if (!videoProgress) {
            try {
                const decoded = decodeURIComponent(videoUrl);
                videoProgress = appState.videoProgressMap?.[decoded];
            } catch (e) {
                // ignore
            }
        }
        if (!videoProgress && !hasActiveProfile()) {
            videoProgress = getVideoLocalProgress(videoUrl);
        }

        const isSyncGuest = appState.syncModeEnabled && !appState.isHost;
        const syncTimestamp = appState.savedVideoTimestamp;

        // SYNC GUEST: Prioritize sync timestamp over local progress map if available
        if (isSyncGuest && syncTimestamp !== null && syncTimestamp !== undefined) {
            resumeTimestamp = syncTimestamp;
            console.log(`[Sync] Priority: using host timestamp ${resumeTimestamp}s for ${videoUrl}`);
        } else if (videoProgress) {
            const progressTs = Number(videoProgress.video_timestamp ?? 0);
            if (progressTs > 0) {
                resumeTimestamp = progressTs;
            }
            console.log(`[ContinueWatching] Video tracking: found ${resumeTimestamp}s for ${videoUrl}`);
        }
    } else {
        const savedTimestamp = appState.savedVideoTimestamp;
        const savedIndex = appState.savedVideoIndex;
        const canUseLocalVideoFallback = !hasActiveProfile() && fileInfo?.url;

        if (savedTimestamp !== null && savedTimestamp !== undefined && savedTimestamp > 0 &&
            (savedIndex === null || clickedIndex === savedIndex)) {
            resumeTimestamp = savedTimestamp;
        } else if (savedTimestamp && clickedIndex !== savedIndex) {
            setAppState('savedVideoTimestamp', null);
            setAppState('savedVideoIndex', null);
            setAppState('savedVideoCategoryId', null);
        }

        if ((resumeTimestamp === null || resumeTimestamp <= 0) && canUseLocalVideoFallback) {
            // Guest fallback: if category-level resume state is missing or stale, use per-video local progress.
            const videoProgress = getVideoLocalProgress(fileInfo.url);
            const progressTs = Number(videoProgress?.video_timestamp ?? 0);
            if (progressTs > 0) {
                resumeTimestamp = progressTs;
            }
        }
    }

    return resumeTimestamp;
}

/**
 * Setup progress saving for a video element
 * @param {HTMLVideoElement} videoElement - The video element
 * @param {Object} fileInfo - File information
 */
function setupProgressSaving(videoElement, fileInfo) {
    let lastSavedTime = 0;
    const saverLifecycle = new Module().start();
    const attachStartedAt = Date.now();
    let maxKnownTimestamp = 0;
    const boundIndex = Number.parseInt(videoElement?.dataset?.index, 10);
    const getBoundIndex = () => {
        if (Number.isInteger(boundIndex)) return boundIndex;
        return getViewerSession(getAppState())?.activeIndex ?? 0;
    };
    const getBoundMedia = () => {
        const idx = getBoundIndex();
        const viewer = getViewerSession(getAppState());
        return (viewer ? selectRecordAt(viewer.viewKey, idx) : null) || fileInfo || null;
    };

    try {
        const appState = getAppState();
        if (!isPlaybackProgressAllowed(appState)) {
            maxKnownTimestamp = 0;
        } else {
            const trackingMode = appState.trackingMode || 'category';
            if (trackingMode === 'video' && fileInfo?.url) {
                let existing = appState.videoProgressMap?.[fileInfo.url];
                if (!existing) {
                    const encodedUrl = encodeURI(fileInfo.url);
                    existing = appState.videoProgressMap?.[encodedUrl];
                }
                if (!existing && !hasActiveProfile()) {
                    existing = getVideoLocalProgress(fileInfo.url);
                }
                maxKnownTimestamp = Math.max(0, Number(existing?.video_timestamp ?? 0) || 0);
            } else {
                maxKnownTimestamp = Math.max(0, Number(appState.savedVideoTimestamp) || 0);
            }
        }
    } catch (e) {
        maxKnownTimestamp = 0;
    }

    const saveVideoProgress = (isCritical = false, videoCompleted = false) => {
        if (isScrubPreviewActive(videoElement)) {
            return;
        }

        // Sync Mode: Never save progress to server for anyone
        // Guest progress stays in IndexedDB, Host progress is Master (should not be saved during sync to avoid noise)
        const appState = getAppState();
        if (!isPlaybackProgressAllowed(appState) || appState.syncModeEnabled) {
            return;
        }

        if (videoElement.currentTime > 0 && videoElement.duration > 0) {
            const currentMedia = getBoundMedia();
            const boundIndexToSave = getBoundIndex();
            const mediaUrl = currentMedia?.url || fileInfo?.url || null;
            const thumbnailUrl = currentMedia?.thumbnailUrl || currentMedia?.url || fileInfo?.thumbnailUrl || fileInfo?.url;
            const categoryId = appState.currentCategoryId;
            const totalCount = getKnownViewerCount(appState);
            let timestamp = videoElement.currentTime;
            const duration = videoElement.duration;

            // Prevent early startup events from clobbering a higher known resume point.
            const warmupWindowMs = 5000;
            const isWarmup = (Date.now() - attachStartedAt) < warmupWindowMs;
            if (isWarmup && maxKnownTimestamp > 0 && timestamp < Math.max(3, maxKnownTimestamp - 1)) {
                return;
            }
            if (maxKnownTimestamp > 0 && timestamp < maxKnownTimestamp - 1) {
                timestamp = maxKnownTimestamp;
            }
            maxKnownTimestamp = Math.max(maxKnownTimestamp, timestamp);

            persistPlaybackProgress({
                socket,
                categoryId,
                index: boundIndexToSave,
                totalCount,
                mediaUrl,
                thumbnailUrl,
                timestamp,
                duration,
                videoCompleted,
                isCritical,
                optimisticLayout: true
            });
        }
    };

    // Event listeners
    saverLifecycle.on(videoElement, 'play', () => saveVideoProgress(false));
    saverLifecycle.on(videoElement, 'pause', () => saveVideoProgress(true));
    saverLifecycle.on(videoElement, 'seeked', () => {
        // User explicitly seeked — reset the clamp so backward scrubs save correctly
        maxKnownTimestamp = videoElement.currentTime;
        saveVideoProgress(true);
    });

    saverLifecycle.on(videoElement, 'timeupdate', () => {
        if (videoElement.currentTime - lastSavedTime >= 5) {
            lastSavedTime = videoElement.currentTime;
            saveVideoProgress(false);
        }
    });

    const saveOnExit = () => {
        saveVideoProgress(
            true,
            shouldMarkCompletedOnExit(videoElement.currentTime, videoElement.duration)
        );
    };
    saverLifecycle.on(videoElement, 'emptied', saveOnExit);
    saverLifecycle.on(window, 'beforeunload', saveOnExit);

    const saveOnHide = () => {
        if (document.visibilityState === 'hidden') {
            saveVideoProgress(true);
        }
    };
    saverLifecycle.on(document, 'visibilitychange', saveOnHide);

    if (videoElement.tagName === 'VIDEO') {
        saverLifecycle.on(videoElement, 'ended', () => {
            const endDuration = videoElement.duration;
            const endTime = endDuration > 0 ? endDuration : videoElement.currentTime;
            if (Number.isFinite(endTime) && endTime > 0) {
                videoElement.currentTime = endTime;
            }
            saveVideoProgress(true, true);
        });

        const cleanup = () => {
            saverLifecycle.stop();
        };
        saverLifecycle.on(videoElement, 'emptied', cleanup);
    }
}
