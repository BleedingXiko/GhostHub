/**
 * Core App Module
 * Main application state, DOM references, and configuration constants.
 */

import { getConfigValue } from '../utils/configManager.js';

// DOM element references
const categoryView = document.getElementById('categoryView');
const mediaView = document.getElementById('mediaView');
const categoryList = document.getElementById('categoryList');
const tiktokContainer = document.getElementById('tiktok-container');
const spinnerContainer = document.querySelector('#tiktok-container .spinner-container');
const syncToggleBtn = document.getElementById('sync-toggle-btn');

// Configuration constants
const MOBILE_DEVICE = window.innerWidth <= 768; // Detect if we're on a mobile device

// Load configuration values using getConfigValue, with original values as fallbacks
const MEDIA_PER_PAGE_DESKTOP_DEFAULT = 5;
const MEDIA_PER_PAGE_MOBILE_DEFAULT = 3;
const LOAD_MORE_THRESHOLD_DESKTOP_DEFAULT = 3;
const LOAD_MORE_THRESHOLD_MOBILE_DEFAULT = 2;
const RENDER_WINDOW_SIZE_DEFAULT = 0;
const MOBILE_CLEANUP_INTERVAL_DEFAULT = 60000;
const MOBILE_FETCH_TIMEOUT_DEFAULT = 15000;
const MAX_CACHE_SIZE_PYTHON_DEFAULT = 50; // Default from python_config if not passed via window.appConfig
const MAX_CACHE_SIZE_MOBILE_DEFAULT = 10;
const MAX_CACHE_SIZE_DESKTOP_DEFAULT = 50;

// Make MEDIA_PER_PAGE a function to get the value on demand
function getMediaPerPage() {
    return getConfigValue('javascript_config.core_app.media_per_page_desktop', 
               getConfigValue('javascript_config.core_app.media_per_page_mobile', 
                              MEDIA_PER_PAGE_DESKTOP_DEFAULT
                             )
           );
}

const LOAD_MORE_THRESHOLD = MOBILE_DEVICE ?
    getConfigValue('javascript_config.core_app.load_more_threshold_mobile', LOAD_MORE_THRESHOLD_MOBILE_DEFAULT) :
    getConfigValue('javascript_config.core_app.load_more_threshold_desktop', LOAD_MORE_THRESHOLD_DESKTOP_DEFAULT);

const renderWindowSize = getConfigValue('javascript_config.core_app.render_window_size', RENDER_WINDOW_SIZE_DEFAULT);

// Mobile optimization settings from config
const MOBILE_CLEANUP_INTERVAL = getConfigValue('javascript_config.core_app.mobile_cleanup_interval', MOBILE_CLEANUP_INTERVAL_DEFAULT);
const MOBILE_FETCH_TIMEOUT = getConfigValue('javascript_config.core_app.mobile_fetch_timeout', MOBILE_FETCH_TIMEOUT_DEFAULT);

// Cache size configuration
const MAX_CACHE_SIZE = (function() {
    // 1. Try to get from window.appConfig (set by configManager.js from /api/config)
    let cacheSize = getConfigValue('python_config.MAX_CACHE_SIZE', null);
    if (cacheSize !== null && typeof cacheSize === 'number') {
        console.log(`Using MAX_CACHE_SIZE from appConfig (python_config): ${cacheSize}`);
        return cacheSize;
    }

    // 2. Fallback to device-specific defaults (original logic, slightly adapted)
    let defaultCacheSize = MOBILE_DEVICE ? MAX_CACHE_SIZE_MOBILE_DEFAULT : MAX_CACHE_SIZE_DESKTOP_DEFAULT;

    if (navigator.deviceMemory) {
        console.log(`Device memory reported: ${navigator.deviceMemory} GB`);
        if (navigator.deviceMemory >= 8) {
            defaultCacheSize = MOBILE_DEVICE ? 20 : 100;
        } else if (navigator.deviceMemory >= 4) {
            defaultCacheSize = MOBILE_DEVICE ? 15 : 75;
        }
        console.log(`Adjusted MAX_CACHE_SIZE based on device memory: ${defaultCacheSize}`);
    } else {
         console.log(`Using default MAX_CACHE_SIZE (no deviceMemory API or python_config): ${defaultCacheSize}`);
    }
    return defaultCacheSize;
})();


// Main application object
const app = {
    // Application state
    state: {
        currentCategoryId: null,
        currentPage: 1,
        isLoading: false,
        hasMoreMedia: true,
        fullMediaList: [],
        currentMediaIndex: 0,
        // Sync mode variables
        syncModeEnabled: false,
        isHost: false,
        navigationDisabled: false, // Flag to disable navigation for guests in sync mode
        syncPollingInterval: null,
        // Media loading optimization variables
        preloadQueue: [],
        isPreloading: false,
        lastCleanupTime: Date.now(),
        currentFetchController: null,
        controlsContainer: null,
        // Mobile optimization variables
        cleanupInterval: null,
        fetchTimeouts: {}
    },
    
    // Media element cache
    mediaCache: new Map(), // Size-limited cache for loaded media
    
    // State reset function
    resetState: function() {
        console.log("Resetting app state");
        // Reset all state variables
        this.state.currentCategoryId = null;
        this.state.currentPage = 1;
        this.state.hasMoreMedia = true;
        this.state.isLoading = false;
        this.state.fullMediaList = [];
        this.state.preloadQueue = [];
        this.state.isPreloading = false;
        this.state.currentMediaIndex = 0;
        this.state.navigationDisabled = false;
        
        // Clear media cache
        this.mediaCache.clear();
        
        // Abort any ongoing fetch requests
        if (this.state.currentFetchController) {
            console.log("Aborting fetch requests during reset");
            this.state.currentFetchController.abort();
            this.state.currentFetchController = null;
        }
        
        // Perform aggressive cleanup
        if (typeof window.appModules !== 'undefined' && window.appModules.mediaLoader) {
            window.appModules.mediaLoader.clearResources(true);
        }
        
        console.log("App state reset complete");
    }
};

// Global app reference
window.appInstance = app;

    // Mobile-specific memory management
if (MOBILE_DEVICE) {
    console.log('Mobile device detected: Setting up aggressive memory management');
    
    // Periodic memory cleanup using configured interval
    app.state.cleanupInterval = setInterval(() => {
        console.log('Mobile device: performing periodic cleanup');
        
        // Clear any media that's not currently visible
        if (app.state.currentMediaIndex !== null && app.state.fullMediaList.length > 0) {
            const currentMedia = app.state.fullMediaList[app.state.currentMediaIndex];
            
            // Only keep the current media in cache, clear everything else
            app.mediaCache.clear();
            if (currentMedia && currentMedia.url) {
                // Re-add just the current item if it exists
                const cachedItem = document.querySelector(`[data-media-url="${currentMedia.url}"]`);
                if (cachedItem) {
                    app.mediaCache.set(currentMedia.url, cachedItem.cloneNode(true));
                }
            }
        }
        
        // Force garbage collection hint
        app.state.lastCleanupTime = Date.now();
        
        // Clear any stale fetch timeouts
        const now = Date.now();
        Object.keys(app.state.fetchTimeouts).forEach(key => {
            if (now - app.state.fetchTimeouts[key] > MOBILE_FETCH_TIMEOUT) {
                delete app.state.fetchTimeouts[key];
            }
        });
        
        // Call the cacheManager's cleanup if available
        if (window.appModules && window.appModules.cacheManager) {
            window.appModules.cacheManager.performCacheCleanup(true);
        }
        
        // Ensure fullscreen buttons are present on active videos
        // This helps recover from situations where buttons were removed during cleanup
        if (window.appModules && window.appModules.fullscreenManager) {
            window.appModules.fullscreenManager.ensureFullscreenButtons();
        }
    }, MOBILE_CLEANUP_INTERVAL);
    
    // Ensure fullscreen controls remain available using configured interval
    const fullscreenCheckInterval = getConfigValue('javascript_config.core_app.fullscreen_check_interval', 2000);
    app.state.fullscreenCheckInterval = setInterval(() => {
        if (window.appModules && window.appModules.fullscreenManager) {
            window.appModules.fullscreenManager.ensureFullscreenButtons();
        }
    }, fullscreenCheckInterval);
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (app.state.cleanupInterval) {
            clearInterval(app.state.cleanupInterval);
        }
        if (app.state.fullscreenCheckInterval) {
            clearInterval(app.state.fullscreenCheckInterval);
        }
    });
}

// Module exports
export {
    categoryView,
    mediaView,
    categoryList,
    tiktokContainer,
    spinnerContainer,
    syncToggleBtn,
    MOBILE_DEVICE,
    getMediaPerPage,
    LOAD_MORE_THRESHOLD,
    renderWindowSize,
    MAX_CACHE_SIZE,
    MOBILE_FETCH_TIMEOUT,
    MOBILE_CLEANUP_INTERVAL,
    app
};
