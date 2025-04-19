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
const MEDIA_PER_PAGE = 5; // Reduced: Load 5 items per page for faster initial load
const LOAD_MORE_THRESHOLD = 3; // Reduced: Load more when 3 items away from the end
const renderWindowSize = 0; // Reduced: Only render the current item to save memory
const MAX_CACHE_SIZE = MOBILE_DEVICE ? 20 : 50; // Smaller cache on mobile

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
        controlsContainer: null
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

// Export DOM elements, constants, and app instance
export {
    categoryView,
    mediaView,
    categoryList,
    tiktokContainer,
    spinnerContainer,
    syncToggleBtn,
    MOBILE_DEVICE,
    MEDIA_PER_PAGE, // Export this constant
    LOAD_MORE_THRESHOLD,
    renderWindowSize,
    MAX_CACHE_SIZE,
    app
};
