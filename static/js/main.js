/**
 * Main Entry Point
 * Application initialization and module orchestration.
 */

// Core app module
import { app, syncToggleBtn } from './core/app.js';

// Utility modules
import * as cacheManager from './utils/cacheManager.js';
import { fetchAndApplyConfig, getConfigValue } from './utils/configManager.js'; // Import config manager

// Feature modules
import * as categoryManager from './modules/categoryManager.js';
import * as mediaLoader from './modules/mediaLoader.js';
import * as mediaNavigation from './modules/mediaNavigation.js';
import * as uiController from './modules/uiController.js';
import * as syncManager from './modules/syncManager.js';
import * as eventHandlers from './modules/eventHandlers.js';
import * as chatManager from './modules/chatManager.js';
import * as fullscreenManager from './modules/fullscreenManager.js';
// Import the init function specifically
import { initMediaNavigation } from './modules/mediaNavigation.js'; 

// Global module namespace to prevent circular dependencies
window.appModules = {
    cacheManager,
    categoryManager,
    mediaLoader,
    mediaNavigation,
    uiController,
    syncManager,
    eventHandlers,
    chatManager,
    fullscreenManager
};

// Application initialization on DOM ready
document.addEventListener('DOMContentLoaded', async () => { // Make async
    console.log('Initializing application...');

    // PHASE 0: Load application configuration
    await fetchAndApplyConfig();
    console.log('Configuration loaded.');
    
    // Connect interdependent modules
    categoryManager.setViewCategoryFunction(mediaLoader.viewCategory);
    
    // Sync toggle initialization
    if (syncToggleBtn) {
        syncToggleBtn.addEventListener('click', syncManager.toggleSyncMode);
    }
    
    // PHASE 1: Critical initialization
    categoryManager.loadCategories();
    
    // Get phase delays from config, with fallbacks to original values
    const phase2Delay = getConfigValue('javascript_config.main.phase2_init_delay', 250);
    const phase3Delay = getConfigValue('javascript_config.main.phase3_init_delay', 500);

    // PHASE 2: Secondary initialization (delayed)
    setTimeout(() => {
        console.log('Phase 2 initialization...');
        
        // Check sync mode status
        syncManager.checkSyncMode();
        
        // Setup fullscreen support
        fullscreenManager.setupFullscreenChangeListener();
        
        // PHASE 3: Non-critical features (further delayed)
        setTimeout(() => {
            console.log('Phase 3 initialization (non-critical features)...');
            
            // Chat initialization (optional)
            if (typeof io !== 'undefined') {
                try {
                    // Get socket options from config
                    const socketOptions = {
                        reconnectionAttempts: getConfigValue('javascript_config.main.socket_reconnectionAttempts', 5),
                        reconnectionDelay: getConfigValue('javascript_config.main.socket_reconnectionDelay', 2000)
                        // Add other Socket.IO client options here if they become configurable
                    };
                    console.log('Initializing main socket with options:', socketOptions);
                    const socket = io(socketOptions);
                    
                    // Initialize chat
                    chatManager.initChat(socket);
                    
                    // Initialize media navigation with socket
                    initMediaNavigation(socket); 
                    
                } catch (e) {
                    console.error('Error initializing chat or media navigation:', e);
                    // Non-blocking error
                }
            } else {
                console.warn('Socket.io not available for chat initialization');
            }
            
            console.log('Application fully initialized');
        }, phase3Delay); // Use configured delay
        
    }, phase2Delay); // Use configured delay
    
    console.log('Critical application components initialized');
});
