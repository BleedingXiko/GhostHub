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
import * as ghoststreamManager from './modules/ghoststreamManager.js';
import { initAdminControls } from './modules/adminController.js'; // Import admin controller
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
    fullscreenManager,
    ghoststreamManager
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
    initAdminControls(); // Initialize admin controls early
    categoryManager.loadCategories();
    
    // Initialize GhostStream (non-blocking)
    ghoststreamManager.initGhostStream().then(status => {
        if (status.enabled && status.available) {
            console.log('GhostStream ready for transcoding');
        }
    }).catch(err => console.warn('GhostStream init error:', err));
    
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

                    // Listener for when the current user gets kicked
                    socket.on('you_have_been_kicked', (data) => {
                        console.warn('Received you_have_been_kicked event:', data);
                        alert(`You have been kicked by an administrator: ${data.message}\nYour access to this session has been revoked.`);
                        // Disable UI elements or overlay the screen
                        // For simplicity, we'll just show an alert and log.
                        // A more robust solution would involve uiController to freeze the UI.
                        document.body.innerHTML = `<div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); color: white; display: flex; justify-content: center; align-items: center; text-align: center; font-size: 2em; z-index: 9999;">${data.message}<br/>Please close this tab.</div>`;
                        // Consider also trying to close the socket connection from client-side if possible
                        if (socket && typeof socket.disconnect === 'function') {
                            socket.disconnect();
                        }
                    });

                    // Listener for admin receiving confirmation of a kick action
                    socket.on('admin_kick_confirmation', (data) => {
                        console.log('Received admin_kick_confirmation:', data);
                        if (window.appModules && window.appModules.chatManager && typeof window.appModules.chatManager.displayLocalMessage === 'function') {
                            const messageType = data.success ? 'info' : 'error';
                            window.appModules.chatManager.displayLocalMessage(data.message, messageType);
                        } else {
                            // Fallback if displayLocalMessage is not available
                            alert(`Kick attempt: ${data.success ? 'Success' : 'Failed'}\nMessage: ${data.message}`);
                        }
                    });


                    // Listen for category activity updates
                    // Ensure app.socket is set by chatManager.initChat or use local socket
                    const activeSocket = app.socket || socket; 
                    if (activeSocket) {
                        activeSocket.on('category_activity_update', (data) => {
                            // Use the imported categoryManager module directly
                            if (categoryManager && typeof categoryManager.updateCategoryActivityDisplay === 'function') {
                                categoryManager.updateCategoryActivityDisplay(data);
                            } else {
                                console.error('categoryManager.updateCategoryActivityDisplay is not available.');
                            }
                        });
                    } else {
                        console.error('Socket not available for category_activity_update listener.');
                    }
                    
                } catch (e) {
                    console.error('Error initializing chat, media navigation, or category activity listener:', e);
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
