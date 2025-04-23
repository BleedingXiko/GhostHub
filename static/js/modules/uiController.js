/**
 * UI Controller Module
 * Handles UI-related functionality like controls and indicators
 */

import { app, tiktokContainer, MOBILE_DEVICE } from '../core/app.js';

/**
 * Setup controls for media viewing - with mobile-specific handling
 */
function setupControls() {
    try {
        // Create a wrapper for easier removal
        app.state.controlsContainer = document.createElement('div');
        app.state.controlsContainer.className = 'controls-wrapper';
        app.state.controlsContainer.style.cssText = `
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none; z-index: 100;
        `;
        
        // Make sure the permanent back button is visible
        const backButton = document.getElementById('permanent-back-button');
        if (backButton) {
            // Make sure it's visible
            backButton.style.display = 'flex';
            
            // Remove any existing event listeners
            const newBackButton = backButton.cloneNode(true);
            if (backButton.parentNode) {
                backButton.parentNode.replaceChild(newBackButton, backButton);
            }
            
            // Add a special mobile-specific touch handler
            if (MOBILE_DEVICE) {
                // Create a transparent overlay just for the back button area
                const backButtonOverlay = document.createElement('div');
                backButtonOverlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 120px;
                    height: 120px;
                    z-index: 10000000;
                    background-color: transparent;
                    pointer-events: auto;
                `;
                
                // Add a direct click handler to the overlay
                backButtonOverlay.addEventListener('touchstart', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log("Back button overlay touched");
                    
                    // Show spinner
                    const spinner = document.getElementById('back-button-spinner');
                    if (spinner) spinner.style.display = 'inline-block';
                    
                    // Force reload
                    window.location.reload(true);
                }, {passive: false});
                
                // Add the overlay to the document
                document.body.appendChild(backButtonOverlay);
                console.log("Added special mobile back button overlay");
            }
            
            // Also add regular click handler for non-mobile
            newBackButton.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                console.log("Back button clicked");
                
                // Show spinner
                const spinner = document.getElementById('back-button-spinner');
                if (spinner) spinner.style.display = 'inline-block';
                
                // Force reload
                window.location.reload(true);
            });
            
            console.log("Back button configured with event handlers");
        } else {
            console.error("Back button element not found!");
        }
        
        tiktokContainer.appendChild(app.state.controlsContainer);
    } catch (controlsError) {
        console.error("!!! Error inside setupControls:", controlsError);
    }
}

/**
 * Show or hide the loading spinner
 * @param {boolean} show - Whether to show or hide the spinner
 */
function toggleSpinner(show) {
    const spinner = document.querySelector('#tiktok-container .spinner-container');
    if (spinner) {
        spinner.style.display = show ? 'flex' : 'none';
    }
}

/**
 * Disable navigation controls for guests in sync mode
 * Modified to allow chat interaction and video tapping while preventing swipe navigation
 */
function disableNavigationControls() {
    // Instead of removing all touch events, we'll use a more targeted approach
    // that allows chat interaction and video tapping but prevents swipe navigation
    
    // Set a flag in app state to indicate that navigation should be disabled
    app.state.navigationDisabled = true;
    
    // Create an overlay that covers only the media area to prevent direct swipes
    const mediaOverlay = document.createElement('div');
    mediaOverlay.id = 'media-navigation-overlay';
    mediaOverlay.style.position = 'absolute';
    mediaOverlay.style.top = '0';
    mediaOverlay.style.left = '0';
    mediaOverlay.style.width = '100%';
    mediaOverlay.style.height = '100%';
    mediaOverlay.style.zIndex = '999';
    mediaOverlay.style.backgroundColor = 'transparent';
    mediaOverlay.style.pointerEvents = 'none'; // Allow touches to pass through for tapping
    
    // Add the overlay to the tiktok container only (not covering chat)
    const tiktokContainer = document.getElementById('tiktok-container');
    if (tiktokContainer) {
        tiktokContainer.appendChild(mediaOverlay);
    }
    
    // Only remove keyboard navigation
    document.removeEventListener('keydown', window.appModules.eventHandlers.handleKeyDown);
    
    console.log('Navigation controls disabled for guest in sync mode - swipe navigation prevented, tapping allowed');
}

/**
 * Re-enable navigation controls when sync mode is disabled
 */
function enableNavigationControls() {
    // Clear the navigation disabled flag
    app.state.navigationDisabled = false;
    
    // Re-add event listeners
    window.appModules.eventHandlers.setupMediaNavigation();
    
    // Re-setup the controls (including the back button)
    setupControls();
    
    // Remove the media overlay
    const mediaOverlay = document.getElementById('media-navigation-overlay');
    if (mediaOverlay) {
        mediaOverlay.remove();
    }
    
    // Remove the guest message
    const message = document.getElementById('guest-message');
    if (message) {
        message.remove();
    }
    
    console.log('Navigation controls re-enabled - swipe navigation allowed');
}

/**
 * Update sync toggle button and status display appearance
 */
function updateSyncToggleButton() {
    const syncToggleBtn = document.getElementById('sync-toggle-btn');
    const syncStatusDisplay = document.getElementById('sync-status-display'); // Get the new display element
    if (!syncToggleBtn || !syncStatusDisplay) return;

    let statusText = 'Sync Mode: OFF'; // Default status text
    let buttonText = 'Sync'; // Default button text

    if (app.state.syncModeEnabled) {
        statusText = app.state.isHost ? 'Sync Mode: HOST' : 'Sync Mode: ON';
        buttonText = app.state.isHost ? 'Stop Host' : 'Leave Sync'; // More descriptive button text
        syncToggleBtn.classList.add('active');
    } else {
        syncToggleBtn.classList.remove('active');
    }

    // Update the text content
    syncStatusDisplay.textContent = statusText;
    syncToggleBtn.textContent = buttonText;
}

export {
    setupControls,
    toggleSpinner,
    disableNavigationControls,
    enableNavigationControls,
    updateSyncToggleButton
};
