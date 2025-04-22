/**
 * Core App Module
 * Main application state, DOM references, and configuration constants.
 */

// DOM element references
const categoryView = document.getElementById('categoryView');
const mediaView = document.getElementById('mediaView');
const categoryList = document.getElementById('categoryList');
const tiktokContainer = document.getElementById('tiktok-container');
const spinnerContainer = document.querySelector('#tiktok-container .spinner-container');
const syncToggleBtn = document.getElementById('sync-toggle-btn');

// Configuration constants
const MOBILE_DEVICE = window.innerWidth <= 768; // Detect if we're on a mobile device
const MEDIA_PER_PAGE = MOBILE_DEVICE ? 3 : 5; // Load fewer items per page on mobile
const LOAD_MORE_THRESHOLD = MOBILE_DEVICE ? 2 : 3; // Load more sooner on mobile
const renderWindowSize = 0; // Only render the current item to save memory

// Mobile optimization settings
const MOBILE_CLEANUP_INTERVAL = 60000; // 1 minute in ms
const MOBILE_FETCH_TIMEOUT = 15000; // 15 seconds in ms

// Cache size configuration
const MAX_CACHE_SIZE = (function() {
    // Try to get the value from a global config object that might be set by the server
    if (window.serverConfig && typeof window.serverConfig.MAX_CACHE_SIZE === 'number') {
        return window.serverConfig.MAX_CACHE_SIZE;
    }
    // Otherwise use device-specific defaults
    // Start with device-specific defaults
    let defaultCacheSize = MOBILE_DEVICE ? 10 : 50;

    // Try to use navigator.deviceMemory as a hint (if available and not overridden by server)
    if (!window.serverConfig?.MAX_CACHE_SIZE && navigator.deviceMemory) {
        console.log(`Device memory reported: ${navigator.deviceMemory} GB`);
        // Adjust cache size based on memory (example thresholds)
        if (navigator.deviceMemory >= 8) {
            defaultCacheSize = MOBILE_DEVICE ? 20 : 100; // More memory, larger cache
        } else if (navigator.deviceMemory >= 4) {
            defaultCacheSize = MOBILE_DEVICE ? 15 : 75;
        } else {
            defaultCacheSize = MOBILE_DEVICE ? 10 : 50; // Default for lower memory
        }
        console.log(`Adjusted MAX_CACHE_SIZE based on device memory: ${defaultCacheSize}`);
    } else if (window.serverConfig?.MAX_CACHE_SIZE) {
         console.log(`Using MAX_CACHE_SIZE from server config: ${window.serverConfig.MAX_CACHE_SIZE}`);
         return window.serverConfig.MAX_CACHE_SIZE;
    } else {
         console.log(`Using default MAX_CACHE_SIZE: ${defaultCacheSize}`);
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
    
    // Periodic memory cleanup
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
    
    // Ensure fullscreen controls remain available
    app.state.fullscreenCheckInterval = setInterval(() => {
        if (window.appModules && window.appModules.fullscreenManager) {
            window.appModules.fullscreenManager.ensureFullscreenButtons();
        }
    }, 2000); // Check every 2 seconds
    
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
    MEDIA_PER_PAGE,
    LOAD_MORE_THRESHOLD,
    renderWindowSize,
    MAX_CACHE_SIZE,
    MOBILE_FETCH_TIMEOUT,
    MOBILE_CLEANUP_INTERVAL,
    app
};
