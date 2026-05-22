/**
 * Streaming Layout - State Management
 *
 * StreamingStateModule extends Module so other modules/components can subscribe
 * to normalized category/order state changes.
 */
import { Module, $ } from '../../../libs/ragot.esm.min.js';
import { selectView } from '../../media/selectors.js';

export const MEDIA_PER_PAGE = 20;
export const SCROLL_LOAD_THRESHOLD = 200;
export const MAX_CONTINUE_WATCHING = 15;
const CATEGORY_VIEW_FIELDS = [
    'viewKey',
    'viewPage',
    'viewHasMore',
    'viewStatus',
    'viewSubfolder',
    'viewMediaFilter',
    'subfolders',
    'asyncIndexing',
    'indexingProgress',
];

// ── StreamingStateModule ────────────────────────────────────────────────────

export class StreamingStateModule extends Module {
    constructor() {
        super({
            // Container reference
            streamingContainer: null,
            isStreamingLayout: false,

            // Media data
            categoriesData: [],
            continueWatchingData: [],
            whatsNewData: [],
            whatsNewViewKey: null,
            videoProgressMap: {},
            continueWatchingLoading: false,
            whatsNewLoading: false,

            // UI/loading state
            isLoading: false,

            // Filter state
            mediaFilter: 'all',
            categoryIdFilter: null,
            categoryNameFilter: null,
            subfolderFilter: null,
            parentNameFilter: null,
            categoryIdsFilter: null,

            // Grid mode
            gridMode: false,
            gridTotalItems: 0,

            // Pagination
            activePage: 1,
            limit: 20,
            total: 0,
            totalPages: 1,
            hasMore: false,
        });

        // Lazy loading observer — not reactive, no subscribers need it
        this._lazyLoadObserver = null;
    }
}

// Singleton — started immediately so subscribers can attach before layout init
export const streamingState = new StreamingStateModule();
streamingState.start();

// Lazy-loaded image tracker — WeakSet, never reactive
export const lazyLoadedImages = new WeakSet();

// ── Getters ─────────────────────────────────────────────────────────────────

export function getContainer() {
    return $('#streaming-content-container') || $('#streaming-container') || streamingState.state.streamingContainer;
}
export function isActive() { return document.documentElement.getAttribute('data-layout') === 'streaming'; }
export function getIsLoading() { return streamingState.state.isLoading; }
export function getCategoriesData() { return streamingState.state.categoriesData; }
export function getContinueWatchingData() { return streamingState.state.continueWatchingData; }
export function getWhatsNewData() { return streamingState.state.whatsNewData; }
export function getWhatsNewViewKey() { return streamingState.state.whatsNewViewKey; }
export function getVideoProgressMap() { return streamingState.state.videoProgressMap; }
export function getContinueWatchingLoading() { return streamingState.state.continueWatchingLoading; }
export function getWhatsNewLoading() { return streamingState.state.whatsNewLoading; }
export function getLazyLoadObserver() { return streamingState._lazyLoadObserver; }
export function getLazyLoadedImages() { return lazyLoadedImages; }
export function getMediaFilter() { return streamingState.state.mediaFilter; }
export function getCategoryIdFilter() { return streamingState.state.categoryIdFilter; }
export function getCategoryNameFilter() { return streamingState.state.categoryNameFilter; }
export function getSubfolderFilter() { return streamingState.state.subfolderFilter; }
export function getParentNameFilter() { return streamingState.state.parentNameFilter; }
export function getCategoryIdsFilter() { return streamingState.state.categoryIdsFilter; }
export function getActivePage() { return streamingState.state.activePage; }
export function getLimit() { return streamingState.state.limit; }
export function getTotal() { return streamingState.state.total; }
export function getTotalPages() { return streamingState.state.totalPages; }
export function getHasMore() { return streamingState.state.hasMore; }
export function getGridMode() { return streamingState.state.gridMode; }
export function getGridTotalItems() { return streamingState.state.gridTotalItems; }

// ── Setters ─────────────────────────────────────────────────────────────────

export function setContainer(container) { streamingState.setState({ streamingContainer: container }); }
export function setIsStreamingLayout(value) { streamingState.setState({ isStreamingLayout: value }); }
export function setIsLoading(value) { streamingState.setState({ isLoading: value }); }
export function deriveStreamingRowViewKey(category, filterState = {}) {
    if (!category) return null;
    const subfolderFilter = filterState.subfolderFilter !== undefined ? filterState.subfolderFilter : streamingState.state.subfolderFilter;
    const categoryIdFilter = filterState.categoryIdFilter !== undefined ? filterState.categoryIdFilter : streamingState.state.categoryIdFilter;
    const mediaFilter = filterState.mediaFilter !== undefined ? filterState.mediaFilter : streamingState.state.mediaFilter;

    const subfolder = (subfolderFilter && String(categoryIdFilter) === String(category.id)) ? subfolderFilter : '';
    const viewType = subfolder ? 'subfolder_grid' : 'streaming_row';
    const mf = mediaFilter || 'all';
    return `${viewType}::${category.id}::${subfolder}::${mf}::${MEDIA_PER_PAGE}`;
}

export function setCategoriesData(data) {
    if (!Array.isArray(data)) {
        streamingState.setState({ categoriesData: data });
        return;
    }
    const existing = streamingState.state.categoriesData || [];
    const filterState = {
        subfolderFilter: streamingState.state.subfolderFilter,
        categoryIdFilter: streamingState.state.categoryIdFilter,
        mediaFilter: streamingState.state.mediaFilter,
    };
    const merged = data.map((incoming) => {
        const matched = existing.find((item) => String(item?.id) === String(incoming?.id));
        const base = matched ? { ...matched, ...incoming } : { ...incoming };
        base.viewKey = deriveStreamingRowViewKey(base, filterState);
        if (!base.viewStatus) {
            base.viewStatus = matched?.viewStatus || 'idle';
        }
        return base;
    });
    streamingState.setState({ categoriesData: merged });
}
export function setContinueWatchingData(data) { streamingState.setState({ continueWatchingData: data }); }
export function setWhatsNewData(data) { streamingState.setState({ whatsNewData: data }); }
export function setWhatsNewViewKey(viewKey) { streamingState.setState({ whatsNewViewKey: viewKey || null }); }
export function setVideoProgressMap(map) { streamingState.setState({ videoProgressMap: map }); }
export function setContinueWatchingLoading(value) { streamingState.setState({ continueWatchingLoading: value }); }
export function setWhatsNewLoading(value) { streamingState.setState({ whatsNewLoading: value }); }
export function setLazyLoadObserver(observer) { streamingState._lazyLoadObserver = observer; }
export function setMediaFilter(filter) { streamingState.setState({ mediaFilter: filter }); }
export function setCategoryIdFilter(id) { streamingState.setState({ categoryIdFilter: id }); }
export function setCategoryNameFilter(name) { streamingState.setState({ categoryNameFilter: name }); }
export function setSubfolderFilter(subfolder) { streamingState.setState({ subfolderFilter: subfolder }); }
export function setParentNameFilter(name) { streamingState.setState({ parentNameFilter: name }); }
export function setCategoryIdsFilter(ids) { streamingState.setState({ categoryIdsFilter: ids }); }
export function setActivePage(page) { streamingState.setState({ activePage: page }); }
export function setLimit(value) { streamingState.setState({ limit: value }); }
export function setTotal(value) { streamingState.setState({ total: value }); }
export function setTotalPages(value) { streamingState.setState({ totalPages: value }); }
export function setHasMore(value) { streamingState.setState({ hasMore: value }); }
export function setGridMode(value) { streamingState.setState({ gridMode: value }); }
export function setGridTotalItems(value) { streamingState.setState({ gridTotalItems: value }); }

export function getCategoryView(categoryId, subfolder = null, mf = 'all') {
    const category = (streamingState.state.categoriesData || []).find((item) => String(item?.id) === String(categoryId));
    if (!category?.viewKey && !category?.viewStatus) return null;
    if ((category.viewSubfolder || '') !== (subfolder || '')) return null;
    if ((category.viewMediaFilter || 'all') !== (mf || 'all')) return null;
    return categoryToView(category);
}

export function setCategoryView(categoryId, data, subfolder = null, mf = 'all') {
    updateCategoryRecord(categoryId, {
        viewKey: data?.viewKey || null,
        viewPage: data?.page || 1,
        viewHasMore: data?.hasMore === true,
        viewStatus: data?.status || 'ready',
        viewSubfolder: subfolder || '',
        viewMediaFilter: mf || 'all',
        subfolders: data?.subfolders || [],
        asyncIndexing: data?.asyncIndexing === true,
        indexingProgress: data?.indexingProgress || 0,
    });
}

export function clearCategoryViews() {
    streamingState.setState({
        categoriesData: (streamingState.state.categoriesData || []).map(stripCategoryView),
    });
}

export function pruneCategoryViews(validCategoryIds) {
    if (!Array.isArray(validCategoryIds) || validCategoryIds.length === 0) {
        clearCategoryViews();
        return;
    }
    const validIds = new Set(validCategoryIds.map((categoryId) => String(categoryId)));
    streamingState.setState({
        categoriesData: (streamingState.state.categoriesData || []).map((category) =>
            validIds.has(String(category?.id)) ? category : stripCategoryView(category)
        ),
    });
}

function categoryToView(category) {
    const view = selectView(category.viewKey);
    return {
        orderedIds: view?.orderedIds || [],
        viewKey: category.viewKey || null,
        page: category.viewPage || 1,
        hasMore: category.viewHasMore === true || view?.hasMore === true,
        status: category.viewStatus || view?.status || 'idle',
        subfolders: category.subfolders || [],
        asyncIndexing: category.asyncIndexing === true,
        indexingProgress: category.indexingProgress || 0,
    };
}

function stripCategoryView(category) {
    const next = { ...(category || {}) };
    const fieldsToKeep = ['viewKey', 'viewSubfolder', 'viewMediaFilter'];
    CATEGORY_VIEW_FIELDS.forEach((field) => {
        if (!fieldsToKeep.includes(field)) {
            delete next[field];
        }
    });
    return next;
}

function updateCategoryRecord(categoryId, patch) {
    let changed = false;
    const categories = (streamingState.state.categoriesData || []).map((category) => {
        if (String(category?.id) !== String(categoryId)) return category;
        changed = true;
        return { ...category, ...patch };
    });
    if (!changed && categoryId) {
        categories.push({ id: categoryId, ...patch });
    }
    streamingState.setState({ categoriesData: categories });
}

export function updateCategoryView(categoryId, updates, subfolder = null, mf = 'all') {
    const existing = getCategoryView(categoryId, subfolder, mf);
    if (!existing) return;
    setCategoryView(categoryId, { ...existing, ...updates }, subfolder, mf);
}

// ── Video progress operations ────────────────────────────────────────────────

export function getVideoProgress(videoUrl) {
    if (!videoUrl) return null;
    const direct = streamingState.state.videoProgressMap[videoUrl];
    if (direct) return direct;
    for (const [key, value] of Object.entries(streamingState.state.videoProgressMap)) {
        if (urlMatches(key, videoUrl)) {
            return value;
        }
    }
    return null;
}

export function setVideoProgress(videoUrl, progress) {
    const map = { ...streamingState.state.videoProgressMap };
    map[videoUrl] = progress;
    streamingState.setState({ videoProgressMap: map });
}

export function deleteVideoProgress(videoUrl) {
    if (!videoUrl) return;
    const map = { ...streamingState.state.videoProgressMap };
    let changed = false;
    Object.keys(map).forEach((key) => {
        if (urlMatches(key, videoUrl)) {
            delete map[key];
            changed = true;
        }
    });
    if (changed) streamingState.setState({ videoProgressMap: map });
}

export function clearVideoProgressMap() {
    streamingState.setState({ videoProgressMap: {} });
}

export function clearContinueWatchingData() {
    streamingState.setState({ continueWatchingData: [] });
}

export function clearWhatsNewData() {
    streamingState.setState({ whatsNewData: [] });
}

// ── URL rename helpers ───────────────────────────────────────────────────────

function buildThumbnailUrlFromVideoUrl(videoUrl) {
    if (!videoUrl || !videoUrl.startsWith('/media/')) return null;
    const parts = videoUrl.split('/');
    if (parts.length < 4) return null;
    const categoryId = parts[2];
    const filename = decodeURIComponent(parts.slice(3).join('/'));
    if (!categoryId || !filename) return null;
    const baseName = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.[^.]+$/, '')
        .replace(/[?&%#'!$"()[\]{}+=, ;]/g, '_');
    return `/thumbnails/${categoryId}/${encodeURIComponent(baseName)}.jpeg`;
}

function urlMatches(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try { if (a === encodeURI(b)) return true; } catch (e) { /* ignore */ }
    try { if (a === decodeURIComponent(b)) return true; } catch (e) { /* ignore */ }
    try { if (decodeURIComponent(a) === decodeURIComponent(b)) return true; } catch (e) { /* ignore */ }
    return false;
}

function getFilenameFromUrl(url) {
    if (!url) return null;
    const raw = String(url).split('?')[0].split('#')[0];
    const last = raw.split('/').pop();
    if (!last) return null;
    try { return decodeURIComponent(last); } catch (e) { return last; }
}

export function updateContinueWatchingVideoUrl(oldUrl, newUrl) {
    if (!oldUrl || !newUrl) return;
    const oldThumb = buildThumbnailUrlFromVideoUrl(oldUrl);
    const newThumb = buildThumbnailUrlFromVideoUrl(newUrl);
    let updated = 0;
    const data = streamingState.state.continueWatchingData.map(item => {
        if (item.videoUrl !== oldUrl) return item;
        const copy = { ...item, videoUrl: newUrl };
        if (copy.thumbnailUrl === oldUrl) copy.thumbnailUrl = newUrl;
        else if (oldThumb && newThumb && copy.thumbnailUrl === oldThumb) copy.thumbnailUrl = newThumb;
        updated++;
        return copy;
    });
    if (updated > 0) streamingState.setState({ continueWatchingData: data });
}

export function updateVideoProgressMapUrl(oldUrl, newUrl) {
    if (!oldUrl || !newUrl) return;
    const entry = streamingState.state.videoProgressMap[oldUrl];
    if (!entry) return;
    const map = { ...streamingState.state.videoProgressMap };
    map[newUrl] = entry;
    delete map[oldUrl];
    streamingState.setState({ videoProgressMap: map });
}

export function invalidateCategoryViewRecords(oldUrl, newUrl) {
    if (!oldUrl || !newUrl) return;
    const oldThumb = buildThumbnailUrlFromVideoUrl(oldUrl);
    const newThumb = buildThumbnailUrlFromVideoUrl(newUrl);
    const newFilename = getFilenameFromUrl(newUrl);

    function applyRename(item) {
        if (!urlMatches(item.url, oldUrl)) return item;
        const clone = { ...item, url: newUrl };
        if (newFilename) { clone.name = newFilename; clone.displayName = newFilename; clone.filename = newFilename; }
        if (clone.thumbnailUrl === oldUrl) clone.thumbnailUrl = newUrl;
        else if (oldThumb && newThumb && clone.thumbnailUrl === oldThumb) clone.thumbnailUrl = newThumb;
        return clone;
    }

    // Manifest/ordering invalidation is owned by MediaInvalidationModule's
    // surgical path (invalidateIds + dropIdsFromAllViews + per-category
    // refetch). Re-invalidating here would abort the in-flight refetch's
    // AbortController, leaving the row missing the renamed id until reload.

    const whatsNewData = Array.isArray(streamingState.state.whatsNewData)
        ? streamingState.state.whatsNewData.map(applyRename)
        : streamingState.state.whatsNewData;

    streamingState.setState({ whatsNewData });
}
