/**
 * Auto-Play Manager
 * Handles automatic media advancement for slideshow-like playback.
 *
 * @module playback/autoPlay
 */

import { Module, createElement, attr, $, $$ } from '../../libs/ragot.esm.min.js';
import { selectRecordAt } from '../media/selectors.js';
import { getViewerSession } from '../media/viewerState.js';

// Auto-Play State
const autoPlayState = {
    active: false,
    interval: 10000, // Default 10s for images
    timer: null
};

// Reference to navigate function (set via init)
let navigateMediaFn = null;
let autoPlayLifecycle = null;

class AutoPlayLifecycle extends Module {
    constructor() {
        super();
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
    }

    onStart() {
        this.bindFullscreenListeners();
    }

    bindFullscreenListeners() {
        // Rebind on every init to stay resilient across test/DOM resets without duplicating handlers.
        this.off(document, 'fullscreenchange', this.handleFullscreenChange);
        this.off(document, 'webkitfullscreenchange', this.handleFullscreenChange);
        this.off(document, 'mozfullscreenchange', this.handleFullscreenChange);
        this.on(document, 'fullscreenchange', this.handleFullscreenChange);
        this.on(document, 'webkitfullscreenchange', this.handleFullscreenChange);
        this.on(document, 'mozfullscreenchange', this.handleFullscreenChange);
    }

    handleFullscreenChange() {
        if (!autoPlayState.active) return;

        const fullscreenEl = document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement;

        if (fullscreenEl && fullscreenEl.tagName === 'VIDEO') {
            fullscreenEl.loop = false;
            fullscreenEl.removeAttribute('loop');

            attr(fullscreenEl, {
                onEnded: () => {
                if (autoPlayState.active && navigateMediaFn) {
                    const exitFullscreen = document.exitFullscreen ||
                        document.webkitExitFullscreen ||
                        document.mozCancelFullScreen;
                    if (exitFullscreen) {
                        exitFullscreen.call(document).then(() => {
                            navigateMediaFn('next');
                        }).catch(() => {
                            navigateMediaFn('next');
                        });
                    } else {
                        navigateMediaFn('next');
                    }
                }
            }
        });
        }
    }
}

/**
 * Initialize the auto-play manager
 * @param {Function} navigateMedia - The navigation function to call when advancing
 */
export function initAutoPlayManager(navigateMedia) {
    navigateMediaFn = navigateMedia;
    if (!autoPlayLifecycle) {
        autoPlayLifecycle = new AutoPlayLifecycle();
    }
    autoPlayLifecycle.start();
    if (autoPlayLifecycle._isMounted) {
        autoPlayLifecycle.bindFullscreenListeners();
    }
}

/**
 * Show or hide the auto-play indicator
 * @param {boolean} show
 */
function updateAutoPlayIndicator(show) {
    let indicator = $('#autoplay-indicator');

    if (show) {
        if (!indicator) {
            indicator = createElement('div', {
                id: 'autoplay-indicator',
                innerHTML: '▶',
                style: {
                    position: 'fixed',
                    top: '12px',
                    right: '12px',
                    width: '28px',
                    height: '28px',
                    background: 'rgba(0,0,0,0.5)',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#4ade80',
                    fontSize: '12px',
                    zIndex: '1000',
                    pointerEvents: 'none',
                    animation: 'autoplay-pulse 2s ease-in-out infinite'
                }
            });
            if (!$('#autoplay-styles')) {
                const style = createElement('style', {
                    id: 'autoplay-styles',
                    textContent: `
                    @keyframes autoplay-pulse {
                        0%, 100% { opacity: 0.7; }
                        50% { opacity: 1; }
                    }
                `
                });
                document.head.appendChild(style);
            }
            document.body.appendChild(indicator);
        }
        indicator.style.display = 'flex';
    } else if (indicator) {
        indicator.style.display = 'none';
    }
}

/**
 * Start or Stop Auto-Play mode
 * @param {number|boolean} interval - Interval in seconds (or false to stop)
 * @returns {string} - 'started' or 'stopped'
 */
export function toggleAutoPlay(interval) {
    if (interval === false || interval === 'stop') {
        autoPlayState.active = false;
        if (autoPlayLifecycle && autoPlayState.timer) {
            autoPlayLifecycle.clearTimeout(autoPlayState.timer);
        } else {
            clearTimeout(autoPlayState.timer);
        }
        updateAutoPlayIndicator(false);
        console.log("Auto-Play Stopped");
        return "stopped";
    }

    autoPlayState.active = true;
    if (typeof interval === 'number' && interval > 0) {
        autoPlayState.interval = interval * 1000;
    }

    updateAutoPlayIndicator(true);
    console.log(`Auto-Play Started (Image Interval: ${autoPlayState.interval / 1000}s)`);

    const viewer = getViewerSession(window.ragotModules?.appState);
    if (viewer) {
        handleAutoPlay(viewer.activeIndex);
    }

    return "started";
}

/**
 * Handle Auto-Play logic for the current item
 * @param {number} index - Current media index
 */
export function handleAutoPlay(index) {
    if (autoPlayLifecycle && autoPlayState.timer) {
        autoPlayLifecycle.clearTimeout(autoPlayState.timer);
    } else {
        clearTimeout(autoPlayState.timer);
    }
    if (!autoPlayState.active) return;

    const viewer = getViewerSession(window.ragotModules?.appState);
    const currentFile = viewer ? selectRecordAt(viewer.viewKey, index) : null;
    if (!currentFile) return;

    const mediaViewer = window.ragotModules?.appDom?.mediaViewer;

    if (currentFile.type === 'image') {
        const schedule = autoPlayLifecycle
            ? (cb, ms) => autoPlayLifecycle.timeout(cb, ms)
            : (cb, ms) => setTimeout(cb, ms);
        autoPlayState.timer = schedule(() => {
            if (autoPlayState.active && navigateMediaFn) {
                navigateMediaFn('next');
            }
        }, autoPlayState.interval);
    } else if (currentFile.type === 'video') {
        let videoEl = null;

        const activeEl = mediaViewer ? $(`.viewer-media.active[data-index="${index}"]`, mediaViewer) : null;
        if (activeEl) {
            if (activeEl.classList.contains('video-thumbnail-container')) {
                const didActivate = window.ragotModules?.mediaNavigation?.activateVideoThumbnail?.(activeEl) === true;
                if (!didActivate) {
                    console.warn('Auto-play: Failed to activate thumbnail for video playback');
                }
                return;
            } else if (activeEl.tagName === 'VIDEO') {
                videoEl = activeEl;
            }
        }

        if (!videoEl) {
            const fullscreenEl = document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement;
            if (fullscreenEl && fullscreenEl.tagName === 'VIDEO') {
                videoEl = fullscreenEl;
            }
        }

        if (!videoEl) {
            const allVideos = $$('video');
            for (const v of allVideos) {
                if (!v.paused && !v.ended) {
                    videoEl = v;
                    break;
                }
            }
        }

        if (videoEl) {
            console.log('Auto-play: Found video element, disabling loop');
            videoEl.loop = false;
            videoEl.removeAttribute('loop');

            attr(videoEl, {
                onEnded: () => {
                console.log('Auto-play: Video ended, advancing to next');
                if (autoPlayState.active && navigateMediaFn) {
                    navigateMediaFn('next');
                }
            }
            });

            if (videoEl.paused) {
                videoEl.play().catch(e => console.warn("Auto-play video failed:", e));
            }
        }
    }
}

/**
 * Check if auto-play is currently active
 * @returns {boolean}
 */
export function isAutoPlayActive() {
    return autoPlayState.active;
}

/**
 * Get the current auto-play interval in milliseconds
 * @returns {number}
 */
export function getAutoPlayInterval() {
    return autoPlayState.interval;
}

export function cleanupAutoPlayManager() {
    if (autoPlayLifecycle && autoPlayState.timer) {
        autoPlayLifecycle.clearTimeout(autoPlayState.timer);
    } else {
        clearTimeout(autoPlayState.timer);
    }
    autoPlayState.timer = null;
    autoPlayState.active = false;
    updateAutoPlayIndicator(false);
    if (autoPlayLifecycle) {
        autoPlayLifecycle.stop();
        autoPlayLifecycle = null;
    }
}

export { updateAutoPlayIndicator };
