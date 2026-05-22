/**
 * Streaming Layout - Main Entry Point
 *
 * Netflix/HBO Max style horizontal browsing interface.
 *
 * StreamingLayoutModule mounts:
 *   - StreamingContainerComponent  → #streaming-container shell
 *   - StreamingHeroComponent       → hero banner (subscribes streamingState)
 *   - StreamingFilterBarComponent  → filter pill bar (subscribes streamingState)
 *   - CategoryRowsContainer        → owns N CategoryRow Components +
 *                                     ContinueWatching/WhatsNew row Components,
 *                                     each subscribing to its own slice
 *                                     (subscribeView for row data,
 *                                     streamingState for CW/WN).
 *   - StreamingGridComponent       → single-category grid (mounted on demand)
 *
 * The coordinator never patches view-data into Components. Every Component
 * derives what it shows from streamingState + mediaOrdering + mediaManifest
 * via its own subscription path. loadAndRender is a linear
 * fetch → streamingState write sequence.
 */

import {
    isActive,
    getContainer,
    setContainer,
    setIsStreamingLayout,
    getContinueWatchingData,
    getCategoriesData,
    getCategoryView,
    setCategoriesData,
    setCategoryView,
    setCategoryIdFilter,
    getCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    setMediaFilter,
    setActivePage,
    getSubfolderFilter,
    streamingState
} from './state.js';

import { resolveCategoryName, updateCategoryFilterPill, flushFilterBarScroll } from '../../ui/categoryFilterPill.js';
import { initLazyLoading, cleanupLazyLoading, refreshLazyLoader } from './lazyLoad.js';
import { StreamingContainerComponent } from './renderer.js';
import { CategoryRowsContainerComponent } from './CategoryRowsContainer.js';
import { StreamingGridComponent } from './grid.js';
import { updateMediaCardProgressBars, cancelMediaCardProgressBars } from './progressBars.js';
import { openViewerByUrl, openViewer } from './navigation.js';
import {
    fetchCategories,
    fetchAllCategoryMedia,
    buildContinueWatchingData,
    fetchNewestMedia
} from './mediaDataSource.js';
import { registerLayoutHandler } from '../../../utils/layoutUtils.js';
import { initProgressSync } from '../../media/progressSync.js';
import { syncShowHiddenFromEvent } from '../../../utils/showHiddenManager.js';
import { createLayoutChangeLifecycle } from '../shared/layoutLifecycle.js';
import { createLayoutSocketHandlerManager } from '../shared/socketHandlers.js';
import { createThumbnailProgressTracker } from '../shared/thumbnailProgressLifecycle.js';
import { withOptionalViewTransition } from '../../../utils/viewTransitions.js';
import { Module, createElement, append, clear, $, $$ } from '../../../libs/ragot.esm.min.js';
import { handleProgressUpdate as _handleProgressUpdate } from './progressUpdates.js';
import { createPaginationHandlers } from './pagination.js';
import { createIndexUpdateHandlers } from './indexUpdates.js';
import { createSubfolderNavigation, formatSubfolderPillName } from './subfolderInstantNavigation.js';
import { setupHeroComponent, setupFilterBarComponent, setupEventListeners, createFilterActions, renderLayoutError } from './componentWiring.js';

function viewItemCount(cache) {
    return Array.isArray(cache?.orderedIds) ? cache.orderedIds.length : 0;
}

export function transitionToSingleCategoryGrid({ category, cache, mountGrid, unmountRows }) {
    if (!category || !cache) return;
    withOptionalViewTransition(() => {
        unmountRows();
        mountGrid(category, cache);
    }, { fallbackClass: 'gh-transition-surface' });
}

// ── StreamingLayoutModule ────────────────────────────────────────────────────

class StreamingLayoutModule extends Module {
    constructor() {
        super({ isInitialized: false });
        this._containerComp = null;
        this._heroComp = null;
        this._filterBarComp = null;
        this._rowsComp = null;
        this._gridComp = null;
    }

    onStart() {
        this.adopt(streamingState);
    }

    async mountRoot(target) {
        if (this._containerComp) return this._containerComp.element;
        this._containerComp = new StreamingContainerComponent();
        this.adoptComponent(this._containerComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [target]
        });
        setContainer(this._containerComp.element);
        return this._containerComp.element;
    }

    mountComponents() {
        if (!this._containerComp || !this._containerComp.element) return;
        const heroSlot = document.getElementById('streaming-hero-slot');
        const filterSlot = document.getElementById('streaming-filter-bar-slot');

        if (!this._heroComp) {
            setupHeroComponent(this, heroSlot);
        }

        if (!this._filterBarComp) {
            setupFilterBarComponent(this, filterSlot, loadAndRender);
        }
    }

    mountGrid(category, cache) {
        const scrollRoot = this._containerComp?.element || document.getElementById('streaming-container');
        const gridSlot = document.getElementById('streaming-content-container');
        if (!gridSlot) return;
        if (this._gridComp && this._gridComp.element) {
            this._gridComp.rebind(category, cache);
            return;
        }
        this.unmountGrid();
        this._gridComp = new StreamingGridComponent(category, cache, scrollRoot);
        this.adoptComponent(this._gridComp, {
            startMethod: 'mount', stopMethod: 'unmount', startArgs: [gridSlot]
        });
    }

    unmountGrid() {
        const hadMountedGrid = !!(this._gridComp && this._gridComp.element);
        if (this._gridComp) { this._gridComp.unmount(); this._gridComp = null; }
        if (hadMountedGrid) {
            const slot = document.getElementById('streaming-content-container');
            if (slot) clear(slot);
        }
        return hadMountedGrid;
    }

    isGridMounted() { return !!(this._gridComp && this._gridComp.element); }

    mountRows() {
        const rowsSlot = document.getElementById('streaming-content-container');
        if (!rowsSlot) return false;
        if (this._rowsComp) {
            const rowsMounted = !!(
                this._rowsComp.element &&
                rowsSlot.contains(this._rowsComp.element) &&
                this._rowsComp._isMounted === true
            );
            if (rowsMounted) return false;
            this._rowsComp.unmount();
            this._rowsComp = null;
        }
        this._rowsComp = new CategoryRowsContainerComponent();
        this.adoptComponent(this._rowsComp, {
            startMethod: 'mount', stopMethod: 'unmount', startArgs: [rowsSlot]
        });
        return true;
    }

    unmountRows() {
        if (this._rowsComp) { this._rowsComp.unmount(); this._rowsComp = null; }
    }

    wireEvents() {
        setupEventListeners(this, {
            loadAndRender,
            _handleProgressUpdate,
            _handlePaginationClick
        });
    }

    unmountComponents() {
        this.unmountGrid();
        this.unmountRows();
        if (this._filterBarComp) { this._filterBarComp.unmount(); this._filterBarComp = null; }
        if (this._heroComp) { this._heroComp.unmount(); this._heroComp = null; }
        if (this._containerComp) { this._containerComp.unmount(); this._containerComp = null; }
    }

    onStop() { this.unmountComponents(); }

    _getVideoProgressMap() { return streamingState.state.videoProgressMap; }
}

// ── Module singleton ─────────────────────────────────────────────────────────

const _module = new StreamingLayoutModule();

let _loadAbortController = null;

const indexUpdateHandlers = createIndexUpdateHandlers({ getModule: () => _module });
const { registerIndexUpdateSocketHandler, cleanupIndexUpdateLifecycle } = indexUpdateHandlers;

const thumbnailProgressTracker = createThumbnailProgressTracker({
    label: 'StreamingLayout',
    getProcessingCategories: () =>
        (getCategoriesData() || []).filter((c) => c && c.processingStatus === 'generating')
});

// ── loadAndRender ────────────────────────────────────────────────────────────

export async function loadAndRender(forceRefresh = false, options = {}) {
    if (!isActive()) return;

    if (options._fromSocketRefresh !== true) socketHandlerManager.cancelPendingRefresh();
    if (_loadAbortController) _loadAbortController.abort();
    _loadAbortController = new AbortController();
    const { signal } = _loadAbortController;

    const refreshContinueWatching = options.refreshContinueWatching !== false;
    const refreshWhatsNew = options.refreshWhatsNew !== false;
    const refreshCategoryList = options.refreshCategoryList === true;
    const isNavigatingToSingleView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;

    streamingState.setState({ isLoading: true });

    try {
        await fetchCategories(forceRefresh, {
            bypassClientCache: refreshCategoryList || forceRefresh,
            pruneMissingCategories: refreshCategoryList || forceRefresh,
            signal
        });
        if (signal.aborted) return;

        if (!isNavigatingToSingleView) {
            _module.unmountGrid();
            _module.mountRows();
        }

        const secondaryTasks = [];
        if (refreshContinueWatching) secondaryTasks.push(buildContinueWatchingData());
        if (refreshWhatsNew) secondaryTasks.push(fetchNewestMedia(10));
        if (secondaryTasks.length > 0) await Promise.all(secondaryTasks);
        if (signal.aborted) return;

        await fetchAllCategoryMedia(forceRefresh, null, {
            signal,
            bypassClientCache: options.bypassMediaClientCache === true
        });
        if (signal.aborted) return;

        const categoriesData = getCategoriesData();
        const isSingleCategoryView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;

        if (isSingleCategoryView && categoriesData.length === 1) {
            const category = categoriesData[0];
            const subfolder = getSubfolderFilter();
            const mediaFilter = streamingState.state.mediaFilter;
            const cache = getCategoryView(category?.id, subfolder, mediaFilter);
            if (category && cache && (viewItemCount(cache) > 0 || cache.subfolders?.length > 0)) {
                const existingPagination = document.querySelector('#streaming-container .pagination-container');
                if (existingPagination) existingPagination.remove();
                transitionToSingleCategoryGrid({
                    category, cache,
                    mountGrid: (next, nextCache) => _module.mountGrid(next, nextCache),
                    unmountRows: () => _module.unmountRows()
                });
                cleanupLazyLoading();
                initLazyLoading(document.getElementById('streaming-container') || null);
                requestAnimationFrame(() => refreshLazyLoader());
                return;
            }
        }

        // Row mode — ensure rows container is mounted; the container itself diffs
        // its children when streamingState.categoriesData changes.
        const hadGridMounted = _module.unmountGrid();
        const rowsMountedOrRecovered = _module.mountRows();
        if (hadGridMounted || rowsMountedOrRecovered || refreshCategoryList) {
            cleanupLazyLoading();
            initLazyLoading(document.getElementById('streaming-container') || null);
        }

        requestAnimationFrame(() => refreshLazyLoader());
        _renderPaginationControls();
        _flushFilterBarScroll();

    } catch (error) {
        if (signal.aborted) return;
        console.error('[StreamingLayout] loadAndRender error:', error);
        renderLayoutError(loadAndRender);
    } finally {
        if (!signal.aborted) streamingState.setState({ isLoading: false });
    }
}

// ── Pagination & Subfolder Navigation ────────────────────────────────────────

let _renderPaginationControls = null;
let _handlePaginationClick = null;
let navigateToSubfolderInstant = null;

const paginationHandlers = createPaginationHandlers({
    loadAndRender,
    getModule: () => _module
});
_renderPaginationControls = paginationHandlers.renderPaginationControls;
_handlePaginationClick = paginationHandlers.handlePaginationClick;

function _flushFilterBarScroll() {
    if (typeof flushFilterBarScroll === 'function') flushFilterBarScroll();
}// ── init / cleanup / refresh ─────────────────────────────────────────────────

let _isInitializing = false;

function getLayoutMountTarget() {
    return document.querySelector('#app-shell > main') || document.getElementById('app-shell') || document.body;
}

async function init() {
    if (_isInitializing) return;
    if (!isActive()) return;
    _isInitializing = true;
    setIsStreamingLayout(true);
    try {
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
        if (socket) initProgressSync(socket);
        registerLayoutHandler('streaming', {
            viewMedia: async (categoryId, mediaUrl, index) => {
                if (mediaUrl) await openViewerByUrl(categoryId, mediaUrl);
                else await openViewer(categoryId, index);
            },
            getCurrentState: () => null,
            setupNavigation: () => { },
            onMediaRendered: () => { },
            onViewerClosed: () => { handleViewerClosed(); }
        });

        setActivePage(1);
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        setMediaFilter('all');

        const _initSpinner = createElement('div', { className: 'layout-init-spinner' },
            createElement('div', { className: 'layout-init-spinner__wheel' }),
            createElement('p', { className: 'layout-init-spinner__label', textContent: 'Loading content...' })
        );
        append(document.body, _initSpinner);

        _module.start();
        await _module.mountRoot(getLayoutMountTarget());
        _initSpinner.remove();
        _module.mountComponents();
        _module.wireEvents();

        initLazyLoading(document.getElementById('streaming-container') || null);
        thumbnailProgressTracker.init();
        await loadAndRender(false, { refreshCategoryList: true, bypassMediaClientCache: true });
    } finally {
        _isInitializing = false;
    }
}

function cleanup() {
    setIsStreamingLayout(false);
    thumbnailProgressTracker.cleanup();
    cancelMediaCardProgressBars();
    cleanupIndexUpdateLifecycle();
    cleanupLazyLoading();
    if (_loadAbortController) { _loadAbortController.abort(); _loadAbortController = null; }
    _module.stop();
    setContainer(null);
}

async function refresh(forceRefresh = false, secondaryOnly = false, refreshCategoryList = false) {
    if (!isActive()) return;
    if (secondaryOnly) {
        const tasks = [
            buildContinueWatchingData(true),
            fetchNewestMedia(10, true)
        ];
        try { await Promise.all(tasks); } catch (e) {
            console.error('[StreamingLayout] secondary refresh error:', e);
        }
        return;
    }

    setActivePage(1);
    if (refreshCategoryList) {
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setSubfolderFilter(null);
        setParentNameFilter(null);
        setCategoryIdsFilter(null);
        updateCategoryFilterPill(null);
        _module.unmountRows();
    }
    _module.unmountGrid();
    await loadAndRender(forceRefresh, {
        refreshCategoryList,
        bypassMediaClientCache: refreshCategoryList === true,
        _fromSocketRefresh: true
    });
    if (forceRefresh) {
        thumbnailProgressTracker.cleanup();
        thumbnailProgressTracker.init();
    }
}

// ── Layout lifecycle wiring ──────────────────────────────────────────────────

const ensureLayoutLifecycle = createLayoutChangeLifecycle({
    layoutName: 'streaming',
    initLayout: init,
    cleanupLayout: cleanup
});

const socketHandlerManager = createLayoutSocketHandlerManager({
    isActive,
    refresh,
    handleProgressUpdate: _handleProgressUpdate,
    syncShowHiddenFromEvent,
    forceRefreshOnShowHiddenToggle: false,
    shouldScheduleCategoryRefresh: (data) => data?.reason !== 'index_updated'
});

const filterActions = createFilterActions(_module, { loadAndRender });

const subfolderNavigation = createSubfolderNavigation({
    getModule: () => _module,
    getAbortController: () => _loadAbortController,
    setAbortController: (ctrl) => { _loadAbortController = ctrl; },
    cancelPendingRefresh: () => socketHandlerManager.cancelPendingRefresh(),
    transitionToSingleCategoryGrid
});
navigateToSubfolderInstant = subfolderNavigation.navigateToSubfolderInstant;

ensureLayoutLifecycle();

// ── Viewer closed handler ────────────────────────────────────────────────────

export async function handleViewerClosed() {
    if (!isActive()) return;
    try {
        await buildContinueWatchingData(true);
        updateMediaCardProgressBars();
    } catch (e) {
        console.error('[StreamingLayout] Error refreshing after viewer closed:', e);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function registerSocketHandlers(socket) {
    initProgressSync(socket);
    socketHandlerManager.register(socket);
    registerIndexUpdateSocketHandler(socket);
}

export function cleanupSocketHandlers() {
    socketHandlerManager.cleanup();
    cleanupIndexUpdateLifecycle();
}

export function setCategoryFilter(categoryId, categoryName = null) {
    filterActions.setCategoryFilter(categoryId, categoryName);
}

export function setParentFilter(parentName, categoryIds = null) {
    filterActions.setParentFilter(parentName, categoryIds);
}

export function setSubfolderFilterAction(categoryId, subfolder, categoryName = null) {
    navigateToSubfolderInstant(categoryId, subfolder, categoryName);
}

export {
    init,
    cleanup,
    refresh,
    isActive,
    getContinueWatchingData,
    getCategoryIdFilter,
    getSubfolderFilter,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    getCategoriesData
};

export { getGridMode } from './state.js';
