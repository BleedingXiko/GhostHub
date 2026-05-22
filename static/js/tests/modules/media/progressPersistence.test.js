/**
 * Progress Persistence Tests
 * --------------------------
 * THE critical path for "Continue Watching". This module determines:
 * 1. Whether a video is "completed" (should be removed from Continue Watching)
 * 2. Whether to save or suppress a progress event (race condition prevention)
 * 3. Where progress gets routed (server for admin, IndexedDB for guests)
 *
 * Bugs here directly cause the #1 user-reported issue: completed videos
 * reappearing in Continue Watching.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to mock the progressDB dependency before importing the module
vi.mock('../../../utils/progressDB.js', () => ({
    isTvAuthorityForCategory: vi.fn(() => false),
    deleteVideoLocalProgress: vi.fn(),
    saveLocalProgress: vi.fn(),
    saveVideoLocalProgress: vi.fn(),
}));

vi.mock('../../../utils/profileUtils.js', () => ({
    hasActiveProfile: vi.fn(() => false),
}));

import {
    shouldMarkCompletedOnExit,
    getVideoProgressSnapshot,
    getViewerPlaybackVideo,
    markPendingDeletion,
    isPendingDeletion,
    persistPlaybackProgress,
    EXIT_COMPLETION_MIN_DURATION_SECONDS,
    EXIT_COMPLETION_PERCENT_THRESHOLD,
    EXIT_COMPLETION_MAX_REMAINING_SECONDS,
} from '../../../modules/media/progressPersistence.js';

import {
    isTvAuthorityForCategory,
    deleteVideoLocalProgress,
    saveLocalProgress,
    saveVideoLocalProgress,
} from '../../../utils/progressDB.js';
import { hasActiveProfile } from '../../../utils/profileUtils.js';
import { mediaManifest } from '../../../modules/media/manifest.js';
import { mediaOrdering } from '../../../modules/media/ordering.js';

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    hasActiveProfile.mockReturnValue(false);
    isTvAuthorityForCategory.mockReturnValue(false);
    window.ragotModules = {
        ...window.ragotModules,
        appStore: {
            getState: () => ({})
        }
    };
});

afterEach(() => {
    vi.useRealTimers();
});

// ─── shouldMarkCompletedOnExit ────────────────────────────────────────────────
// This is the function that decides if a video should be cleared from
// Continue Watching when the user navigates away.

describe('shouldMarkCompletedOnExit', () => {
    it('returns false for short clips (< 60s)', () => {
        // A 30-second clip watched to the end should NOT be treated as "completed"
        expect(shouldMarkCompletedOnExit(29, 30)).toBe(false);
    });

    it('returns false when timestamp is 0 (never played)', () => {
        expect(shouldMarkCompletedOnExit(0, 7200)).toBe(false);
    });

    it('returns false when duration is 0', () => {
        expect(shouldMarkCompletedOnExit(100, 0)).toBe(false);
    });

    it('returns false for NaN/Infinity inputs', () => {
        expect(shouldMarkCompletedOnExit(NaN, 100)).toBe(false);
        expect(shouldMarkCompletedOnExit(100, NaN)).toBe(false);
        expect(shouldMarkCompletedOnExit(Infinity, 100)).toBe(false);
        expect(shouldMarkCompletedOnExit(100, Infinity)).toBe(false);
    });

    it('returns false for null/undefined inputs', () => {
        expect(shouldMarkCompletedOnExit(null, 100)).toBe(false);
        expect(shouldMarkCompletedOnExit(100, null)).toBe(false);
        expect(shouldMarkCompletedOnExit(undefined, undefined)).toBe(false);
    });

    it('returns true when ≥80% watched AND ≤420s remaining (movie near end)', () => {
        // 2-hour movie, watched 1h50m = 6600/7200 = 91.7%, remaining 600s... > 420
        expect(shouldMarkCompletedOnExit(6600, 7200)).toBe(false);

        // watched 6900/7200 = 95.8%, remaining 300s < 420 → true
        expect(shouldMarkCompletedOnExit(6900, 7200)).toBe(true);
    });

    it('returns true at exactly 80% watched with ≤420s remaining', () => {
        // 500s total → 80% = 400s watched, remaining = 100s
        expect(shouldMarkCompletedOnExit(400, 500)).toBe(true);
    });

    it('returns false at 79% watched (just under threshold)', () => {
        // 1000s total → 79% = 790s, remaining 210s
        expect(shouldMarkCompletedOnExit(790, 1000)).toBe(false);
    });

    it('returns true for episode-length content (22 min)', () => {
        const duration = 22 * 60; // 1320 seconds
        const watched = duration * 0.90; // 1188 seconds
        // remaining = 132s, ratio = 0.9 → both conditions met
        expect(shouldMarkCompletedOnExit(watched, duration)).toBe(true);
    });

    it('returns false for 80%+ watched but >420s remaining (long movie)', () => {
        // 3-hour movie: 10800s, 80% = 8640, remaining = 2160 > 420
        expect(shouldMarkCompletedOnExit(8640, 10800)).toBe(false);
    });

    it('handles string inputs (coerced to number)', () => {
        expect(shouldMarkCompletedOnExit('450', '500')).toBe(true);
    });

    it('exports correct threshold constants', () => {
        expect(EXIT_COMPLETION_MIN_DURATION_SECONDS).toBe(60);
        expect(EXIT_COMPLETION_PERCENT_THRESHOLD).toBe(0.80);
        expect(EXIT_COMPLETION_MAX_REMAINING_SECONDS).toBe(420);
    });
});

// ─── Pending Deletion (Race Condition Prevention) ─────────────────────────────
// When a video is completed, the pause event fires AFTER the completion event.
// Without this guard, the pause event saves progress and "resurrects" the entry.

describe('Pending Deletion Guard', () => {
    it('marks a URL as pending deletion', () => {
        markPendingDeletion('/media/Movies/movie.mp4');
        expect(isPendingDeletion('/media/Movies/movie.mp4')).toBe(true);
    });

    it('returns false for non-pending URLs', () => {
        expect(isPendingDeletion('/media/other.mp4')).toBe(false);
    });

    it('handles null/empty URLs safely', () => {
        markPendingDeletion(null);
        markPendingDeletion('');
        expect(isPendingDeletion(null)).toBe(false);
        expect(isPendingDeletion('')).toBe(false);
    });

    it('auto-expires after TTL (10 seconds)', () => {
        markPendingDeletion('/media/expire-test.mp4');
        expect(isPendingDeletion('/media/expire-test.mp4')).toBe(true);

        // Advance time past TTL
        vi.advanceTimersByTime(11_000);
        expect(isPendingDeletion('/media/expire-test.mp4')).toBe(false);
    });

    it('normalizes URLs with query strings and fragments', () => {
        markPendingDeletion('/media/video.mp4?t=123#section');
        // Should match the base URL
        expect(isPendingDeletion('/media/video.mp4')).toBe(true);
    });

    it('normalizes encoded URLs', () => {
        markPendingDeletion('/media/My%20Movie.mp4');
        expect(isPendingDeletion('/media/My Movie.mp4')).toBe(true);
    });
});

// ─── getVideoProgressSnapshot ────────────────────────────────────────────────

describe('getVideoProgressSnapshot', () => {
    function createVideoElement(currentTime, duration, paused = false, hlsOffset = 0, hlsSourceDuration = 0) {
        const video = document.createElement('video');
        Object.defineProperty(video, 'currentTime', { value: currentTime, writable: true });
        Object.defineProperty(video, 'duration', { value: duration, writable: true });
        Object.defineProperty(video, 'paused', { value: paused, writable: true });
        if (hlsOffset) video.dataset.hlsTimeOffset = String(hlsOffset);
        if (hlsSourceDuration) video.dataset.hlsSourceDuration = String(hlsSourceDuration);
        return video;
    }

    it('returns null for null source', () => {
        expect(getVideoProgressSnapshot(null)).toBeNull();
    });

    it('returns null when video has no duration', () => {
        const video = createVideoElement(0, 0);
        expect(getVideoProgressSnapshot(video)).toBeNull();
    });

    it('returns null when currentTime is 0 (never started)', () => {
        const video = createVideoElement(0, 100);
        expect(getVideoProgressSnapshot(video)).toBeNull();
    });

    it('returns timestamp and duration for a playing video', () => {
        const video = createVideoElement(50, 100);
        const snap = getVideoProgressSnapshot(video);
        expect(snap).toEqual({
            video_timestamp: 50,
            video_duration: 100
        });
    });

    it('returns null when requirePlaying=true and video is paused', () => {
        const video = createVideoElement(50, 100, true);
        expect(getVideoProgressSnapshot(video, true)).toBeNull();
    });

    it('returns data when requirePlaying=true and video is not paused', () => {
        const video = createVideoElement(50, 100);
        const snap = getVideoProgressSnapshot(video, true);
        expect(snap).not.toBeNull();
    });

    it('adds HLS time offset to timestamp', () => {
        const video = createVideoElement(30, 60, false, 120);
        const snap = getVideoProgressSnapshot(video);
        expect(snap.video_timestamp).toBe(150); // 30 + 120
    });

    it('uses HLS source duration when available', () => {
        const video = createVideoElement(30, 60, false, 0, 7200);
        const snap = getVideoProgressSnapshot(video);
        expect(snap.video_duration).toBe(7200);
    });

    it('extracts video from a container element', () => {
        const container = document.createElement('div');
        const video = createVideoElement(25, 200);
        container.appendChild(video);
        const snap = getVideoProgressSnapshot(container);
        expect(snap).toEqual({ video_timestamp: 25, video_duration: 200 });
    });
});

// ─── getViewerPlaybackVideo ──────────────────────────────────────────────────

describe('getViewerPlaybackVideo', () => {
    it('returns null for null viewer', () => {
        expect(getViewerPlaybackVideo(null)).toBeNull();
    });

    it('finds video.viewer-media.active', () => {
        const viewer = document.createElement('div');
        const video = document.createElement('video');
        video.className = 'viewer-media active';
        viewer.appendChild(video);
        expect(getViewerPlaybackVideo(viewer)).toBe(video);
    });

    it('finds video inside .viewer-media.active container', () => {
        const viewer = document.createElement('div');
        const container = document.createElement('div');
        container.className = 'viewer-media active';
        const video = document.createElement('video');
        container.appendChild(video);
        viewer.appendChild(container);
        expect(getViewerPlaybackVideo(viewer)).toBe(video);
    });

    it('returns null when no active video exists', () => {
        const viewer = document.createElement('div');
        const video = document.createElement('video');
        video.className = 'viewer-media'; // NOT active
        viewer.appendChild(video);
        expect(getViewerPlaybackVideo(viewer)).toBeNull();
    });
});

// ─── persistPlaybackProgress ─────────────────────────────────────────────────

describe('persistPlaybackProgress', () => {
    it('does nothing when categoryId is missing', async () => {
        await persistPlaybackProgress({ categoryId: null, index: 0, timestamp: 50, duration: 100 });
        expect(saveLocalProgress).not.toHaveBeenCalled();
        expect(saveVideoLocalProgress).not.toHaveBeenCalled();
    });

    describe('without an active profile', () => {
        it('saves both category and video progress to IndexedDB', async () => {
            await persistPlaybackProgress({
                categoryId: 'movies',
                index: 3,
                totalCount: 20,
                mediaUrl: '/media/movie.mp4',
                thumbnailUrl: '/thumb.jpg',
                timestamp: 1500,
                duration: 7200
            });

            expect(saveVideoLocalProgress).toHaveBeenCalledWith(
                '/media/movie.mp4', 'movies', 1500, 7200, '/thumb.jpg'
            );
            expect(saveLocalProgress).toHaveBeenCalledWith(
                'movies', 3, 20, 1500, 7200, '/thumb.jpg'
            );
        });

        it('deletes video progress when videoCompleted=true', async () => {
            await persistPlaybackProgress({
                categoryId: 'movies',
                index: 3,
                mediaUrl: '/media/done.mp4',
                timestamp: 7190,
                duration: 7200,
                videoCompleted: true
            });

            expect(deleteVideoLocalProgress).toHaveBeenCalledWith('/media/done.mp4');
            expect(saveVideoLocalProgress).not.toHaveBeenCalled();
        });

        it('passes null timestamp/duration on completion', async () => {
            await persistPlaybackProgress({
                categoryId: 'movies',
                index: 3,
                mediaUrl: '/media/done.mp4',
                timestamp: 100,
                duration: 200,
                videoCompleted: true
            });

            expect(saveLocalProgress).toHaveBeenCalledWith(
                'movies', 3, 0, null, null, null
            );
        });

        it('blocks non-completion saves for recently-completed URLs', async () => {
            // First: complete the video
            await persistPlaybackProgress({
                categoryId: 'movies',
                index: 0,
                mediaUrl: '/media/race.mp4',
                timestamp: 100,
                duration: 120,
                videoCompleted: true
            });
            vi.clearAllMocks();

            // Second: the pause event fires (same URL, NOT completed)
            await persistPlaybackProgress({
                categoryId: 'movies',
                index: 0,
                mediaUrl: '/media/race.mp4',
                timestamp: 100,
                duration: 120,
                videoCompleted: false
            });

            // The non-completion save should have been suppressed
            expect(saveVideoLocalProgress).not.toHaveBeenCalled();
            expect(saveLocalProgress).not.toHaveBeenCalled();
        });

    });

    describe('with an active profile', () => {
        beforeEach(() => {
            hasActiveProfile.mockReturnValue(true);
            const viewKey = 'viewer::movies';
            const orderedIds = Array.from({ length: 6 }, (_, index) => `movies::item_${index}.mp4`);
            mediaOrdering.orders.clear();
            mediaOrdering.ingestView(viewKey, {
                viewType: 'viewer_category',
                orderedIds,
                status: 'ready',
                params: { category_id: 'movies', media_filter: 'all' }
            });
            mediaManifest.clear();
            mediaManifest.ingest(Object.fromEntries(
                orderedIds.map((id, index) => [id, {
                    id,
                    categoryId: 'movies',
                    url: `/media/movies/item_${index}.mp4`,
                    thumbnailUrl: `/thumbs/${index}.jpg`
                }])
            ));
            window.ragotModules = {
                ...window.ragotModules,
                appStore: {
                    getState: () => ({ viewer: { viewKey, activeIndex: 0 } })
                }
            };
        });

        it('emits to socket instead of saving to IndexedDB', async () => {
            const socket = { connected: true, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'movies',
                index: 5,
                timestamp: 300,
                duration: 7200
            });

            expect(socket.emit).toHaveBeenCalledWith('update_my_state', expect.objectContaining({
                category_id: 'movies',
                index: 5,
                video_timestamp: 300,
                video_duration: 7200
            }));
            expect(saveLocalProgress).not.toHaveBeenCalled();
        });

        it('does not emit when socket is disconnected', async () => {
            const socket = { connected: false, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'movies',
                index: 0,
                timestamp: 50,
                duration: 100
            });

            expect(socket.emit).not.toHaveBeenCalled();
        });

        it('skips progress when TV is authority for category', async () => {
            isTvAuthorityForCategory.mockReturnValue(true);
            const socket = { connected: true, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'tvcat',
                index: 0,
                timestamp: 50,
                duration: 100
            });

            expect(socket.emit).not.toHaveBeenCalled();
        });

        it('emits canonical view identity without legacy order payload', async () => {
            const socket = { connected: true, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'movies',
                index: 0,
                timestamp: 50,
                duration: 100
            });

            expect(socket.emit).toHaveBeenCalledWith('update_my_state', expect.objectContaining({
                viewKey: 'viewer::movies',
                viewType: 'viewer_category',
                viewParams: { category_id: 'movies', media_filter: 'all' },
                mediaId: 'movies::item_0.mp4'
            }));
        });

        it('sets critical_save flag when isCritical=true', async () => {
            const socket = { connected: true, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'movies',
                index: 0,
                timestamp: 50,
                duration: 100,
                isCritical: true
            });

            expect(socket.emit).toHaveBeenCalledWith('update_my_state', expect.objectContaining({
                critical_save: true
            }));
        });

        it('fires optimistic streaming layout update when enabled', async () => {
            const mockHandler = vi.fn();
            window.ragotModules = {
                ...window.ragotModules,
                streamingLayout: { handleProgressUpdate: mockHandler }
            };
            document.documentElement.setAttribute('data-layout', 'streaming');

            const socket = { connected: true, emit: vi.fn() };

            await persistPlaybackProgress({
                socket,
                categoryId: 'movies',
                index: 0,
                timestamp: 50,
                duration: 100,
                optimisticLayout: true
            });

            expect(mockHandler).toHaveBeenCalledWith(expect.objectContaining({
                category_id: 'movies'
            }));

            document.documentElement.removeAttribute('data-layout');
        });
    });
});
