/**
 * Core App Module
 * Contains the main application instance, global variables, and DOM element references
 */

// DOM Elements
const categoryView = document.getElementById('categoryView');
const mediaView = document.getElementById('mediaView');
const categoryList = document.getElementById('categoryList');
const tiktokContainer = document.getElementById('tiktok-container');
const spinnerContainer = document.querySelector('#tiktok-container .spinner-container');
const syncToggleBtn = document.getElementById('sync-toggle-btn');

// Global constants
const MOBILE_DEVICE = window.innerWidth <= 768; // Detect if we're on a mobile device
const MEDIA_PER_PAGE = MOBILE_DEVICE ? 3 : 5; // Load fewer items per page on mobile
const LOAD_MORE_THRESHOLD = MOBILE_DEVICE ? 2 : 3; // Load more sooner on mobile
const renderWindowSize = 0; // Only render the current item to save memory

// Mobile-specific memory management constants
const MOBILE_CLEANUP_INTERVAL = 60000; // 1 minute in ms
const MOBILE_FETCH_TIMEOUT = 15000; // 15 seconds in ms

// Get MAX_CACHE_SIZE from server config if available, otherwise use default
const MAX_CACHE_SIZE = (function() {
    // Try to get the value from a global config object that might be set by the server
    if (window.serverConfig && typeof window.serverConfig.MAX_CACHE_SIZE === 'number') {
        return window.serverConfig.MAX_CACHE_SIZE;
    }
    // Otherwise use device-specific defaults
    return MOBILE_DEVICE ? 10 : 50; // Much smaller cache on mobile
})();


// Create app instance to expose to window for back button handler
const app = {
    // Global state variables
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
    
    // Media cache
    mediaCache: new Map(), // Cache for loaded media (with size limit)
    
    // Function to reset state when going back to category view
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

// Expose app instance to window
window.appInstance = app;

// Set up periodic cleanup for mobile devices
if (MOBILE_DEVICE) {
    console.log('Mobile device detected: Setting up aggressive memory management');
    
    // Set up periodic cleanup interval
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
    
    // Set up a more frequent check for fullscreen buttons
    // This helps ensure buttons are always available during rapid navigation
    app.state.fullscreenCheckInterval = setInterval(() => {
        if (window.appModules && window.appModules.fullscreenManager) {
            window.appModules.fullscreenManager.ensureFullscreenButtons();
        }
    }, 2000); // Check every 2 seconds
    
    // Add unload handler to clean up intervals
    window.addEventListener('beforeunload', () => {
        if (app.state.cleanupInterval) {
            clearInterval(app.state.cleanupInterval);
        }
        if (app.state.fullscreenCheckInterval) {
            clearInterval(app.state.fullscreenCheckInterval);
        }
    });
}

// Export DOM elements, constants, and app instance
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
