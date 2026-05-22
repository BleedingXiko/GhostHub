/**
 * Video Player Module
 * Creates actual video elements for playback with sync and error handling.
 * 
 * @module media/videoPlayer
 */

import { isAutoPlayActive } from '../playback/autoPlay.js';
import {
    requiresTranscoding,
    createCannotPlayElement,
    createPlaceholderElement
} from './elementFactory.js';
import { createTranscodingVideoElement } from './transcodingPlayer.js';
import { requestWakeLock, releaseWakeLock } from '../../utils/wakeLock.js';
import { createElement, attr, $ } from '../../libs/ragot.esm.min.js';
import { isScrubPreviewActive } from './scrubPreviewState.js';
import { getKnownViewerCount, getViewerSession } from './viewerState.js';

/**
 * Create the actual HTMLVideoElement for playback.
 * Handles codec detection and GhostStream fallback.
 * 
 * @param {Object} file - The file object containing media details
 * @param {boolean} isActive - Whether this video is the currently active one
 * @returns {HTMLVideoElement|HTMLElement} The configured element
 */
export function createActualVideoElement(file, isActive) {
    const needsTranscoding = requiresTranscoding(file.name);
    const ghoststream = window.ragotModules?.ghoststreamManager;
    const ghoststreamAvailable = ghoststream?.isAvailable?.();

    // Block incompatible formats when GhostStream unavailable
    if (needsTranscoding && !ghoststreamAvailable) {
        console.log(`[Playback] BLOCKED: ${file.name} requires transcoding but GhostStream unavailable`);
        return createCannotPlayElement(file, 'No transcoding server connected.');
    }

    // Proactive transcoding check (Plex-like)
    if (ghoststreamAvailable && ghoststream?.analyzePlayback) {
        const decision = ghoststream.analyzePlayback(file.name);

        if (decision.mode === 'transcode' && !decision.canDirectPlay) {
            console.log(`[GhostStream] Proactive transcode for ${file.name}: ${decision.reason}`);
            return createTranscodingVideoElement(file, isActive, decision);
        }
    }

    const mediaElement = createElement('video', {
        onPlay: () => {
            requestWakeLock();
            if (isScrubPreviewActive(mediaElement)) return;
            // Sync: Broadcast play
            if (!window.ragotModules?.syncManager?.isPlaybackSyncInProgress?.()) {
                window.ragotModules?.syncManager?.sendPlaybackSync?.('play', mediaElement.currentTime);
            }
        },
        onPause: () => {
            releaseWakeLock();
            if (isScrubPreviewActive(mediaElement)) return;
            // Sync: Broadcast pause
            if (!window.ragotModules?.syncManager?.isPlaybackSyncInProgress?.()) {
                window.ragotModules?.syncManager?.sendPlaybackSync?.('pause', mediaElement.currentTime);
            }
        },
        onEnded: () => {
            // Release wake lock when video ends
            releaseWakeLock();

            // Handle 'play_next' behavior (if not in auto-play mode)
            const currentEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
            const isCurrentlyAutoPlay = isAutoPlayActive();

            if (currentEndBehavior === 'play_next' && !isCurrentlyAutoPlay) {
                // Check if next media is available
                const appState = window.ragotModules?.appState;
                const currentIndex = getViewerSession(appState)?.activeIndex;
                const totalMedia = getKnownViewerCount(appState);

                if (currentIndex !== undefined && currentIndex < totalMedia - 1) {
                    // Next media is available, play it
                    console.log('[VideoPlayer] Playing next media (index:', currentIndex + 1, ')');
                    const navigateMediaFn = window.ragotModules?.mediaNavigation?.navigateMedia;
                    if (navigateMediaFn) {
                        navigateMediaFn('next');
                    }
                } else {
                    // No next media available, stop (do nothing - video will stay at end frame)
                    console.log('[VideoPlayer] No next media available, stopping playback');
                }
            }
        },
        onSeeked: () => {
            if (isScrubPreviewActive(mediaElement)) return;
            if (!window.ragotModules?.syncManager?.isPlaybackSyncInProgress?.()) {
                window.ragotModules?.syncManager?.sendPlaybackSync?.('seek', mediaElement.currentTime);
            }
        }
    });

    // Get video end behavior from config
    const videoEndBehavior = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.VIDEO_END_BEHAVIOR || 'loop';
    const isAutoPlay = isAutoPlayActive();

    // Set loop based on config and auto-play state
    // Auto-play takes precedence when active
    const shouldLoop = isAutoPlay ? false : (videoEndBehavior === 'loop');
    mediaElement.loop = shouldLoop;
    if (shouldLoop) {
        mediaElement.setAttribute('loop', 'true');
    } else {
        mediaElement.removeAttribute('loop');
    }

    // Start muted - required for robust sync/autoplay
    mediaElement.muted = true;
    mediaElement.preload = 'auto'; // Must be auto/metadata for sync listeners to fire
    mediaElement.removeAttribute('autoplay');

    // Custom controls overlay replaces native controls on all platforms
    mediaElement.controls = false;
    mediaElement.setAttribute('controlsList', 'nodownload');

    // Always set playsinline initially for tap-to-play functionality
    // We'll remove it dynamically when entering fullscreen on iOS
    mediaElement.playsInline = true;
    mediaElement.setAttribute('playsinline', 'true');
    mediaElement.setAttribute('webkit-playsinline', 'true');

    // Performance attributes
    mediaElement.setAttribute('disableRemotePlayback', 'true');
    mediaElement.disablePictureInPicture = false;
    mediaElement.autoPictureInPicture = true;
    mediaElement.setAttribute('autopictureinpicture', 'true');

    // Add PiP support if available
    if (document.pictureInPictureEnabled) {
        attr(mediaElement, {
            onEnterPictureInPicture: () => {
                console.log('[PiP] Entered Picture-in-Picture');
            },
            onLeavePictureInPicture: () => {
                console.log('[PiP] Left Picture-in-Picture');
            }
        });
    }

    // Poster
    if (file.thumbnailUrl) {
        mediaElement.poster = file.thumbnailUrl;
    } else {
        mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
    }

    if (isActive) {
        mediaElement.setAttribute('fetchpriority', 'high');
    }

    const placeholder = createPlaceholderElement(file, 'video');

    // Error handling with codec detection
    attr(mediaElement, {
        onError: function () {
            const error = mediaElement.error;
            console.error(`Error loading video: ${file.url}`, error);

            const isCodecError = error && (error.code === 3 ||
                (error.message && error.message.includes('DECODE')));

            if (isCodecError) {
                console.warn('Video codec not supported by browser.');

                const gs = window.ragotModules?.ghoststreamManager;
                if (gs?.isAvailable?.()) {
                    console.log('[GhostStream] Codec error, attempting auto-transcode...');

                    const container = mediaElement.closest('.viewer-media-item') || mediaElement.parentNode;
                    if (container && mediaElement.parentNode) {
                        mediaElement.remove();
                        const transcodingEl = createTranscodingVideoElement(file, isActive, {
                            mode: 'transcode',
                            reason: 'Audio codec not supported (AC3/DTS/etc)',
                            canDirectPlay: false
                        });
                        container.appendChild(transcodingEl);
                    }
                    return;
                }

                $('.placeholder-text', placeholder)?.remove();
                const msg = createElement('div', { className: 'placeholder-text', innerHTML: '<strong>Cannot play this video</strong><br><small>Format not supported (may contain AC3/DTS audio).</small>' });
                msg.style.cssText = 'text-align:center;padding:10px;color:#fff;';
                placeholder.appendChild(msg);
                if (mediaElement.parentNode) {
                    mediaElement.parentNode.replaceChild(placeholder, mediaElement);
                }
                return;
            }

            let retries = parseInt(mediaElement.getAttribute('data-retries') || '0');
            const maxRetries = 2;

            if (retries < maxRetries) {
                retries++;
                mediaElement.setAttribute('data-retries', retries);
                mediaElement.src = `${file.url}${file.url.includes('?') ? '&' : '?'}retry=${retries}&_t=${Date.now()}`;
                mediaElement.load();
            } else {
                if (mediaElement.parentNode) {
                    mediaElement.parentNode.replaceChild(placeholder, mediaElement);
                }
            }
        }
    });

    // Attach custom controls overlay for active videos
    if (isActive) {
        attr(mediaElement, {
            onLoadedData: () => {
                setTimeout(() => {
                    window.ragotModules?.videoControls?.attachControls(mediaElement, file);
                }, 100);
            }
        });

        // Double-tap to toggle fullscreen (mobile)
        let lastTap = 0;
        attr(mediaElement, {
            onTouchEnd: (e) => {
                const now = Date.now();
                if (now - lastTap < 300) {
                    e.preventDefault();
                    e.stopPropagation();

                    // iOS requires direct webkitEnterFullscreen call in gesture handler
                    if (typeof mediaElement.webkitEnterFullscreen === 'function') {
                        mediaElement.removeAttribute('playsinline');
                        mediaElement.removeAttribute('webkit-playsinline');
                        mediaElement.webkitEnterFullscreen();
                    } else if (mediaElement.requestFullscreen) {
                        mediaElement.requestFullscreen();
                    } else if (window.ragotModules?.fullscreenManager?.toggleFullscreen) {
                        window.ragotModules.fullscreenManager.toggleFullscreen(mediaElement);
                    }
                }
                lastTap = now;
            }
        });

        // Double-click to toggle fullscreen (desktop)
        let lastClickTime = 0;
        attr(mediaElement, {
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
                    window.ragotModules.fullscreenManager.toggleFullscreen(mediaElement);
                }
            }
        });
    }

    mediaElement.src = file.url;

    return mediaElement;
}
