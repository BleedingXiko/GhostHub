/**
 * Index Updates — socket-driven category re-fetch after async indexing
 *
 * Manages debounced refreshes for categories whose server-side index has
 * changed, plus shell-refresh scheduling for categories still indexing.
 */

import {
    getCategoriesData,
    getCategoryIdFilter,
    getSubfolderFilter,
    getCategoryView,
    setCategoryView,
    setGridTotalItems,
    streamingState,
    isActive
} from './state.js';
import { fetchCategoryMedia } from './mediaDataSource.js';
import { refreshLazyLoader } from './lazyLoad.js';
import { Module, $ } from '../../../libs/ragot.esm.min.js';
import { SOCKET_EVENTS } from '../../../core/socketEvents.js';

function viewItemCount(cache) {
    return Array.isArray(cache?.orderedIds) ? cache.orderedIds.length : 0;
}

/**
 * @param {Object} deps
 * @param {Function} deps.getModule — returns the StreamingLayoutModule singleton
 * @returns {{
 *   registerIndexUpdateSocketHandler: Function,
 *   cleanupIndexUpdateLifecycle: Function,
 *   refreshIndexedCategorySurface: Function,
 *   scheduleShellRefresh: Function,
 *   clearPendingShellRefresh: Function
 * }}
 */
export function createIndexUpdateHandlers({ getModule }) {
    let _indexUpdateLifecycle = null;
    const _pendingIndexRefreshes = new Map();
    const _pendingShellRefreshes = new Map();

    function cleanupIndexUpdateLifecycle() {
        if (_indexUpdateLifecycle) {
            _indexUpdateLifecycle.stop();
            _indexUpdateLifecycle = null;
        }
        _pendingIndexRefreshes.clear();
        _pendingShellRefreshes.clear();
    }

    function clearPendingShellRefresh(categoryId) {
        const timer = _pendingShellRefreshes.get(categoryId);
        if (timer && _indexUpdateLifecycle) _indexUpdateLifecycle.clearTimeout(timer);
        _pendingShellRefreshes.delete(categoryId);
    }

    function scheduleShellRefresh(categoryId, delayMs = 1800) {
        if (!_indexUpdateLifecycle || !categoryId) return;
        clearPendingShellRefresh(categoryId);
        const timer = _indexUpdateLifecycle.timeout(() => {
            _pendingShellRefreshes.delete(categoryId);
            refreshIndexedCategorySurface(categoryId);
        }, delayMs);
        _pendingShellRefreshes.set(categoryId, timer);
    }

    async function refreshIndexedCategorySurface(categoryId) {
        if (!isActive() || !categoryId) return;
        const categories = getCategoriesData() || [];
        const category = categories.find((item) => item?.id === categoryId);
        if (!category) return;
        const activeSubfolder = (getSubfolderFilter() && getCategoryIdFilter() === categoryId)
            ? getSubfolderFilter() : null;
        const isSingleCategoryView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;
        const mediaFilter = streamingState.state.mediaFilter;
        const fetchOptions = {
            ...((isSingleCategoryView && categories.length === 1) ? { includeTotal: true, limit: 30 } : {}),
            bypassClientCache: true
        };

        try {
            const result = await fetchCategoryMedia(categoryId, 1, false, activeSubfolder, fetchOptions);
            if (!isActive()) return;
            if (isSingleCategoryView && result.total !== null && result.total !== undefined) {
                setGridTotalItems(result.total);
            }
            setCategoryView(categoryId, {
                viewKey: result.viewKey || null,
                page: 1,
                hasMore: result.hasMore || false,
                status: 'ready',
                subfolders: result.subfolders || [],
                asyncIndexing: result.asyncIndexing === true,
                indexingProgress: result.indexingProgress || 0
            }, activeSubfolder, mediaFilter);

            const nextCount = viewItemCount({ orderedIds: result.orderedIds }) + (result.subfolders?.length || 0);
            const stillShell = nextCount === 0 && result.asyncIndexing === true;
            if (stillShell) scheduleShellRefresh(categoryId);
            else clearPendingShellRefresh(categoryId);

            const mod = getModule();
            if (mod.isGridMounted() && categories.length === 1) {
                const cache = getCategoryView(categoryId, activeSubfolder, mediaFilter);
                if (cache) mod.mountGrid(category, cache);
                requestAnimationFrame(() => refreshLazyLoader());
            }
        } catch (error) {
            console.error('[StreamingLayout] Error refreshing indexed category row:', error);
        }
    }

    function registerIndexUpdateSocketHandler(socket) {
        cleanupIndexUpdateLifecycle();
        if (!socket) return;
        _indexUpdateLifecycle = new Module();
        _indexUpdateLifecycle.start();

        _indexUpdateLifecycle.onSocket(socket, SOCKET_EVENTS.CATEGORY_UPDATED, (data) => {
            if (!isActive() || data?.reason !== 'index_updated') return;
            const mediaViewerEl = $('#media-viewer');
            if (mediaViewerEl && !mediaViewerEl.classList.contains('hidden')) return;
            const categoryId = data?.category_id || data?.categoryId;
            if (!categoryId) return;

            const existing = _pendingIndexRefreshes.get(categoryId);
            if (existing) _indexUpdateLifecycle.clearTimeout(existing);
            const timer = _indexUpdateLifecycle.timeout(() => {
                _pendingIndexRefreshes.delete(categoryId);
                refreshIndexedCategorySurface(categoryId);
            }, 400);
            _pendingIndexRefreshes.set(categoryId, timer);
        });
    }

    return {
        registerIndexUpdateSocketHandler,
        cleanupIndexUpdateLifecycle,
        refreshIndexedCategorySurface,
        scheduleShellRefresh,
        clearPendingShellRefresh
    };
}
