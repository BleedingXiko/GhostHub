/**
 * Event Handlers Module
 * Handles touch and keyboard event handling for media navigation
 */

import { app, tiktokContainer } from '../core/app.js';
import { navigateMedia } from './mediaNavigation.js';

// Touch event variables
let startY = 0;
let isSwiping = false;
const swipeThreshold = 50;
let lastTap = 0;
const doubleTapDelay = 300; // ms

// Event handler functions
let handleTouchStart, handleTouchMove, handleTouchEnd, handleKeyDown;

/**
 * Setup swipe and keyboard navigation for media
 */
function setupMediaNavigation() {
    // Remove existing event listeners if any
    document.body.removeEventListener('touchstart', handleTouchStart);
    document.body.removeEventListener('touchmove', handleTouchMove);
    document.body.removeEventListener('touchend', handleTouchEnd);
    document.removeEventListener('keydown', handleKeyDown);

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
        
        startY = e.touches[0].clientY;
        isSwiping = true;
        console.log(`touchstart: startY = ${startY}`);
        
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
        // Only prevent default if we're actually swiping
        if (Math.abs(e.touches[0].clientY - startY) > 10) {
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
        const endY = e.changedTouches[0].clientY;
        const diffY = startY - endY;
        console.log(`touchend: endY = ${endY}, diffY = ${diffY}`);

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
        // Vertical Swipe - Navigate Media (only if navigation is not disabled)
        if (app.state.navigationDisabled) {
            console.log('Swipe navigation ignored: user is a guest in sync mode');
            // Still allow tapping to play/pause
            const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
            if (activeElement && activeElement.tagName === 'VIDEO') {
                // Ensure loop is set before playing
                activeElement.loop = true;
                activeElement.setAttribute('loop', 'true');
                
                if (activeElement.paused) {
                    activeElement.play().catch(e => console.error("Resume play failed:", e));
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
            console.log('Swipe threshold not met, resuming video');
            // No vertical threshold met, resume video
            const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
            if (activeElement && activeElement.tagName === 'VIDEO') {
                // Ensure loop is set before playing
                activeElement.loop = true;
                activeElement.setAttribute('loop', 'true');
                activeElement.play().catch(e => console.error("Resume play failed:", e));
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
        } else if (e.key === 'f') {
            // 'f' key toggles fullscreen
            e.preventDefault();
            const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
            if (activeElement && activeElement.tagName === 'VIDEO') {
                window.appModules.fullscreenManager.toggleFullscreen(activeElement);
            }
        }
    };

    // Add new event listeners
    document.body.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.body.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.body.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('keydown', handleKeyDown);
}

// Export the event handlers and setup function
export {
    setupMediaNavigation,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleKeyDown
};
