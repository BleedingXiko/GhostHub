/**
 * Main Entry Point
 * Application initialization and module orchestration.
 */

// Core app module (side effects + shared app services)
import {
    app,
    appStore,
    appState,
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
    cleanupCoreAppLifecycle
} from './core/app.js';
import { ensureSessionId } from './utils/cookieUtils.js';
import { initProfileSelector } from './modules/profile/selector.js';
import {
    registerProfileSocketHandlers,
    cleanupProfileSocketHandlers,
    PROFILE_SELECTED_EVENT,
} from './modules/profile/events.js';
import { SOCKET_EVENTS } from './core/socketEvents.js';

// Utility modules
import * as cacheManager from './utils/cacheManager.js';
import { fetchAndApplyConfig, getConfigValue } from './utils/configManager.js'; // Import config manager
import * as themeManager from './utils/themeManager.js'; // Import theme manager
import { initLogger } from './utils/logger.js'; // Import logger for debug control
import { getUserPreference } from './utils/userPreferences.js'; // Import user preferences
import { applyMotionPreference } from './utils/motionPreferences.js';
import { checkRevealHiddenStatus } from './utils/showHiddenManager.js';
import { toast, dialog, initNotificationManager } from './utils/notificationManager.js';
import { initTooltipManager, destroyTooltipManager } from './utils/tooltipManager.js';
import { hasActiveProfile } from './utils/profileUtils.js';
import { Module, ragotRegistry, $ } from './libs/ragot.esm.min.js';

// Feature modules
import * as mediaLoader from './modules/media/loader.js';
import * as mediaNavigation from './modules/media/navigation.js';
import { mediaManifest } from './modules/media/manifest.js';
import { mediaOrdering } from './modules/media/ordering.js';
import * as mediaSelectors from './modules/media/selectors.js';
import { MediaInvalidationModule } from './modules/media/invalidation.js';
import * as uiController from './modules/ui/controller.js';
import { initSearchBar, destroySearchBar } from './modules/ui/searchBar.js';
import * as syncManager from './modules/sync/manager.js';
import * as chatManager from './modules/chat/manager.js';
import * as fullscreenManager from './modules/playback/fullscreen.js';
import * as piOptimization from './modules/optimization/piOptimization.js'; // Import Pi optimization module
import { initAdminControls, registerSocketHandlers as registerAdminSocketHandlers, cleanupAdminControls } from './modules/admin/controller.js'; // Import admin controller and updater
import { destroyFileManager } from './modules/admin/files.js';
import { destroyThemeBuilder } from './modules/config/themeBuilder.js';
import { initProgressDB } from './utils/progressDB.js';
// Import TV Cast Manager
import { createTvCastUI, initTvCastManager, castMediaToTv, stopCasting, sendTvPlaybackControl, isCastingToTv, getCastingCategoryId, isCastingToCategory, refreshCastButtonVisibility, destroyTvCastManager } from './modules/sync/tvCast.js';
// Import Layouts
import * as streamingLayout from './modules/layouts/streaming/index.js';
import * as galleryLayout from './modules/layouts/gallery/index.js';
// Import GhostStream Manager for transcoding integration
import * as ghoststreamManager from './modules/ghoststream/manager.js';
// Import shared gestures (swipe-right-to-go-back, double-tap-fullscreen)
import { setupSharedGestures, cleanupSharedGestures } from './utils/gestures.js';
// Import video controls overlay
import * as videoControls from './modules/media/videoControls.js';
// Import photo viewer
import * as photoViewer from './modules/media/photoViewer.js';
// Import shared thumbnail progress utility
import ThumbnailProgress from './modules/shared/thumbnailProgress.js';

const mainLifecycle = new Module().start();
const mediaInvalidation = new MediaInvalidationModule(mediaManifest, mediaOrdering);
mainLifecycle.adopt(mediaManifest);
mainLifecycle.adopt(mediaOrdering);
mainLifecycle.adopt(mediaInvalidation);

// Single-source registry provisioning (main.js owns all registrations).
ragotRegistry.provide('cacheManager', cacheManager, mainLifecycle);
ragotRegistry.provide('appStore', appStore, mainLifecycle);
ragotRegistry.provide('appState', appState, mainLifecycle);
ragotRegistry.provide('appCache', app.mediaCache, mainLifecycle);
// appStore is the single source of truth for app state and carries its own
// actions via appStore.actions.* (registered in app.js via registerActions).
// Non-store services that don't belong on the store live here.
ragotRegistry.provide('appServices', {
    resetState: app.resetState.bind(app),
    cleanupCoreAppLifecycle
}, mainLifecycle);
ragotRegistry.provide('appDom', {
    gridContainer,
    mediaViewer,
    spinnerContainer,
    syncToggleBtn
}, mainLifecycle);
ragotRegistry.provide('appRuntime', {
    MOBILE_DEVICE,
    LOW_MEMORY_DEVICE,
    getMediaPerPage,
    LOAD_MORE_THRESHOLD,
    renderWindowSize,
    MAX_CACHE_SIZE,
    MOBILE_FETCH_TIMEOUT,
    MOBILE_CLEANUP_INTERVAL
}, mainLifecycle);
ragotRegistry.provide('mediaLoader', mediaLoader, mainLifecycle);
ragotRegistry.provide('mediaNavigation', mediaNavigation, mainLifecycle);
ragotRegistry.provide('mediaManifest', mediaManifest, mainLifecycle);
ragotRegistry.provide('mediaOrdering', mediaOrdering, mainLifecycle);
ragotRegistry.provide('mediaSelectors', mediaSelectors, mainLifecycle);
ragotRegistry.provide('mediaInvalidation', mediaInvalidation, mainLifecycle);
ragotRegistry.provide('uiController', uiController, mainLifecycle);
ragotRegistry.provide('syncManager', syncManager, mainLifecycle);
ragotRegistry.provide('chatManager', chatManager, mainLifecycle);
ragotRegistry.provide('fullscreenManager', fullscreenManager, mainLifecycle);
ragotRegistry.provide('tvCastManager', { createTvCastUI, initTvCastManager, castMediaToTv, stopCasting, sendTvPlaybackControl, isCastingToTv, getCastingCategoryId, isCastingToCategory, refreshCastButtonVisibility }, mainLifecycle);
ragotRegistry.provide('streamingLayout', streamingLayout, mainLifecycle);
ragotRegistry.provide('galleryLayout', galleryLayout, mainLifecycle);
ragotRegistry.provide('ghoststreamManager', ghoststreamManager, mainLifecycle);
ragotRegistry.provide('videoControls', videoControls, mainLifecycle);
ragotRegistry.provide('photoViewer', photoViewer, mainLifecycle);
ragotRegistry.provide('notificationManager', { toast, dialog, initNotificationManager }, mainLifecycle);

function applyActiveProfileUserPreferences(options = {}) {
    const { emitUpdates = true } = options;
    const runtimeConfig = appStore.get('config', {});
    const serverTheme = runtimeConfig?.javascript_config?.ui?.theme || 'dark';
    const serverLayout = runtimeConfig?.javascript_config?.ui?.layout || 'streaming';
    const serverFeatures = runtimeConfig?.javascript_config?.ui?.features || {};
    const userMotion = getUserPreference('motion', null);

    const validLayouts = ['streaming', 'gallery'];
    const userTheme = getUserPreference('theme', serverTheme);
    let userLayout = getUserPreference('layout', serverLayout);
    if (!validLayouts.includes(userLayout)) {
        console.log(`Invalid layout '${userLayout}', migrating to 'streaming'`);
        userLayout = 'streaming';
    }

    const featureKeys = ['chat', 'headerBranding', 'search', 'syncButton'];
    const features = {};
    featureKeys.forEach((key) => {
        features[key] = getUserPreference(`features.${key}`, serverFeatures[key]);
    });

    if (emitUpdates) {
        themeManager.applyTheme(userTheme, false);
        themeManager.applyLayout(userLayout, false);
        themeManager.applyFeatureToggles(features, false);
    } else {
        document.documentElement.setAttribute('data-theme', userTheme);
        document.documentElement.setAttribute('data-layout', userLayout);
        Object.entries(features).forEach(([key, enabled]) => {
            const attrName = `data-feature-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
            const value = enabled !== null && enabled !== undefined ? enabled.toString() : 'false';
            document.documentElement.setAttribute(attrName, value);
        });
    }

    applyMotionPreference(userMotion);
    console.log(`Applied motion preference: ${userMotion || 'system'}`);

    const latestConfig = appStore.get('config', {});
    if (latestConfig?.javascript_config?.ui) {
        const mergedConfig = JSON.parse(JSON.stringify(latestConfig));
        mergedConfig.javascript_config.ui.features = {
            ...(mergedConfig.javascript_config.ui.features || {}),
            ...features,
        };
        mergedConfig.javascript_config.ui.theme = userTheme;
        mergedConfig.javascript_config.ui.layout = userLayout;
        appStore.set('config', mergedConfig, { source: 'main.userPreferences.apply' });
        console.log('User preferences applied to config:', mergedConfig.javascript_config.ui);
    }
}

// Application initialization on DOM ready
document.addEventListener('DOMContentLoaded', async () => { // Make async
    let syncToggleBtn = null;
    let onSyncToggleClick = null;
    let profileSelector = null;
    // PRE-PHASE: Ensure session stability
    ensureSessionId();
    initNotificationManager();
    initTooltipManager();

    console.log('Initializing application...');

    // PHASE 0: Theme is now applied server-side via data-theme attribute on <html>
    // This prevents the flash of unstyled content (FOUC) that occurred when
    // waiting for async config fetch before applying theme

    // PHASE 0.5: Load application configuration
    await fetchAndApplyConfig();
    const runtimeConfig = appStore.get('config', {});
    appStore.set('isAdmin', runtimeConfig?.is_admin === true, { source: 'main.config.isAdmin' });

    profileSelector = initProfileSelector();
    ragotRegistry.provide('profileSelector', profileSelector, mainLifecycle, { replace: true });
    await profileSelector.ensureActiveProfile();

    // Sync show_hidden session state with server BEFORE first layout render.
    // Without this, initial load can render with stale visibility filters until later socket events.
    await checkRevealHiddenStatus();

    // PHASE 0.6: Apply user preferences (overrides server defaults)
    applyActiveProfileUserPreferences({ emitUpdates: false });
    mainLifecycle.on(window, PROFILE_SELECTED_EVENT, () => {
        applyActiveProfileUserPreferences({ emitUpdates: true });
    });

    // Initialize logger (silences console.log in production when DEBUG_MODE is false)
    initLogger();

    // Initialize theme manager to sync with loaded config (handles custom themes, etc.)
    themeManager.initThemeManager();
    console.log('Theme Manager initialized.');

    // Setup shared gestures (swipe-right-to-go-back, double-tap-fullscreen) for all layouts
    setupSharedGestures();
    console.log('Shared gestures initialized.');

    // Initialize GhostStream EARLY - must happen before media is rendered
    // so MKV/AVI/etc files know transcoding is available
    // Initialize GhostStream - start it but verify it non-blocking to speed up initial load
    // The media renderer will check availability dynamically
    ghoststreamManager.initGhostStream().then(() => {
        console.log('GhostStream initialized, available:', ghoststreamManager.isAvailable());
    }).catch(e => {
        console.warn('GhostStream init error (non-critical):', e);
    });

    // Initialize lifecycle-owned non-layout UI/orchestration modules.
    uiController.initUIController();
    piOptimization.initPiOptimizationListeners();

    // Sync toggle initialization
    syncToggleBtn = $('#sync-toggle-btn');
    if (syncToggleBtn) {
        onSyncToggleClick = () => syncManager.toggleSyncMode();
        mainLifecycle.on(syncToggleBtn, 'click', onSyncToggleClick);
    }

    // Search bar initialization
    initSearchBar();

    // PHASE 1: Critical initialization
    createTvCastUI(); // Create TV cast button BEFORE admin controls check visibility
    initAdminControls(); // Initialize admin controls early
    // initUsersTab(); // Call moved to after socket initialization

    // Guest mode keeps progress in IndexedDB. Active profiles use server storage.
    if (!hasActiveProfile()) {
        await initProgressDB();
    }

    // Initialize the active layout
    // data-layout is already validated above (only 'streaming' or 'gallery')
    const currentLayout = document.documentElement.getAttribute('data-layout');
    if (currentLayout === 'gallery') {
        await galleryLayout.init();
        console.log('Gallery Layout initialized.');
    } else {
        await streamingLayout.init();
        console.log('Streaming Layout initialized.');
    }

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
                        reconnectionDelay: getConfigValue('javascript_config.main.socket_reconnectionDelay', 2000),
                        transports: ['websocket', 'polling'],
                        upgrade: true,
                        rememberUpgrade: true
                    };
                    console.log('Initializing main socket with options:', socketOptions);
                    const socket = io(socketOptions);

                    // Store socket in app state as single source of truth
                    appStore.set('socket', socket, { source: 'main.socket.init' });
                    mediaInvalidation.attachSocket(socket);

                    // Factory reset: USB sentinel file detected — passwords nuked, reload to clear gate
                    mainLifecycle.onSocket(socket, SOCKET_EVENTS.FACTORY_RESET, () => {
                        dialog.alert(
                            'Passwords have been reset to defaults. The page will reload.',
                            { title: 'Factory Reset' }
                        ).then(() => location.reload()).catch(() => location.reload());
                        setTimeout(() => location.reload(), 8000);
                    });

                    // Initialize media navigation now that socket exists
                    mediaNavigation.initMediaNavigation(socket);

                    // Initialize shared thumbnail progress utility
                    ThumbnailProgress.init(socket);
                    console.log('[ThumbnailProgress] Global utility initialized with socket');

                    // Heartbeat removed: using simple toggle model for admin lock

                    // Initialize chat and provide chat-owned services.
                    const chatLifecycle = chatManager.initChat(socket);
                    const chatServices = chatManager.getRegistryServices();
                    if (chatLifecycle && chatServices) {
                        ragotRegistry.provide('commandHandler', chatServices.commandHandler, chatLifecycle, { replace: true });
                        ragotRegistry.provide('commandPopup', chatServices.commandPopup, chatLifecycle, { replace: true });
                    }

                    // Initialize sync manager with the socket instance
                    syncManager.initSync(socket);

                    // Initialize TV Casting UI and Logic
                    initTvCastManager(socket);

                    // GhostStream already initialized in Phase 0.5 (before media rendering)

                    // Delegate socket events to their owning modules
                    registerAdminSocketHandlers(socket);
                    registerProfileSocketHandlers(socket, profileSelector);
                    streamingLayout.registerSocketHandlers(socket);
                    galleryLayout.registerSocketHandlers(socket);

                } catch (e) {
                    console.error('Error initializing chat, media navigation, or socket listeners:', e);
                    // Non-blocking error
                }
            } else {
                console.warn('Socket.io not available for chat initialization');
                mediaNavigation.initMediaNavigation(null);
            }

            console.log('Application fully initialized');
        }, phase3Delay); // Use configured delay

    }, phase2Delay); // Use configured delay

    console.log('Critical application components initialized');

    const safeUnload = (task) => {
        try {
            task();
        } catch (e) {
            // Ignore errors during unload
        }
    };

    // Central unload coordinator:
    // only non-HTML lifecycle owners with long-lived side effects are explicitly cleaned here.
    mainLifecycle.on(window, 'beforeunload', () => {
        const unloadTasks = [
            () => syncManager.cleanupSyncManager?.(),
            () => chatManager.cleanupChat?.(),
            () => destroySearchBar?.(),
            () => destroyTooltipManager?.(),
            () => uiController.cleanupUIController?.(),
            () => cleanupAdminControls?.(),
            () => cleanupProfileSocketHandlers?.(),
            () => destroyFileManager?.(),
            () => destroyThemeBuilder?.(),
            () => streamingLayout.cleanupSocketHandlers?.(),
            () => galleryLayout.cleanupSocketHandlers?.(),
            () => mediaNavigation.cleanupMediaNavigation?.(),
            () => ghoststreamManager.cleanup?.(),
            () => piOptimization.cleanupPiOptimization?.(),
            () => fullscreenManager.cleanupFullscreenChangeListener?.(),
            () => destroyTvCastManager?.(),
            () => cleanupSharedGestures?.(),
            () => cleanupCoreAppLifecycle?.(),
            () => mainLifecycle.stop(),
            () => window.ragotModules?.cacheManager?.clearCache?.(),
            () => sessionStorage.clear(),
            () => {
                const clearHiddenData = new FormData();
                clearHiddenData.append('clear_hidden', 'true');
                navigator.sendBeacon('/api/admin/categories/clear-session', clearHiddenData);
            }
        ];

        for (const task of unloadTasks) {
            safeUnload(task);
        }
    });
});
