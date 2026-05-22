/**
 * Transcoding Player Module
 * Handles GhostStream/HLS transcoding for incompatible video formats.
 * 
 * @module media/transcodingPlayer
 */

import {
    getVideoLocalProgress
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { requiresTranscoding, createCannotPlayElement } from './elementFactory.js';
import { diskIcon, lightningIcon } from '../../utils/icons.js';
import { createElement, attr, prepend, $ } from '../../libs/ragot.esm.min.js';
import { requestWakeLock, releaseWakeLock } from '../../utils/wakeLock.js';
import { isAutoPlayActive } from '../playback/autoPlay.js';
import {
    persistPlaybackProgress,
    shouldMarkCompletedOnExit
} from './progressPersistence.js';
import { isPlaybackProgressAllowed } from './progressSync.js';
import { isScrubPreviewActive } from './scrubPreviewState.js';
import { getKnownViewerCount, getViewerSession } from './viewerState.js';

// Module-level socket reference (set via init)
let socket = null;

/**
 * Initialize the transcoding player with socket reference
 * @param {Object} socketInstance - Socket.IO instance
 */
export function initTranscodingPlayer(socketInstance) {
    socket = socketInstance;
}

/**
 * Handle video end behavior (play_next, loop, or stop)
 * This is a helper function shared across all video players
 */
function handleVideoEndBehavior() {
    const videoEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
    const isCurrentlyAutoPlay = isAutoPlayActive();

    if (videoEndBehavior === 'play_next' && !isCurrentlyAutoPlay) {
        // Check if next media is available
        const appState = window.ragotModules?.appState;
        const currentIndex = getViewerSession(appState)?.activeIndex;
        const totalMedia = getKnownViewerCount(appState);

        if (currentIndex !== undefined && currentIndex < totalMedia - 1) {
            // Next media is available, play it
            console.log('[TranscodingPlayer] Playing next media (index:', currentIndex + 1, ')');
            const navigateMediaFn = window.ragotModules?.mediaNavigation?.navigateMedia;
            if (navigateMediaFn) {
                navigateMediaFn('next');
            }
        } else {
            // No next media available, stop (do nothing - video will stay at end frame)
            console.log('[TranscodingPlayer] No next media available, stopping playback');
        }
    }
}

/**
 * Create a video element that auto-transcodes via GhostStream (Plex-like)
 * @param {Object} file - File object
 * @param {boolean} isActive - Whether this is the active video
 * @param {Object} decision - Playback decision from analyzePlayback
 * @returns {HTMLElement} Container with transcoding video
 */
export function createTranscodingVideoElement(file, isActive, decision) {
    const ghoststream = window.ragotModules?.ghoststreamManager;
    const activeIndex = getViewerSession(window.ragotModules?.appState)?.activeIndex ?? 0;

    const container = createElement('div', {
        className: 'viewer-media ghoststream-transcode-container',
        dataset: { transcoding: 'true', url: file.url, index: activeIndex },
        'data-index': activeIndex
    });

    // Show poster/thumbnail
    if (file.thumbnailUrl) {
        container.appendChild(createElement('img', {
            src: file.thumbnailUrl,
            className: 'ghoststream-poster',
            alt: file.name
        }));
    }

    // Show transcoding reason badge
    const badge = createElement('div', { className: 'ghoststream-badge', innerHTML: `⚡ ${decision.reason}` });
    container.appendChild(badge);

    // Show loading indicator
    const indicator = createElement('div', {
        className: 'ghoststream-indicator', innerHTML: `
        <div class="gs-indicator-icon">⚡</div>
        <div class="gs-indicator-text">Preparing stream...</div>
        <div class="gs-indicator-progress">0%</div>
    ` });
    container.appendChild(indicator);

    // Start transcoding automatically
    startTranscoding(file, container, badge, indicator, ghoststream);

    return container;
}

/**
 * Start the transcoding process
 * @private
 */
async function startTranscoding(file, container, badge, indicator, ghoststream) {
    try {
        // Fresh availability check
        if (ghoststream?.checkStatus) {
            await ghoststream.checkStatus();
        }
        if (!ghoststream?.isAvailable?.()) {
            throw new Error('GhostStream not available - no transcoding server connected');
        }

        const urlParts = file.url.split('/');
        const categoryId = urlParts[2];
        const filename = decodeURIComponent(urlParts.slice(3).join('/'));

        const prefs = ghoststream.getPreferences ? ghoststream.getPreferences() : {};
        const resolution = prefs.preferredQuality || 'original';

        const textEl = $('.gs-indicator-text', indicator);
        if (textEl) textEl.textContent = 'Checking cache...';

        // Check cache first
        const cached = ghoststream.checkCache ?
            await ghoststream.checkCache(categoryId, filename, resolution, 'h264') : null;

        if (cached && cached.url) {
            await playCachedTranscode(file, container, badge, indicator, cached, categoryId);
            return;
        }

        // No cache - start live transcoding
        await startLiveTranscode(file, container, badge, indicator, ghoststream, categoryId, filename, resolution, prefs);

    } catch (error) {
        console.error('[GhostStream] Auto-transcode failed:', error);
        showTranscodeError(file, container, error, ghoststream?.isAvailable?.());
    }
}

/**
 * Play from cached transcode
 * @private
 */
async function playCachedTranscode(file, container, badge, indicator, cached, categoryId) {
    console.log(`[GhostStream] Using cached transcode: ${cached.url}`);
    indicator.remove();

    const video = createElement('video', {
        className: 'viewer-media active ghoststream-video',
        controls: false,
        playsInline: true,
        poster: file.thumbnailUrl || '',
        src: cached.url,
        dataset: { originalUrl: file.url, cachedTranscode: 'true' }
    });

    // Get video end behavior from config
    const videoEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
    const isAutoPlay = isAutoPlayActive();

    // Set loop based on config and auto-play state
    // Auto-play takes precedence when active
    const shouldLoop = isAutoPlay ? false : (videoEndBehavior === 'loop');
    video.loop = shouldLoop;
    if (shouldLoop) {
        video.setAttribute('loop', 'true');
    } else {
        video.removeAttribute('loop');
    }

    video.disablePictureInPicture = false;
    video.autoPictureInPicture = true;
    video.setAttribute('autopictureinpicture', 'true');
    video.setAttribute('playsinline', 'true');

    // Add PiP support if available
    if (document.pictureInPictureEnabled) {
        attr(video, {
            onEnterPictureInPicture: () => {
                console.log('[PiP] Entered Picture-in-Picture (Cached)');
            },
            onLeavePictureInPicture: () => {
                console.log('[PiP] Left Picture-in-Picture (Cached)');
            }
        });
    }

    const posterEl = $('.ghoststream-poster', container);
    if (posterEl) posterEl.remove();
    prepend(container, video);

    badge.innerHTML = `${diskIcon(14)} Cached`;
    badge.title = 'Playing pre-transcoded version';

    // Setup progress saving for cached videos
    setupCachedProgressSaving(video, file, categoryId);

    // Setup fullscreen support (button + double-tap/click)
    setupFullscreenSupport(video);

    // Auto-play
    try {
        await video.play();
    } catch (e) {
        video.muted = true;
        await video.play();
    }

    console.log(`[GhostStream] Cached playback ready for ${file.name}`);
}

/**
 * Setup progress saving for cached transcode videos
 * @private
 */
function setupCachedProgressSaving(video, file, categoryId) {
    let lastSavedTime = 0;
    let cachedKnownDuration = 0;
    const cleanupController = new AbortController();

    const saveCachedProgress = (currentTime, duration, isCritical = false, videoCompleted = false) => {
        if (isScrubPreviewActive(video)) return;
        if (currentTime <= 0) return;

        if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) {
            return;
        }

        const safeDuration = cachedKnownDuration > 0 ? cachedKnownDuration :
            (duration && isFinite(duration)) ? duration : 0;
        const thumbnailUrl = file.thumbnailUrl || file.url;
        const index = getViewerSession(window.ragotModules?.appState)?.activeIndex ?? 0;
        const totalCount = getKnownViewerCount(window.ragotModules?.appState);
        const activeSocket = socket || window.ragotModules?.appStore?.get?.('socket', null);

        persistPlaybackProgress({
            socket: activeSocket,
            categoryId,
            index,
            totalCount,
            mediaUrl: file.url,
            thumbnailUrl,
            timestamp: currentTime,
            duration: safeDuration,
            videoCompleted,
            isCritical,
            optimisticLayout: isCritical
        });
    };

    attr(video, {
        onDurationChange: () => {
            if (video.duration && isFinite(video.duration) && video.duration > cachedKnownDuration) {
                cachedKnownDuration = video.duration;
            }
        },
        onTimeUpdate: () => {
            if (Math.abs(video.currentTime - lastSavedTime) >= 5) {
                lastSavedTime = video.currentTime;
                saveCachedProgress(video.currentTime, video.duration || 0, false);
            }
        },
        onPlay: () => {
            // Request wake lock to prevent screen sleep during playback
            requestWakeLock();
        },
        onPause: () => {
            if (isScrubPreviewActive(video)) {
                releaseWakeLock();
                return;
            }
            saveCachedProgress(video.currentTime, video.duration || 0, true);
            // Release wake lock when paused
            releaseWakeLock();
        },
        onSeeked: () => saveCachedProgress(video.currentTime, video.duration || 0, true),
        onEnded: () => {
            const endDuration = video.duration || cachedKnownDuration || 0;
            const endTime = endDuration > 0 ? endDuration : video.currentTime;
            saveCachedProgress(endTime, endDuration, true, true);
            // Release wake lock when video ends
            releaseWakeLock();
            // Handle play_next behavior
            handleVideoEndBehavior();
        },
        onEmptied: () => {
            cleanupController.abort();
        }
    });

    const saveOnExit = () => {
        saveCachedProgress(
            video.currentTime,
            video.duration || cachedKnownDuration || 0,
            true,
            shouldMarkCompletedOnExit(video.currentTime, video.duration || cachedKnownDuration || 0)
        );
    };
    window.addEventListener('beforeunload', saveOnExit, { signal: cleanupController.signal });

    // Resume from saved position
    setupCachedResume(video, file, categoryId, (duration) => { cachedKnownDuration = duration; });
}

/**
 * Setup resume functionality for cached videos
 * @private
 */
async function setupCachedResume(video, file, categoryId, setDuration) {
    if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) return;

    let savedTimestamp = 0;

    if (isPlaybackProgressAllowed(window.ragotModules?.appState) && hasActiveProfile()) {
        try {
            const resp = await fetch(`/api/progress/video?video_path=${encodeURIComponent(file.url)}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.video_timestamp > 0) {
                    savedTimestamp = data.video_timestamp;
                    if (data.video_duration > 0) setDuration(data.video_duration);
                }
            }
        } catch (e) { /* ignore */ }
    } else if (isPlaybackProgressAllowed(window.ragotModules?.appState)) {
        const savedProgress = getVideoLocalProgress(file.url);
        if (savedProgress?.video_timestamp > 0) {
            savedTimestamp = savedProgress.video_timestamp;
            if (savedProgress.video_duration > 0) setDuration(savedProgress.video_duration);
        }
    }

    if (savedTimestamp > 0 && video.duration > 0) {
        video.currentTime = savedTimestamp;
    } else if (savedTimestamp > 0) {
        let metadataCalled = false;
        attr(video, {
            onLoadedMetadata: () => {
                if (metadataCalled) return;
                metadataCalled = true;
                video.currentTime = savedTimestamp;
            }
        });
    }
}

/**
 * Start live transcoding (not cached)
 * @private
 */
async function startLiveTranscode(file, container, badge, indicator, ghoststream, categoryId, filename, resolution, prefs) {
    // Check for saved progress BEFORE starting transcode
    // Also grab saved duration as fallback if GhostStream doesn't return it
    let resumeFromTime = 0;
    let savedDuration = 0;

    if (hasActiveProfile()) {
        try {
            const resp = await fetch(`/api/progress/video?video_path=${encodeURIComponent(file.url)}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.video_timestamp > 10) {
                    resumeFromTime = data.video_timestamp;
                    console.log(`[GhostStream Resume] Profile saved position: ${resumeFromTime}s`);
                }
                if (data.video_duration > 0) {
                    savedDuration = data.video_duration;
                    console.log(`[GhostStream Resume] Using saved duration: ${savedDuration}s`);
                }
            }
        } catch (e) { console.warn('[GhostStream Resume] Failed to fetch progress:', e); }
    } else {
        const savedProgress = getVideoLocalProgress(file.url);
        if (savedProgress?.video_timestamp > 10) {
            resumeFromTime = savedProgress.video_timestamp;
            console.log(`[GhostStream Resume] Guest saved position: ${resumeFromTime}s`);
        }
        if (savedProgress?.video_duration > 0) {
            savedDuration = savedProgress.video_duration;
            console.log(`[GhostStream Resume] Using saved duration: ${savedDuration}s`);
        }
    }

    const textEl = $('.gs-indicator-text', indicator);
    if (textEl) {
        textEl.textContent = resumeFromTime > 0
            ? `Resuming from ${Math.floor(resumeFromTime / 60)}:${String(Math.floor(resumeFromTime % 60)).padStart(2, '0')}...`
            : 'Starting transcode...';
    }

    const job = await ghoststream.transcode({
        category_id: categoryId,
        filename: filename,
        ghosthub_base_url: `${window.location.protocol}//${window.location.host}`,
        mode: 'stream',
        format: 'hls',
        video_codec: 'h264',
        audio_codec: 'aac',
        resolution: resolution,
        hw_accel: 'auto',
        start_time: resumeFromTime,
        abr: prefs.enableABR
    });

    if (!job || job.error) {
        throw new Error(job?.error || 'Failed to start transcode');
    }

    const actualStreamStartTime = job.start_time ?? resumeFromTime;
    const isSharedStream = job.is_shared || false;

    // Update indicator with server name if load balancing is active
    if (job.server_name && textEl) {
        const serverDisplay = job.server_name.replace('ghoststream_', '').replace(/_/g, '.');
        textEl.textContent = `Transcoding on ${serverDisplay}...`;
        console.log(`[GhostStream] Job assigned to server: ${job.server_name}`);
    }

    if (isSharedStream) {
        console.log(`[GhostStream SharedStream] Joined shared stream`);
    }

    // Priority: GhostStream duration > saved duration > 0
    let sourceDuration = job.media_info?.duration || job.duration || savedDuration || 0;

    // Get stream URL
    let streamUrl = job.stream_url;
    if (!streamUrl) {
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            const status = await ghoststream.getJobStatus(job.job_id);

            if (sourceDuration === 0) {
                const statusDuration = status?.media_info?.duration || status?.duration || 0;
                if (statusDuration > 0) sourceDuration = statusDuration;
            }

            if (status?.stream_url) {
                streamUrl = status.stream_url;
                break;
            }
            if (status?.status === 'error') {
                throw new Error(status.error_message || 'Transcode failed');
            }
        }
    }

    if (!streamUrl) {
        throw new Error('Timeout waiting for stream URL');
    }

    // Start HLS playback
    await startHLSPlayback(file, container, badge, indicator, ghoststream, job, streamUrl,
        categoryId, filename, resolution, prefs, actualStreamStartTime, resumeFromTime, sourceDuration);
}

/**
 * Start HLS playback for live transcode
 * @private
 */
async function startHLSPlayback(file, container, badge, indicator, ghoststream, job, streamUrl,
    categoryId, filename, resolution, prefs, actualStreamStartTime, resumeFromTime, sourceDuration) {

    indicator.remove();

    const video = createElement('video', {
        className: 'viewer-media active ghoststream-video',
        controls: false,
        playsInline: true,
        poster: file.thumbnailUrl || '',
        dataset: {
            ghoststreamJobId: job.job_id,
            originalUrl: file.url,
            hlsTimeOffset: String(actualStreamStartTime || 0),
            hlsSourceDuration: String(sourceDuration || 0),
            hlsUserResumeTime: String(resumeFromTime || 0)
        }
    });

    // Get video end behavior from config
    const videoEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
    const isAutoPlay = isAutoPlayActive();

    // Set loop based on config and auto-play state
    // Auto-play takes precedence when active
    const shouldLoop = isAutoPlay ? false : (videoEndBehavior === 'loop');
    video.loop = shouldLoop;
    if (shouldLoop) {
        video.setAttribute('loop', 'true');
    } else {
        video.removeAttribute('loop');
    }

    video.disablePictureInPicture = false;
    video.autoPictureInPicture = true;
    video.setAttribute('autopictureinpicture', 'true');
    video.setAttribute('playsinline', 'true');

    // Add PiP support if available
    if (document.pictureInPictureEnabled) {
        attr(video, {
            onEnterPictureInPicture: () => {
                console.log('[PiP] Entered Picture-in-Picture (HLS)');
            },
            onLeavePictureInPicture: () => {
                console.log('[PiP] Left Picture-in-Picture (HLS)');
            }
        });
    }

    const posterEl = $('.ghoststream-poster', container);
    if (posterEl) posterEl.remove();
    prepend(container, video);

    const hlsPlayer = ghoststream.createHLSPlayer(video, streamUrl);
    if (!hlsPlayer) {
        throw new Error('HLS playback not supported in this browser');
    }

    try {
        await hlsPlayer.load();

        let currentJobId = job.job_id;

        // Setup auto-resume for stalls
        setupAutoResume(video, container, ghoststream, hlsPlayer, categoryId, filename, resolution, prefs,
            () => currentJobId, (id) => { currentJobId = id; });

        // Store cleanup function
        video._ghoststreamCleanup = () => {
            hlsPlayer.destroy();
            ghoststream.cancelJob(currentJobId);
        };

        // Add fullscreen support
        setupFullscreenSupport(video);

        // Setup HLS progress saving
        setupHLSProgressSaving(video, file, categoryId, actualStreamStartTime, sourceDuration);

        // Setup sync integration
        setupSyncIntegration(video);

        // Handle shared stream seeking
        handleSharedStreamSeek(video, actualStreamStartTime, resumeFromTime);

        badge.innerHTML = `${lightningIcon(14)} Transcoded`;
        badge.title = 'Playing via GhostStream';

        console.log(`[GhostStream] Transcoded playback ready for ${file.name}`);

    } catch (hlsError) {
        console.error('[GhostStream] HLS load failed:', hlsError);
        video.remove();
        throw new Error(`HLS playback failed: ${hlsError.message}`);
    }
}

/**
 * Setup auto-resume for stalled playback
 * @private
 */
function setupAutoResume(video, container, ghoststream, hlsPlayer, categoryId, filename, resolution, prefs, getJobId, setJobId) {
    let isResuming = false;
    let resumeAttempts = 0;
    const MAX_RESUME_ATTEMPTS = 3;

    const autoResumeTranscode = async () => {
        if (isResuming || resumeAttempts >= MAX_RESUME_ATTEMPTS) return;
        isResuming = true;
        resumeAttempts++;

        const hlsOffset = parseFloat(video.dataset.hlsTimeOffset) || 0;
        const resumePosition = (video.currentTime || 0) + hlsOffset;
        console.log(`[GhostStream AutoResume] Attempt ${resumeAttempts}/${MAX_RESUME_ATTEMPTS} from ${resumePosition}s`);

        const resumeIndicator = createElement('div', {
            className: 'ghoststream-resume-indicator',
            innerHTML: `<div>⚡ Resuming stream...</div><div class="ghoststream-resume-indicator__meta">From ${Math.floor(resumePosition / 60)}:${String(Math.floor(resumePosition % 60)).padStart(2, '0')}</div>`
        });
        resumeIndicator.style.cssText = `
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.8); padding: 20px 30px; border-radius: 10px;
            color: white; font-size: 16px; z-index: 100; text-align: center;
        `;
        container.appendChild(resumeIndicator);

        try {
            const newJob = await ghoststream.transcode({
                category_id: categoryId,
                filename: filename,
                ghosthub_base_url: `${window.location.protocol}//${window.location.host}`,
                mode: 'stream',
                format: 'hls',
                video_codec: 'h264',
                audio_codec: 'aac',
                resolution: resolution,
                hw_accel: 'auto',
                start_time: resumePosition,
                abr: prefs.enableABR
            });

            if (!newJob || newJob.error) {
                throw new Error(newJob?.error || 'Failed to restart transcode');
            }

            let newStreamUrl = newJob.stream_url;
            if (!newStreamUrl) {
                for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    const status = await ghoststream.getJobStatus(newJob.job_id);
                    if (status?.stream_url) { newStreamUrl = status.stream_url; break; }
                    if (status?.status === 'error') throw new Error('Resume transcode failed');
                }
            }

            if (!newStreamUrl) throw new Error('Timeout waiting for resume stream');

            setJobId(newJob.job_id);
            hlsPlayer.hls.loadSource(newStreamUrl);

            const newActualStartTime = newJob.start_time ?? resumePosition;
            video.dataset.hlsTimeOffset = String(newActualStartTime);

            video._ghoststreamCleanup = () => {
                hlsPlayer.destroy();
                ghoststream.cancelJob(getJobId());
            };

            resumeIndicator.remove();
            isResuming = false;
            console.log(`[GhostStream AutoResume] Successfully resumed from ${resumePosition}s`);

        } catch (e) {
            console.error('[GhostStream AutoResume] Failed:', e);
            resumeIndicator.innerHTML = `<div class="ghoststream-resume-indicator__error">⚠️ Resume failed</div><div class="ghoststream-resume-indicator__meta">${e.message}</div>`;
            setTimeout(() => resumeIndicator.remove(), 3000);
            isResuming = false;
        }
    };

    // Detect stall
    let stallTimeout = null;
    attr(video, {
        onWaiting: () => {
            stallTimeout = setTimeout(async () => {
                const status = await ghoststream.getJobStatus(getJobId());
                if (!status || status.status === 'error' || status.status === 'cancelled') {
                    autoResumeTranscode();
                }
            }, 10000);
        },
        onPlaying: () => {
            if (stallTimeout) clearTimeout(stallTimeout);
            resumeAttempts = 0;
        },
        onTranscodeError: async (e) => {
            console.error('[GhostStream] Transcode error during playback:', e.detail);
            if (resumeAttempts < MAX_RESUME_ATTEMPTS) {
                await autoResumeTranscode();
                return;
            }
            showPlaybackError(video, e.detail.error || 'The video could not be transcoded.');
        }
    });
}

/**
 * Setup fullscreen support for mobile/iOS
 * @private
 */
function setupFullscreenSupport(video) {
    // Attach custom controls overlay instead of standalone fullscreen button
    if (window.ragotModules?.videoControls) {
        window.ragotModules.videoControls.attachControls(video, { name: video.dataset.originalUrl || '' });
    }

    // Double-tap for mobile fullscreen
    let lastTap = 0;
    attr(video, {
        onTouchEnd: (e) => {
            const now = Date.now();
            if (now - lastTap < 300) {
                e.preventDefault();
                e.stopPropagation();

                // iOS requires direct webkitEnterFullscreen call in gesture handler
                if (typeof video.webkitEnterFullscreen === 'function') {
                    video.removeAttribute('playsinline');
                    video.removeAttribute('webkit-playsinline');
                    video.webkitEnterFullscreen();
                } else if (video.requestFullscreen) {
                    video.requestFullscreen();
                } else if (window.ragotModules?.fullscreenManager?.toggleFullscreen) {
                    window.ragotModules.fullscreenManager.toggleFullscreen(video);
                }
            }
            lastTap = now;
        }
    });

    // Double-click for desktop
    attr(video, {
        onDblClick: (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Debounce to prevent rapid clicks
            const now = Date.now();
            if (now - lastClickTime < 500) {
                return;
            }
            lastClickTime = now;

            // Check if it's safe to toggle fullscreen
            if (window.ragotModules?.fullscreenManager?.isSafeToToggleFullscreen?.()) {
                window.ragotModules.fullscreenManager.toggleFullscreen(video);
            }
        }
    });
}

/**
 * Setup HLS progress saving
 * @private
 */
function setupHLSProgressSaving(video, file, categoryId, hlsTimeOffset, sourceDuration) {
    let knownDuration = sourceDuration || 0;
    const hasSourceDuration = sourceDuration > 0;
    let lastSavedTime = 0;
    const cleanupController = new AbortController();

    const saveHLSProgress = (hlsCurrentTime, duration, isCritical = false, videoCompleted = false) => {
        if (isScrubPreviewActive(video)) return;
        const actualPosition = hlsCurrentTime + hlsTimeOffset;
        if (actualPosition <= 0) return;

        if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) {
            return;
        }

        const safeDuration = knownDuration > 0 ? knownDuration :
            (duration && isFinite(duration) && duration > 0) ? (duration + hlsTimeOffset) : 0;
        const thumbnailUrl = file.thumbnailUrl || file.url;
        const index = getViewerSession(window.ragotModules?.appState)?.activeIndex ?? 0;
        const totalCount = getKnownViewerCount(window.ragotModules?.appState);
        const activeSocket = socket || window.ragotModules?.appStore?.get?.('socket', null);

        persistPlaybackProgress({
            socket: activeSocket,
            categoryId,
            index,
            totalCount,
            mediaUrl: file.url,
            thumbnailUrl,
            timestamp: actualPosition,
            duration: safeDuration,
            videoCompleted,
            isCritical,
            optimisticLayout: isCritical
        });
    };

    attr(video, {
        onDurationChange: () => {
            if (!hasSourceDuration && video.duration && isFinite(video.duration)) {
                const fullDuration = video.duration + hlsTimeOffset;
                if (fullDuration > knownDuration) {
                    knownDuration = fullDuration;
                }
            }
        },
        onTimeUpdate: () => {
            if (Math.abs(video.currentTime - lastSavedTime) >= 5) {
                lastSavedTime = video.currentTime;
                saveHLSProgress(video.currentTime, video.duration || 0, false);
            }
        },
        onPlay: () => {
            // Request wake lock to prevent screen sleep during playback
            requestWakeLock();
        },
        onPause: () => {
            if (isScrubPreviewActive(video)) {
                releaseWakeLock();
                return;
            }
            saveHLSProgress(video.currentTime, video.duration || 0, true);
            // Release wake lock when paused
            releaseWakeLock();
        },
        onSeeked: () => saveHLSProgress(video.currentTime, video.duration || 0, true),
        onEnded: () => {
            const endDuration = knownDuration > 0 ? knownDuration : (video.duration || 0) + hlsTimeOffset;
            const endTime = endDuration > 0 ? Math.max(endDuration - hlsTimeOffset, 0) : video.currentTime;
            saveHLSProgress(endTime, video.duration || 0, true, true);
            // Release wake lock when video ends
            releaseWakeLock();
            // Handle play_next behavior
            handleVideoEndBehavior();
        },
        onEmptied: () => {
            cleanupController.abort();
        }
    });

    const saveOnExit = () => {
        const actualPosition = video.currentTime + hlsTimeOffset;
        const safeDuration = knownDuration > 0 ? knownDuration :
            ((video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration + hlsTimeOffset : 0);
        saveHLSProgress(
            video.currentTime,
            video.duration || 0,
            true,
            shouldMarkCompletedOnExit(actualPosition, safeDuration)
        );
    };
    window.addEventListener('beforeunload', saveOnExit, { signal: cleanupController.signal });
}

/**
 * Setup sync integration for HLS videos
 * @private
 */
function setupSyncIntegration(video) {
    const syncManager = window.ragotModules?.syncManager;
    if (!syncManager) return;

    const getActualSyncPosition = () => {
        const offset = parseFloat(video.dataset.hlsTimeOffset) || 0;
        return video.currentTime + offset;
    };

    attr(video, {
        onPlay: () => {
            if (isScrubPreviewActive(video)) return;
            if (!syncManager.isPlaybackSyncInProgress?.()) {
                syncManager.sendPlaybackSync?.('play', getActualSyncPosition());
            }
            // Request wake lock to prevent screen sleep during playback
            requestWakeLock();
        },
        onPause: () => {
            if (isScrubPreviewActive(video)) {
                releaseWakeLock();
                return;
            }
            if (!syncManager.isPlaybackSyncInProgress?.()) {
                syncManager.sendPlaybackSync?.('pause', getActualSyncPosition());
            }
            // Release wake lock when paused
            releaseWakeLock();
        },
        onSeeked: () => {
            if (isScrubPreviewActive(video)) return;
            if (!syncManager.isPlaybackSyncInProgress?.()) {
                syncManager.sendPlaybackSync?.('seek', getActualSyncPosition());
            }
        },
        onEnded: () => {
            // Release wake lock when video ends
            releaseWakeLock();
            // Handle play_next behavior
            handleVideoEndBehavior();
        }
    });
}

/**
 * Handle shared stream seeking
 * @private
 */
function handleSharedStreamSeek(video, hlsTimeOffset, userWantedPosition) {
    if (userWantedPosition > hlsTimeOffset + 5) {
        const seekTarget = userWantedPosition - hlsTimeOffset;
        console.log(`[HLS Resume] Seeking to HLS position ${seekTarget}s`);

        let metadataCalled = false;
        attr(video, {
            onLoadedMetadata: () => {
                if (metadataCalled) return;
                metadataCalled = true;
                if (video.duration && seekTarget < video.duration) {
                    video.currentTime = seekTarget;
                }
            }
        });
    } else if (userWantedPosition > 0 && userWantedPosition < hlsTimeOffset) {
        console.warn(`[HLS Resume] Cannot seek backwards, starting from stream position`);
    }
}

/**
 * Show transcode error in container
 * @private
 */
function showTranscodeError(file, container, error, isGhoststreamAvailable) {
    container.innerHTML = '';
    container.classList.add('ghoststream-transcode-container');

    const errorDiv = createElement('div', { className: 'ghoststream-error' });

    if (!isGhoststreamAvailable) {
        errorDiv.innerHTML = `
            <div class="ghoststream-error__content">
                <div class="ghoststream-error__icon">🎬</div>
                <strong class="ghoststream-error__title">Cannot play this video</strong>
                <small class="ghoststream-error__meta">This format (${file.name.split('.').pop().toUpperCase()}) requires transcoding.<br>No transcoding server is connected.</small>
            </div>
        `;
    } else {
        errorDiv.innerHTML = `
            <div class="ghoststream-error__content">
                <div class="ghoststream-error__icon ghoststream-error__icon--error">❌</div>
                <strong class="ghoststream-error__title">Transcode failed</strong>
                <small class="ghoststream-error__meta">${error.message || 'Unknown error'}</small>
                <button class="btn btn--primary gs-retry-btn ghoststream-error__retry">Retry</button>
            </div>
        `;

        setTimeout(() => {
            const retryBtn = $('.gs-retry-btn', errorDiv);
            if (retryBtn) {
                attr(retryBtn, { onClick: () => container.remove() });
            }
        }, 0);
    }

    container.appendChild(errorDiv);
}

/**
 * Show playback error overlay
 * @private
 */
function showPlaybackError(video, errorMessage) {
    const errorOverlay = createElement('div', {
        className: 'ghoststream-error-overlay',
        children: [
            createElement('div', {
                className: 'ghoststream-error-overlay__content',
                children: [
                    createElement('div', { className: 'ghoststream-error-overlay__icon ghoststream-error-overlay__icon--error', textContent: '⚠️' }),
                    createElement('div', { className: 'ghoststream-error-overlay__title', textContent: 'Transcoding Failed' }),
                    createElement('div', { className: 'ghoststream-error-overlay__meta', textContent: errorMessage }),
                    createElement('button', {
                        className: 'btn btn--primary ghoststream-error-overlay__retry',
                        textContent: 'Retry',
                        onClick: () => {
                            errorOverlay.remove();
                            window.location.reload();
                        }
                    })
                ]
            })
        ]
    });

    const videoContainer = video.closest('.ghoststream-container') || video.parentElement;
    if (videoContainer) {
        videoContainer.style.position = 'relative';
        videoContainer.appendChild(errorOverlay);
    }

    video.pause();
}

/**
 * Play a video using GhostStream transcoding (fallback method)
 * @param {Object} file - The file object
 * @param {HTMLElement} container - Container element
 * @param {HTMLElement} placeholder - Placeholder to replace
 */
export async function playWithTranscoding(file, container, placeholder) {
    const ghoststream = window.ragotModules?.ghoststreamManager;
    if (!ghoststream?.isAvailable?.()) {
        throw new Error('GhostStream not available');
    }

    const urlParts = file.url.split('/');
    const categoryId = urlParts[2];
    const filename = decodeURIComponent(urlParts.slice(3).join('/'));

    console.log(`[GhostStream] Starting transcode for ${filename} in category ${categoryId}`);

    const msgEl = $('.placeholder-text', placeholder);
    if (msgEl) {
        msgEl.innerHTML = '<strong>Transcoding...</strong><br><small>Preparing stream</small>';
    }

    const prefs = ghoststream.getPreferences ? ghoststream.getPreferences() : {};
    const resolution = prefs.preferredQuality || 'original';

    const job = await ghoststream.transcodeMedia(categoryId, filename, {
        mode: 'stream',
        format: 'hls',
        video_codec: 'h264',
        audio_codec: 'aac',
        resolution: resolution,
        abr: prefs.enableABR
    });

    if (!job) {
        throw new Error('Failed to start transcode job');
    }

    let streamUrl = job.stream_url;

    if (!streamUrl) {
        if (msgEl) {
            msgEl.innerHTML = `<strong>Starting stream...</strong><br><small>Waiting for first segments</small>`;
        }

        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            const status = await ghoststream.getJobStatus(job.job_id);
            if (status?.stream_url) {
                streamUrl = status.stream_url;
                break;
            }
            if (status?.status === 'error') {
                throw new Error(status.error_message || 'Transcode failed');
            }
        }
    }

    if (!streamUrl) {
        throw new Error('Timeout waiting for stream to start');
    }

    // Verify manifest
    if (msgEl) {
        msgEl.innerHTML = `<strong>Verifying stream...</strong>`;
    }
    let manifestValid = false;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            const manifestResp = await fetch(streamUrl);
            if (manifestResp.ok) {
                const manifestText = await manifestResp.text();
                if (manifestText.startsWith('#EXTM3U')) {
                    manifestValid = true;
                    break;
                }
            }
        } catch (e) {
            console.warn(`[GhostStream] Manifest check attempt ${attempt + 1} failed`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!manifestValid) {
        const finalStatus = await ghoststream.getJobStatus(job.job_id);
        throw new Error(finalStatus?.error_message || 'Stream not available - transcoding may have failed');
    }

    const videoElement = createElement('video', {
        className: 'viewer-media active ghoststream-video',
        controls: false,
        playsInline: true,
        poster: file.thumbnailUrl || '',
        dataset: { originalUrl: file.url, categoryId, ghoststreamJobId: job.job_id }
    });

    // Get video end behavior from config
    const videoEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
    const isAutoPlay = isAutoPlayActive();

    // Set loop based on config and auto-play state
    // Auto-play takes precedence when active
    const shouldLoop = isAutoPlay ? false : (videoEndBehavior === 'loop');
    videoElement.loop = shouldLoop;
    if (shouldLoop) {
        videoElement.setAttribute('loop', 'true');
    } else {
        videoElement.removeAttribute('loop');
    }

    videoElement.setAttribute('playsinline', 'true');

    if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(videoElement, placeholder);
    } else if (container) {
        container.appendChild(videoElement);
    }

    // Attach custom video controls
    setTimeout(() => {
        window.ragotModules?.videoControls?.attachControls(videoElement, file);
    }, 100);

    // Setup fullscreen support/gestures
    setupFullscreenSupport(videoElement);

    const hlsPlayer = ghoststream.createHLSPlayer(videoElement, streamUrl);
    if (!hlsPlayer) {
        throw new Error('HLS playback not supported in this browser');
    }

    try {
        await hlsPlayer.load();
        videoElement.muted = false;
        console.log('[GhostStream] Transcoded video playing');
    } catch (e) {
        console.error('[GhostStream] HLS playback error:', e);
        hlsPlayer.destroy();
        throw e;
    }

    videoElement._ghoststreamCleanup = () => {
        hlsPlayer.destroy();
        ghoststream.cancelJob(job.job_id);
    };

    return videoElement;
}
