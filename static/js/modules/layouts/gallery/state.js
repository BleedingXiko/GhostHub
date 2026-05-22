/**
 * Gallery Layout - State Management
 * Centralized state for gallery layout (Google Photos / Immich style).
 *
 * GalleryStateModule extends Module so that other modules/components can
 * subscribe to normalized timeline/order state changes.
 *
 * Note on Set state (selectedMedia):
 *   Module.setState detects changes by object identity. Since selectedMedia is
 *   a Set mutated in-place, we pair it with a version counter (selectedVersion)
 *   that increments on every selection change. Components that need to react to
 *   selection changes should subscribe on `selectedVersion` (via selector).
 */
import { $, Module } from '../../../libs/ragot.esm.min.js';
import { selectRecordsForView } from '../../media/selectors.js';
import { mediaOrdering } from '../../media/ordering.js';

// Constants (unchanged)
export const MEDIA_PER_PAGE = 100;
export const SCROLL_LOAD_THRESHOLD = 500;

// ── GalleryStateModule ─────────────────────────────────────────────────────

export class GalleryStateModule extends Module {
    constructor() {
        super({
            // Container reference
            galleryContainer: null,
            isGalleryLayout: false,

            // Timeline projection metadata
            galleryTimelineViewKey: null,
            timelineProjectionVersion: 0,
            dateTotals: {},
            categoriesData: [],
            isLoading: false,
            eventListenersAttached: false,

            // Filter state
            mediaFilter: 'all',
            categoryIdFilter: null,
            categoryNameFilter: null,
            parentNameFilter: null,
            categoryIdsFilter: null,

            // Grid / date paging
            gridSize: 'medium',
            datesPage: 1,
            hasMoreDates: true,

            // Timeline navigation
            allYearsData: [],
            selectedMobileYear: null,

            // Selection (Set is mutated in-place; selectedVersion is the reactive trigger)
            isSelectionMode: false,
            selectedVersion: 0, // bumped on every selection mutation
        });

        // selectedMedia Set is kept outside reactive state to avoid shallow-merge issues
        this._selectedMedia = new Set();

        // Lazy loading observer (not reactive)
        this._lazyLoadObserver = null;
    }

    // ── Selection helpers (mutate _selectedMedia + bump selectedVersion) ─────

    toggleMediaSelection(url) {
        if (this._selectedMedia.has(url)) {
            this._selectedMedia.delete(url);
        } else {
            this._selectedMedia.add(url);
        }
        const isSelectionMode = this._selectedMedia.size > 0;
        this.setState({ isSelectionMode, selectedVersion: this.state.selectedVersion + 1 });
        return this._selectedMedia.has(url);
    }

    selectMedia(url) {
        this._selectedMedia.add(url);
        this.setState({ isSelectionMode: true, selectedVersion: this.state.selectedVersion + 1 });
    }

    deselectMedia(url) {
        this._selectedMedia.delete(url);
        const isSelectionMode = this._selectedMedia.size > 0;
        this.setState({ isSelectionMode, selectedVersion: this.state.selectedVersion + 1 });
    }

    clearSelection() {
        this._selectedMedia.clear();
        this.setState({ isSelectionMode: false, selectedVersion: this.state.selectedVersion + 1 });
    }

    selectAllInDate(dateKey) {
        const media = getMediaByDate()[dateKey] || [];
        media.forEach(m => this._selectedMedia.add(m.url));
        if (this._selectedMedia.size > 0) {
            this.setState({ isSelectionMode: true, selectedVersion: this.state.selectedVersion + 1 });
        }
    }

    getSelectedMedia() { return this._selectedMedia; }
    getSelectedCount() { return this._selectedMedia.size; }
    isMediaSelected(url) { return this._selectedMedia.has(url); }

    getSelectedMediaItems() {
        return getAllMedia().filter(m => this._selectedMedia.has(m.url));
    }

    // ── Date grouping helpers ────────────────────────────────────────────────

    groupMediaByDate() {
        const mediaByDate = {};
        for (const media of getAllMedia()) {
            const dateKey = media.dateKey || getDateKey(media.modified || media.created || null);
            if (!mediaByDate[dateKey]) mediaByDate[dateKey] = [];
            mediaByDate[dateKey].push(media);
        }
        return mediaByDate;
    }

    setAllMediaIds(ids, view = {}) {
        const nextIds = uniqueIds(ids);
        this._syncTimelineView(nextIds, view);
    }

    appendMediaIds(ids) {
        const current = this._currentTimelineIds();
        const seen = new Set(current);
        const nextIds = [...current];
        for (const id of ids || []) {
            if (!id || seen.has(id)) continue;
            seen.add(id);
            nextIds.push(id);
        }
        this._syncTimelineView(nextIds);
    }

    mergeDateTotals(newTotals) {
        const dateTotals = { ...this.state.dateTotals, ...newTotals };
        this.setState({ dateTotals });
    }

    clearAllMedia() {
        this._selectedMedia.clear();
        this.setState({
            galleryTimelineViewKey: null,
            timelineProjectionVersion: this.state.timelineProjectionVersion + 1,
            dateTotals: {},
            datesPage: 1,
            hasMoreDates: true,
            isSelectionMode: false,
            selectedVersion: this.state.selectedVersion + 1,
            selectedMobileYear: null,
            categoryIdsFilter: null,
            allYearsData: [],
        });
    }

    _syncTimelineView(orderedIds, view = {}) {
        const viewKey = this.state.galleryTimelineViewKey;
        if (!viewKey) return;
        const current = mediaOrdering.selectView(viewKey);
        const params = this._aggregateTimelineParams(view.params || current.params || {});
        mediaOrdering.ingestView(viewKey, {
            ...current,
            viewKey,
            viewType: view.viewType || view.view || current.viewType || 'gallery_timeline',
            orderedIds,
            params,
            status: current.status === 'idle' ? 'ready' : current.status,
        });
        this.bumpTimelineProjection();
    }

    _currentTimelineIds() {
        const viewKey = this.state.galleryTimelineViewKey;
        if (!viewKey) return [];
        return mediaOrdering.selectView(viewKey)?.orderedIds || [];
    }

    bumpTimelineProjection() {
        this.setState({ timelineProjectionVersion: this.state.timelineProjectionVersion + 1 });
    }

    _aggregateTimelineParams(params) {
        const next = { ...(params || {}) };
        if (next.dates_limit != null) {
            const baseLimit = Math.max(1, Number(next.dates_limit) || 15);
            const pages = Math.max(1, Number(this.state.datesPage) || 1);
            next.dates_page = 1;
            next.dates_limit = Math.min(366, baseLimit * pages);
        }
        if (next.jump_to_date) delete next.jump_to_date;
        if (next.date) delete next.date;
        if (next.date_offset) delete next.date_offset;
        return next;
    }
}

// Singleton instance — started immediately so subscribers can attach before layout init
export const galleryState = new GalleryStateModule();
galleryState.start();

// Lazy-loaded images tracker — module-level WeakSet, not reactive
export const lazyLoadedImages = new WeakSet();

function uniqueIds(ids) {
    return Array.from(new Set((ids || []).filter(Boolean)));
}

function idsFromMedia(media) {
    return (media || []).map((item) => item?.id).filter(Boolean);
}

// ── State Accessors ────────────────────────────────────────────────────────

export function getContainer() {
    return $('#gallery-container') || galleryState.state.galleryContainer;
}
export function isActive() {
    return document.documentElement.getAttribute('data-layout') === 'gallery';
}
export function getIsLoading() { return galleryState.state.isLoading; }
export function getGalleryTimelineIds() {
    const viewKey = getGalleryTimelineViewKey();
    return viewKey ? (mediaOrdering.selectView(viewKey)?.orderedIds || []) : [];
}
export function getGalleryTimelineViewKey() { return galleryState.state.galleryTimelineViewKey; }
export function getAllMedia() { return selectRecordsForView(getGalleryTimelineViewKey()); }
export function getMediaByDate() { return galleryState.groupMediaByDate(); }
export function getCategoriesData() { return galleryState.state.categoriesData; }
export function getMediaFilter() { return galleryState.state.mediaFilter; }
export function getCategoryIdFilter() { return galleryState.state.categoryIdFilter; }
export function getCategoryNameFilter() { return galleryState.state.categoryNameFilter; }
export function getParentNameFilter() { return galleryState.state.parentNameFilter; }
export function getCategoryIdsFilter() { return galleryState.state.categoryIdsFilter; }
export function getGridSize() { return galleryState.state.gridSize; }
export function getDateTotals() { return galleryState.state.dateTotals; }
export function getDateTotal(dateKey) { return galleryState.state.dateTotals[dateKey] || 0; }
export function getMonthTotal(dateKey) {
    if (!dateKey || dateKey === 'Unknown') return 0;
    const prefix = dateKey.slice(0, 7); // 'YYYY-MM'
    const [yearStr, monthStr] = prefix.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const yearData = (galleryState.state.allYearsData || []).find((item) => item.year === year);
    const monthData = yearData?.months?.find((item) => item.month === month);

    if (monthData?.media_count != null) {
        const explicitMonthTotal = Number(monthData.media_count);
        if (!Number.isNaN(explicitMonthTotal)) return explicitMonthTotal;
    }

    const totals = galleryState.state.dateTotals;
    return Object.keys(totals).reduce((sum, k) => k.startsWith(prefix) ? sum + totals[k] : sum, 0);
}
export function getDatesPage() { return galleryState.state.datesPage; }
export function getHasMoreDates() { return galleryState.state.hasMoreDates; }
export function getSelectedMedia() { return galleryState._selectedMedia; }
export function getSelectedCount() { return galleryState._selectedMedia.size; }
export function isInSelectionMode() { return galleryState.state.isSelectionMode; }
export function isMediaSelected(url) { return galleryState._selectedMedia.has(url); }
export function getLazyLoadObserver() { return galleryState._lazyLoadObserver; }
export function getLazyLoadedImages() { return lazyLoadedImages; }
export function areEventListenersAttached() { return galleryState.state.eventListenersAttached; }
export function getAllYearsData() { return galleryState.state.allYearsData; }
export function getSelectedMobileYear() { return galleryState.state.selectedMobileYear; }

// ── State Mutators ─────────────────────────────────────────────────────────

export function setContainer(container) { galleryState.setState({ galleryContainer: container }); }
export function setIsGalleryLayout(value) { galleryState.setState({ isGalleryLayout: value }); }
export function setIsLoading(value) { galleryState.setState({ isLoading: value }); }
export function setAllMediaIds(ids, view = {}) { galleryState.setAllMediaIds(ids, view); }
export function setGalleryTimelineViewKey(viewKey) {
    galleryState.setState({ galleryTimelineViewKey: viewKey || null });
    const currentIds = viewKey ? (mediaOrdering.selectView(viewKey)?.orderedIds || []) : [];
    galleryState._syncTimelineView(currentIds);
}
export function appendMediaIds(ids) { galleryState.appendMediaIds(ids); }
export function bumpTimelineProjection() { galleryState.bumpTimelineProjection(); }
export function setCategoriesData(data) { galleryState.setState({ categoriesData: data }); }
export function setMediaFilter(filter) { galleryState.setState({ mediaFilter: filter }); }
export function setCategoryIdFilter(id) { galleryState.setState({ categoryIdFilter: id }); }
export function setCategoryNameFilter(name) { galleryState.setState({ categoryNameFilter: name }); }
export function setParentNameFilter(name) { galleryState.setState({ parentNameFilter: name }); }
export function setCategoryIdsFilter(ids) { galleryState.setState({ categoryIdsFilter: ids }); }
export function setGridSize(size) { galleryState.setState({ gridSize: size }); }
export function setDateTotals(totals) { galleryState.setState({ dateTotals: totals }); }
export function setDatesPage(page) { galleryState.setState({ datesPage: page }); }
export function setHasMoreDates(value) { galleryState.setState({ hasMoreDates: value }); }
export function setSelectionMode(value) { galleryState.setState({ isSelectionMode: value }); }
export function setLazyLoadObserver(observer) { galleryState._lazyLoadObserver = observer; }
export function setAllYearsData(data) { galleryState.setState({ allYearsData: data }); }
export function setSelectedMobileYear(year) { galleryState.setState({ selectedMobileYear: year }); }
export function setEventListenersAttached(value) { galleryState.setState({ eventListenersAttached: value }); }

// ── Selection Operations ───────────────────────────────────────────────────

export function toggleMediaSelection(url) { return galleryState.toggleMediaSelection(url); }
export function selectMedia(url) { galleryState.selectMedia(url); }
export function deselectMedia(url) { galleryState.deselectMedia(url); }
export function clearSelection() { galleryState.clearSelection(); }
export function selectAllInDate(dateKey) { galleryState.selectAllInDate(dateKey); }
export function getSelectedMediaItems() { return galleryState.getSelectedMediaItems(); }

// ── Media Helpers ─────────────────────────────────────────────────────────

export function clearAllMedia() { galleryState.clearAllMedia(); }

export function mergeDateTotals(newTotals) { galleryState.mergeDateTotals(newTotals); }

export function appendMedia(newMedia) { galleryState.appendMediaIds(idsFromMedia(newMedia)); }

export function groupMediaByDate() { return galleryState.groupMediaByDate(); }

// ── Date utilities (pure functions, unchanged) ─────────────────────────────

export function getDateKey(timestamp) {
    if (!timestamp) return 'Unknown';
    try {
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) {
            const parsed = new Date(timestamp);
            if (isNaN(parsed.getTime())) return 'Unknown';
            return parsed.toISOString().split('T')[0];
        }
        return date.toISOString().split('T')[0];
    } catch (e) {
        return 'Unknown';
    }
}

export function formatDateDisplay(dateKey) {
    if (dateKey === 'Unknown') return 'Unknown Date';
    try {
        const date = new Date(dateKey);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (date.toDateString() === today.toDateString()) return 'Today';
        if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
        if (date.getFullYear() === today.getFullYear()) {
            return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        }
        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return dateKey;
    }
}

export function getSortedDateKeys() {
    return Object.keys(getMediaByDate()).sort((a, b) => {
        if (a === 'Unknown') return 1;
        if (b === 'Unknown') return -1;
        return b.localeCompare(a);
    });
}
