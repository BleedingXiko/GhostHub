/**
 * Config Modal Module
 * Handles the configuration modal, its population, and saving settings.
 */

import { saveConfig } from '../utils/configManager.js';
import { CONFIG_DESCRIPTIONS } from '../core/configDescriptions.js';

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

    // Iterate over remaining CONFIG_DESCRIPTIONS for python_config keys
    for (const fullKey in CONFIG_DESCRIPTIONS) {
        if (fullKey.startsWith('python_config.') && fullKey !== 'python_config.SESSION_PASSWORD') {
            const key = fullKey.substring('python_config.'.length);
            if (!tunnelConfigKeys.includes(key)) { // Exclude tunnel-specific keys handled elsewhere
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
