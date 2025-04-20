/**
 * Main Entry Point
 * Imports all modules and initializes the application
 */

// Import core app module
import { app, syncToggleBtn } from './core/app.js';

// Import utility modules
import * as cacheManager from './utils/cacheManager.js';

// Import feature modules
import * as categoryManager from './modules/categoryManager.js';
import * as mediaLoader from './modules/mediaLoader.js';
import * as mediaNavigation from './modules/mediaNavigation.js';
import * as uiController from './modules/uiController.js';
import * as syncManager from './modules/syncManager.js';
import * as eventHandlers from './modules/eventHandlers.js';
import * as chatManager from './modules/chatManager.js';
import * as fullscreenManager from './modules/fullscreenManager.js';

// Create a global namespace for modules to avoid circular dependencies
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

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing application...');
    
    // Connect modules that have circular dependencies
    categoryManager.setViewCategoryFunction(mediaLoader.viewCategory);
    
    // Initialize sync toggle button - critical UI element
    if (syncToggleBtn) {
        syncToggleBtn.addEventListener('click', syncManager.toggleSyncMode);
    }
    
    // PHASE 1: Critical initialization - UI and categories
    // Load categories immediately - this is essential for the app to function
    categoryManager.loadCategories();
    
    // PHASE 2: Secondary initialization - after a short delay
    setTimeout(() => {
        console.log('Phase 2 initialization...');
        
        // Check sync mode status with a slight delay to avoid blocking initial render
        syncManager.checkSyncMode();
        
        // Initialize fullscreen change listener - not critical for initial load
        fullscreenManager.setupFullscreenChangeListener();
        
        // PHASE 3: Non-critical features - after a longer delay
        setTimeout(() => {
            console.log('Phase 3 initialization (non-critical features)...');
            
            // Initialize chat module - completely non-critical
            // The socket.io client creates a global io object
            if (typeof io !== 'undefined') {
                try {
                    // Create a socket connection if not already connected
                    const socket = io({
                        reconnectionAttempts: 5,
                        reconnectionDelay: 2000
                    });
                    
                    // Initialize chat with the socket
                    chatManager.initChat(socket);
                } catch (e) {
                    console.error('Error initializing chat:', e);
                    // Non-critical error, don't block the app
                }
            } else {
                console.warn('Socket.io not available for chat initialization');
            }
            
            console.log('Application fully initialized');
        }, 2000); // Wait 2 seconds for non-critical features
        
    }, 500); // Wait 500ms for secondary initialization
    
    console.log('Critical application components initialized');
});
