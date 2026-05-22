/**
 * Gallery Layout - Main Entry Point
 * Google Photos / Immich style timeline interface
 *
 * Module Structure:
 * - state.js      - Centralized state management (GalleryStateModule extends Module)
 * - mediaDataSource.js - Manifest-backed API calls and data fetching
 * - lazyLoad.js   - IntersectionObserver image loading
 * - navigation.js - Media viewer navigation
 * - renderer.js   - Main render logic (GallerySidebarComponent, GalleryMobileTimelineComponent,
 *                   GallerySelectionToolbarComponent, GalleryTimelineComponent, DateGroupComponent)
 *
 * RAGOT Architecture:
 * GalleryLayoutModule (Module)
 *   └─ adopts galleryState (GalleryStateModule)
 *   └─ adopts GallerySidebarComponent           → syncs on allYearsData/dateKeys
 *   └─ adopts GalleryMobileTimelineComponent    → syncs on allYearsData/dateKeys/selectedMobileYear
 *   └─ adopts GallerySelectionToolbarComponent  → syncs on selectedVersion (selectedCount)
 */

import {
    isActive,
    getContainer,
    setContainer,
    setIsGalleryLayout,
    clearAllMedia,
    getCategoriesData,
    getCategoryIdFilter,
    getCategoryIdsFilter,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    setMediaFilter,
    setDatesPage,
    getSortedDateKeys,
    getMediaByDate,
    getHasMoreDates,
    galleryState
} from './state.js';

import { resolveCategoryName } from '../../ui/categoryFilterPill.js';

import { initLazyLoading, cleanupLazyLoading, observeLazyImage, resetLazyImage } from './lazyLoad.js';
import {
    loadAndRender,
    render,
    mountTimeline,
    unmountTimeline,
    getTimelineComponent,
    setToolbarComponent,
    setDateHeaderClickHandler,
    clearDateGroupState,
    handleDownloadSelected,
    GallerySidebarComponent,
    GalleryMobileTimelineComponent,
    GallerySelectionToolbarComponent,
    GalleryToolbarComponent,
    GalleryContainerComponent,
    GalleryMonthOverlayComponent
} from './renderer.js';
import { jumpToYear, jumpToDate, fetchMonthMedia } from './mediaDataSource.js';
import { openViewer } from './navigation.js';
import { registerLayoutHandler, urlsMatch } from '../../../utils/layoutUtils.js';
import { buildThumbnailImageAttrs, setThumbnailImageState } from '../../../utils/mediaUtils.js';
import { appendShowHiddenParam, syncShowHiddenFromEvent } from '../../../utils/showHiddenManager.js';
import { Module, createElement, append, $, $$, attr } from '../../../libs/ragot.esm.min.js';
import { createLayoutChangeLifecycle } from '../shared/layoutLifecycle.js';
import { createThumbnailProgressTracker } from '../shared/thumbnailProgressLifecycle.js';
import { createLayoutSocketHandlerManager } from '../shared/socketHandlers.js';
import { createLayoutFilterActions } from '../shared/filterActions.js';

// ── Month list helper ──────────────────────────────────────────────────────

/**
 * Build a flat ordered list of {year, month, dateKey} from allYearsData.
 * Ordered newest-first to match the server's descending timeline order.
 */
function buildFlatMonthList(allYearsData) {
    const result = [];
    for (const yearObj of allYearsData) {
        for (const monthObj of (yearObj.months || [])) {
            result.push({ year: yearObj.year, month: monthObj.month, dateKey: monthObj.dateKey });
        }
    }
    return result;
}

// ── GalleryLayoutModule ────────────────────────────────────────────────────
/**
 * RAGOT Module that owns the gallery layout's full lifecycle.
 */
export class GalleryLayoutModule extends Module {
    constructor() {
        super({ isInitialized: false });
        this._containerComp = null;
        this._sidebarComp = null;
        this._mobileTimelineComp = null;
        this._selectionToolbarComp = null;
        this._toolbarComp = null;
        this._overlayComp = null;
        this._overlayRequestId = 0;
        this._overlayAbortController = null;
        this._timelineCleanupRegistered = false;
    }

    onStart() {
        this.adopt(galleryState);
    }

    /**
     * Mount the main layout container component.
     */
    async mountRoot(target) {
        if (!this._containerComp) {
            this._containerComp = new GalleryContainerComponent();
            this.adoptComponent(this._containerComp, {
                startMethod: 'mount',
                stopMethod: 'unmount',
                startArgs: [target]
            });
            setContainer(this._containerComp.element);
        }
        return this._containerComp.element;
    }

    /**
     * Mount the timeline component into its slot.
     * renderer.js owns the instance; module registers cleanup once.
     */
    mountTimelineSlot() {
        const slot = $('#gallery-timeline-slot');
        if (!slot) return;
        mountTimeline(slot);
        if (!this._timelineCleanupRegistered) {
            this._timelineCleanupRegistered = true;
            this.addCleanup(() => unmountTimeline());
        }
    }

    /**
     * Mount Component children into their designated slots.
     */
    mountComponents() {
        if (this._sidebarComp) return;

        this._sidebarComp = new GallerySidebarComponent({
            allYearsData: galleryState.state.allYearsData,
            mediaByDate: getMediaByDate(),
            dateKeys: getSortedDateKeys(),
            hasMoreDates: galleryState.state.hasMoreDates,
        });

        this._sidebarComp.setYearClickHandler(async (year, btn) => {
            const yearPrefix = year + '-';
            const cont = getContainer();
            const dateGroup = cont ? $(`.gallery-date-group[data-date^="${yearPrefix}"]`, cont) : null;
            if (dateGroup) {
                dateGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                btn.classList.add('loading');
                btn.textContent = `${year}...`;
                const foundDate = await jumpToYear(year);
                btn.classList.remove('loading');
                btn.textContent = year;
                render();
                if (foundDate) {
                    requestAnimationFrame(() => getTimelineComponent()?.scrollToDate(foundDate));
                }
            }
        });

        this._sidebarComp.setMonthClickHandler(async (dateKey, btn) => {
            const cont = getContainer();
            const dateGroup = cont ? $(`.gallery-date-group[data-date="${dateKey}"]`, cont) : null;
            if (dateGroup) {
                dateGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = '...';
            try {
                const success = await jumpToDate(dateKey);
                if (success) {
                    render();
                    requestAnimationFrame(() => getTimelineComponent()?.scrollToDate(dateKey));
                }
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });

        this.adoptComponent(this._sidebarComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [$('#gallery-sidebar-slot')]
        });

        // Sync Sidebar from galleryState with change detection
        galleryState.subscribe((_slice, state) => {
            const dateKeys = getSortedDateKeys();
            const mediaByDate = getMediaByDate();
            const { allYearsData, hasMoreDates } = state;

            if (
                this._sidebarComp.state.allYearsData !== allYearsData ||
                this._sidebarComp.state.dateKeys.join('|') !== dateKeys.join('|') ||
                this._sidebarComp.state.dateKeys.length !== dateKeys.length ||
                this._sidebarComp.state.hasMoreDates !== hasMoreDates
            ) {
                this._sidebarComp.setState({
                    allYearsData: allYearsData || [],
                    mediaByDate: mediaByDate || {},
                    dateKeys: dateKeys || [],
                    hasMoreDates: hasMoreDates ?? true,
                });
            }
        }, {
            owner: this,
            immediate: true,
            selector: (s) => `${s.allYearsData}|${s.timelineProjectionVersion}|${s.hasMoreDates}`,
        });

        this._mobileTimelineComp = new GalleryMobileTimelineComponent({
            allYearsData: galleryState.state.allYearsData,
            dateKeys: getSortedDateKeys(),
            selectedMobileYear: galleryState.state.selectedMobileYear,
        });

        this._mobileTimelineComp.setYearClickHandler(async (year, yearBtn, timelineEl) => {
            const { setSelectedMobileYear } = await import('./state.js');
            setSelectedMobileYear(year);

            $$('.gallery-mobile-year-btn', timelineEl).forEach(b => b.classList.remove('expanded'));
            $$('.gallery-mobile-year-months', timelineEl).forEach(d => d.classList.remove('expanded'));
            yearBtn.classList.add('expanded');
            const monthsDiv = $(`.gallery-mobile-year-months[data-year="${year}"]`, timelineEl);
            if (monthsDiv) monthsDiv.classList.add('expanded');

            const cont = getContainer();
            const yearPrefix = year + '-';
            const dateGroup = cont ? $(`.gallery-date-group[data-date^="${yearPrefix}"]`, cont) : null;
            if (dateGroup) {
                dateGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                yearBtn.classList.add('loading');
                yearBtn.textContent = `${year}...`;
                if (monthsDiv) monthsDiv.innerHTML = '<span class="gallery-mobile-month-placeholder">Loading...</span>';
                try {
                    const foundDate = await jumpToYear(year);
                    yearBtn.classList.remove('loading');
                    yearBtn.textContent = year;
                    render();
                    if (foundDate) {
                        requestAnimationFrame(() => getTimelineComponent()?.scrollToDate(foundDate));
                    }
                } catch (err) {
                    console.error('[GalleryLayout] Error jumping to year:', err);
                    yearBtn.classList.remove('loading');
                    yearBtn.textContent = year;
                    render();
                }
            }
        });

        this._mobileTimelineComp.setMonthClickHandler(async (dateKey, btn) => {
            const cont = getContainer();
            const dateGroup = cont ? $(`.gallery-date-group[data-date="${dateKey}"]`, cont) : null;
            if (dateGroup) {
                dateGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = '...';
            try {
                const success = await jumpToDate(dateKey);
                if (success) {
                    render();
                    requestAnimationFrame(() => getTimelineComponent()?.scrollToDate(dateKey));
                }
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });

        this.adoptComponent(this._mobileTimelineComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [$('#gallery-mobile-timeline-slot')]
        });

        // Sync Mobile Timeline from galleryState
        galleryState.subscribe((_slice, state) => {
            const dateKeys = getSortedDateKeys();
            this._mobileTimelineComp.setState({
                allYearsData: state.allYearsData || [],
                dateKeys: dateKeys || [],
                selectedMobileYear: state.selectedMobileYear,
            });
        }, {
            owner: this,
            immediate: true,
            selector: (s) => `${s.allYearsData}|${s.timelineProjectionVersion}|${s.selectedMobileYear}`,
        });

        this._selectionToolbarComp = new GallerySelectionToolbarComponent({
            selectedCount: galleryState.getSelectedCount(),
        });

        this._selectionToolbarComp.setClearHandler(() => {
            galleryState.clearSelection();
            // Remount timeline to clear selection styling on all items
            render();
        });

        this._selectionToolbarComp.setDownloadHandler(() => {
            handleDownloadSelected();
        });

        this.adoptComponent(this._selectionToolbarComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [$('#gallery-selection-toolbar-slot')]
        });

        // Sync Selection Toolbar from galleryState
        galleryState.subscribe((_slice, _state) => {
            this._selectionToolbarComp.setState({
                selectedCount: galleryState.getSelectedCount()
            });
        }, {
            owner: this,
            immediate: true,
            // selectedVersion is bumped atomically with every _selectedMedia mutation,
            // so this fires exactly once per selection change and never on unrelated updates.
            selector: (s) => s.selectedVersion,
        });

        // Toolbar — owns filter bar, zoom controls, upload button
        const categoryIdsFilter = getCategoryIdsFilter();
        const hasNavFilter = !!(getCategoryIdFilter() || (categoryIdsFilter && categoryIdsFilter.length > 0));
        this._toolbarComp = new GalleryToolbarComponent({
            currentFilter: 'all',
            hasNavFilter,
            categoryName: null,
        });

        this.adoptComponent(this._toolbarComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [$('#gallery-toolbar-slot')]
        });

        // Register toolbar with renderer so render() can call syncState()
        setToolbarComponent(this._toolbarComp);

        // Sync Toolbar from galleryState
        galleryState.subscribe(() => {
            if (this._toolbarComp) this._toolbarComp.syncState();
        }, { owner: this, immediate: true });

        // Month overlay — mounts into the dedicated slot on gallery-container
        this._overlayComp = new GalleryMonthOverlayComponent();
        this._overlayComp.setCloseHandler(() => this.closeOverlay());
        this._overlayComp.setNavigateHandler((dir) => this.navigateOverlay(dir));
        this._overlayComp.setTimelineClickHandler((y, m) => this.openMonthOverlay(y, m));
        this._overlayComp.setRetryHandler(() => {
            const { year, month } = this._overlayComp?.state || {};
            if (year && month) this.openMonthOverlay(year, month);
        });
        this.adoptComponent(this._overlayComp, {
            startMethod: 'mount',
            stopMethod: 'unmount',
            startArgs: [$('#gallery-month-overlay-slot')]
        });

        // Wire date header clicks in the timeline to open the overlay
        setDateHeaderClickHandler((year, month) => this.openMonthOverlay(year, month));
    }

    async openMonthOverlay(year, month) {
        if (!this._overlayComp) return;


        const flatMonths = buildFlatMonthList(galleryState.state.allYearsData || []);
        const idx = flatMonths.findIndex(m => m.year === year && m.month === month);
        // "prev" = older month = higher index in newest-first list
        const hasPrev = idx >= 0 && idx < flatMonths.length - 1;
        // "next" = newer month = lower index
        const hasNext = idx > 0;

        this._overlayAbortController?.abort?.();
        this._overlayAbortController = typeof AbortController === 'function'
            ? new AbortController()
            : null;
        const requestId = ++this._overlayRequestId;

        const filter = galleryState.state.mediaFilter || 'all';
        const categoryId = galleryState.state.categoryIdFilter || null;
        const categoryIdsFilter = galleryState.state.categoryIdsFilter || null;
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const viewKey = `gallery_month::${categoryId || ''}::${categoryIdsFilter?.join(',') || ''}::${filter}::${monthStr}`;

        this._overlayComp.setState({
            open: true,
            year,
            month,
            viewKey,
            mediaIds: null,
            error: null,
            hasPrev,
            hasNext,
            allMonths: flatMonths
        });

        let result;
        try {
            result = await fetchMonthMedia(year, month, {
                signal: this._overlayAbortController?.signal
            });
        } catch (err) {
            console.error(`[GalleryMonthOverlay] Unexpected fetch error for ${year}-${month} (requestId: ${requestId}):`, err);
            result = { error: String(err?.message || err) };
        }

        // Guard: user may have navigated or closed while fetching
        if (requestId !== this._overlayRequestId) {
            return;
        }
        if (!this._overlayComp?.state.open) {
            return;
        }
        if (this._overlayComp.state.year !== year || this._overlayComp.state.month !== month) {
            return;
        }

        if (result?.aborted) {
            this._overlayComp.setState({
                mediaIds: [],
                error: 'Request was cancelled. Please try again.'
            });
            return;
        }

        if (result?.error) {
            this._overlayComp.setState({
                mediaIds: [],
                error: result.error
            });
            return;
        }

        this._overlayComp.setState({
            viewKey: result?.viewKey || null,
            mediaIds: result?.orderedIds || [],
            error: null
        });
    }

    navigateOverlay(direction) {
        if (!this._overlayComp?.state.open) return;
        const { year, month } = this._overlayComp.state;
        const flatMonths = buildFlatMonthList(galleryState.state.allYearsData || []);
        const idx = flatMonths.findIndex(m => m.year === year && m.month === month);
        if (idx < 0) return;
        const targetIdx = direction === 'prev' ? idx + 1 : idx - 1;
        if (targetIdx < 0 || targetIdx >= flatMonths.length) return;
        const target = flatMonths[targetIdx];
        this.openMonthOverlay(target.year, target.month);
    }

    closeOverlay() {
        this._overlayAbortController?.abort?.();
        this._overlayAbortController = null;
        this._overlayRequestId += 1;
        if (!this._overlayComp) return;
        this._overlayComp.setState({
            open: false,
            year: null,
            month: null,
            viewKey: null,
            mediaIds: [],
            error: null,
            hasPrev: false,
            hasNext: false
        });
    }

    unmountComponents() {
        this._overlayAbortController?.abort?.();
        this._overlayAbortController = null;
        if (this._overlayComp) {
            setDateHeaderClickHandler(null);
            this._overlayComp.unmount();
            this._overlayComp = null;
        }
        if (this._sidebarComp) {
            this._sidebarComp.unmount();
            this._sidebarComp = null;
        }
        if (this._mobileTimelineComp) {
            this._mobileTimelineComp.unmount();
            this._mobileTimelineComp = null;
        }
        if (this._selectionToolbarComp) {
            this._selectionToolbarComp.unmount();
            this._selectionToolbarComp = null;
        }
        if (this._toolbarComp) {
            this._toolbarComp.unmount();
            this._toolbarComp = null;
            setToolbarComponent(null);
        }
        if (this._containerComp) {
            this._containerComp.unmount();
            this._containerComp = null;
        }
    }

    onStop() {
        this.unmountComponents();
    }
}

// Singleton instance
const _galleryLayoutModule = new GalleryLayoutModule();
// No top-level .start() here; init() handles it.

// Prevent double initialization
let isInitializing = false;

function getLayoutMountTarget() {
    return document.querySelector('#app-shell > main') || document.getElementById('app-shell') || document.body;
}

// Thumbnail progress tracker — lifecycle owned via createThumbnailProgressTracker
const thumbnailProgressTracker = createThumbnailProgressTracker({
    label: 'GalleryLayout',
    getProcessingCategories: () =>
        (getCategoriesData() || []).filter(c => c && c.processingStatus === 'generating'),
    onThumbnailReady: (statusData) => updateGalleryThumbnail(statusData),
});


function updateGalleryThumbnail(statusData) {
    const mediaUrl = statusData?.mediaUrl;
    const thumbnailUrl = statusData?.thumbnailUrl;

    if (!mediaUrl || !thumbnailUrl) return;

    const container = getContainer();
    if (!container) return;

    const items = $$('.gallery-item[data-media-url]', container);
    items.forEach(item => {
        const itemUrl = item.dataset.mediaUrl;
        if (!urlsMatch(mediaUrl, itemUrl)) return;

        const shell = $('.gallery-item-thumbnail-shell', item);
        if (!shell) return;

        let thumbnail = $('.gallery-item-thumbnail', shell);
        const finalUrl = appendShowHiddenParam(thumbnailUrl);

        const preload = new Image();
        attr(preload, {
            onLoad: () => {
                if (!thumbnail) {
                    thumbnail = createElement('img', buildThumbnailImageAttrs({
                        className: 'gh-thumbnail-image gallery-item-thumbnail gh-img-reveal',
                        finalSrc: finalUrl,
                        fetchPriority: 'low',
                        showPendingState: true
                    }));
                    append(shell, thumbnail);
                } else {
                    thumbnail.dataset.src = finalUrl;
                }

                const overlay = $('.gallery-item-thumbnail-overlay', shell);
                if (overlay) overlay.remove();

                resetLazyImage(thumbnail);
                observeLazyImage(thumbnail);
            },
            onError: () => {
                if (thumbnail) setThumbnailImageState(thumbnail, 'error');
            }
        });
        preload.src = finalUrl;
    });
}

/**
 * Initialize gallery layout
 */
async function init() {
    if (isInitializing) return;

    if (!isActive()) return;

    isInitializing = true;
    setIsGalleryLayout(true);

    try {
        // Register layout handler for sync functionality
        registerLayoutHandler('gallery', {
            viewMedia: async (categoryId, mediaUrl, index) => {
                await openViewer(categoryId, mediaUrl, { index });
            },
            getCurrentState: () => {
                // Gallery doesn't track current state like default layout
                return null;
            },
            setupNavigation: () => {
                // Gallery main view uses standard scrolling
                // If we want wheel navigation in the viewer, it's handled by mediaLoader calling setupLayoutNavigation
            },
            onMediaRendered: (index, total) => {
                // Gallery layout could add indicators
            },
            onViewerClosed: () => {
                // Gallery layout doesn't need to do anything here
            }
        });

        // Initialize lazy loading
        initLazyLoading();

        const _initSpinner = createElement('div', { className: 'layout-init-spinner' },
            createElement('div', { className: 'layout-init-spinner__wheel' }),
            createElement('p', { className: 'layout-init-spinner__label', textContent: 'Loading content...' })
        );
        append(document.body, _initSpinner);

        // Start the root module to activate RAGOT lifecycle
        _galleryLayoutModule.start();

        // Create and mount gallery container via RAGOT
        await _galleryLayoutModule.mountRoot(getLayoutMountTarget());
        _initSpinner.remove();

        // Mount RAGOT Component children into their designated slots
        _galleryLayoutModule.mountComponents();

        // Mount the persistent timeline component into its slot
        _galleryLayoutModule.mountTimelineSlot();

        // Load and render
        await loadAndRender();

        // Initialize thumbnail progress tracking
        initThumbnailProgress();
    } finally {
        isInitializing = false;
    }
}

/**
 * Cleanup gallery layout
 */
async function cleanup() {
    // Stop the module — RAGOT will automatically unmount all adopted components
    // and cleanup their slots, containers, and listeners.
    _galleryLayoutModule.stop();

    setContainer(null);
    setIsGalleryLayout(false);

    cleanupLazyLoading();
    cleanupThumbnailProgress();
}

/**
 * Refresh gallery data (full reload from server)
 * Uses force_refresh only when explicitly requested
 */
async function refresh(forceRefresh = false) {
    if (!isActive()) return;
    // Always reset to page 1 - the visible content set has changed
    setDatesPage(1);
    clearAllMedia();
    clearDateGroupState();
    await loadAndRender(forceRefresh);
    if (forceRefresh) {
        initThumbnailProgress();
    }
}

function initThumbnailProgress() { thumbnailProgressTracker.init(); }
function cleanupThumbnailProgress() { thumbnailProgressTracker.cleanup(); }

const ensureLayoutLifecycle = createLayoutChangeLifecycle({
    layoutName: 'gallery',
    initLayout: init,
    cleanupLayout: cleanup
});

const socketHandlerManager = createLayoutSocketHandlerManager({
    isActive,
    refresh,
    syncShowHiddenFromEvent,
    forceRefreshOnShowHiddenToggle: false,
    shouldScheduleCategoryRefresh: (data) => data?.reason !== 'index_updated'
});

const filterActions = createLayoutFilterActions({
    isActive,
    resolveCategoryName: (categoryId, categoryName = null) =>
        resolveCategoryName(categoryId, getCategoriesData(), categoryName),
    applyCategoryState: ({ categoryId, resolvedName }) => {
        setDatesPage(1);
        setCategoryIdFilter(categoryId);
        setCategoryNameFilter(resolvedName);
        setParentNameFilter(null);
        setMediaFilter('all');
    },
    applyParentState: ({ parentName }) => {
        setDatesPage(1);
        setCategoryIdFilter(null);
        setCategoryNameFilter(null);
        setParentNameFilter(parentName);
        setMediaFilter('all');
    },
    refreshForFilter: () => refresh()
});

ensureLayoutLifecycle();

/**
 * Register socket event handlers owned by the gallery layout.
 * Called once after socket is created in main.js Phase 3.
 * @param {Object} socket - Socket.IO client instance
 */
export function registerSocketHandlers(socket) {
    socketHandlerManager.register(socket);
}

export function cleanupSocketHandlers() {
    socketHandlerManager.cleanup();
}

// Export for external use
export {
    init,
    cleanup,
    refresh,
    isActive,
    loadAndRender,
    setCategoryFilter,
    setParentFilter,
    setSubfolderFilterAction,
    getCategoriesData,
    getCategoryIdFilter
};



/**
 * Filter by specific category ID (from search)
 * @param {string} categoryId - Category ID to filter by
 */
function setCategoryFilter(categoryId, categoryName = null) {
    filterActions.setCategoryFilter(categoryId, categoryName);
}

/**
 * Filter by parent folder name (from search)
 * Shows all categories that are children of this parent folder
 * @param {string} parentName - Parent folder name (e.g. "Movies", "TV")
 */
function setParentFilter(parentName) {
    filterActions.setParentFilter(parentName);
}

/**
 * Filter by specific subfolder (from search)
 * Gallery layout currently only supports filtering by category top-level,
 * but we provide this for interface consistency.
 */
function setSubfolderFilterAction(categoryId, subfolder, categoryName = null) {
    filterActions.setSubfolderFilterAction(categoryId, subfolder, categoryName);
}
