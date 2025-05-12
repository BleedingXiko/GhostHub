/**
 * UI Controller Module
 * Handles UI-related functionality like controls and indicators
 */

import { app, tiktokContainer, MOBILE_DEVICE } from '../core/app.js';
import { initConfigModal, openConfigModal as importedOpenConfigModal } from './configModal.js';
import { initTunnelModal, openTunnelModal as importedOpenTunnelModal } from './tunnelModal.js';


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
    const syncStatusDisplay = document.getElementById('sync-status-display');
    if (!syncToggleBtn || !syncStatusDisplay) return;

    let statusText = 'Sync Mode: OFF';
    let buttonText = 'Sync';

    if (app.state.syncModeEnabled) {
        statusText = app.state.isHost ? 'Sync Mode: HOST' : 'Sync Mode: ON';
        buttonText = app.state.isHost ? 'Stop Host' : 'Leave Sync';
        syncToggleBtn.classList.add('active');
    } else {
        syncToggleBtn.classList.remove('active');
    }

    syncStatusDisplay.textContent = statusText;
    syncToggleBtn.textContent = buttonText;
}

// Call initializers for imported modal modules
initConfigModal();
initTunnelModal();

// Re-export openConfigModal so other modules can access it via uiController if needed
const openConfigModal = importedOpenConfigModal;
const openTunnelModal = importedOpenTunnelModal;

export {
    setupControls,
    toggleSpinner,
    disableNavigationControls,
    enableNavigationControls,
    updateSyncToggleButton,
    openConfigModal,
    openTunnelModal,
    createOrUpdateIndexingUI,
    updateSwipeIndicators
};

/**
 * Create or update the indexing progress UI
 * @param {number} progress - The indexing progress (0-100)
 */
function createOrUpdateIndexingUI(progress) {
    // Create progress indicator if it doesn't exist
    if (!app.state.indexingProgressElement) {
        const progressElement = document.createElement('div');
        progressElement.className = 'indexing-progress';
        progressElement.style.position = 'fixed';
        progressElement.style.top = '10px';
        progressElement.style.left = '50%';
        progressElement.style.transform = 'translateX(-50%)';
        progressElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        progressElement.style.color = 'white';
        progressElement.style.padding = '10px 20px';
        progressElement.style.borderRadius = '5px';
        progressElement.style.zIndex = '1000';
        document.body.appendChild(progressElement);
        app.state.indexingProgressElement = progressElement;
    }
    
    // Update progress text
    app.state.indexingProgressElement.textContent = `Indexing media files: ${progress}%`;
}

/**
 * Update navigation indicators
 * @param {number} currentIndex - Current position
 * @param {number} totalItems - Total available items
 */
function updateSwipeIndicators(currentIndex, totalItems) {
    // Create indicators if they don't exist
    if (!tiktokContainer.querySelector('.swipe-indicator.up')) {
        const upIndicator = document.createElement('div');
        upIndicator.className = 'swipe-indicator up';
        upIndicator.innerHTML = '⬆️';
        tiktokContainer.appendChild(upIndicator);
        
        const downIndicator = document.createElement('div');
        downIndicator.className = 'swipe-indicator down';
        downIndicator.innerHTML = '⬇️';
        tiktokContainer.appendChild(downIndicator);
    }
    
    const upIndicator = tiktokContainer.querySelector('.swipe-indicator.up');
    const downIndicator = tiktokContainer.querySelector('.swipe-indicator.down');
    
    // Show up arrow if not the first item
    upIndicator.classList.toggle('visible', currentIndex > 0);
    // Show down arrow if not the last item or if more media might be loading
    downIndicator.classList.toggle('visible', currentIndex < totalItems - 1 || app.state.hasMoreMedia);
}
