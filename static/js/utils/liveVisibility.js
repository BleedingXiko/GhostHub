/**
 * Live Visibility Manager
 * Centralized function to refresh all layouts after show/hide operations
 */
import { $ } from '../libs/ragot.esm.min.js';

// Prevent concurrent refresh cycles
let isRefreshing = false;
let hasQueuedRefresh = false;
let queuedForceRefresh = false;
let queuedRefreshCategoryList = false;

/**
 * Refresh all layouts to reflect visibility changes
 * Call this after any show/hide operation for instant UI updates
 * @param {boolean} forceRefresh - If true, bypass caches (default: false)
 * @param {boolean} secondaryOnly - If true, only refresh secondary sections like What's New
 * @param {boolean} scrollToTop - If true, scroll the layout container to top after refresh
 * @param {Object} options - Additional layout-specific refresh options
 */
export async function refreshAllLayouts(forceRefresh = false, secondaryOnly = false, scrollToTop = false, options = {}) {
    if (!window.ragotModules) return;
    const refreshCategoryList = options.refreshCategoryList === true;

    // Guard against concurrent refresh cycles (critical for mobile)
    if (isRefreshing) {
        hasQueuedRefresh = true;
        queuedForceRefresh = queuedForceRefresh || forceRefresh;
        queuedRefreshCategoryList = queuedRefreshCategoryList || refreshCategoryList;
        console.log('[LiveVisibility] Queued refresh while another refresh is in progress');
        return;
    }

    const mediaViewerEl = $('#media-viewer');
    const viewerActive = mediaViewerEl && !mediaViewerEl.classList.contains('hidden');
    const fileManagerEl = $('#file-manager-modal');
    const fileManagerActive = fileManagerEl && !fileManagerEl.classList.contains('hidden');
    if (viewerActive || fileManagerActive) {
        const appState = window.ragotModules?.appState;
        if (appState) {
            appState.needsMediaRefresh = true;
            if (forceRefresh) {
                appState.forceMediaRefresh = true;
            }
        }
        console.log(`[LiveVisibility] Deferring refresh while ${viewerActive ? 'media viewer' : 'file manager'} is open`);
        return;
    }

    isRefreshing = true;
    const effectiveForceRefresh = queuedForceRefresh || forceRefresh;
    const effectiveRefreshCategoryList = queuedRefreshCategoryList || refreshCategoryList;
    hasQueuedRefresh = false;
    queuedForceRefresh = false;
    queuedRefreshCategoryList = false;
    try {
        const currentLayout = document.documentElement.getAttribute('data-layout');

        if (currentLayout === 'streaming' && window.ragotModules.streamingLayout?.refresh) {
            await window.ragotModules.streamingLayout.refresh(
                effectiveForceRefresh,
                secondaryOnly,
                effectiveRefreshCategoryList
            );
        } else if (currentLayout === 'gallery' && window.ragotModules.galleryLayout?.refresh) {
            await window.ragotModules.galleryLayout.refresh(effectiveForceRefresh);
        }

        if (scrollToTop) {
            const el = currentLayout === 'streaming'
                ? document.getElementById('streaming-container')
                : document.querySelector('.gallery-scroll-area');
            if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
        }
    } finally {
        isRefreshing = false;
    }

    if (hasQueuedRefresh) {
        const nextForceRefresh = queuedForceRefresh;
        const nextRefreshCategoryList = queuedRefreshCategoryList;
        hasQueuedRefresh = false;
        queuedForceRefresh = false;
        queuedRefreshCategoryList = false;
        // The queued refresh drops the secondaryOnly flag to do a full refresh 
        // if anything major changed while we were refreshing.
        await refreshAllLayouts(nextForceRefresh, false, false, {
            refreshCategoryList: nextRefreshCategoryList
        });
    }
}
