/**
 * Main Entry Point
 * Application initialization and module orchestration.
 */

// Core app module
import { app, syncToggleBtn } from './core/app.js';

// Utility modules
import * as cacheManager from './utils/cacheManager.js';

// Feature modules
import * as categoryManager from './modules/categoryManager.js';
import * as mediaLoader from './modules/mediaLoader.js';
import * as mediaNavigation from './modules/mediaNavigation.js';
import * as uiController from './modules/uiController.js';
import * as syncManager from './modules/syncManager.js';
import * as eventHandlers from './modules/eventHandlers.js';
import * as chatManager from './modules/chatManager.js';
import * as fullscreenManager from './modules/fullscreenManager.js';

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
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing application...');
    
    // Connect interdependent modules
    categoryManager.setViewCategoryFunction(mediaLoader.viewCategory);
    
    // Sync toggle initialization
    if (syncToggleBtn) {
        syncToggleBtn.addEventListener('click', syncManager.toggleSyncMode);
    }
    
    // PHASE 1: Critical initialization
    categoryManager.loadCategories();
    
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
                    // Create socket connection
                    const socket = io({
                        reconnectionAttempts: 5,
                        reconnectionDelay: 2000
                    });
                    
                    // Initialize chat
                    chatManager.initChat(socket);
                } catch (e) {
                    console.error('Error initializing chat:', e);
                    // Non-blocking error
                }
            } else {
                console.warn('Socket.io not available for chat initialization');
            }
            
            console.log('Application fully initialized');
        }, 2000); // Wait 2 seconds for non-critical features
        
    }, 500); // Wait 500ms for secondary initialization
    
    console.log('Critical application components initialized');
});
