/**
 * Tunnel Modal Module
 * Handles the tunnel management modal, its population, and related tunnel operations.
 */

import { saveConfig } from '../utils/configManager.js';

// DOM Elements for Tunnel Modal
const tunnelModal = document.getElementById('tunnel-modal');
const tunnelToggleBtn = document.getElementById('tunnel-toggle-btn'); // Will be used by uiController to trigger open
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

    if (tunnelStatusPollingInterval) {
        clearInterval(tunnelStatusPollingInterval);
        tunnelStatusPollingInterval = null;
    }

    try {
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

        if (data.status === 'success') { 
            alert(data.message || 'Tunnel started successfully!');
            
            if (provider === 'cloudflare') {
                console.log('Starting tunnel status polling for Cloudflare URL');
                await updateTunnelStatusDisplay();
                let pollCount = 0;
                const maxPolls = 30;
                
                tunnelStatusPollingInterval = setInterval(async () => {
                    pollCount++;
                    console.log(`Polling tunnel status (${pollCount}/${maxPolls})`);
                    
                    try {
                        const statusResponse = await fetch('/api/tunnel/status');
                        const statusData = await statusResponse.json();
                        
                        if (statusResponse.ok) {
                            if (statusData.status === 'running' && statusData.url && 
                                statusData.provider === 'cloudflare' && 
                                statusData.url.includes('trycloudflare.com')) {
                                
                                console.log('Cloudflare URL found, updating display and stopping polling');
                                await updateTunnelStatusDisplay();
                                clearInterval(tunnelStatusPollingInterval);
                                tunnelStatusPollingInterval = null;
                            } else if (statusData.status !== 'running') {
                                console.log('Tunnel is no longer running, stopping polling');
                                clearInterval(tunnelStatusPollingInterval);
                                tunnelStatusPollingInterval = null;
                                await updateTunnelStatusDisplay();
                            }
                        }
                    } catch (error) {
                        console.error('Error polling tunnel status:', error);
                    }
                    
                    if (pollCount >= maxPolls) {
                        console.log('Reached maximum polling attempts, stopping');
                        clearInterval(tunnelStatusPollingInterval);
                        tunnelStatusPollingInterval = null;
                    }
                }, 2000); 
            } else {
                updateTunnelStatusDisplay();
            }
        } else {
            alert(`Error starting tunnel: ${data.message || 'Unknown error'}`);
            updateTunnelStatusDisplay();
        }
    } catch (error) {
        console.error('Failed to start tunnel:', error);
        alert(`Error starting tunnel: ${error.toString()}`);
        updateTunnelStatusDisplay();
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
        tunnelStatusDisplay.className = 'tunnel-status status-starting';
    }
    
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

/**
 * Initializes the tunnel modal event listeners.
 */
function initTunnelModal() {
    // tunnelToggleBtn is handled by uiController, which will call openTunnelModal
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
    console.log('Tunnel Modal Initialized');
}

export { initTunnelModal, openTunnelModal }; 