/**
 * Shared media progress policy and persistence helpers.
 *
 * @module media/progressPersistence
 */

import {
    isTvAuthorityForCategory,
    deleteVideoLocalProgress,
    saveLocalProgress,
    saveVideoLocalProgress
} from '../../utils/progressDB.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { selectParams, selectRecordAt, selectView } from './selectors.js';
import { getViewerSession } from './viewerState.js';

export const EXIT_COMPLETION_MIN_DURATION_SECONDS = 60;
export const EXIT_COMPLETION_PERCENT_THRESHOLD = 0.80;
export const EXIT_COMPLETION_MAX_REMAINING_SECONDS = 420;

// Track recently-completed URLs so a server-fetch race can't resurrect them.
const _pendingDeletions = new Map();
const _PENDING_DELETION_TTL_MS = 10_000;

function _normUrl(url) {
    if (!url) return '';
    try { url = decodeURIComponent(url); } catch (_) { /* ignore */ }
    return String(url).split('#')[0].split('?')[0];
}

export function markPendingDeletion(mediaUrl) {
    if (!mediaUrl) return;
    _pendingDeletions.set(_normUrl(mediaUrl), Date.now());
    // Auto-expire after TTL
    setTimeout(() => _pendingDeletions.delete(_normUrl(mediaUrl)), _PENDING_DELETION_TTL_MS);
}

export function isPendingDeletion(mediaUrl) {
    if (!mediaUrl) return false;
    const key = _normUrl(mediaUrl);
    const ts = _pendingDeletions.get(key);
    if (!ts) return false;
    if (Date.now() - ts > _PENDING_DELETION_TTL_MS) {
        _pendingDeletions.delete(key);
        return false;
    }
    return true;
}

function getVideoElement(source) {
    if (!source) return null;
    if (source.tagName === 'VIDEO') return source;
    if (typeof source.querySelector === 'function') {
        return source.querySelector('video');
    }
    return null;
}

export function shouldMarkCompletedOnExit(timestamp, duration) {
    const current = Number(timestamp || 0);
    const total = Number(duration || 0);

    if (!Number.isFinite(current) || !Number.isFinite(total)) return false;
    if (total < EXIT_COMPLETION_MIN_DURATION_SECONDS || current <= 0) return false;

    const remaining = Math.max(total - current, 0);
    const watchedRatio = total > 0 ? current / total : 0;
    return watchedRatio >= EXIT_COMPLETION_PERCENT_THRESHOLD
        && remaining <= EXIT_COMPLETION_MAX_REMAINING_SECONDS;
}

export function getViewerPlaybackVideo(viewer) {
    if (!viewer) return null;

    return viewer.querySelector('video.viewer-media.active')
        || viewer.querySelector('.viewer-media.active video')
        || null;
}

export function getVideoProgressSnapshot(source, requirePlaying = false) {
    const video = getVideoElement(source);
    if (!video || video.duration <= 0 || video.currentTime <= 0) {
        return null;
    }

    if (requirePlaying && video.paused) {
        return null;
    }

    const hlsOffset = parseFloat(video.dataset?.hlsTimeOffset) || 0;
    const hlsSourceDuration = parseFloat(video.dataset?.hlsSourceDuration) || 0;

    return {
        video_timestamp: video.currentTime + hlsOffset,
        video_duration: hlsSourceDuration > 0 ? hlsSourceDuration : video.duration
    };
}

export async function persistPlaybackProgress({
    socket = null,
    categoryId,
    index,
    totalCount = 0,
    mediaUrl = null,
    thumbnailUrl = null,
    timestamp,
    duration,
    videoCompleted = false,
    isCritical = false,
    optimisticLayout = false
}) {
    if (!categoryId) return;

    // If this URL was just marked completed, block any non-completion save.
    // This prevents the pause-event save (fired when captureVideoProgress pauses
    // the video) from racing the completion-delete on the server and resurrecting
    // the progress entry that was just deleted.
    if (!videoCompleted && mediaUrl && isPendingDeletion(mediaUrl)) {
        return;
    }

    if (videoCompleted && mediaUrl) {
        markPendingDeletion(mediaUrl);
    }

    const viewer = getViewerSession();
    const currentView = viewer ? selectView(viewer.viewKey) : null;
    const currentRecord = viewer ? selectRecordAt(viewer.viewKey, index) : null;
    const payload = {
        category_id: categoryId,
        viewKey: viewer?.viewKey || null,
        viewType: currentView?.viewType || null,
        viewParams: viewer ? selectParams(viewer.viewKey) : {},
        mediaId: currentRecord?.id || null,
        index,
        total_count: totalCount,
        video_timestamp: timestamp,
        video_duration: duration,
        thumbnail_url: thumbnailUrl,
        video_url: mediaUrl,
        persist_video_progress: true,
        video_completed: videoCompleted,
        video_progress_deleted: videoCompleted
    };

    if (isCritical) {
        payload.critical_save = true;
    }

    if (hasActiveProfile()) {
        if (isTvAuthorityForCategory(categoryId)) {
            return;
        }

        if (optimisticLayout && document.documentElement.getAttribute('data-layout') === 'streaming') {
            try {
                window.ragotModules?.streamingLayout?.handleProgressUpdate?.(payload);
            } catch (e) {
                console.warn('[ContinueWatching] Optimistic streaming progress update failed:', e);
            }
        }

        if (socket?.connected) {
            if (payload.viewKey && payload.viewType && payload.mediaId) {
                socket.emit(SOCKET_EVENTS.UPDATE_MY_STATE, payload);
            }
        }
        return;
    }

    if (mediaUrl) {
        if (videoCompleted) {
            deleteVideoLocalProgress(mediaUrl);
        } else {
            saveVideoLocalProgress(mediaUrl, categoryId, timestamp, duration, thumbnailUrl);
        }
    }

    saveLocalProgress(
        categoryId,
        index,
        totalCount,
        videoCompleted ? null : timestamp,
        videoCompleted ? null : duration,
        thumbnailUrl
    );
}
