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
 */
function disableNavigationControls() {
    // Remove swipe and keyboard event listeners for guests
    document.body.removeEventListener('touchstart', window.appModules.eventHandlers.handleTouchStart);
    document.body.removeEventListener('touchmove', window.appModules.eventHandlers.handleTouchMove);
    document.body.removeEventListener('touchend', window.appModules.eventHandlers.handleTouchEnd);
    document.removeEventListener('keydown', window.appModules.eventHandlers.handleKeyDown);
    
    // Add a message or visual indicator that controls are disabled
    const message = document.createElement('div');
    message.id = 'guest-message';
    message.style.position = 'fixed';
    message.style.bottom = '20px';
    message.style.left = '0';
    message.style.width = '100%';
    message.style.textAlign = 'center';
    message.style.color = 'rgba(255,255,255,0.7)';
    message.style.fontSize = '14px';
    message.style.padding = '10px';
    message.style.zIndex = '1000';
    message.textContent = 'Navigation controlled by host';
    
    document.body.appendChild(message);
}

/**
 * Re-enable navigation controls when sync mode is disabled
 */
function enableNavigationControls() {
    // Re-add event listeners
    window.appModules.eventHandlers.setupMediaNavigation();
    
    // Remove the guest message
    const message = document.getElementById('guest-message');
    if (message) {
        message.remove();
    }
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
