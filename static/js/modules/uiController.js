/**
 * UI Controller Module
 * Handles UI-related functionality like controls and indicators
 */

import { app, tiktokContainer, MOBILE_DEVICE } from '../core/app.js';
import { getConfigValue, saveConfig } from '../utils/configManager.js'; // Import config manager functions
import { CONFIG_DESCRIPTIONS } from '../core/configDescriptions.js'; // Import descriptions

// DOM Elements for Config Modal
const configModal = document.getElementById('config-modal');
const configToggleBtn = document.getElementById('config-toggle-btn');
const configModalCloseBtn = document.getElementById('config-modal-close-btn');
const configModalSaveBtn = document.getElementById('config-modal-save-btn');
const configModalCancelBtn = document.getElementById('config-modal-cancel-btn');
const configModalBody = document.getElementById('config-modal-body');

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
    updateSyncToggleButton,
    openConfigModal // Export new function
};

// --- Config Modal Logic ---

/**
 * Creates a form input element for a configuration setting.
 * @param {string} key - The configuration key.
 * @param {*} value - The current value of the configuration.
 * @param {string} pathPrefix - The path prefix for nested objects (e.g., "python_config.").
 * @returns {HTMLElement} The created form group element.
 */
function createConfigInput(key, value, pathPrefix = '') {
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = `config-${pathPrefix}${key}`;
    const labelText = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    label.textContent = labelText;

    const helpIcon = document.createElement('span');
    helpIcon.className = 'config-help-icon';
    helpIcon.textContent = '?'; // Simple text-based icon
    helpIcon.title = 'Click for details'; // Tooltip for desktop (won't harm mobile)
    
    const descriptionDiv = document.createElement('div');
    descriptionDiv.className = 'config-description hidden'; // Initially hidden
    const fullPath = `${pathPrefix}${key}`;
    descriptionDiv.textContent = CONFIG_DESCRIPTIONS[fullPath] || 'No description available.';
    
    helpIcon.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent click from bubbling to other elements
        descriptionDiv.classList.toggle('hidden');
    });

    label.appendChild(helpIcon); // Add icon next to label text
    
    let input;
    const inputWrapper = document.createElement('div'); // Wrapper for input and its description
    inputWrapper.className = 'input-wrapper';

    if (typeof value === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
        input.className = 'config-input-checkbox';
        const checkboxLabel = document.createElement('span'); // Use a separate span for the text part of checkbox label
        checkboxLabel.className = 'checkbox-label-text';
        checkboxLabel.textContent = ` ${labelText}`; // Use the original formatted label text
        
        // The main label element will now only contain the help icon for checkboxes
        label.textContent = ''; 
        label.appendChild(helpIcon);

        inputWrapper.appendChild(input);
        inputWrapper.appendChild(checkboxLabel); // Add text label next to checkbox
        inputWrapper.appendChild(descriptionDiv); // Description below checkbox and its text label
        formGroup.appendChild(label); // Label with help icon
        formGroup.appendChild(inputWrapper); // Wrapper with checkbox, text, and description
    } else { // For number and text inputs
        if (typeof value === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.value = value;
            if (key.includes('FACTOR')) {
                input.step = '0.1';
            }
        } else { // Treat as string
            input = document.createElement('input');
            input.type = 'text';
            input.value = value;
        }
        inputWrapper.appendChild(input);
        inputWrapper.appendChild(descriptionDiv); // Description below input
        formGroup.appendChild(label); // Label with help icon
        formGroup.appendChild(inputWrapper); // Wrapper with input and description
    }
    
    if (input) {
      input.id = `config-${pathPrefix}${key}`;
      input.dataset.path = `${pathPrefix}${key}`;
    }

    return formGroup;
}

/**
 * Populates the configuration modal with form fields based on currentConfig.
 */
function populateConfigModal() {
    if (!window.appConfig) {
        configModalBody.innerHTML = '<p>Configuration not yet loaded. Please try again shortly.</p>';
        return;
    }

    configModalBody.innerHTML = ''; // Clear previous content

    // Iterate over python_config
    if (window.appConfig.python_config) {
        const pythonHeader = document.createElement('h3');
        pythonHeader.className = 'config-section-header collapsed'; // Collapsed by default
        pythonHeader.textContent = 'Server Settings (Python)';
        configModalBody.appendChild(pythonHeader);

        const pythonSettingsContainer = document.createElement('div');
        pythonSettingsContainer.className = 'config-section-settings collapsed'; // Collapsed by default
        for (const [key, value] of Object.entries(window.appConfig.python_config)) {
            pythonSettingsContainer.appendChild(createConfigInput(key, value, 'python_config.'));
        }
        configModalBody.appendChild(pythonSettingsContainer);
        pythonHeader.addEventListener('click', () => {
            pythonSettingsContainer.classList.toggle('collapsed');
            pythonHeader.classList.toggle('collapsed');
        });
    }

    // Iterate over javascript_config sections
    if (window.appConfig.javascript_config) {
        for (const [sectionKey, sectionValue] of Object.entries(window.appConfig.javascript_config)) {
            const sectionHeader = document.createElement('h3');
            sectionHeader.className = 'config-section-header collapsed'; // Collapsed by default
            sectionHeader.textContent = `${sectionKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} Settings (JavaScript)`;
            configModalBody.appendChild(sectionHeader);

            const jsSettingsContainer = document.createElement('div');
            jsSettingsContainer.className = 'config-section-settings collapsed'; // Collapsed by default
            if (typeof sectionValue === 'object' && sectionValue !== null) {
                for (const [key, value] of Object.entries(sectionValue)) {
                    jsSettingsContainer.appendChild(createConfigInput(key, value, `javascript_config.${sectionKey}.`));
                }
            }
            configModalBody.appendChild(jsSettingsContainer);
            sectionHeader.addEventListener('click', () => {
                jsSettingsContainer.classList.toggle('collapsed');
                sectionHeader.classList.toggle('collapsed');
            });
        }
    }
}


/**
 * Opens the configuration modal and populates it.
 */
function openConfigModal() {
    populateConfigModal();
    if (configModal) configModal.classList.remove('hidden');
}

/**
 * Closes the configuration modal.
 */
function closeConfigModal() {
    if (configModal) configModal.classList.add('hidden');
}

/**
 * Handles saving the configuration.
 */
async function handleSaveConfig() {
    const newConfig = JSON.parse(JSON.stringify(window.appConfig || { python_config: {}, javascript_config: {} })); // Deep clone current or default

    const inputs = configModalBody.querySelectorAll('[data-path]');
    inputs.forEach(input => {
        const path = input.dataset.path.split('.');
        let currentLevel = newConfig;
        
        for (let i = 0; i < path.length - 1; i++) {
            currentLevel = currentLevel[path[i]] = currentLevel[path[i]] || {};
        }
        
        const key = path[path.length - 1];
        if (input.type === 'checkbox') {
            currentLevel[key] = input.checked;
        } else if (input.type === 'number') {
            currentLevel[key] = parseFloat(input.value); // Or parseInt if always integers
        } else {
            currentLevel[key] = input.value;
        }
    });

    try {
        configModalSaveBtn.textContent = 'Saving...';
        configModalSaveBtn.disabled = true;
        const result = await saveConfig(newConfig);
        alert(result.message || 'Settings saved successfully! Some changes may require a page reload or app restart.');
        closeConfigModal();
    } catch (error) {
        console.error('Failed to save configuration:', error);
        alert(`Error saving settings: ${error.message || 'Unknown error'}`);
    } finally {
        configModalSaveBtn.textContent = 'Save Changes';
        configModalSaveBtn.disabled = false;
    }
}

// Event Listeners for Config Modal
if (configToggleBtn) {
    configToggleBtn.addEventListener('click', openConfigModal);
}
if (configModalCloseBtn) {
    configModalCloseBtn.addEventListener('click', closeConfigModal);
}
if (configModalCancelBtn) {
    configModalCancelBtn.addEventListener('click', closeConfigModal);
}
if (configModalSaveBtn) {
    configModalSaveBtn.addEventListener('click', handleSaveConfig);
}

// Close modal if clicking outside the content
if (configModal) {
    configModal.addEventListener('click', (event) => {
        if (event.target === configModal) {
            closeConfigModal();
        }
    });
}
