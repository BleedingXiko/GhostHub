/**
 * Config Modal Module
 * Handles the configuration modal, its population, and saving settings.
 */

import { saveConfig } from '../utils/configManager.js';
import { CONFIG_DESCRIPTIONS } from '../core/configDescriptions.js';

/**
 * Get default value for GhostStream settings
 */
function getGhoststreamDefault(key) {
    const defaults = {
        'GHOSTSTREAM_ENABLED': false,
        'GHOSTSTREAM_SERVER': '',
        'GHOSTSTREAM_AUTO_TRANSCODE': true,
        'GHOSTSTREAM_DEFAULT_RESOLUTION': '1080p',
        'GHOSTSTREAM_DEFAULT_CODEC': 'h264',
        'GHOSTSTREAM_PREFER_ABR': false
    };
    return defaults[key];
}

// DOM Elements for Config Modal
const configModal = document.getElementById('config-modal');
const configToggleBtn = document.getElementById('config-toggle-btn'); // Will be used by uiController to trigger open
const configModalCloseBtn = document.getElementById('config-modal-close-btn');
const configModalSaveBtn = document.getElementById('config-modal-save-btn');
const configModalCancelBtn = document.getElementById('config-modal-cancel-btn');
const configModalBody = document.getElementById('config-modal-body');

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
    const labelText = key.replace(/_/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
    label.textContent = labelText;

    const helpIcon = document.createElement('span');
    helpIcon.className = 'config-help-icon';
    helpIcon.textContent = '?';
    helpIcon.title = 'Click for details';

    const descriptionDiv = document.createElement('div');
    descriptionDiv.className = 'config-description hidden';
    const fullPath = `${pathPrefix}${key}`;
    descriptionDiv.textContent = CONFIG_DESCRIPTIONS[fullPath] || 'No description available.';

    helpIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        descriptionDiv.classList.toggle('hidden');
    });

    label.appendChild(helpIcon);

    let input;
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'input-wrapper';
    const fullPathKey = `${pathPrefix}${key}`;

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
    } else {
        input = document.createElement('input');

        if (fullPathKey === 'python_config.SESSION_PASSWORD') {
            input.type = 'password';
            input.value = ''; // Never show real password
            input.placeholder = value ? '••••••••' : 'Enter a password';
        } else if (typeof value === 'number') {
            input.type = 'number';
            input.value = value;
            if (key.includes('FACTOR')) {
                input.step = '0.1';
            }
        } else {
            input.type = 'text';
            input.value = value;
        }

        inputWrapper.appendChild(input);
        inputWrapper.appendChild(descriptionDiv);
        formGroup.appendChild(label);
        formGroup.appendChild(inputWrapper);
    }

    if (input) {
        input.id = `config-${fullPathKey.replace(/\./g, '-')}`;
        input.dataset.path = fullPathKey;
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

    // Add Delete All Saved Progress button
    const deleteProgressButton = document.createElement('button');
    deleteProgressButton.textContent = 'Delete All Saved Media Progress';
    deleteProgressButton.className = 'btn btn-danger btn-small config-delete-progress-btn'; // Added class for styling/selection
    deleteProgressButton.style.marginTop = '10px';
    deleteProgressButton.style.marginBottom = '15px';
    deleteProgressButton.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete all saved media progress? This cannot be undone.')) {
            try {
                const response = await fetch('/api/progress/delete_all', { method: 'POST' });
                const result = await response.json();
                if (response.ok) {
                    alert(result.message || 'All saved progress deleted successfully.');
                } else {
                    alert(`Error: ${result.error || 'Failed to delete progress.'}`);
                }
            } catch (error) {
                console.error('Error deleting progress:', error);
                alert('An error occurred while trying to delete progress.');
            }
        }
    });
    pythonSettingsContainer.appendChild(deleteProgressButton);

    // Handle SESSION_PASSWORD first
    const passwordValue = (window.appConfig && window.appConfig.python_config && window.appConfig.python_config.hasOwnProperty('SESSION_PASSWORD'))
                          ? window.appConfig.python_config.SESSION_PASSWORD
                          : '';
    pythonSettingsContainer.appendChild(createConfigInput('SESSION_PASSWORD', passwordValue, 'python_config.'));

    // Keys handled in separate sections
    const ghoststreamConfigKeys = ['GHOSTSTREAM_ENABLED', 'GHOSTSTREAM_SERVER', 'GHOSTSTREAM_AUTO_TRANSCODE', 
                                   'GHOSTSTREAM_DEFAULT_RESOLUTION', 'GHOSTSTREAM_DEFAULT_CODEC', 'GHOSTSTREAM_PREFER_ABR'];

    // Iterate over remaining CONFIG_DESCRIPTIONS for python_config keys
    for (const fullKey in CONFIG_DESCRIPTIONS) {
        if (fullKey.startsWith('python_config.') && fullKey !== 'python_config.SESSION_PASSWORD') {
            const key = fullKey.substring('python_config.'.length);
            // Exclude tunnel-specific and GhostStream keys (handled in their own sections)
            if (!tunnelConfigKeys.includes(key) && !ghoststreamConfigKeys.includes(key)) {
                const value = (window.appConfig && window.appConfig.python_config && window.appConfig.python_config.hasOwnProperty(key))
                              ? window.appConfig.python_config[key]
                              : undefined;

                if (value !== undefined) { // Only create input if a value is determined
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

    // --- GhostStream Config Section ---
    const ghoststreamHeader = document.createElement('h3');
    ghoststreamHeader.className = 'config-section-header collapsed';
    ghoststreamHeader.textContent = 'GhostStream (External Transcoding)';
    configModalBody.appendChild(ghoststreamHeader);

    const ghoststreamSettingsContainer = document.createElement('div');
    ghoststreamSettingsContainer.className = 'config-section-settings collapsed';

    const ghoststreamKeys = [
        'GHOSTSTREAM_ENABLED',
        'GHOSTSTREAM_SERVER', 
        'GHOSTSTREAM_AUTO_TRANSCODE',
        'GHOSTSTREAM_DEFAULT_RESOLUTION',
        'GHOSTSTREAM_DEFAULT_CODEC',
        'GHOSTSTREAM_PREFER_ABR'
    ];

    for (const key of ghoststreamKeys) {
        const value = (window.appConfig && window.appConfig.python_config && window.appConfig.python_config.hasOwnProperty(key))
                      ? window.appConfig.python_config[key]
                      : getGhoststreamDefault(key);
        ghoststreamSettingsContainer.appendChild(createConfigInput(key, value, 'python_config.'));
    }

    // Add GhostStream status indicator and test button
    const statusDiv = document.createElement('div');
    statusDiv.className = 'ghoststream-status-indicator';
    statusDiv.style.marginTop = '10px';
    statusDiv.style.padding = '8px';
    statusDiv.style.borderRadius = '4px';
    statusDiv.style.backgroundColor = 'rgba(255,255,255,0.1)';
    
    const statusLabel = document.createElement('div');
    statusLabel.innerHTML = '<span class="status-label">Status:</span> <span class="status-value">Not checked</span>';
    statusDiv.appendChild(statusLabel);
    
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.textContent = 'Test Connection';
    testBtn.style.marginTop = '8px';
    testBtn.style.padding = '6px 12px';
    testBtn.style.width = 'auto';
    testBtn.addEventListener('click', async () => {
        const statusValue = statusLabel.querySelector('.status-value');
        statusValue.textContent = 'Testing...';
        statusValue.style.color = '#fbbf24';
        
        // Get the current server URL from the input field
        const serverInput = ghoststreamSettingsContainer.querySelector('[data-path="python_config.GHOSTSTREAM_SERVER"]');
        const serverUrl = serverInput ? serverInput.value : '';
        
        try {
            const response = await fetch('/api/ghoststream/test-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server_url: serverUrl })
            });
            const data = await response.json();
            
            if (data.success) {
                statusValue.textContent = `Connected! (${data.response?.status || 'OK'})`;
                statusValue.style.color = '#4ade80';
                // Update GhostStream availability state
                if (window.appModules?.ghoststreamManager?.setAvailable) {
                    window.appModules.ghoststreamManager.setAvailable(true);
                }
            } else {
                statusValue.textContent = data.error || 'Connection failed';
                statusValue.style.color = '#f87171';
                console.error('GhostStream test failed:', data);
            }
        } catch (err) {
            statusValue.textContent = 'Request failed: ' + err.message;
            statusValue.style.color = '#f87171';
        }
    });
    statusDiv.appendChild(testBtn);
    
    ghoststreamSettingsContainer.appendChild(statusDiv);
    
    // Add Transcode All button
    const transcodeAllDiv = document.createElement('div');
    transcodeAllDiv.style.marginTop = '15px';
    transcodeAllDiv.style.padding = '10px';
    transcodeAllDiv.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    
    const transcodeAllLabel = document.createElement('div');
    transcodeAllLabel.style.marginBottom = '8px';
    transcodeAllLabel.innerHTML = '<strong>Batch Transcode</strong><br><small>Pre-transcode all videos in current category to MP4 for faster playback</small>';
    transcodeAllDiv.appendChild(transcodeAllLabel);
    
    const transcodeAllBtn = document.createElement('button');
    transcodeAllBtn.type = 'button';
    transcodeAllBtn.textContent = 'Transcode All Videos';
    transcodeAllBtn.style.padding = '8px 16px';
    transcodeAllBtn.style.width = 'auto';
    transcodeAllBtn.style.marginRight = '10px';
    
    const transcodeStatus = document.createElement('span');
    transcodeStatus.style.fontSize = '0.9em';
    
    transcodeAllBtn.addEventListener('click', async () => {
        const categoryId = window.appModules?.app?.state?.currentCategoryId;
        if (!categoryId) {
            transcodeStatus.textContent = 'No category selected';
            transcodeStatus.style.color = '#f87171';
            return;
        }
        
        transcodeAllBtn.disabled = true;
        transcodeAllBtn.textContent = 'Starting...';
        transcodeStatus.textContent = '';
        
        try {
            const ghoststreamManager = window.appModules?.ghoststreamManager;
            if (!ghoststreamManager) {
                throw new Error('GhostStream manager not loaded');
            }
            
            const result = await ghoststreamManager.transcodeAllInCategory(categoryId);
            
            if (result) {
                if (result.queued > 0) {
                    transcodeStatus.textContent = `Started ${result.queued} jobs`;
                    transcodeStatus.style.color = '#4ade80';
                    
                    // Monitor progress
                    ghoststreamManager.monitorBatchJobs(result.jobs, categoryId, (filename, status) => {
                        if (status.status === 'all_complete') {
                            transcodeStatus.textContent = 'All done!';
                            transcodeAllBtn.textContent = 'Transcode All Videos';
                            transcodeAllBtn.disabled = false;
                        } else if (filename) {
                            transcodeStatus.textContent = `${filename}: ${Math.round(status.progress)}%`;
                        }
                    });
                } else {
                    transcodeStatus.textContent = result.message || 'No videos need transcoding';
                    transcodeStatus.style.color = '#fbbf24';
                    transcodeAllBtn.textContent = 'Transcode All Videos';
                    transcodeAllBtn.disabled = false;
                }
            } else {
                transcodeStatus.textContent = 'Failed to start';
                transcodeStatus.style.color = '#f87171';
                transcodeAllBtn.textContent = 'Transcode All Videos';
                transcodeAllBtn.disabled = false;
            }
        } catch (err) {
            transcodeStatus.textContent = err.message;
            transcodeStatus.style.color = '#f87171';
            transcodeAllBtn.textContent = 'Transcode All Videos';
            transcodeAllBtn.disabled = false;
        }
    });
    
    transcodeAllDiv.appendChild(transcodeAllBtn);
    transcodeAllDiv.appendChild(transcodeStatus);
    ghoststreamSettingsContainer.appendChild(transcodeAllDiv);

    configModalBody.appendChild(ghoststreamSettingsContainer);
    ghoststreamHeader.addEventListener('click', () => {
        ghoststreamSettingsContainer.classList.toggle('collapsed');
        ghoststreamHeader.classList.toggle('collapsed');
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

/**
 * Initializes the config modal event listeners.
 */
function initConfigModal() {
    // Event Listeners for Config Modal
    // configToggleBtn is handled by uiController, which will call openConfigModal
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
    console.log('Config Modal Initialized');
}

export { initConfigModal, openConfigModal };
