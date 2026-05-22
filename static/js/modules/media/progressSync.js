/**
 * Progress Sync Module
 * Handles progress state emission and tracking for media playback.
 * 
 * @module media/progressSync
 */

import {
    isTvAuthorityForCategory,
    saveLocalProgress
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { Module, attr, $ } from '../../libs/ragot.esm.min.js';
import { setAppState, getAppState } from '../../utils/appStateUtils.js';
import {
    getViewerPlaybackVideo,
    getVideoProgressSnapshot,
    persistPlaybackProgress,
    shouldMarkCompletedOnExit
} from './progressPersistence.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { getCurrentLayout } from '../../utils/layoutUtils.js';
import {
    getKnownViewerCount,
    getViewerRecordAt,
    getViewerSession
} from './viewerState.js';
import { selectParams, selectView } from './selectors.js';

/**
 * Update Media Session API metadata and action handlers
 * @param {Object} file - Media file info
 */
export function updateMediaSession(file) {
    if (!('mediaSession' in navigator)) return;

    const title = file.displayName || file.name || 'Unknown Media';
    const artist = 'GhostHub';
    const artwork = file.thumbnailUrl ? [
        { src: file.thumbnailUrl, sizes: '512x512', type: 'image/png' }
    ] : [
        { src: '/static/icons/Ghosthub512.png', sizes: '512x512', type: 'image/png' }
    ];

    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: getAppState().currentCategoryId || 'Media',
        artwork: artwork
    });

    // Add action handlers
    const actions = {
        play: () => {
            const viewer = window.ragotModules?.appDom?.mediaViewer;
            const video = viewer ? $('video.viewer-media.active', viewer) : null;
            if (video) video.play();
        },
        pause: () => {
            const viewer = window.ragotModules?.appDom?.mediaViewer;
            const video = viewer ? $('video.viewer-media.active', viewer) : null;
            if (video) video.pause();
        },
        previoustrack: () => {
            if (window.ragotModules?.mediaNavigation?.navigateMedia) {
                window.ragotModules.mediaNavigation.navigateMedia('prev');
            }
        },
        nexttrack: () => {
            if (window.ragotModules?.mediaNavigation?.navigateMedia) {
                window.ragotModules.mediaNavigation.navigateMedia('next');
            }
        },
        seekbackward: (details) => {
            const viewer = window.ragotModules?.appDom?.mediaViewer;
            const video = viewer ? $('video.viewer-media.active', viewer) : null;
            if (video) video.currentTime = Math.max(video.currentTime - (details.seekOffset || 10), 0);
        },
        seekforward: (details) => {
            const viewer = window.ragotModules?.appDom?.mediaViewer;
            const video = viewer ? $('video.viewer-media.active', viewer) : null;
            if (video) video.currentTime = Math.min(video.currentTime + (details.seekOffset || 10), video.duration);
        }
    };

    for (const [action, handler] of Object.entries(actions)) {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
            console.warn(`Media Session action "${action}" not supported.`);
        }
    }

    // Update playback state
    const viewer = window.ragotModules?.appDom?.mediaViewer;
    const video = viewer ? $('video.viewer-media.active', viewer) : null;
    if (video) {
        navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';

        // Update position state if supported
        if ('setPositionState' in navigator.mediaSession) {
            const updatePosition = () => {
                if (video.duration && isFinite(video.duration)) {
                    navigator.mediaSession.setPositionState({
                        duration: video.duration,
                        playbackRate: video.playbackRate,
                        position: video.currentTime
                    });
                }
            };

            // Use managed listeners on transient video element
            attr(video, {
                onPlay: () => {
                    navigator.mediaSession.playbackState = 'playing';
                    updatePosition();
                },
                onPause: () => {
                    navigator.mediaSession.playbackState = 'paused';
                },
                onTimeUpdate: () => {
                    // Throttle position updates
                    if (Math.floor(video.currentTime) % 5 === 0) {
                        updatePosition();
                    }
                }
            });
            updatePosition();
        }
    }
}

// Module-level state
let socket = null;

export function isPlaybackProgressAllowed(appState = getAppState()) {
    if (getCurrentLayout() === 'gallery') return false;

    const viewer = getViewerSession(appState);
    const viewKey = viewer?.viewKey || '';
    if (viewKey.startsWith('gallery_') || viewKey.startsWith('viewer::gallery_')) {
        return false;
    }

    const view = viewKey ? selectView(viewKey) : null;
    if (view?.viewType && String(view.viewType).startsWith('gallery_')) {
        return false;
    }

    return true;
}

/**
 * Initialize the progress sync module
 * @param {Object} socketInstance - Socket.IO instance
 */
export function initProgressSync(socketInstance) {
    socket = socketInstance;
}

/**
 * Gets the current video timestamp and duration.
 * @param {boolean} requirePlaying - If true, only return progress if video is playing
 * @returns {Object|null} - {video_timestamp, video_duration} or null if no video found
 */
export function getCurrentVideoProgress(requirePlaying = false) {
    if (!isPlaybackProgressAllowed()) return null;
    const viewer = window.ragotModules?.appDom?.mediaViewer;
    const activeVideo = getViewerPlaybackVideo(viewer);
    return getVideoProgressSnapshot(activeVideo, requirePlaying);
}

/**
 * Emits the current user's state to the server.
 * @param {string} categoryId - The current category ID.
 * @param {number} index - The current media index.
 * @param {boolean} includeVideoProgress - Whether to include video timestamp/duration
 */
export function emitMyStateUpdate(categoryId, index, includeVideoProgress = false) {
    const appState = getAppState();
    if (!isPlaybackProgressAllowed(appState)) return;
    if (!socket) {
        console.warn('emitMyStateUpdate: Socket instance is not available.');
        return;
    }
    if (!socket.connected) {
        console.warn(`emitMyStateUpdate: Socket not connected.`);
        return;
    }

    if (!categoryId || typeof categoryId !== 'string' || !categoryId.trim()) {
        console.warn(`emitMyStateUpdate: Invalid categoryId: ${categoryId}`);
        return;
    }
    // Safety check for index - normalize to 0 if null/undefined/non-number
    if (index === null || index === undefined || typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
        console.warn(`emitMyStateUpdate: Invalid index ${index}, defaulting to 0`);
        index = 0;
    }

    const currentMedia = getViewerRecordAt(index, appState);
    const viewer = getViewerSession(appState);
    const currentView = viewer ? selectView(viewer.viewKey) : null;
    const payload = {
        category_id: categoryId,
        viewKey: viewer?.viewKey || null,
        viewType: currentView?.viewType || null,
        viewParams: viewer ? selectParams(viewer.viewKey) : {},
        mediaId: currentMedia?.id || null,
        index: index,
        total_count: getKnownViewerCount(appState)
    };
    if (!payload.viewKey || !payload.viewType || !payload.mediaId) {
        console.warn('emitMyStateUpdate: Missing canonical view identity; skipping state update.');
        return;
    }

    if (currentMedia) {
        payload.thumbnail_url = currentMedia.thumbnailUrl || currentMedia.url;
    }

    if (includeVideoProgress) {
        const videoProgress = getCurrentVideoProgress();
        if (videoProgress) {
            payload.video_timestamp = videoProgress.video_timestamp;
            payload.video_duration = videoProgress.video_duration;
            if (currentMedia?.url) {
                payload.video_url = currentMedia.url;
            }
        }
    }

    if (hasActiveProfile()) {
        if (isTvAuthorityForCategory(categoryId)) {
            console.log(`[ContinueWatching] Profile state update blocked - TV is authority for ${categoryId}`);
        }
        try {
            socket.emit(SOCKET_EVENTS.UPDATE_MY_STATE, payload);
        } catch (e) { /* ignore */ }
    } else {
        saveLocalProgress(
            payload.category_id,
            payload.index,
            payload.total_count,
            payload.video_timestamp,
            payload.video_duration,
            payload.thumbnail_url
        );
        try {
            socket.emit(SOCKET_EVENTS.UPDATE_MY_STATE, payload);
        } catch (e) { /* ignore */ }
    }
}

/**
 * Create video progress save handler for a video element
 * @param {HTMLVideoElement} videoElement - The video element
 * @param {Object} file - The file info object
 * @param {string} categoryId - The category ID
 * @returns {Function} The save progress function
 */
export function createVideoProgressSaver(videoElement, file, categoryId) {
    let lastSavedTime = 0;
    const boundIndex = Number.parseInt(videoElement?.dataset?.index, 10);
    const getBoundIndex = () => Number.isInteger(boundIndex)
        ? boundIndex
        : (getViewerSession(getAppState())?.activeIndex ?? 0);
    const getBoundMedia = () => {
        const idx = getBoundIndex();
        return getViewerRecordAt(idx, getAppState()) || file || null;
    };

    const saveVideoProgress = (isCritical = false, videoCompleted = false) => {
        const appState = getAppState();
        if (!isPlaybackProgressAllowed(appState)) {
            return;
        }

        // Sync Mode: Never save progress for anyone
        if (appState.syncModeEnabled) {
            return;
        }

        if (videoElement.currentTime > 0 && videoElement.duration > 0) {
            const currentMedia = getBoundMedia();
            const index = getBoundIndex();
            const mediaUrl = currentMedia?.url || file?.url || null;
            const thumbnailUrl = currentMedia?.thumbnailUrl || currentMedia?.url || file?.thumbnailUrl || file?.url;
            const totalCount = getKnownViewerCount(appState);
            const timestamp = videoElement.currentTime;
            const duration = videoElement.duration;

            // Update window.ragotModules.appState with current video progress so it's available when viewer closes
            setAppState('savedVideoTimestamp', timestamp);
            setAppState('savedVideoDuration', duration);
            setAppState('savedVideoIndex', index);
            setAppState('savedVideoCategoryId', categoryId);

            persistPlaybackProgress({
                socket,
                categoryId,
                index,
                totalCount,
                mediaUrl,
                thumbnailUrl,
                timestamp,
                duration,
                videoCompleted,
                isCritical,
                optimisticLayout: isCritical
            });
        }
    };

    // Return object with save function and setup method
    return {
        save: saveVideoProgress,
        setup: () => {
            const saverLifecycle = new Module().start();
            // Non-critical events (will be debounced on backend)
            saverLifecycle.on(videoElement, 'play', () => saveVideoProgress(false));

            // Critical events (bypass debouncing for immediate saves)
            saverLifecycle.on(videoElement, 'pause', () => saveVideoProgress(true));
            saverLifecycle.on(videoElement, 'seeked', () => saveVideoProgress(true));

            saverLifecycle.on(videoElement, 'timeupdate', () => {
                if (videoElement.currentTime - lastSavedTime >= 5) {
                    lastSavedTime = videoElement.currentTime;
                    saveVideoProgress(false);  // Non-critical, will be debounced
                }
            });

            const saveOnExit = () => {
                saveVideoProgress(
                    true,
                    shouldMarkCompletedOnExit(videoElement.currentTime, videoElement.duration)
                );
            };
            saverLifecycle.on(videoElement, 'emptied', saveOnExit);
            saverLifecycle.on(videoElement, 'ended', () => {
                const endDuration = videoElement.duration;
                const endTime = endDuration > 0 ? endDuration : videoElement.currentTime;
                if (Number.isFinite(endTime) && endTime > 0) {
                    videoElement.currentTime = endTime;
                }
                saveVideoProgress(true, true);
            });
            saverLifecycle.on(window, 'beforeunload', saveOnExit);

            const saveOnHide = () => {
                if (document.visibilityState === 'hidden') {
                    saveVideoProgress(true);  // Critical save only, not completion
                }
            };
            saverLifecycle.on(document, 'visibilitychange', saveOnHide);

            // Cleanup: ensure saver stops when video is emptied
            saverLifecycle.on(videoElement, 'emptied', () => {
                saverLifecycle.stop();
            }, { once: true });
        }
    };
}
