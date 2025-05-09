/**
 * Event Handlers Module
 * Handles touch and keyboard event handling for media navigation
 */

import { app, tiktokContainer } from '../core/app.js';
import { navigateMedia } from './mediaNavigation.js';

// Touch event variables
let startX = 0; // Added for horizontal swipe
let startY = 0;
let isSwiping = false;
const swipeThreshold = 50;
let lastTap = 0;
const doubleTapDelay = 300; // ms

// Mouse wheel debounce variables
let wheelDebounceTimeout;
const WHEEL_DEBOUNCE_DELAY = 300; // ms

// Event handler functions
let handleTouchStart, handleTouchMove, handleTouchEnd, handleKeyDown;
// No need to declare handleMouseWheel here if it's a direct function definition

/**
 * Setup swipe and keyboard navigation for media
 */
function setupMediaNavigation() {
    // Remove existing event listeners if any
    document.body.removeEventListener('touchstart', handleTouchStart);
    document.body.removeEventListener('touchmove', handleTouchMove);
    document.body.removeEventListener('touchend', handleTouchEnd);
    document.removeEventListener('keydown', handleKeyDown);

    const tiktokViewerElement = document.getElementById('tiktok-container');
    if (tiktokViewerElement) {
        tiktokViewerElement.removeEventListener('wheel', handleMouseWheel);
    }

    // Define touch start handler
    handleTouchStart = function(e) {
        // Ignore touch events on the chat container
        if (e.target.closest('#chat-container')) {
            console.log('touchstart ignored: target is chat container');
            return;
        }
        
        if (tiktokContainer.classList.contains('hidden')) return;
        console.log('touchstart event fired on body');
        if (e.target.closest('.media-controls, .back-button')) {
            console.log('touchstart ignored: target is controls/back button');
            return;
        }
        
        // Check if we've recently exited fullscreen mode
        if (window.fullscreenExited) {
            console.log('touchstart ignored: recently exited fullscreen');
            return;
        }
        
        startX = e.touches[0].clientX; // Record startX
        startY = e.touches[0].clientY;
        isSwiping = true;
        console.log(`touchstart: startX = ${startX}, startY = ${startY}`); // Updated log
        
        // Pause current video during swipe interaction
        const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
        if (activeElement && activeElement.tagName === 'VIDEO') {
            activeElement.pause();
        }
    };

    // Define touch move handler
    handleTouchMove = function(e) {
        // Ignore touch events on the chat container
        if (e.target.closest('#chat-container')) {
            return;
        }
        
        if (tiktokContainer.classList.contains('hidden') || !isSwiping) return;
        
        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        // Only prevent default if we're actually swiping significantly in either direction
        if (Math.abs(currentY - startY) > 10 || Math.abs(currentX - startX) > 10) {
            e.preventDefault();
        }
    };

    // Define touch end handler
    handleTouchEnd = function(e) {
        // Ignore touch events on the chat container
        if (e.target.closest('#chat-container')) {
            console.log('touchend ignored: target is chat container');
            return;
        }
        
        if (tiktokContainer.classList.contains('hidden')) return;
        console.log('touchend event fired on body');
        if (!isSwiping) {
            console.log('touchend ignored: isSwiping is false');
            return;
        }
        isSwiping = false;
        const endX = e.changedTouches[0].clientX; // Record endX
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX; // Calculate horizontal difference
        const diffY = startY - endY; // Vertical difference (original logic)
        console.log(`touchend: endX = ${endX}, endY = ${endY}, diffX = ${diffX}, diffY = ${diffY}`); // Updated log

        // Check for double tap
        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;
        
        if (tapLength < doubleTapDelay && tapLength > 0) {
            // Double tap detected
            console.log('Double tap detected');
            const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
            if (activeElement && activeElement.tagName === 'VIDEO') {
                // Toggle fullscreen on double tap
                window.appModules.fullscreenManager.toggleFullscreen(activeElement);
                e.preventDefault();
            }
        } else {
            const absDiffX = Math.abs(diffX);
            const absDiffY = Math.abs(diffY);

            // Determine dominant swipe direction
            if (absDiffX > swipeThreshold && absDiffX > absDiffY) { // Horizontal swipe is dominant
                if (diffX > 0) { // Swipe Right (Refresh)
                    console.log('Swipe Right (Refresh) detected');
                    if (!app.state.navigationDisabled && !e.target.closest('.media-controls, .back-button')) {
                        window.location.reload(); // Changed to refresh the page
                    } else {
                        console.log('Swipe Right (Refresh) ignored: navigation disabled or target is controls/back button');
                        // Resume video if back navigation is ignored
                        const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                        if (activeElement && activeElement.tagName === 'VIDEO') {
                            activeElement.loop = true;
                            activeElement.setAttribute('loop', 'true');
                            activeElement.play().catch(err => console.error("Resume play failed:", err));
                        }
                    }
                } else { // Swipe Left
                    console.log('Swipe Left detected (no action assigned), resuming video');
                    // No action for swipe left, resume video
                    const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                    if (activeElement && activeElement.tagName === 'VIDEO') {
                        activeElement.loop = true;
                        activeElement.setAttribute('loop', 'true');
                        activeElement.play().catch(err => console.error("Resume play failed:", err));
                    }
                }
            } else if (absDiffY > swipeThreshold && absDiffY >= absDiffX) { // Vertical swipe is dominant or equal
                if (app.state.navigationDisabled) {
                    console.log('Vertical swipe navigation ignored: user is a guest in sync mode');
                    // Still allow tapping to play/pause
                    const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                    if (activeElement && activeElement.tagName === 'VIDEO') {
                        activeElement.loop = true;
                        activeElement.setAttribute('loop', 'true');
                        if (activeElement.paused) {
                            activeElement.play().catch(err => console.error("Resume play failed:", err));
                        } else {
                            activeElement.pause();
                        }
                    }
                } else if (diffY > swipeThreshold) {
                    console.log('Swipe Up detected');
                    navigateMedia('next', e);
                } else if (diffY < -swipeThreshold) {
                    console.log('Swipe Down detected');
                    navigateMedia('prev', e);
                } else {
                     // This case should ideally not be reached if absDiffY > swipeThreshold
                    console.log('Vertical swipe threshold met but no direction, resuming video');
                    const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                    if (activeElement && activeElement.tagName === 'VIDEO') {
                        activeElement.loop = true;
                        activeElement.setAttribute('loop', 'true');
                        activeElement.play().catch(err => console.error("Resume play failed:", err));
                    }
                }
            } else {
                // No significant swipe (tap or minor movement), toggle play/pause
                console.log('Swipe threshold not met or no dominant swipe, treating as tap to play/pause');
                const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                if (activeElement && activeElement.tagName === 'VIDEO') {
                    activeElement.loop = true;
                    activeElement.setAttribute('loop', 'true');
                    if (activeElement.paused) {
                        activeElement.play().catch(err => console.error("Resume play failed:", err));
                    } else {
                        activeElement.pause();
                    }
                }
            }
        }
        
        lastTap = currentTime;
    };

    // Define key down handler
    handleKeyDown = function(e) {
        if (tiktokContainer.classList.contains('hidden')) {
            return;
        }

        // Check if navigation is disabled (for guests in sync mode)
        if (app.state.navigationDisabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            console.log('Keyboard navigation ignored: user is a guest in sync mode');
            e.preventDefault();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateMedia('next', e);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateMedia('prev', e);
         } //else if (e.key === 'f') {
        //     // 'f' key toggles fullscreen
        //     e.preventDefault();
        //     const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
        //     if (activeElement && activeElement.tagName === 'VIDEO') {
        //         window.appModules.fullscreenManager.toggleFullscreen(activeElement);
        //     }
        // }
    };

    // Add new event listeners
    document.body.addEventListener('touchstart', handleTouchStart, { passive: false }); // passive:false because preventDefault is used
    document.body.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.body.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('keydown', handleKeyDown);

    if (tiktokViewerElement) {
        tiktokViewerElement.addEventListener('wheel', handleMouseWheel, { passive: false });
    }
}

// Debounce function for media navigation via wheel
function debouncedNavigateMedia(direction, event) {
    clearTimeout(wheelDebounceTimeout);
    wheelDebounceTimeout = setTimeout(() => {
        navigateMedia(direction, event);
    }, WHEEL_DEBOUNCE_DELAY);
}

// Mouse wheel event handler
function handleMouseWheel(e) {
    const tiktokViewer = document.getElementById('tiktok-container'); // Get fresh reference
    if (!tiktokViewer || tiktokViewer.classList.contains('hidden')) {
        return; // Only act if media viewer is active
    }

    // Prevent default page scrolling behavior
    e.preventDefault();

    // Respect navigationDisabled state
    if (app.state.navigationDisabled) {
        console.log('Mouse wheel navigation ignored: navigation is disabled.');
        return;
    }
    
    if (e.deltaY > 0) { // Scrolling down
        debouncedNavigateMedia('next', e);
    } else if (e.deltaY < 0) { // Scrolling up
        debouncedNavigateMedia('prev', e);
    }
}

// Export the event handlers and setup function
export {
    setupMediaNavigation,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleKeyDown
    // handleMouseWheel is used internally by the event listener setup
};
