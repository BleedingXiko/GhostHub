/**
 * Shared Gesture Utilities
 * Provides swipe-right-to-go-back and double-tap-fullscreen for ALL layouts
 *
 * These gestures work on the media viewer (#media-viewer) regardless of which layout is active.
 * - Swipe right: Go back to categories
 * - Double tap: Toggle fullscreen on videos
 */
import { Module, $ } from '../libs/ragot.esm.min.js';

// Touch event state
let startX = 0;
let startY = 0;
let isSwiping = false;
let lastTap = 0;
let hasMoved = false;

// iOS needs longer double-tap window
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const doubleTapDelay = isIOS ? 400 : 300;
const swipeThreshold = 50;

// Handler references for cleanup
let handleTouchStart = null;
let handleTouchMove = null;
let handleTouchEnd = null;

// Track if gestures are attached
let gesturesAttached = false;
let gesturesLifecycle = null;

/**
 * Check if the media viewer is visible
 */
function isViewerVisible() {
    const mediaViewer = $('#media-viewer');
    return mediaViewer && !mediaViewer.classList.contains('hidden');
}

/**
 * Get the active media element in the viewer
 */
function getActiveMediaElement() {
    const mediaViewer = $('#media-viewer');
    if (!mediaViewer) return null;
    return $('.viewer-media.active', mediaViewer);
}

/**
 * Handle double-tap to fullscreen on video
 */
function handleDoubleTapFullscreen(e) {
    const activeElement = getActiveMediaElement();
    if (!activeElement || activeElement.tagName !== 'VIDEO') return false;

    e.preventDefault();
    e.stopPropagation();

    // Try native iOS fullscreen first
    if (typeof activeElement.webkitEnterFullscreen === 'function') {
        activeElement.removeAttribute('playsinline');
        activeElement.removeAttribute('webkit-playsinline');
        activeElement.webkitEnterFullscreen();
    } else if (activeElement.requestFullscreen) {
        activeElement.requestFullscreen();
    } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
    }

    return true;
}

/**
 * Handle swipe right to go back to categories
 */
function handleSwipeRightGoBack() {
    // Check navigation module first (new location)
    if (window.ragotModules?.mediaNavigation?.goBackToCategories) {
        window.ragotModules.mediaNavigation.goBackToCategories();
        return true;
    }
    return false;
}

/**
 * Setup shared gesture handlers for media viewer
 * These work for ALL layouts - handles swipe-right and double-tap
 */
export function setupSharedGestures() {
    if (gesturesAttached) return;
    if (!gesturesLifecycle) {
        gesturesLifecycle = new Module();
    }
    gesturesLifecycle.start();

    handleTouchStart = (e) => {
        // Skip if touching chat, modals, or theme builder overlay
        if (e.target.closest('#chat-container')) return;
        if (e.target.closest('.modal:not(.hidden)')) return;
        if (e.target.closest('.gh-theme-builder')) return;

        // Only handle when viewer is visible
        if (!isViewerVisible()) return;

        // Skip if fullscreen was just exited
        if (window.ragotModules?.fullscreenManager?.hasRecentFullscreenExit?.()) return;

        // Relaxed exclusion: Allow swipes on center controls/skip buttons, but keep exclusion for bottom bar (seeking)
        // and back button/media/download controls to prevent accidental triggers.
        if (e.target.closest('.media-controls, .gh-back-btn, .vc-bottom, .download-btn-container')) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isSwiping = true;
        hasMoved = false;
    };

    handleTouchMove = (e) => {
        if (e.target.closest('#chat-container')) return;
        if (e.target.closest('.modal:not(.hidden)')) return;
        if (e.target.closest('.gh-theme-builder')) return;
        if (!isViewerVisible() || !isSwiping) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const diffX = Math.abs(currentX - startX);
        const diffY = Math.abs(currentY - startY);

        // Detect movement threshold
        if (!hasMoved && (diffY > 10 || diffX > 10)) {
            hasMoved = true;
        }

        // Prevent browser scrolling/gestures once we've moved enough to be a swipe
        if (hasMoved) {
            e.preventDefault();
        }
    };

    handleTouchEnd = (e) => {
        if (e.target.closest('#chat-container')) return;
        if (e.target.closest('.modal:not(.hidden)')) return;
        if (e.target.closest('.gh-theme-builder')) return;
        if (!isViewerVisible()) return;

        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;

        // Check for double tap (only if not moved)
        if (tapLength < doubleTapDelay && tapLength > 0 && !hasMoved) {
            if (handleDoubleTapFullscreen(e)) {
                lastTap = currentTime;
                isSwiping = false;
                return;
            }
        }

        lastTap = currentTime;

        if (!isSwiping) return;
        isSwiping = false;

        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX;
        const diffY = startY - endY;
        const absDiffX = Math.abs(diffX);
        const absDiffY = Math.abs(diffY);

        // Photo viewer: intercept swipe-right to close, block other gestures
        const pv = window.ragotModules?.photoViewer;
        if (pv?.isPhotoViewerOpen?.()) {
            isSwiping = false; // Always clear swiping flag
            // Block swipe gesture when zoomed in or panning
            if (pv.isZoomed?.() || pv.isPanningPhoto?.()) {
                return;
            }

            // Swipe right to close photo viewer
            if (absDiffX > swipeThreshold && absDiffX > absDiffY && diffX > 0) {
                pv.closePhotoViewer();
            }
            return;
        }

        // Vertical swipe for navigation (up = next, down = prev)
        if (absDiffY > swipeThreshold && absDiffY > absDiffX) {
            // IGNORE vertical swipes if a video is currently playing (active viewer)
            // This prevents accidental navigation while trying to reach for volume/controls
            if (window.ragotModules?.videoControls?.isControlsAttached?.()) {
                isSwiping = false;
                return;
            }

            if (diffY > swipeThreshold) {
                window.ragotModules?.mediaNavigation?.navigateMedia('next');
            } else if (diffY < -swipeThreshold) {
                window.ragotModules?.mediaNavigation?.navigateMedia('prev');
            }
            isSwiping = false; // Clear flag
            return;
        }

        // Swipe right to go back (horizontal swipe, right direction)
        if (absDiffX > swipeThreshold && absDiffX > absDiffY && diffX > 0) {
            handleSwipeRightGoBack();
        }

        isSwiping = false; // Clear flag at the end
    };

    gesturesLifecycle.on(document.body, 'touchstart', handleTouchStart, { passive: false });
    gesturesLifecycle.on(document.body, 'touchmove', handleTouchMove, { passive: false });
    gesturesLifecycle.on(document.body, 'touchend', handleTouchEnd, { passive: false });

    gesturesAttached = true;
}

/**
 * Cleanup shared gesture handlers
 */
export function cleanupSharedGestures() {
    if (!gesturesAttached) return;
    if (gesturesLifecycle) {
        gesturesLifecycle.stop();
    }

    handleTouchStart = null;
    handleTouchMove = null;
    handleTouchEnd = null;
    gesturesAttached = false;
}

/**
 * Check if shared gestures are currently attached
 */
export function areSharedGesturesAttached() {
    return gesturesAttached;
}
