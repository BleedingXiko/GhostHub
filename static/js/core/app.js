/**
 * Core App Module
 * Main application state, DOM references, and configuration constants.
 */

import { getConfigValue } from '../utils/configManager.js';
import { Module, createStateStore, $ } from '../libs/ragot.esm.min.js';

// DOM element references
const gridContainer = $('#grid-container');
const mediaViewer = $('#media-viewer');
const spinnerContainer = $('#media-viewer .spinner-container');
const syncToggleBtn = $('#sync-toggle-btn');

// Configuration constants
const MOBILE_DEVICE = window.innerWidth <= 768; // Detect if we're on a mobile device

// Low memory client device detection (for mobile phones, tablets, etc.)
// Note: Pi runs as server - this detects the CLIENT device capabilities
const LOW_MEMORY_DEVICE = navigator.deviceMemory && navigator.deviceMemory <= 2;

document.documentElement.classList.toggle('gh-low-memory', !!LOW_MEMORY_DEVICE);

// Load configuration values using getConfigValue, with original values as fallbacks
const MEDIA_PER_PAGE_DESKTOP_DEFAULT = 5;
const MEDIA_PER_PAGE_MOBILE_DEFAULT = 3;
const LOAD_MORE_THRESHOLD_DESKTOP_DEFAULT = 3;
const LOAD_MORE_THRESHOLD_MOBILE_DEFAULT = 2;
const RENDER_WINDOW_SIZE_DEFAULT = 0;
const MOBILE_CLEANUP_INTERVAL_DEFAULT = 60000;
const MOBILE_FETCH_TIMEOUT_DEFAULT = 15000;
const MAX_CACHE_SIZE_PYTHON_DEFAULT = 50;
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
const MAX_CACHE_SIZE = (function () {
    // 1. Try to get from fetched config (configManager.js from /api/config)
    let cacheSize = getConfigValue('python_config.MAX_CACHE_SIZE', null);
    if (cacheSize !== null && typeof cacheSize === 'number') {
        console.log(`Using MAX_CACHE_SIZE from appConfig (python_config): ${cacheSize}`);
        return cacheSize;
    }

    // 2. Fallback to device-specific defaults based on CLIENT device
    let defaultCacheSize = MOBILE_DEVICE ? MAX_CACHE_SIZE_MOBILE_DEFAULT : MAX_CACHE_SIZE_DESKTOP_DEFAULT;

    if (navigator.deviceMemory) {
        console.log(`Client device memory: ${navigator.deviceMemory} GB`);
        if (navigator.deviceMemory >= 8) {
            defaultCacheSize = MOBILE_DEVICE ? 20 : 100;
        } else if (navigator.deviceMemory >= 4) {
            defaultCacheSize = MOBILE_DEVICE ? 15 : 75;
        } else if (navigator.deviceMemory <= 2) {
            // Very low memory client - use conservative cache
            defaultCacheSize = MOBILE_DEVICE ? 5 : 10;
        }
        console.log(`Adjusted MAX_CACHE_SIZE based on client memory: ${defaultCacheSize}`);
    } else {
        console.log(`Using default MAX_CACHE_SIZE: ${defaultCacheSize}`);
    }
    return defaultCacheSize;
})();


const INITIAL_APP_STATE = {
    isAdmin: false,
    config: {},
    socket: null,
    activeProfileId: null,
    activeProfileName: null,
    activeProfileColor: null,
    activeProfileIcon: null,
    currentCategoryId: null,
    viewer: null,
    isLoading: false,
    asyncIndexingActive: false,
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
};

// Canonical mutable store for app-level shared state
const appStore = createStateStore(INITIAL_APP_STATE, { name: 'appState' });
const appState = appStore.getState();

// Register named app-level actions on the store.
// These are the only correct way to perform tracked mutations from outside this module.
// Callers: appStore.actions.setField('key', value) or appStore.dispatch('setField', 'key', value).
// Source metadata is injected automatically via the action name.
appStore.registerActions({
    setField(store, key, value) {
        store.set(key, value, { source: `appActions.setField:${key}` });
    },
    patchState(store, partial) {
        store.setState(partial, { source: 'appActions.patchState' });
    },
    batchState(store, mutator) {
        store.batch(mutator, { source: 'appActions.batchState' });
    },
    compareAndSet(store, path, expectedValue, nextValue) {
        return store.compareAndSet(path, expectedValue, nextValue, { source: 'appActions.compareAndSet' });
    },
});

// Main application object
const app = {
    // Internal reference to the proxied store state.
    // ACCESS POLICY: Only CoreAppLifecycle (within this module) should use app.state.X.
    // All external modules must read/write state via:
    //   - appStateUtils helpers           (preferred — setAppState, batchAppState, etc.)
    //   - window.ragotModules.appStore.actions.*  (direct store action dispatch)
    //   - window.ragotModules.appState    (read-only proxy access)
    // Do NOT add new external usages of `app.state`.
    state: appState,

    // Media element cache
    mediaCache: new Map(), // Size-limited cache for loaded media

    // State reset function
    resetState: function () {
        console.log("Resetting app state");

        // Reset core state in one transactional batch.
        appStore.batch((state) => {
            state.currentCategoryId = null;
            state.viewer = null;
            state.asyncIndexingActive = false;
            state.isLoading = false;
            state.preloadQueue = [];
            state.isPreloading = false;
            state.navigationDisabled = false;
        }, { source: 'app.resetState' });

        // Clear media cache
        this.mediaCache.clear();

        // Abort any ongoing fetch requests
        if (this.state.currentFetchController) {
            console.log("Aborting fetch requests during reset");
            this.state.currentFetchController.abort();
            this.state.currentFetchController = null;
        }

        // Perform aggressive cleanup
        if (typeof window.ragotModules !== 'undefined' && window.ragotModules.mediaLoader) {
            window.ragotModules.mediaLoader.clearResources(true);
        }

        console.log("App state reset complete");
    }
};

let coreAppLifecycle = null;

class CoreAppLifecycle extends Module {
    onStart() {
        if (!MOBILE_DEVICE) return;

        console.log('Mobile device detected: Setting up aggressive memory management');

        // Periodic memory cleanup using configured interval
        app.state.cleanupInterval = this.interval(() => {
            console.log('Mobile device: performing periodic cleanup');

            app.mediaCache.clear();

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
            if (window.ragotModules && window.ragotModules.cacheManager) {
                window.ragotModules.cacheManager.performCacheCleanup(true);
            }
        }, MOBILE_CLEANUP_INTERVAL);

        // Cleanup on page unload
        this.on(window, 'beforeunload', () => {
            if (app.state.cleanupInterval) {
                this.clearInterval(app.state.cleanupInterval);
                app.state.cleanupInterval = null;
            }
        });
    }

    onStop() {
        if (app.state.cleanupInterval) {
            this.clearInterval(app.state.cleanupInterval);
            app.state.cleanupInterval = null;
        }
    }
}

function ensureCoreAppLifecycle() {
    if (!coreAppLifecycle) {
        coreAppLifecycle = new CoreAppLifecycle();
    }
    coreAppLifecycle.start();
}

function cleanupCoreAppLifecycle() {
    if (coreAppLifecycle) {
        coreAppLifecycle.stop();
        coreAppLifecycle = null;
    }
}

ensureCoreAppLifecycle();

// Module exports
export {
    gridContainer,
    mediaViewer,
    spinnerContainer,
    syncToggleBtn,
    MOBILE_DEVICE,
    LOW_MEMORY_DEVICE,
    getMediaPerPage,
    LOAD_MORE_THRESHOLD,
    renderWindowSize,
    MAX_CACHE_SIZE,
    MOBILE_FETCH_TIMEOUT,
    MOBILE_CLEANUP_INTERVAL,
    appStore,
    appState,
    app,
    cleanupCoreAppLifecycle
};
