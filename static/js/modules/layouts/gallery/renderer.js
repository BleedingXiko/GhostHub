/**
 * Gallery Layout - Renderer
 * Google Photos / Immich style timeline interface
 */

import {
    isActive,
    getContainer,
    setContainer,
    getCategoriesData,
    getMediaFilter,
    setMediaFilter,
    getHasMoreDates,
    setIsLoading,
    getIsLoading,
    getSortedDateKeys,
    getDateTotal,
    getMonthTotal,
    isMediaSelected,
    toggleMediaSelection,
    clearSelection,
    getSelectedMediaItems,
    getAllYearsData,
    getSelectedMobileYear,
    setSelectedMobileYear,
    setCategoryIdFilter,
    getCategoryIdFilter,
    getCategoryNameFilter,
    setCategoryNameFilter,
    getParentNameFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    getCategoryIdsFilter,
    getGalleryTimelineViewKey,
    bumpTimelineProjection,
    getDateKey
} from './state.js';
import { cameraIcon, warningIcon } from '../../../utils/icons.js';
import { appendShowHiddenParam } from '../../../utils/showHiddenManager.js';
import {
    buildThumbnailImageAttrs,
    createThumbnailShell,
    setThumbnailImageState
} from '../../../utils/mediaUtils.js';
import { loadInitialMedia, loadMoreDates } from './mediaDataSource.js';
import { observeLazyImage, resetLazyImage } from './lazyLoad.js';
import { openViewer, openViewerFromGalleryCard } from './navigation.js';
import { ensureFeatureAccess } from '../../../utils/authManager.js';
import { openFileManager } from '../../admin/files.js';
import {
    setupGalleryDragDrop,
    setupAutoCollapseObserver,
    cleanupAutoCollapseObserver,
    clearDateGroupState as clearDateGroupStateInternal,
    getDateGroupState,
    setIsZooming
} from './components/index.js';
import ThumbnailProgress from '../../shared/thumbnailProgress.js';
import { updateCategoryFilterPill, handlePillClear, getLeafName } from '../../ui/categoryFilterPill.js';
import { formatDateDisplay } from '../../../utils/layoutUtils.js';
import { Module, Component, VirtualScroller, createElement, $, $$, append, prepend, insertBefore, remove, clear, attr, renderGrid } from '../../../libs/ragot.esm.min.js';
import { toast } from '../../../utils/notificationManager.js';
import { selectView, selectRecordsForView, subscribeView } from '../../media/selectors.js';

// Constants
const ITEMS_PER_DATE_GROUP = 9;
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_DEFAULT = 3;
const MONTH_OVERLAY_CHUNK_SIZE = 60;
const VIDEO_BADGE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

export function clearDateGroupState() {
    clearDateGroupStateInternal();
}

// ── GalleryContainerComponent ──────────────────────────────────────────

export class GalleryContainerComponent extends Component {
    render() {
        return createElement('div', {
            className: 'gallery-container',
            id: 'gallery-container'
        }, [
            createElement('div', { id: 'gallery-sidebar-slot' }),
            createElement('div', { className: 'gallery-main', id: 'gallery-main-slot' }, [
                createElement('div', { id: 'gallery-selection-toolbar-slot' }),
                createElement('div', { id: 'gallery-toolbar-slot' }),
                createElement('div', { id: 'gallery-mobile-timeline-slot' }),
                createElement('div', { id: 'gallery-timeline-slot' })
            ]),
            createElement('div', { id: 'gallery-month-overlay-slot' })
        ]);
    }
}

// ── GalleryMonthOverlayComponent ──────────────────────────────────────────────

export class GalleryMonthOverlayComponent extends Component {
    constructor() {
        super({
            open: false,
            year: null,
            month: null,
            viewKey: null,
            mediaIds: [],
            error: null,
            hasPrev: false,
            hasNext: false,
            allMonths: []
        });
        this._onClose = null;
        this._onNavigate = null;
        this._onMediaClick = null;
        this._onTimelineClick = null;
        this._onRetry = null;
        this._unsubscribeView = null;
        this._subscribedViewKey = null;
        this._gridComp = null;
        this._gridViewKey = null;
    }

    setCloseHandler(fn) { this._onClose = fn; }
    setNavigateHandler(fn) { this._onNavigate = fn; }
    setMediaClickHandler(fn) { this._onMediaClick = fn; }
    setTimelineClickHandler(fn) { this._onTimelineClick = fn; }
    setRetryHandler(fn) { this._onRetry = fn; }

    _buildTimeline() {
        const { allMonths, year, month } = this.state;
        if (!allMonths || allMonths.length === 0) return null;

        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        const pills = allMonths
            .filter(m => m.year === year)
            .map(m => createElement('button', {
                className: `gallery-mobile-month gallery-overlay-timeline-month${m.month === month ? ' active' : ''}`,
                dataset: { year: m.year, month: m.month },
                textContent: MONTH_NAMES[m.month - 1]
            }));

        if (pills.length === 0) return null;

        return createElement('div', { className: 'gallery-overlay-timeline' },
            createElement('div', { className: 'gallery-mobile-timeline gallery-overlay-timeline-months' }, pills)
        );
    }

    render() {
        const { open, year, month, viewKey, error, hasPrev, hasNext } = this.state;
        const view = viewKey ? (selectView(viewKey) || {}) : {};
        const liveMediaIds = view.orderedIds || [];
        const displayError = error || (view.status === 'error' ? `Couldn't load. Please try again.` : null);
        const loading = open && !displayError && (!viewKey || view.status === 'fetching');
        const hiddenClass = open ? '' : ' hidden';

        // Keep an order-only subscription so the spinner→grid transition fires
        // when the first batch arrives. The inner MonthOverlayGridComponent
        // owns its own subscription for record updates; we deliberately avoid
        // a duplicate update() here to keep this overlay's re-renders cheap.
        if (this._isMounted) {
            this._subscribeToOverlayView(viewKey);
        }

        const monthLabel = year && month
            ? new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
            : '';

        let bodyContent;
        if (loading) {
            bodyContent = createElement('div', { className: 'gallery-month-loading' },
                createElement('div', { className: 'gallery-loading-spinner' })
            );
        } else if (displayError) {
            bodyContent = createElement('div', { className: 'gallery-month-empty gallery-month-error' }, [
                createElement('p', { textContent: displayError }),
                createElement('button', {
                    className: 'gallery-month-retry-btn',
                    textContent: 'Try Again'
                })
            ]);
        } else if (liveMediaIds.length === 0) {
            bodyContent = createElement('div', { className: 'gallery-month-empty' },
                createElement('p', { textContent: 'No photos or videos for this month.' })
            );
        } else {
            bodyContent = createElement('div', { className: 'gallery-month-grid-slot' });
        }

        const timeline = this._buildTimeline();
        const contentChildren = [
            createElement('div', { className: 'modal__header' }, [
                createElement('h2', { className: 'modal__title', textContent: monthLabel }),
                createElement('button', {
                    className: 'btn btn--icon modal__close',
                    title: 'Close',
                    textContent: '\u00d7'
                })
            ])
        ];
        if (timeline) contentChildren.push(timeline);
        contentChildren.push(createElement('div', { className: 'modal__body' }, bodyContent));

        return createElement('div', { className: `modal gallery-month-modal${hiddenClass}` }, [
            createElement('button', {
                className: `gallery-month-nav-arrow prev${hasNext ? '' : ' hidden'}`,
                title: 'Newer month',
                innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>'
            }),
            createElement('div', { className: 'modal__content' }, contentChildren),
            createElement('button', {
                className: `gallery-month-nav-arrow next${hasPrev ? '' : ' hidden'}`,
                title: 'Older month',
                innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>'
            })
        ]);
    }

    onStart() {
        this.on(this.element, 'click', (e) => {
            // Close on backdrop click (the .modal element itself) or close button
            if (e.target === this.element || e.target.closest('.modal__close')) {
                this._onClose?.();
                return;
            }
            if (e.target.closest('.gallery-month-nav-arrow.prev')) {
                if (this.state.hasNext) this._onNavigate?.('next');
                return;
            }
            if (e.target.closest('.gallery-month-nav-arrow.next')) {
                if (this.state.hasPrev) this._onNavigate?.('prev');
                return;
            }
            // Timeline month click → navigate to that month
            const monthBtn = e.target.closest('.gallery-overlay-timeline-month');
            if (monthBtn) {
                const y = Number(monthBtn.dataset.year);
                const m = Number(monthBtn.dataset.month);
                this._onTimelineClick?.(y, m);
                return;
            }
            if (e.target.closest('.gallery-month-retry-btn')) {
                this._onRetry?.();
                return;
            }
            // Card click → open viewer rooted in this month's view so the
            // viewer sees the same ordering the user saw in the overlay.
            const item = e.target.closest('.gallery-item');
            if (item) openViewerFromGalleryCard(item, this.state.viewKey);
        });

        this.on(document, 'keydown', (e) => {
            if (!this.state.open) return;
            if (e.key === 'Escape') { this._onClose?.(); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); if (this.state.hasNext) this._onNavigate?.('next'); return; }
            if (e.key === 'ArrowRight') { e.preventDefault(); if (this.state.hasPrev) this._onNavigate?.('prev'); }
        });

        let _tx = 0;
        let _ty = 0;
        let _swipeOnTimeline = false;
        this.on(this.element, 'touchstart', (e) => {
            _tx = e.touches[0].clientX;
            _ty = e.touches[0].clientY;
            _swipeOnTimeline = !!e.target.closest('.gallery-overlay-timeline');
        }, { passive: true });
        this.on(this.element, 'touchend', (e) => {
            if (!this.state.open || _swipeOnTimeline) return;
            const dx = e.changedTouches[0].clientX - _tx;
            const dy = e.changedTouches[0].clientY - _ty;
            if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
            // Swipe left → older month (prev), swipe right → newer month (next)
            // so the active pill tracks with the swipe direction
            if (dx < 0 && this.state.hasPrev) this._onNavigate?.('prev');
            else if (dx > 0 && this.state.hasNext) this._onNavigate?.('next');
        }, { passive: true });

        this._subscribeToOverlayView(this.state.viewKey);
        this._syncGridComponent();

        // Auto-scroll timeline strips to center the active items
        requestAnimationFrame(() => this._scrollTimelineToActive());
    }

    onStop() {
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        this._subscribedViewKey = null;
        this._unmountGridComponent();
    }

    /**
     * Subscribe to a view key for status/order transitions only.
     * The inner MonthOverlayGridComponent owns its own subscription for
     * record updates; the outer modal only needs to know when the view
     * flips loading → ready (or vice versa) and when the id list changes.
     * Re-rendering on every record bump caused a full modal rebuild on
     * each batched hydration.
     */
    _subscribeToOverlayView(viewKey) {
        if (this._subscribedViewKey === viewKey && this._unsubscribeView) return;
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        this._subscribedViewKey = viewKey || null;
        this._lastOverlayStatus = null;
        this._lastOverlayIdsRef = null;
        if (!viewKey) return;
        const refreshIfShapeChanged = () => {
            if (!this._isMounted) return;
            const next = selectView(viewKey) || {};
            const nextStatus = next.status || 'idle';
            const nextIds = next.orderedIds || [];
            const statusChanged = nextStatus !== this._lastOverlayStatus;
            const idsChanged = nextIds !== this._lastOverlayIdsRef;
            this._lastOverlayStatus = nextStatus;
            this._lastOverlayIdsRef = nextIds;
            if (!statusChanged && !idsChanged) return;
            this.update();
        };
        this._unsubscribeView = subscribeView(viewKey, refreshIfShapeChanged, { owner: this });
        // Seed the snapshot so the first real change is detected correctly.
        const initial = selectView(viewKey) || {};
        this._lastOverlayStatus = initial.status || 'idle';
        this._lastOverlayIdsRef = initial.orderedIds || [];
    }

    update() {
        if (typeof super.update === 'function') {
            super.update();
        } else {
            this._performUpdate?.();
        }
        // Auto-scroll timeline strips to center the active pill after re-render
        requestAnimationFrame(() => this._scrollTimelineToActive());
        this._syncGridComponent();
    }

    setState(newState) {
        super.setState(newState);
        requestAnimationFrame(() => {
            if (!this._isMounted) return;
            this._subscribeToOverlayView(this.state.viewKey);
            this._scrollTimelineToActive();
            this._syncGridComponent();
        });
    }

    setStateSync(newState) {
        super.setStateSync(newState);
        if (!this._isMounted) return;
        this._subscribeToOverlayView(this.state.viewKey);
        requestAnimationFrame(() => this._scrollTimelineToActive());
        this._syncGridComponent();
    }

    _syncGridComponent() {
        const { open, viewKey, error } = this.state;
        const slot = this.element?.querySelector('.gallery-month-grid-slot');
        if (!open || error || !viewKey || !slot) {
            this._unmountGridComponent();
            return;
        }
        if (this._gridComp && this._gridViewKey === viewKey) return;
        this._unmountGridComponent();
        clear(slot);
        this._gridViewKey = viewKey;
        this._gridComp = new MonthOverlayGridComponent(viewKey);
        this._gridComp.mount(slot);
    }

    _unmountGridComponent() {
        if (this._gridComp) {
            this._gridComp.unmount();
        }
        this._gridComp = null;
        this._gridViewKey = null;
    }

    _scrollTimelineToActive() {
        const monthsStrip = this.element?.querySelector('.gallery-overlay-timeline-months');
        if (monthsStrip) {
            const activeMonth = monthsStrip.querySelector('.active');
            if (activeMonth) activeMonth.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
        }
    }
}

class MonthOverlayGridComponent extends Component {
    constructor(viewKey) {
        super({});
        this._viewKey = viewKey;
        this._unsubscribeView = null;
        this._vs = null;
        this._lastSignature = null;
    }

    render() {
        return createElement('div', {
            className: 'gallery-grid zoom-3',
            style: { position: 'relative' }
        });
    }

    onStart() {
        this._mountVirtualScroller({ force: true });
        this._unsubscribeView = subscribeView(this._viewKey, () => {
            this._mountVirtualScroller();
        }, { owner: this });
    }

    onStop() {
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        if (this._vs) {
            this._vs.unmount();
            this._vs = null;
        }
        this._lastSignature = null;
    }

    _signatureFor(records) {
        return (records || []).map((record) => record?.id || record?.url || '').join('|');
    }

    _mountVirtualScroller({ force = false } = {}) {
        if (!this.element) return;
        const records = selectRecordsForView(this._viewKey);
        const signature = this._signatureFor(records);
        if (!force && signature === this._lastSignature) return;
        this._lastSignature = signature;

        if (this._vs) {
            this._vs.unmount();
            this._vs = null;
        }
        clear(this.element);
        this._vs = new VirtualScroller({
            root: this.element.closest('.modal__body') || this.element,
            chunkContainer: this.element,
            totalItems: () => records.length,
            chunkSize: MONTH_OVERLAY_CHUNK_SIZE,
            maxChunks: 8,
            poolSize: 0,
            renderChunk: (chunkIndex) => {
                const start = chunkIndex * MONTH_OVERLAY_CHUNK_SIZE;
                const items = records.slice(start, start + MONTH_OVERLAY_CHUNK_SIZE);
                const chunk = createElement('div', { style: { display: 'contents' } });
                items.forEach((media, index) => append(chunk, renderMediaItem(media, start + index)));
                $$('img[data-src]', chunk).forEach(img => observeLazyImage(img));
                return chunk;
            },
            measureChunk: (el) => el.offsetHeight,
            rootMargin: '900px 0px',
        });
        this._vs.mount(this.element);
    }
}

export async function createGalleryContainer() {
    const existing = $('.gallery-container');
    if (existing) {
        setContainer(existing);
        return existing;
    }
    const comp = new GalleryContainerComponent();
    const mountTarget = document.querySelector('#app-shell > main') || document.getElementById('app-shell') || document.body;
    comp.mount(mountTarget);
    setContainer(comp.element);
    return comp.element;
}

// ── GalleryToolbarComponent ────────────────────────────────────────────

export class GalleryToolbarComponent extends Component {
    constructor(initialState = {}) {
        super({ currentFilter: 'all', hasNavFilter: false, categoryName: null, zoomLevel: ZOOM_DEFAULT, ...initialState });
    }

    render() {
        const { currentFilter, hasNavFilter, categoryName, zoomLevel } = this.state;

        const createBtn = (type, label) => createElement('button', {
            className: `pill pill--filter pill--sm ${currentFilter === type && !hasNavFilter ? 'pill--active' : ''}`,
            dataset: { filter: type },
            textContent: label
        });

        return createElement('div', {
            className: 'gh-streaming__filter-bar gh-gallery__filter-bar'
        }, [
            createElement('div', { className: 'gh-streaming__filter-buttons' }, [
                createBtn('all', 'All'),
                createBtn('image', 'Photos'),
                createBtn('video', 'Videos')
            ]),
            createElement('div', {
                className: `category-active-filter ${categoryName ? '' : 'hidden'}`
            },
                createElement('span', {
                    className: `pill pill--breadcrumb pill--sm ${categoryName ? 'pill--active' : 'hidden'}`,
                    dataset: { categoryFilterPill: '' },
                    textContent: categoryName || ''
                })
            ),
            createElement('div', { className: 'gallery-toolbar-right' }, [
                createElement('button', {
                    className: 'gallery-upload-btn',
                    title: 'Upload media',
                    innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload</span>'
                }),
                createElement('div', { className: 'gallery-zoom' }, [
                    createElement('button', {
                        className: 'gallery-zoom-btn',
                        dataset: { zoom: 'out' },
                        title: 'Smaller thumbnails',
                        textContent: '−'
                    }),
                    createElement('button', {
                        className: 'gallery-zoom-btn',
                        dataset: { zoom: 'in' },
                        title: 'Larger thumbnails',
                        textContent: '+'
                    })
                ])
            ])
        ]);
    }

    onStart() {
        this.on(this.element, 'click', async (e) => {
            if (e.target.closest('[data-category-filter-pill]')) {
                handlePillClear();
                return;
            }

            const filterBtn = e.target.closest('.pill--filter[data-filter]');
            if (filterBtn) {
                e.preventDefault();
                e.stopPropagation();
                const filter = filterBtn.dataset.filter;
                setCategoryIdFilter(null);
                setCategoryNameFilter(null);
                setParentNameFilter(null);
                setCategoryIdsFilter(null);
                updateCategoryFilterPill(null);
                setMediaFilter(filter);
                clearDateGroupStateInternal();
                setIsLoading(false);
                this.syncState();
                await loadAndRender();
                return;
            }

            const zoomBtn = e.target.closest('.gallery-zoom-btn');
            if (zoomBtn) {
                const action = zoomBtn.dataset.zoom;
                const current = this.state.zoomLevel;
                const next = action === 'in' ? Math.min(current + 1, ZOOM_MAX) : Math.max(current - 1, ZOOM_MIN);
                if (next === current) return;
                this.setState({ zoomLevel: next });
                setIsZooming(true);
                const container = getContainer();
                if (container) {
                    $$('.gallery-grid', container).forEach(grid => {
                        grid.className = `gallery-grid zoom-${next}`;
                    });
                }
                this.timeout(() => setIsZooming(false), 300);
                return;
            }

            if (e.target.closest('.gallery-upload-btn')) {
                const accessGranted = await ensureFeatureAccess();
                if (accessGranted) openFileManager();
            }
        });
    }

    syncState() {
        const categoryIdsFilter = getCategoryIdsFilter();
        const hasNavFilter = !!(getCategoryIdFilter() || getParentNameFilter() || (categoryIdsFilter && categoryIdsFilter.length > 0));
        const rawName = getCategoryNameFilter() || getParentNameFilter() || null;
        this.setState({
            currentFilter: getMediaFilter(),
            hasNavFilter,
            categoryName: getLeafName(rawName),
        });
    }
}

// ── GallerySidebarComponent ───────────────────────────────────────────────────

export class GallerySidebarComponent extends Component {
    constructor(initialState) {
        super(initialState);
        this._onYearClick = null;
        this._onMonthClick = null;
    }

    setYearClickHandler(fn) { this._onYearClick = fn; }
    setMonthClickHandler(fn) { this._onMonthClick = fn; }

    render() {
        const { allYearsData, mediaByDate, dateKeys } = this.state;
        const dateKeysArr = dateKeys || [];

        let oldestLoadedYear = null;
        if (dateKeysArr.length > 0) {
            const sortedDates = [...dateKeysArr].filter(d => d !== 'Unknown').sort();
            if (sortedDates.length > 0) oldestLoadedYear = parseInt(sortedDates[0].split('-')[0]);
        }

        const loadedYearMonthsMap = new Map();
        dateKeysArr.forEach(dateKey => {
            if (dateKey === 'Unknown') return;
            const date = new Date(dateKey);
            const year = date.getFullYear();
            const monthKey = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = date.toLocaleDateString('en-US', { month: 'short' });
            if (!loadedYearMonthsMap.has(year)) loadedYearMonthsMap.set(year, new Map());
            if (!loadedYearMonthsMap.get(year).has(monthKey)) {
                loadedYearMonthsMap.get(year).set(monthKey, { label: monthLabel, dateKey });
            }
        });

        let years = [];
        if (allYearsData && allYearsData.length > 0) {
            years = allYearsData;
        } else {
            const sortedYears = Array.from(loadedYearMonthsMap.keys()).sort((a, b) => b - a);
            years = sortedYears.map(y => ({ year: y }));
        }

        const sidebarContent = [];
        years.forEach((yearObj, idx) => {
            const year = yearObj.year;
            if (!allYearsData || allYearsData.length === 0) {
                const months = loadedYearMonthsMap.get(year);
                if ((!months || months.size === 0) && oldestLoadedYear !== null && oldestLoadedYear <= year) return;
            }

            if (idx > 0) sidebarContent.push(createElement('div', { className: 'gallery-year-divider' }));
            sidebarContent.push(createElement('button', {
                className: 'gallery-year-label',
                dataset: { year, firstDate: yearObj.first_date || '' },
                textContent: year
            }));

            if (yearObj.months && yearObj.months.length > 0) {
                yearObj.months.forEach(monthObj => {
                    const parts = monthObj.dateKey.split('-');
                    const safeDate = new Date(parts[0], parts[1] - 1, parts[2]);
                    sidebarContent.push(createElement('button', {
                        className: 'gallery-month-btn',
                        dataset: { date: monthObj.dateKey },
                        textContent: safeDate.toLocaleDateString('en-US', { month: 'short' })
                    }));
                });
            } else {
                const months = loadedYearMonthsMap.get(year);
                if (months && months.size > 0) {
                    months.forEach((data) => {
                        sidebarContent.push(createElement('button', {
                            className: 'gallery-month-btn',
                            dataset: { date: data.dateKey },
                            textContent: data.label
                        }));
                    });
                } else if (yearObj.media_count) {
                    sidebarContent.push(createElement('span', {
                        className: 'gallery-month-hint',
                        textContent: `${yearObj.media_count} items`
                    }));
                }
            }
        });

        const sidebar = createElement('div', { className: 'gallery-sidebar' });
        append(sidebar, sidebarContent);
        return sidebar;
    }

    onStart() {
        this.on(this.element, 'click', (e) => {
            const yearBtn = e.target.closest('.gallery-year-label[data-year]');
            if (yearBtn && this._onYearClick) {
                this._onYearClick(parseInt(yearBtn.dataset.year), yearBtn);
                return;
            }
            const monthBtn = e.target.closest('.gallery-month-btn[data-date]');
            if (monthBtn && this._onMonthClick) {
                this._onMonthClick(monthBtn.dataset.date, monthBtn);
            }
        });
    }
}

// ── GalleryMobileTimelineComponent ────────────────────────────────────────────

export class GalleryMobileTimelineComponent extends Component {
    constructor(initialState) {
        super(initialState);
        this._onYearClick = null;
        this._onMonthClick = null;
    }

    setYearClickHandler(fn) { this._onYearClick = fn; }
    setMonthClickHandler(fn) { this._onMonthClick = fn; }

    render() {
        const { allYearsData, dateKeys, selectedMobileYear } = this.state;
        const dateKeysArr = dateKeys || [];

        let years = [];
        let loadedYearMonthsMap = new Map();
        let oldestLoadedYear = null;

        if (dateKeysArr.length > 0) {
            const sortedDates = [...dateKeysArr].filter(d => d !== 'Unknown').sort();
            if (sortedDates.length > 0) oldestLoadedYear = parseInt(sortedDates[0].split('-')[0]);
        }

        dateKeysArr.forEach(dateKey => {
            if (dateKey === 'Unknown') return;
            const date = new Date(dateKey);
            const year = date.getFullYear();
            const monthKey = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = date.toLocaleDateString('en-US', { month: 'short' });
            if (!loadedYearMonthsMap.has(year)) loadedYearMonthsMap.set(year, new Map());
            if (!loadedYearMonthsMap.get(year).has(monthKey)) {
                loadedYearMonthsMap.get(year).set(monthKey, { label: monthLabel, dateKey });
            }
        });

        if (allYearsData && allYearsData.length > 0) {
            years = allYearsData;
        } else {
            const sortedYears = Array.from(loadedYearMonthsMap.keys()).sort((a, b) => b - a);
            years = sortedYears.map(y => ({ year: y }));
        }

        if (years.length === 0) return createElement('div', { className: 'gallery-mobile-timeline-wrapper' });

        if (!allYearsData || allYearsData.length === 0) {
            years = years.filter(yearObj => {
                const year = yearObj.year;
                const months = loadedYearMonthsMap.get(year);
                if (months && months.size > 0) return true;
                if (oldestLoadedYear !== null && oldestLoadedYear <= year) return false;
                return true;
            });
        }

        const hasMultipleYears = years.length > 1;
        const expandedYear = (selectedMobileYear !== null && years.some(y => y.year === selectedMobileYear))
            ? selectedMobileYear
            : (years.length > 0 ? years[0].year : null);

        const timelineContent = [];
        years.forEach((yearObj) => {
            const year = yearObj.year;
            const isExpanded = year === expandedYear;

            if (hasMultipleYears) {
                timelineContent.push(createElement('button', {
                    className: `gallery-mobile-year-btn ${isExpanded ? 'expanded' : ''}`,
                    dataset: { year, firstDate: yearObj.first_date || '' },
                    textContent: year
                }));
            }

            const monthsContent = [];
            if (yearObj.months && yearObj.months.length > 0) {
                yearObj.months.forEach(monthObj => {
                    const parts = monthObj.dateKey.split('-');
                    const safeDate = new Date(parts[0], parts[1] - 1, parts[2]);
                    monthsContent.push(createElement('button', {
                        className: 'gallery-mobile-month',
                        dataset: { date: monthObj.dateKey },
                        textContent: safeDate.toLocaleDateString('en-US', { month: 'short' })
                    }));
                });
            } else {
                const months = loadedYearMonthsMap.get(year);
                if (months && months.size > 0) {
                    months.forEach((data) => {
                        monthsContent.push(createElement('button', {
                            className: 'gallery-mobile-month',
                            dataset: { date: data.dateKey },
                            textContent: data.label
                        }));
                    });
                } else if (yearObj.media_count) {
                    monthsContent.push(createElement('span', {
                        className: 'gallery-mobile-month-placeholder',
                        textContent: 'Loading...'
                    }));
                }
            }

            if (hasMultipleYears) {
                const monthsDiv = createElement('div', {
                    className: `gallery-mobile-year-months ${isExpanded ? 'expanded' : ''}`,
                    dataset: { year }
                });
                append(monthsDiv, monthsContent);
                timelineContent.push(monthsDiv);
            } else {
                timelineContent.push(...monthsContent);
            }
        });

        const timelineContainerChildren = [];
        if (!hasMultipleYears && years.length === 1) {
            timelineContainerChildren.push(createElement('span', { className: 'gallery-mobile-year', textContent: years[0].year }));
        }
        const timelineContainer = createElement('div', { className: 'gallery-mobile-timeline' });
        append(timelineContainer, [...timelineContainerChildren, ...timelineContent]);
        return createElement('div', { className: 'gallery-mobile-timeline-wrapper' }, timelineContainer);
    }

    onStart() {
        this.on(this.element, 'click', (e) => {
            const yearBtn = e.target.closest('.gallery-mobile-year-btn[data-year]');
            if (yearBtn && this._onYearClick) {
                e.preventDefault();
                e.stopPropagation();
                this._onYearClick(parseInt(yearBtn.dataset.year), yearBtn, this.element);
                return;
            }
            const monthBtn = e.target.closest('.gallery-mobile-month[data-date]');
            if (monthBtn && this._onMonthClick) {
                e.preventDefault();
                e.stopPropagation();
                this._onMonthClick(monthBtn.dataset.date, monthBtn);
            }
        });
    }
}

// ── GallerySelectionToolbarComponent ─────────────────────────────────────────

export class GallerySelectionToolbarComponent extends Component {
    constructor(initialState) {
        super(initialState);
        this._onClearSelection = null;
        this._onDownload = null;
    }

    setClearHandler(fn) { this._onClearSelection = fn; }
    setDownloadHandler(fn) { this._onDownload = fn; }

    render() {
        const { selectedCount } = this.state;
        if (!selectedCount || selectedCount === 0) {
            return createElement('div', { className: 'gallery-selection-toolbar-empty', style: 'display:none' });
        }
        return createElement('div', { className: 'gallery-selection-toolbar' },
            createElement('div', { className: 'gallery-selection-info' },
                createElement('button', {
                    className: 'gallery-selection-close',
                    title: 'Clear selection',
                    innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                }),
                createElement('span', {
                    className: 'gallery-selection-count',
                    textContent: `${selectedCount} selected`
                })
            ),
            createElement('div', { className: 'gallery-selection-actions' },
                createElement('button', {
                    className: 'gallery-action-btn',
                    dataset: { action: 'download' },
                    title: 'Download selected',
                    innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download'
                })
            )
        );
    }

    onStart() {
        this.on(this.element, 'click', (e) => {
            if (e.target.closest('.gallery-selection-close') && this._onClearSelection) {
                e.preventDefault();
                e.stopPropagation();
                this._onClearSelection();
                return;
            }
            if (e.target.closest('.gallery-action-btn[data-action="download"]') && this._onDownload) {
                this._onDownload();
            }
        });
    }
}

// ── DateGroupComponent ────────────────────────────────────────────────────────

class DateGroupComponent extends Component {
    constructor(dateKey, viewKey) {
        super({});
        this._dateKey = dateKey;
        this._viewKey = viewKey;
        this._vs = null;
        this._unsubscribeView = null;
    }

    render() {
        const dateKey = this._dateKey;
        const displayDate = formatDateDisplay(dateKey);
        const serverTotal = getDateTotal(dateKey);
        const monthTotal = getMonthTotal(dateKey);
        const media = this._getVisibleMedia();
        const loadedCount = media.length;

        // Show max 9 items per date group in timeline view - full month in overlay on header click

        const currentZoom = _toolbarComponent?.state?.zoomLevel ?? ZOOM_DEFAULT;
        const gridClasses = `gallery-grid zoom-${currentZoom}`;

        return createElement('div', {
            className: 'gallery-date-group',
            dataset: { date: dateKey, total: serverTotal }
        }, [
            createElement('div', { className: 'gallery-date-header' }, [
                createElement('span', { className: 'gallery-date-title', textContent: displayDate }),
                createElement('span', { className: 'gallery-date-count', textContent: String(monthTotal || serverTotal) }),
                createElement('span', {
                    className: 'gallery-date-open-icon',
                    innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>'
                })
            ]),
            createElement('div', {
                ref: this.ref('grid'),
                className: gridClasses,
                style: { position: 'relative' } // Ensure scroller sentinels have a stable parent
            })
        ]);
    }

    onStart() {
        this._renderGrid();
        if (this._viewKey) {
            this._unsubscribeView = subscribeView(this._viewKey, () => {
                this._renderGrid();
            }, { owner: this });
        }
    }

    onStop() {
        this._unsubscribeView?.();
        this._unsubscribeView = null;
    }

    _getVisibleMedia() {
        return selectRecordsForView(this._viewKey)
            .filter((media) => {
                const dateKey = media?.dateKey || getDateKey(media?.modified || media?.created || null);
                return dateKey === this._dateKey;
            })
            .slice(0, ITEMS_PER_DATE_GROUP);
    }

    _renderGrid() {
        const visibleMedia = this._getVisibleMedia();
        const count = $('.gallery-date-count', this.element);
        if (count) count.textContent = String(getMonthTotal(this._dateKey) || getDateTotal(this._dateKey) || visibleMedia.length);
        // Key by stable id (category_id::rel_path). Using m.url leaves the
        // renderer vulnerable to mismatches when the same DOM slot picks up
        // a re-hydrated record with a different file path.
        renderGrid(this.refs.grid, visibleMedia, (m) => m.id || m.url, (m) => renderMediaItem(m, 0), updateGalleryItem, { applyGridStyles: false, poolKey: null });
        $$('img[data-src]', this.refs.grid).forEach(img => observeLazyImage(img));
    }
}

// ── GalleryTimelineComponent ───────────────────────────────────────────────────

// Max rendered date groups before eviction. Variable-height groups make a per-group
// (chunkSize=1) approach correct — each date is its own "chunk".
const MAX_DATE_CHUNKS = 30;

class GalleryTimelineComponent extends Component {
    constructor(dateKeys, hasMoreDates, viewKey = null) {
        super({});
        this._dateKeys = dateKeys;
        this._hasMoreDates = hasMoreDates;
        this._viewKey = viewKey;
        this._unsubscribeView = null;

        this._vs = null;
        this._loadingMoreDates = false;
        this._scrollTop = 0;
        this._dateKeysSignature = this._signatureFor(dateKeys, hasMoreDates);
    }

    _signatureFor(dateKeys, hasMoreDates) {
        return `${(dateKeys || []).join('|')}::${hasMoreDates ? 1 : 0}`;
    }

    render() {
        return createElement('div', { className: 'gallery-scroll-area' }, [
            createElement('div', { className: 'gallery-empty-wrapper' }),
            createElement('div', { className: 'gallery-groups-container' })
        ]);
    }

    onStart() {
        const container = this.element.querySelector('.gallery-groups-container');
        if (!container) return;

        this._vs = new VirtualScroller({
            root: this.element,
            chunkContainer: container,
            totalItems: () => this._dateKeys.length + (this._hasMoreDates ? 1 : 0),
            chunkSize: 1,
            maxChunks: MAX_DATE_CHUNKS,
            poolSize: 0,
            renderChunk: (i) => this._renderGroup(i),
            onChunkEvicted: (i) => this._evictGroup(i),
            measureChunk: (el) => el.offsetHeight,
            buildPlaceholder: (i, px) => createElement('div', {
                className: 'gallery-date-placeholder',
                dataset: { vsPlaceholder: String(i) },
                style: `height:${px}px`
            }),
            rootMargin: '800px 0px 1200px 0px'
        });

        this._vs.mount(this.element);
        this._subscribeToTimelineView(this._viewKey);

        this.on(this.element, 'click', async (e) => this._onClick(e));

        // Keyboard navigation for gallery grid items (roving tabindex)
        this.on(this.element, 'keydown', (e) => {
            const item = e.target.closest('.gallery-item');
            if (!item) return;

            const grid = item.closest('.gallery-grid');
            if (!grid) return;

            const items = Array.from(grid.querySelectorAll('.gallery-item'));
            const idx = items.indexOf(item);
            if (idx < 0) return;

            // Calculate columns from grid layout
            const cols = Math.max(1, Math.round(grid.offsetWidth / item.offsetWidth));
            let targetIdx = -1;

            if (e.key === 'ArrowRight') targetIdx = Math.min(idx + 1, items.length - 1);
            else if (e.key === 'ArrowLeft') targetIdx = Math.max(idx - 1, 0);
            else if (e.key === 'ArrowDown') targetIdx = Math.min(idx + cols, items.length - 1);
            else if (e.key === 'ArrowUp') targetIdx = Math.max(idx - cols, 0);
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); return; }

            if (targetIdx >= 0 && targetIdx !== idx) {
                e.preventDefault();
                item.setAttribute('tabindex', '-1');
                items[targetIdx].setAttribute('tabindex', '0');
                items[targetIdx].focus();
                items[targetIdx].scrollIntoView({ block: 'nearest' });
            }
        });

        _setupMarqueeSelection(this.element, this);

        if (this._scrollTop > 0) {
            requestAnimationFrame(() => {
                if (this.element) this.element.scrollTop = this._scrollTop;
            });
        }
    }

    onStop() {
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        if (this._vs) {
            this._vs.unmount();
            this._vs = null;
        }
        cleanupAutoCollapseObserver();
    }

    setTimelineSource({ dateKeys, hasMoreDates, viewKey }) {
        const nextSig = this._signatureFor(dateKeys, hasMoreDates);
        const signatureChanged = nextSig !== this._dateKeysSignature;
        this._dateKeys = dateKeys;
        this._hasMoreDates = hasMoreDates;
        this._dateKeysSignature = nextSig;
        this._subscribeToTimelineView(viewKey);
        if (signatureChanged) this.refresh();
    }

    _subscribeToTimelineView(viewKey) {
        if (this._viewKey === viewKey && this._unsubscribeView) return;
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        this._viewKey = viewKey || null;
        if (!this._viewKey) return;
        this._unsubscribeView = subscribeView(this._viewKey, () => {
            this._syncTimelineSnapshot();
        }, { owner: this });
    }

    _syncTimelineSnapshot({ reset = true } = {}) {
        const nextDateKeys = getSortedDateKeys();
        const nextHasMore = getHasMoreDates();
        const nextSig = this._signatureFor(nextDateKeys, nextHasMore);
        const signatureChanged = nextSig !== this._dateKeysSignature;

        this._dateKeys = nextDateKeys;
        this._hasMoreDates = nextHasMore;
        this._dateKeysSignature = nextSig;

        // Only reset the VS when the date-key list (or hasMore) actually
        // changed. Record-only updates (e.g. month-overlay hydration touching
        // ids that overlap the timeline view) are handled inside each
        // DateGroupComponent via its own subscribeView; a full reset here just
        // makes the visible date groups flicker.
        if (!signatureChanged) return;
        bumpTimelineProjection();
        if (reset && this._vs) this._vs.reset();
    }

    _renderGroup(i) {
        if (i >= this._dateKeys.length) {
            if (!this._hasMoreDates || this._loadingMoreDates) return null;
            this._loadingMoreDates = true;
            return loadMoreDates().then((result) => {
                if (!result?.orderedIds?.length) {
                    this._syncTimelineSnapshot();
                }
                return null;
            }).finally(() => {
                this._loadingMoreDates = false;
            });
        }
        const k = this._dateKeys[i];
        const comp = new DateGroupComponent(k, this._viewKey);
        const el = comp.render();

        // Wire RAGOT lifecycle manually for virtualized chunks
        el.dataset.dateIndex = String(i);
        el.__ragotComponent = comp;
        comp.element = el;
        comp._isMounted = true;
        comp.onStart();

        return el;
    }

    _evictGroup(i) {
        const el = this._vs?.getChunkElement?.(i);
        if (el?.__ragotComponent) {
            el.__ragotComponent.onStop();
        }
    }

    async _onClick(e) {
        const target = e.target;

        // Date header click → open month overlay
        const dateHeader = target.closest('.gallery-date-header');
        if (dateHeader && _onDateHeaderClick) {
            const group = dateHeader.closest('.gallery-date-group');
            const dateKey = group?.dataset.date;
            if (dateKey) {
                const parts = dateKey.split('-');
                _onDateHeaderClick(parseInt(parts[0]), parseInt(parts[1]));
                return;
            }
        }

        const checkbox = target.closest('.gallery-item-check');
        if (checkbox) {
            e.stopPropagation();
            const item = checkbox.closest('.gallery-item');
            const mediaUrl = item?.dataset.mediaUrl;
            if (mediaUrl) {
                const isSelected = toggleMediaSelection(mediaUrl);
                item.classList.toggle('selected', isSelected);
                checkbox.classList.toggle('checked', isSelected);
                _toolbarComponent?.syncState();
            }
            return;
        }

        const galleryItem = target.closest('.gallery-item');
        if (galleryItem && !target.closest('.gallery-item-check')) {
            // Route through the timeline view so the viewer inherits the
            // fully-hydrated ordering, not a fresh category page-1 fetch.
            openViewerFromGalleryCard(galleryItem, this._viewKey);
        }
    }

    scrollToDate(dateKey) {
        const i = this._dateKeys.indexOf(dateKey);
        if (i < 0) return;

        if (this._vs) {
            this._vs.jumpToIndex(i);
            requestAnimationFrame(() => {
                _scrollToDateGroup(dateKey, this.element);
            });
        }
    }

    refresh() {
        if (!this._vs) return;
        const container = this.element.querySelector('.gallery-groups-container');
        if (!container) return;

        this._vs.recycle();
        this._vs.rebind({
            renderChunk: (i) => this._renderGroup(i),
            totalItems: () => this._dateKeys.length + (this._hasMoreDates ? 1 : 0),
        }, container);
    }
}

// ── Singleton management ──────────────

let _timelineComponent = null;
let _toolbarComponent = null;
let _onDateHeaderClick = null;

export function setToolbarComponent(comp) {
    _toolbarComponent = comp;
}

export function setDateHeaderClickHandler(fn) {
    _onDateHeaderClick = fn;
}

export function getTimelineComponent() {
    return _timelineComponent;
}

export function render(preservedScrollTop = null) {
    const container = getContainer();
    if (!container || !isActive()) return;

    const dateKeys = getSortedDateKeys();
    const hasMoreDates = getHasMoreDates();
    const viewKey = getGalleryTimelineViewKey();
    const categoriesData = getCategoriesData();
    const categoryIdFilter = getCategoryIdFilter();

    const prevScrollArea = _timelineComponent?.element;
    const scrollTop = preservedScrollTop ?? (prevScrollArea?.scrollTop || 0);

    if (categoriesData.length === 0 && !categoryIdFilter) {
        if (_timelineComponent) {
            _timelineComponent.unmount();
            _timelineComponent = null;
        }
        const timelineSlot = $('#gallery-timeline-slot', container);
        const target = timelineSlot || container;
        clear(target);
        append(target, createElement('div', {
            style: { display: 'flex', justifyContent: 'center', paddingTop: '50px', width: '100%' }
        },
            createElement('div', {
                className: 'category-item',
                style: { width: '100%', maxWidth: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', textAlign: 'center', cursor: 'default' },
                textContent: 'No media found. Please plug in a USB drive with media files.'
            })
        ));
        return;
    }

    if (_timelineComponent && _timelineComponent._isMounted) {
        _timelineComponent.setTimelineSource({ dateKeys, hasMoreDates, viewKey });
    } else {
        if (_timelineComponent) _timelineComponent.unmount();
        const timelineSlot = $('#gallery-timeline-slot', container);
        if (timelineSlot) clear(timelineSlot);

        _timelineComponent = new GalleryTimelineComponent(dateKeys, hasMoreDates, viewKey);
        _timelineComponent._scrollTop = scrollTop;
        _timelineComponent.mount(timelineSlot || container);
    }

    updateCategoryFilterPill(getCategoryNameFilter() || getParentNameFilter());
    _toolbarComponent?.syncState();
}

export function mountTimeline(_slot) { }

export function unmountTimeline() {
    if (_timelineComponent) {
        _timelineComponent.unmount();
        _timelineComponent = null;
    }
    // Toolbar is unmounted by GalleryLayoutModule via adoptComponent; null the ref here
    // so stale references don't linger after the module stops.
    _toolbarComponent = null;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _collapseGroup(dateKey, scrollArea) {
    const dateGroupState = getDateGroupState();
    const state = dateGroupState.get(dateKey);
    if (state) {
        state.expanded = false;
        dateGroupState.set(dateKey, state);
    }
    if (_timelineComponent) {
        _timelineComponent.refresh();
    }
}

function _scrollToDateGroup(dateKey, scrollArea) {
    if (!dateKey || !scrollArea) return;
    const group = $(`.gallery-date-group[data-date="${dateKey}"]`, scrollArea);
    if (group) {
        group.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const dateKeys = getSortedDateKeys();
    const dateIndex = dateKeys.indexOf(dateKey);
    if (dateIndex > 0) {
        const prevGroup = $(`.gallery-date-group[data-date="${dateKeys[dateIndex - 1]}"]`, scrollArea);
        if (prevGroup) prevGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function _setupMarqueeSelection(scrollArea, owner) {
    const marquee = createElement('div', { className: 'gallery-marquee' });
    append(scrollArea, marquee);

    const SCROLL_EDGE = 60;
    const SCROLL_SPEED = 15;
    let active = false;
    let startX = 0;
    let startY = 0;
    let scrollIntervalId = null;

    const clearScrollInterval = () => {
        if (scrollIntervalId !== null) {
            owner.clearInterval(scrollIntervalId);
            scrollIntervalId = null;
        }
    };

    owner.on(scrollArea, 'mousedown', (e) => {
        if (e.target.closest('.gallery-item') || e.target.closest('button') || e.button !== 0) return;
        const rect = scrollArea.getBoundingClientRect();
        active = true;
        startX = e.clientX - rect.left + scrollArea.scrollLeft;
        startY = e.clientY - rect.top + scrollArea.scrollTop;
        clearSelection();
        $$('.gallery-item.selected', scrollArea).forEach(item => {
            item.classList.remove('selected');
            $('.gallery-item-check', item)?.classList.remove('checked');
        });
        marquee.style.cssText = `left:${startX}px;top:${startY}px;width:0;height:0`;
        marquee.classList.add('active');
        e.preventDefault();
    });

    owner.on(scrollArea, 'mousemove', (e) => {
        if (!active) return;
        clearScrollInterval();
        const rect = scrollArea.getBoundingClientRect();
        if (e.clientY < rect.top + SCROLL_EDGE) {
            scrollIntervalId = owner.interval(() => {
                scrollArea.scrollTop -= SCROLL_SPEED;
                _updateMarquee(e, scrollArea, marquee, startX, startY);
            }, 16);
        } else if (e.clientY > rect.bottom - SCROLL_EDGE) {
            scrollIntervalId = owner.interval(() => {
                scrollArea.scrollTop += SCROLL_SPEED;
                _updateMarquee(e, scrollArea, marquee, startX, startY);
            }, 16);
        }
        _updateMarquee(e, scrollArea, marquee, startX, startY);
    });

    const endMarquee = () => {
        if (!active) return;
        active = false;
        marquee.classList.remove('active');
        clearScrollInterval();
    };
    owner.on(scrollArea, 'mouseup', endMarquee);
    owner.on(scrollArea, 'mouseleave', endMarquee);
}

function _updateMarquee(e, scrollArea, marquee, startX, startY) {
    const rect = scrollArea.getBoundingClientRect();
    const currentX = e.clientX - rect.left + scrollArea.scrollLeft;
    const currentY = e.clientY - rect.top + scrollArea.scrollTop;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    marquee.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
    const marqueeRect = { left, top, right: left + width, bottom: top + height };
    $$('.gallery-item', scrollArea).forEach(item => {
        const intersects = !(
            item.offsetLeft + item.offsetWidth < marqueeRect.left ||
            item.offsetLeft > marqueeRect.right ||
            item.offsetTop + item.offsetHeight < marqueeRect.top ||
            item.offsetTop > marqueeRect.bottom
        );
        const mediaUrl = item.dataset.mediaUrl;
        if (!mediaUrl) return;
        const isSelected = isMediaSelected(mediaUrl);
        if (intersects && !isSelected) {
            toggleMediaSelection(mediaUrl);
            item.classList.add('selected');
            $('.gallery-item-check', item)?.classList.add('checked');
        } else if (!intersects && isSelected) {
            toggleMediaSelection(mediaUrl);
            item.classList.remove('selected');
            $('.gallery-item-check', item)?.classList.remove('checked');
        }
    });
}

const LARGE_FILE_THRESHOLD = 16 * 1024 * 1024;
const MAX_BATCH_SIZE = 300 * 1024 * 1024;

function _createDownloadBatches(items) {
    const largeFiles = [];
    const smallFiles = [];
    for (const item of items) {
        if (item.size && item.size > LARGE_FILE_THRESHOLD) largeFiles.push(item);
        else smallFiles.push(item);
    }
    const batches = [];
    let currentBatch = [];
    let currentBatchSize = 0;
    for (const item of smallFiles) {
        const fileSize = item.size || 1024 * 1024;
        if (currentBatchSize + fileSize > MAX_BATCH_SIZE && currentBatch.length > 0) {
            batches.push({ type: 'batch', items: currentBatch });
            currentBatch = [];
            currentBatchSize = 0;
        }
        currentBatch.push(item);
        currentBatchSize += fileSize;
    }
    if (currentBatch.length > 0) batches.push({ type: 'batch', items: currentBatch });
    for (const item of largeFiles) batches.push({ type: 'single', item });
    return batches;
}

export async function handleDownloadSelected() {
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) return;
    const selectedItems = getSelectedMediaItems();
    if (selectedItems.length === 0) return;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
    const container = getContainer();
    const downloadBtn = container ? $('.gallery-action-btn[data-action="download"]', container) : null;
    const batches = _createDownloadBatches(selectedItems);
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `<span class="gallery-btn-spinner"></span> 0/${batches.length}`;
    }
    try {
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            if (downloadBtn) downloadBtn.innerHTML = `<span class="gallery-btn-spinner"></span> ${i + 1}/${batches.length}`;
            if (batch.type === 'single' || batch.items.length === 1) {
                const item = batch.item || batch.items[0];
                const link = createElement('a', { href: item.url, download: item.name || 'download' });
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } else {
                const urls = batch.items.map(item => item.url);
                const response = await fetch('/api/gallery/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls })
                });
                if (!response.ok) throw new Error('Download batch failed');
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const link = createElement('a', { href: url, download: `ghosthub-batch-${i + 1}-${Date.now()}.zip` });
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
            }
            if (i < batches.length - 1) await new Promise(r => setTimeout(r, isMobile ? 800 : 300));
        }
        clearSelection();
        render();
    } catch (error) {
        console.error('[GalleryLayout] Download error:', error);
        toast.error('Download failed. Please try again.');
    } finally {
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download`;
        }
    }
}

// ── Media item rendering ──────────────────────────────────────────────────────

function renderMediaItem(media, index) {
    const isVideo = media.type === 'video';
    const thumbnailUrl = media.thumbnailUrl || media.url;
    const finalThumbnailSrc = thumbnailUrl ? appendShowHiddenParam(thumbnailUrl) : null;
    const selected = isMediaSelected(media.url);
    const children = [
        createElement('div', {
            className: `gallery-item-check ${selected ? 'checked' : ''}`,
            innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        })
    ];
    const statusType = ThumbnailProgress.isProcessing(media.categoryId) ? 'generating' : 'pending';
    children.push(createThumbnailShell({
        shellClassName: 'gallery-item-thumbnail-shell',
        placeholderClassName: 'gallery-item-thumbnail-placeholder',
        imageClassName: 'gallery-item-thumbnail gh-img-reveal',
        finalSrc: finalThumbnailSrc,
        placeholderState: finalThumbnailSrc ? 'pending' : statusType,
        fetchPriority: 'low',
        showPendingState: true
    }));
    if (isVideo) children.push(createElement('span', { className: 'gallery-item-video', innerHTML: VIDEO_BADGE_SVG }));
    return createElement('div', {
        className: `gallery-item gh-stagger ${selected ? 'selected' : ''}`,
        tabIndex: index === 0 ? 0 : -1,
        role: 'link',
        style: { '--card-index': index },
        dataset: {
            categoryId: media.categoryId || '',
            mediaUrl: media.url || '',
            // Stable id beats URL: indexOf in the timeline view's orderedIds
            // is exact. Reading from dataset (vs. closure) keeps the click
            // path correct after in-place item updates.
            recordId: media.id || '',
            index,
        }
    }, ...children);
}

function updateGalleryItem(el, media) {
    const prevMediaUrl = el.dataset.mediaUrl || '';
    const nextMediaUrl = media.url || '';
    el.dataset.mediaUrl = nextMediaUrl;
    el.dataset.categoryId = media.categoryId || '';
    // Keep stable id in sync. renderGrid keys by id, so the same DOM slot
    // can receive a different record on rebuild — the click handler needs
    // to see the new id, not the prior one.
    el.dataset.recordId = media.id || '';

    const img = $('.gallery-item-thumbnail', el);
    if (img) {
        const thumbnailUrl = media.thumbnailUrl || media.url;
        const nextSrc = thumbnailUrl ? appendShowHiddenParam(thumbnailUrl) : '';
        // Force resync whenever the underlying media URL on this slot changed.
        // Comparing data-src alone is unreliable: the lazy loader may have set
        // img.src but left data-src stale (or vice versa), so a row whose
        // record was swapped could keep showing the old thumbnail while
        // dataset.mediaUrl already points to the new media — causing the
        // "click opens wrong media" bug.
        const slotChanged = prevMediaUrl && prevMediaUrl !== nextMediaUrl;
        const currentSrc = img.dataset.src || img.getAttribute('src') || '';
        if (nextSrc && (slotChanged || currentSrc !== nextSrc)) {
            img.dataset.src = nextSrc;
            img.removeAttribute('src');
            setThumbnailImageState(img, 'pending');
            resetLazyImage(img);
            observeLazyImage(img);
        }
    }

    const badge = $('.gallery-item-video', el);
    const shouldHaveBadge = media.type === 'video';
    if (badge && !shouldHaveBadge) {
        badge.remove();
    } else if (!badge && shouldHaveBadge) {
        append(el, createElement('span', { className: 'gallery-item-video', innerHTML: VIDEO_BADGE_SVG }));
    }

    const selected = isMediaSelected(media.url);
    el.classList.toggle('selected', selected);
    const check = $('.gallery-item-check', el);
    if (check) check.classList.toggle('checked', selected);
}

export async function loadAndRender(forceRefresh = false) {
    if (!isActive() || getIsLoading()) return;
    setIsLoading(true);
    const container = getContainer();
    try {
        if (container) {
            const timelineSlot = $('#gallery-timeline-slot', container);
            const target = timelineSlot || container;
            if (_timelineComponent) _timelineComponent.unmount();
            _timelineComponent = null;
            clear(target);
            append(target, createElement('div', { className: 'gallery-loading' }, [
                createElement('div', { className: 'gallery-loading-spinner' }),
                createElement('p', { textContent: 'Loading gallery...' })
            ]));
        }
        await loadInitialMedia(forceRefresh);
        render();
    } catch (error) {
        console.error('[GalleryLayout] Error loading:', error);
        if (container) renderError();
    } finally {
        setIsLoading(false);
    }
}

export function renderError() {
    const container = getContainer();
    if (!container) return;
    const timelineSlot = $('#gallery-timeline-slot', container);
    const target = timelineSlot || container;
    clear(target);
    append(target, createElement('div', { className: 'gallery-empty' }, [
        createElement('span', { className: 'gallery-empty-icon', innerHTML: warningIcon(48) }),
        createElement('p', { textContent: 'Failed to load gallery' }),
        createElement('button', { style: { marginTop: '10px', padding: '8px 16px', cursor: 'pointer' }, onClick: () => loadAndRender() }, 'Retry')
    ]));
}

export function cleanupRenderer() { unmountTimeline(); }
export function cleanupMarqueeSelection() { }
export function handleProgressUpdate(data) { }
