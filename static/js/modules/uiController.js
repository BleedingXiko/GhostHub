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

// DOM Elements for Tunnel Modal
const tunnelModal = document.getElementById('tunnel-modal');
const tunnelToggleBtn = document.getElementById('tunnel-toggle-btn');
const tunnelModalCloseBtn = document.getElementById('tunnel-modal-close-btn');
const tunnelModalStartBtn = document.getElementById('tunnel-modal-start-btn');
const tunnelModalStopBtn = document.getElementById('tunnel-modal-stop-btn');
const tunnelModalSaveSettingsBtn = document.getElementById('tunnel-modal-save-settings-btn');
const tunnelProviderSelect = document.getElementById('tunnel-provider-select');
const pinggyTokenGroup = document.getElementById('pinggy-token-group');
const pinggyAccessTokenInput = document.getElementById('pinggy-access-token-input');
const tunnelLocalPortInput = document.getElementById('tunnel-local-port-input');
const tunnelStatusDisplay = document.getElementById('tunnel-status-display');

// Variable to track the tunnel status polling interval
let tunnelStatusPollingInterval = null;

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
    openConfigModal, // Export new function
    openTunnelModal // Export new function for tunnel modal
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
    const fullPathKey = `${pathPrefix}${key}`; // Use this for checks and dataset

    if (typeof value === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
        input.className = 'config-input-checkbox';
        const checkboxLabel = document.createElement('span');
        checkboxLabel.className = 'checkbox-label-text';
        checkboxLabel.textContent = ` ${labelText}`;
        
        label.textContent = ''; 
        label.appendChild(helpIcon);

        inputWrapper.appendChild(input);
        inputWrapper.appendChild(checkboxLabel);
        inputWrapper.appendChild(descriptionDiv);
        formGroup.appendChild(label);
        formGroup.appendChild(inputWrapper);
    } else { // For number, text, and password inputs
        input = document.createElement('input');
        if (fullPathKey === 'python_config.SESSION_PASSWORD') {
            input.type = 'password';
            input.value = ''; // Always clear password field for security
            input.placeholder = 'Leave blank for no password';
        } else if (typeof value === 'number') {
            input.type = 'number';
            input.value = value;
            if (key.includes('FACTOR')) {
                input.step = '0.1';
            }
        } else { // Treat as string (default)
            input.type = 'text';
            input.value = value;
        }
        inputWrapper.appendChild(input);
        inputWrapper.appendChild(descriptionDiv);
        formGroup.appendChild(label);
        formGroup.appendChild(inputWrapper);
    }
    
    if (input) {
      // Generate a valid ID by replacing dots with hyphens
      input.id = `config-${fullPathKey.replace(/\./g, '-')}`;
      input.dataset.path = fullPathKey; // Store the original dot-separated path
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

    // --- Python Config Section ---
    const pythonHeader = document.createElement('h3');
    pythonHeader.className = 'config-section-header collapsed';
    pythonHeader.textContent = 'Server Settings (Python)';
    configModalBody.appendChild(pythonHeader);

    const pythonSettingsContainer = document.createElement('div');
    pythonSettingsContainer.className = 'config-section-settings collapsed';
    
    const tunnelConfigKeys = ['TUNNEL_PROVIDER', 'PINGGY_ACCESS_TOKEN', 'TUNNEL_LOCAL_PORT'];

    // Iterate over CONFIG_DESCRIPTIONS for python_config keys to ensure all described fields are attempted
    for (const fullKey in CONFIG_DESCRIPTIONS) {
        if (fullKey.startsWith('python_config.')) {
            const key = fullKey.substring('python_config.'.length);
            if (!tunnelConfigKeys.includes(key)) { // Exclude tunnel-specific keys handled elsewhere
                // Get value from window.appConfig, default to empty string if not found (e.g., for new SESSION_PASSWORD)
                const value = (window.appConfig && window.appConfig.python_config && window.appConfig.python_config.hasOwnProperty(key))
                              ? window.appConfig.python_config[key]
                              : (key === 'SESSION_PASSWORD' ? '' : undefined); // Default SESSION_PASSWORD to ""

                if (value !== undefined) { // Only create input if a value or default is determined
                    pythonSettingsContainer.appendChild(createConfigInput(key, value, 'python_config.'));
                }
            }
        }
    }
    configModalBody.appendChild(pythonSettingsContainer);
    pythonHeader.addEventListener('click', () => {
        pythonSettingsContainer.classList.toggle('collapsed');
        pythonHeader.classList.toggle('collapsed');
    });

    // --- JavaScript Config Sections ---
    if (window.appConfig && window.appConfig.javascript_config) {
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

// --- Tunnel Modal Logic ---

/**
 * Updates the visibility of Pinggy token input based on provider selection.
 */
function updatePinggyTokenVisibility() {
    if (tunnelProviderSelect && pinggyTokenGroup) {
        pinggyTokenGroup.classList.toggle('hidden', tunnelProviderSelect.value !== 'pinggy');
    }
}

/**
 * Populates the tunnel modal with current settings from appConfig.
 */
function populateTunnelModal() {
    if (!window.appConfig || !window.appConfig.python_config) {
        if (tunnelStatusDisplay) tunnelStatusDisplay.textContent = 'Error: App configuration not loaded.';
        return;
    }
    const pythonConfig = window.appConfig.python_config;
    if (tunnelProviderSelect) tunnelProviderSelect.value = pythonConfig.TUNNEL_PROVIDER || 'none';
    if (pinggyAccessTokenInput) pinggyAccessTokenInput.value = pythonConfig.PINGGY_ACCESS_TOKEN || '';
    if (tunnelLocalPortInput) tunnelLocalPortInput.value = pythonConfig.TUNNEL_LOCAL_PORT || 5000;
    
    updatePinggyTokenVisibility();
    updateTunnelStatusDisplay(); // Fetch current status from backend
}

/**
 * Opens the tunnel management modal.
 */
function openTunnelModal() {
    populateTunnelModal();
    if (tunnelModal) tunnelModal.classList.remove('hidden');
}

/**
 * Closes the tunnel management modal.
 */
function closeTunnelModal() {
    if (tunnelModal) tunnelModal.classList.add('hidden');
    
    // Clear any active polling interval when the modal is closed
    if (tunnelStatusPollingInterval) {
        clearInterval(tunnelStatusPollingInterval);
        tunnelStatusPollingInterval = null;
        console.log('Tunnel status polling stopped due to modal close');
    }
}

/**
 * Updates the tunnel status display by fetching from the backend.
 */
async function updateTunnelStatusDisplay() {
    if (!tunnelStatusDisplay) return;
    tunnelStatusDisplay.textContent = 'Status: Checking...';
    tunnelStatusDisplay.className = 'tunnel-status status-checking'; // Base class + checking

    try {
        const response = await fetch('/api/tunnel/status');
        const data = await response.json();

        if (response.ok) {
            if (data.status === 'running') {
                let displayText = `Status: Running (${data.provider || 'Unknown'}) on port ${data.local_port || 'N/A'}`;
                if (data.url) {
                    if (data.provider === 'cloudflare' && data.url.includes('trycloudflare.com')) {
                        // Just display the URL as a clickable link without a copy button
                        // Make it more prominent so it's easier to select manually
                        displayText += ` - URL: <a href="${data.url}" target="_blank" style="font-weight: bold;">${data.url}</a>`;
                    } else if (data.provider === 'pinggy') {
                        displayText += ` - Reminder: Use your permanent Pinggy URL.`;
                    } else if (data.url) { 
                        displayText += ` - URL: <a href="${data.url}" target="_blank">${data.url}</a>`;
                    }
                }
                tunnelStatusDisplay.innerHTML = displayText;
                tunnelStatusDisplay.className = 'tunnel-status status-running'; // Set class last
            } else {
                tunnelStatusDisplay.textContent = `Status: Stopped`;
                tunnelStatusDisplay.className = 'tunnel-status status-stopped';
            }
        } else {
            tunnelStatusDisplay.textContent = `Status: Error fetching - ${data.message || 'Unknown error'}`;
            tunnelStatusDisplay.className = 'tunnel-status status-stopped'; // Treat error as stopped
        }
    } catch (error) {
        console.error('Failed to fetch tunnel status:', error);
        tunnelStatusDisplay.textContent = 'Status: Error fetching status.';
        tunnelStatusDisplay.className = 'tunnel-status status-stopped';
    }
}

/**
 * Handles saving tunnel specific settings (provider, token, port).
 */
async function handleSaveTunnelSettings() {
    if (!window.appConfig) {
        alert('App configuration not loaded. Cannot save tunnel settings.');
        return;
    }

    const newPythonConfig = { ...window.appConfig.python_config }; // Create a copy to modify

    newPythonConfig.TUNNEL_PROVIDER = tunnelProviderSelect ? tunnelProviderSelect.value : 'none';
    newPythonConfig.PINGGY_ACCESS_TOKEN = pinggyAccessTokenInput ? pinggyAccessTokenInput.value : '';
    newPythonConfig.TUNNEL_LOCAL_PORT = tunnelLocalPortInput ? parseInt(tunnelLocalPortInput.value, 10) : 5000;

    // Construct the full config object to save, preserving other parts of appConfig
    const fullNewConfig = {
        ...window.appConfig,
        python_config: newPythonConfig
    };
    
    try {
        if(tunnelModalSaveSettingsBtn) {
            tunnelModalSaveSettingsBtn.textContent = 'Saving...';
            tunnelModalSaveSettingsBtn.disabled = true;
        }
        const result = await saveConfig(fullNewConfig); // Use the global saveConfig
        alert(result.message || 'Tunnel settings saved successfully! These will be used next time a tunnel is started.');
        // Optionally, update window.appConfig if saveConfig doesn't do it globally
        window.appConfig.python_config = newPythonConfig; 
    } catch (error) {
        console.error('Failed to save tunnel settings:', error);
        alert(`Error saving tunnel settings: ${error.message || 'Unknown error'}`);
    } finally {
        if(tunnelModalSaveSettingsBtn) {
            tunnelModalSaveSettingsBtn.textContent = 'Save Settings';
            tunnelModalSaveSettingsBtn.disabled = false;
        }
    }
}

/**
 * Handles starting the tunnel.
 */
async function handleStartTunnel() {
    if(tunnelModalStartBtn) {
        tunnelModalStartBtn.textContent = 'Starting...';
        tunnelModalStartBtn.disabled = true;
    }
    if(tunnelStatusDisplay) {
        tunnelStatusDisplay.textContent = 'Status: Starting...';
        tunnelStatusDisplay.className = 'tunnel-status status-starting';
    }

    // Clear any existing polling interval
    if (tunnelStatusPollingInterval) {
        clearInterval(tunnelStatusPollingInterval);
        tunnelStatusPollingInterval = null;
    }

    try {
        // Save settings first to ensure PINGGY_ACCESS_TOKEN and TUNNEL_LOCAL_PORT are up-to-date in config for next load
        await handleSaveTunnelSettings(); 

        const provider = tunnelProviderSelect ? tunnelProviderSelect.value : 'none';
        const localPort = tunnelLocalPortInput ? parseInt(tunnelLocalPortInput.value, 10) : 5000;
        let pinggyToken = '';
        if (provider === 'pinggy') {
            pinggyToken = pinggyAccessTokenInput ? pinggyAccessTokenInput.value : '';
        }

        if (provider === 'none') {
            alert('Please select a tunnel provider.');
            if(tunnelModalStartBtn) {
                tunnelModalStartBtn.textContent = 'Start Tunnel';
                tunnelModalStartBtn.disabled = false;
            }
            if(tunnelStatusDisplay) tunnelStatusDisplay.textContent = 'Status: Not Active';
            return;
        }

        const body = {
            provider: provider,
            local_port: localPort
        };
        if (provider === 'pinggy') {
            body.pinggy_token = pinggyToken;
        }

        const response = await fetch('/api/tunnel/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const data = await response.json();

        if (data.status === 'success') { // Check data.status from backend response
            alert(data.message || 'Tunnel started successfully!');
            
            // For Cloudflare tunnels, set up polling to check for URL updates
            if (provider === 'cloudflare') {
                console.log('Starting tunnel status polling for Cloudflare URL');
                
                // Initial status check
                await updateTunnelStatusDisplay();
                
                // Set up polling interval (every 2 seconds)
                let pollCount = 0;
                const maxPolls = 30; // Maximum number of polls (60 seconds total)
                
                tunnelStatusPollingInterval = setInterval(async () => {
                    pollCount++;
                    console.log(`Polling tunnel status (${pollCount}/${maxPolls})`);
                    
                    try {
                        const statusResponse = await fetch('/api/tunnel/status');
                        const statusData = await statusResponse.json();
                        
                        // Update the UI with the latest status
                        if (statusResponse.ok) {
                            // If we have a URL, update the display and stop polling
                            if (statusData.status === 'running' && statusData.url && 
                                statusData.provider === 'cloudflare' && 
                                statusData.url.includes('trycloudflare.com')) {
                                
                                console.log('Cloudflare URL found, updating display and stopping polling');
                                await updateTunnelStatusDisplay();
                                
                                // Stop polling since we have the URL
                                clearInterval(tunnelStatusPollingInterval);
                                tunnelStatusPollingInterval = null;
                            } else if (statusData.status !== 'running') {
                                // If tunnel is no longer running, stop polling
                                console.log('Tunnel is no longer running, stopping polling');
                                clearInterval(tunnelStatusPollingInterval);
                                tunnelStatusPollingInterval = null;
                                await updateTunnelStatusDisplay();
                            }
                        }
                    } catch (error) {
                        console.error('Error polling tunnel status:', error);
                    }
                    
                    // Stop polling after maximum attempts
                    if (pollCount >= maxPolls) {
                        console.log('Reached maximum polling attempts, stopping');
                        clearInterval(tunnelStatusPollingInterval);
                        tunnelStatusPollingInterval = null;
                    }
                }, 2000); // Poll every 2 seconds
            } else {
                // For non-Cloudflare tunnels, just update once
                updateTunnelStatusDisplay();
            }
        } else {
            alert(`Error starting tunnel: ${data.message || 'Unknown error'}`);
            updateTunnelStatusDisplay(); // Update status display to show error
        }
    } catch (error) {
        console.error('Failed to start tunnel:', error);
        alert(`Error starting tunnel: ${error.toString()}`);
        updateTunnelStatusDisplay(); // Update status display to show error
    } finally {
        if(tunnelModalStartBtn) {
            tunnelModalStartBtn.textContent = 'Start Tunnel';
            tunnelModalStartBtn.disabled = false;
        }
    }
}

/**
 * Handles stopping the tunnel.
 */
async function handleStopTunnel() {
    if(tunnelModalStopBtn) {
        tunnelModalStopBtn.textContent = 'Stopping...';
        tunnelModalStopBtn.disabled = true;
    }
    if(tunnelStatusDisplay) {
        tunnelStatusDisplay.textContent = 'Status: Stopping...';
        tunnelStatusDisplay.className = 'tunnel-status status-starting'; // Visually similar to starting
    }
    
    // Clear any active polling interval when stopping the tunnel
    if (tunnelStatusPollingInterval) {
        clearInterval(tunnelStatusPollingInterval);
        tunnelStatusPollingInterval = null;
        console.log('Tunnel status polling stopped due to tunnel stop');
    }
    
    try {
        const response = await fetch('/api/tunnel/stop', { method: 'POST' });
        const data = await response.json();

        if (response.ok && data.status === 'success') {
            alert(data.message || 'Tunnel stopped successfully!');
        } else {
            alert(`Error stopping tunnel: ${data.message || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to stop tunnel:', error);
        alert(`Error stopping tunnel: ${error.toString()}`);
    } finally {
        if(tunnelModalStopBtn) {
            tunnelModalStopBtn.textContent = 'Stop Tunnel';
            tunnelModalStopBtn.disabled = false;
        }
        updateTunnelStatusDisplay(); // Refresh status
    }
}


// Event Listeners for Tunnel Modal
if (tunnelToggleBtn) {
    tunnelToggleBtn.addEventListener('click', openTunnelModal);
}
if (tunnelModalCloseBtn) {
    tunnelModalCloseBtn.addEventListener('click', closeTunnelModal);
}
if (tunnelModalStartBtn) {
    tunnelModalStartBtn.addEventListener('click', handleStartTunnel);
}
if (tunnelModalStopBtn) {
    tunnelModalStopBtn.addEventListener('click', handleStopTunnel);
}
if (tunnelModalSaveSettingsBtn) {
    tunnelModalSaveSettingsBtn.addEventListener('click', handleSaveTunnelSettings);
}
if (tunnelProviderSelect) {
    tunnelProviderSelect.addEventListener('change', updatePinggyTokenVisibility);
}

// Close tunnel modal if clicking outside the content
if (tunnelModal) {
    tunnelModal.addEventListener('click', (event) => {
        if (event.target === tunnelModal) {
            closeTunnelModal();
        }
    });
}
