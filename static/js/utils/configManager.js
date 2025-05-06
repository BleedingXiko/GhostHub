/**
 * Configuration Manager
 * Handles fetching, storing, and saving application configuration for the frontend.
 */

let currentConfig = {};
let initialConfigFetched = false;

/**
 * Fetches the application configuration from the server.
 * Stores it locally and makes it available via window.appConfig.
 * @returns {Promise<Object>} The fetched configuration.
 */
async function fetchAndApplyConfig() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) {
            throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}`);
        }
        currentConfig = await response.json();
        window.appConfig = currentConfig; // Make it globally accessible
        initialConfigFetched = true;
        console.log('Application configuration loaded:', currentConfig);
        return currentConfig;
    } catch (error) {
        console.error('Error fetching application configuration:', error);
        // Fallback to an empty config or default structure if needed
        window.appConfig = window.appConfig || { python_config: {}, javascript_config: {} }; 
        currentConfig = window.appConfig;
        return currentConfig; // Return current (possibly default/empty) config
    }
}

/**
 * Gets a configuration value using a dot-separated path.
 * @param {string} path - The dot-separated path to the config value (e.g., "javascript_config.core_app.media_per_page_desktop").
 * @param {*} defaultValue - The value to return if the path is not found.
 * @returns {*} The configuration value or the default value.
 */
function getConfigValue(path, defaultValue) {
    if (!initialConfigFetched) {
        console.warn('ConfigManager: Attempted to get config value before initial fetch completed. Consider awaiting fetchAndApplyConfig() or ensuring it runs first.');
    }
    const keys = path.split('.');
    let value = currentConfig;
    for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
            value = value[key];
        } else {
            return defaultValue;
        }
    }
    return value;
}

/**
 * Saves the provided configuration data to the server.
 * @param {Object} newConfigData - The complete configuration object to save.
 * @returns {Promise<Object>} The server's response.
 */
async function saveConfig(newConfigData) {
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(newConfigData),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to save config and parse error response.' }));
            throw new Error(errorData.error || `Failed to save config: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        // Update local config cache on successful save
        currentConfig = { ...newConfigData }; // Assume newConfigData is the full, correct structure
        window.appConfig = currentConfig;
        console.log('Configuration saved successfully:', result.message);
        return result;
    } catch (error) {
        console.error('Error saving application configuration:', error);
        throw error; // Re-throw to be handled by the caller
    }
}

export { fetchAndApplyConfig, getConfigValue, saveConfig };
