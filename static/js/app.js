/**
 * Mobile Media Browser Application
 * Main JavaScript file - Entry point that initializes the modular application
 */

// Import modules
import { app, syncToggleBtn } from './core/app.js';
import * as cacheManager from './utils/cacheManager.js';
import * as categoryManager from './modules/categoryManager.js';
import * as mediaLoader from './modules/mediaLoader.js';
import * as mediaNavigation from './modules/mediaNavigation.js';
import * as uiController from './modules/uiController.js';
import * as syncManager from './modules/syncManager.js';
import * as eventHandlers from './modules/eventHandlers.js';
import * as chatManager from './modules/chatManager.js';
import * as fullscreenManager from './modules/fullscreenManager.js';

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing application...');
    
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
    
    // Connect modules that have circular dependencies
    categoryManager.setViewCategoryFunction(mediaLoader.viewCategory);
    
    // Initialize sync toggle button
    if (syncToggleBtn) {
        syncToggleBtn.addEventListener('click', syncManager.toggleSyncMode);
    }

    // Check sync mode status on page load
    syncManager.checkSyncMode();
    
    // Load categories on page load
    categoryManager.loadCategories();
    
    // Initialize fullscreen change listener
    fullscreenManager.setupFullscreenChangeListener();
    
    // Initialize chat module
    // We need to wait for the socket to be available
    setTimeout(() => {
        // The socket.io client creates a global io object
        if (typeof io !== 'undefined') {
            // Create a socket connection if not already connected
            const socket = io({
                reconnectionAttempts: 5,
                reconnectionDelay: 2000
            });
            
            // Initialize chat with the socket
            chatManager.initChat(socket);
        } else {
            console.error('Socket.io not available for chat initialization');
        }
    }, 1000); // Wait 1 second to ensure Socket.io is loaded
    
    // Expose app instance to window for back button handler
    window.appInstance = app;
    
    console.log('Application initialized successfully');
});
