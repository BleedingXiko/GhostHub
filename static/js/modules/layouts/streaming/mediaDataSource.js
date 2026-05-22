/**
 * Streaming Layout - Normalized Media Bindings
 * Bridges category/order requests to mediaOrdering and mediaManifest.
 */

import {
    getLocalProgress
} from '../../../utils/progressDB.js';
import { hasActiveProfile } from '../../../utils/profileUtils.js';

import { getShowHiddenHeaders, appendShowHiddenParam } from '../../../utils/showHiddenManager.js';
import { cachedFetch } from '../../../utils/requestCache.js';

import {
    fetchVideoProgressData,
    ensureProgressDBReady as ensureDBReady
} from '../../../utils/layoutUtils.js';
import { isPendingDeletion } from '../../media/progressPersistence.js';
import { rememberCategoryNames } from '../../ui/categoryFilterPill.js';
import { selectRecordsForView } from '../../media/selectors.js';

import {
    MEDIA_PER_PAGE,
    getCategoriesData,
    setCategoriesData,
    getCategoryView,
    setCategoryView,
    clearCategoryViews,
    pruneCategoryViews,
    setContinueWatchingData,
    setWhatsNewData,
    setWhatsNewViewKey,
    updateCategoryView,
    getMediaFilter,
    getCategoryIdFilter,
    getSubfolderFilter,
    getParentNameFilter,
    getCategoryIdsFilter,
    getActivePage,
    getLimit,
    setTotal,
    setTotalPages,
    setHasMore,
    setGridTotalItems,
    setVideoProgressMap,
    setContinueWatchingLoading,
    setWhatsNewLoading
} from './state.js';

// ── Thumbnail prewarm ────────────────────────────────────────────────────────

const prewarmedThumbnails = new Set();

function queueThumbnailPrewarm(mediaItems, limit = 8) {
    if (!Array.isArray(mediaItems) || mediaItems.length === 0) return;
    const candidates = mediaItems
        .filter(item => item && (item.thumbnailUrl || item.url))
        .slice(0, limit)
        .map(item => item.thumbnailUrl || item.url)
        .filter(url => typeof url === 'string' && url.includes('/thumbnails/'))
        .filter(Boolean);
    if (candidates.length === 0) return;
    const run = () => {
        candidates.forEach(url => {
            const finalUrl = appendShowHiddenParam(url);
            if (!finalUrl || prewarmedThumbnails.has(finalUrl)) return;
            prewarmedThumbnails.add(finalUrl);
            const img = new Image();
            img.decoding = 'async';
            img.fetchPriority = 'low';
            img.src = finalUrl;
        });
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 2000 });
    } else {
        setTimeout(run, 0);
    }
}

// ── API calls ────────────────────────────────────────────────────────────────

function getMediaManifest() {
    return window.ragotModules?.mediaManifest || null;
}

function getMediaOrdering() {
    return window.ragotModules?.mediaOrdering || null;
}

/**
 * Fetch categories from API.
 */
export async function fetchCategories(
    forceRefresh = false,
    { bypassClientCache = false, pruneMissingCategories = false, signal = null } = {}
) {
    const params = new URLSearchParams();
    const categoryIdFilter = getCategoryIdFilter();
    const parentNameFilter = getParentNameFilter();
    const categoryIdsFilter = getCategoryIdsFilter();
    const mediaFilter = getMediaFilter();
    const activePage = getActivePage();
    const limit = getLimit();

    params.append('page', activePage);
    params.append('limit', limit);

    if (mediaFilter && mediaFilter !== 'all') params.append('filter', mediaFilter);
    if (forceRefresh) params.append('force_refresh', 'true');
    if (categoryIdFilter) params.append('category_id', categoryIdFilter);
    if (categoryIdsFilter && categoryIdsFilter.length > 0) {
        params.append('category_ids', categoryIdsFilter.join(','));
    } else if (parentNameFilter) {
        params.append('parent_name', parentNameFilter);
    }

    const url = `/api/categories?${params.toString()}`;
    const skipClientCache = forceRefresh || bypassClientCache;
    const response = skipClientCache
        ? await fetch(url, { headers: getShowHiddenHeaders(), cache: 'no-store', signal })
        : await cachedFetch(url, { headers: getShowHiddenHeaders(), signal });

    if (!response.ok) throw new Error('Failed to fetch categories');

    const data = await response.json();
    if (signal?.aborted) return [];
    const categories = data.categories || [];

    if (data.pagination) {
        setTotal(data.pagination.total || 0);
        setTotalPages(data.pagination.totalPages || 1);
        setHasMore(data.pagination.hasMore || false);
    }

    setCategoriesData(categories);
    rememberCategoryNames(categories);
    if (pruneMissingCategories) {
        pruneCategoryViews(categories.map((category) => category?.id).filter(Boolean));
    }
    return categories;
}

/**
 * Fetch media items for a single category.
 */
export async function fetchCategoryMedia(
    categoryId,
    page = 1,
    forceRefresh = false,
    subfolder = null,
    { includeTotal = false, limit: customLimit, signal = null, bypassClientCache = false } = {}
) {
    try {
        const effectiveLimit = customLimit || MEDIA_PER_PAGE;
        const manifest = getMediaManifest();
        const ordering = getMediaOrdering();
        if (!manifest || !ordering) {
            return { orderedIds: [], viewKey: null, hasMore: false, total: null, subfolders: [], asyncIndexing: false, indexingProgress: 0 };
        }

        const mediaFilter = getMediaFilter();
        const viewType = subfolder ? 'subfolder_grid' : 'streaming_row';
        const viewKey = `${viewType}::${categoryId}::${subfolder || ''}::${mediaFilter}::${effectiveLimit}`;
        const params = {
            category_id: categoryId,
            page,
            limit: effectiveLimit,
            include_total: includeTotal ? 'true' : 'false',
            media_filter: mediaFilter || 'all',
            force_refresh: forceRefresh ? 'true' : 'false',
            hydrate: 'true',
        };
        if (subfolder) params.subfolder = subfolder;

        const order = await ordering.requestOrder(viewKey, viewType, params, {
            bypassClientCache: forceRefresh || bypassClientCache,
        });
        if (signal?.aborted) return { orderedIds: [], viewKey: null, hasMore: false, total: null, subfolders: [], asyncIndexing: false, indexingProgress: 0 };

        const orderedIds = order?.orderedIds || [];
        manifest.pin(viewKey, orderedIds);
        await manifest.hydrate(orderedIds);
        if (signal?.aborted) return { orderedIds: [], viewKey: null, hasMore: false, total: null, subfolders: [], asyncIndexing: false, indexingProgress: 0 };

        const records = selectRecordsForView(viewKey);
        const viewMeta = order?.viewMeta || {};
        const hasMore = order?.hasMore === true;
        const total = viewMeta.total ?? null;
        const subfolders = viewMeta['subfolders'] || [];

        queueThumbnailPrewarm(records, 8);
        return {
            orderedIds,
            viewKey,
            hasMore,
            subfolders,
            total,
            asyncIndexing: viewMeta.asyncIndexing === true,
            indexingProgress: viewMeta.indexingProgress ?? 100,
            status: order?.status || 'ready',
        };
    } catch (e) {
        console.error(`[StreamingLayout] Error fetching media for ${categoryId}:`, e);
        return { orderedIds: [], viewKey: null, hasMore: false, subfolders: [], total: null, asyncIndexing: false, indexingProgress: 0, status: 'error' };
    }
}

function buildCategoryMediaRequest(
    categoryId,
    page = 1,
    forceRefresh = false,
    subfolder = null,
    { includeTotal = false, limit: customLimit } = {}
) {
    const effectiveLimit = customLimit || MEDIA_PER_PAGE;
    const mediaFilter = getMediaFilter();
    const viewType = subfolder ? 'subfolder_grid' : 'streaming_row';
    const viewKey = viewType + '::' + categoryId + '::' + (subfolder || '') + '::' + mediaFilter + '::' + effectiveLimit;
    const params = {
        view: viewType,
        viewKey,
        category_id: categoryId,
        page,
        limit: effectiveLimit,
        include_total: includeTotal ? 'true' : 'false',
        media_filter: mediaFilter || 'all',
        force_refresh: forceRefresh ? 'true' : 'false',
        hydrate: 'true',
    };
    if (subfolder) params.subfolder = subfolder;
    return { categoryId, subfolder, mediaFilter, viewType, viewKey, params };
}

export async function fetchCategoryMediaBatch(requests, { signal = null, bypassClientCache = false } = {}) {
    const manifest = getMediaManifest();
    const ordering = getMediaOrdering();
    if (!manifest || !ordering || !Array.isArray(requests) || requests.length === 0) return [];

    const response = await fetch('/api/media/orders', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getShowHiddenHeaders(),
        },
        cache: bypassClientCache ? 'no-store' : 'default',
        signal,
        body: JSON.stringify({ requests: requests.map((request) => request.params) }),
    });
    if (!response.ok) throw new Error('Failed to fetch media orders (' + response.status + ')');

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return requests.map((request, index) => {
        const result = results[index] || {};
        if (result.status === 'error') {
            console.warn('[StreamingLayout] Media order batch item failed:', {
                viewKey: result.viewKey || request.viewKey,
                error: result.error || 'unknown error'
            });
            return {
                orderedIds: [],
                viewKey: result.viewKey || request.viewKey,
                hasMore: false,
                subfolders: [],
                total: null,
                asyncIndexing: false,
                indexingProgress: 0,
                status: 'error',
                error: result.error || 'Media order failed',
            };
        }
        const orderedIds = Array.isArray(result.orderedIds) ? result.orderedIds : [];
        const viewKey = result.viewKey || request.viewKey;
        manifest.ingest(result.records || {}, result.missing || []);
        manifest.pin(viewKey, orderedIds);
        ordering.ingestView(viewKey, {
            viewType: request.viewType,
            orderedIds,
            hasMore: result.hasMore === true,
            pageToken: result.pageToken || null,
            viewMeta: result.viewMeta || {},
            status: result.status || 'ready',
            error: result.error || null,
            params: request.params,
        });
        const records = selectRecordsForView(viewKey);
        queueThumbnailPrewarm(records, 8);
        const viewMeta = result.viewMeta || {};
        return {
            orderedIds,
            viewKey,
            hasMore: result.hasMore === true,
            subfolders: viewMeta.subfolders || [],
            total: viewMeta.total ?? null,
            asyncIndexing: viewMeta.asyncIndexing === true,
            indexingProgress: viewMeta.indexingProgress ?? 100,
            status: result.status || 'ready',
            error: result.error || null,
        };
    });
}

/**
 * Fetch all category media for the current page.
 */
export async function fetchAllCategoryMedia(forceRefresh = false, onCategoryLoaded = null, { signal = null, bypassClientCache = false } = {}) {
    if (forceRefresh) clearCategoryViews();
    if (signal?.aborted) return;

    const categories = getCategoriesData();
    if (!categories || categories.length === 0) return;

    const isSingleCategoryView = getCategoryIdFilter() !== null || getSubfolderFilter() !== null;
    const gridChunkSize = 30;
    const subfolderFilter = getSubfolderFilter();
    const categoryFilter = getCategoryIdFilter();
    const mediaFilter = getMediaFilter();

    const requests = categories.map((category) => {
        const activeSubfolder = (subfolderFilter && categoryFilter === category.id) ? subfolderFilter : null;
        const fetchOptions = (isSingleCategoryView && categories.length === 1)
            ? { includeTotal: true, limit: gridChunkSize }
            : {};
        return {
            category,
            activeSubfolder,
            request: buildCategoryMediaRequest(category.id, 1, forceRefresh, activeSubfolder, fetchOptions),
        };
    });

    let batchResults = [];
    try {
        batchResults = await fetchCategoryMediaBatch(
            requests.map((item) => item.request),
            { signal, bypassClientCache: forceRefresh || bypassClientCache }
        );
    } catch (e) {
        console.warn('[StreamingLayout] Failed to fetch batched category media:', e);
    }
    if (signal?.aborted) return;

    requests.forEach((item, index) => {
        const { category, activeSubfolder } = item;
        const result = batchResults[index] || {
            viewKey: null,
            hasMore: false,
            status: 'error',
            subfolders: [],
            asyncIndexing: false,
            indexingProgress: 0,
            total: null,
        };

        if (result.status === 'error') {
            const existing = getCategoryView(category.id, activeSubfolder, mediaFilter);
            if (!existing) {
                console.warn('[StreamingLayout] Category media load failed with no cached view:', {
                    categoryId: category.id,
                    subfolder: activeSubfolder || null,
                    error: result.error || 'unknown error'
                });
            }
            if (typeof onCategoryLoaded === 'function') {
                try { onCategoryLoaded(category, index + 1, categories.length); } catch (_) { /* ignore */ }
            }
            return;
        }

        if (isSingleCategoryView && result.total !== null && result.total !== undefined) {
            setGridTotalItems(result.total);
        }
        setCategoryView(category.id, {
            viewKey: result.viewKey || null,
            page: 1,
            hasMore: result.hasMore,
            status: result.status || 'ready',
            subfolders: result.subfolders || [],
            asyncIndexing: result.asyncIndexing === true,
            indexingProgress: result.indexingProgress || 0
        }, activeSubfolder, mediaFilter);

        if (typeof onCategoryLoaded === 'function') {
            try { onCategoryLoaded(category, index + 1, categories.length); } catch (_) { /* ignore */ }
        }
    });
}


export function primeCategoryLoadingShells({ replaceExisting = false } = {}) {
    const categories = getCategoriesData() || [];
    if (categories.length === 0) return;

    const categoryFilter = getCategoryIdFilter();
    const subfolderFilter = getSubfolderFilter();
    const mediaFilter = getMediaFilter();

    categories.forEach((category) => {
        if (!category?.id) return;
        const activeSubfolder = (subfolderFilter && categoryFilter === category.id) ? subfolderFilter : null;
        const existing = getCategoryView(category.id, activeSubfolder, mediaFilter)
            || (mediaFilter && mediaFilter !== 'all' ? getCategoryView(category.id, activeSubfolder, 'all') : null);

        if (!replaceExisting && existing) return;

        setCategoryView(category.id, {
            viewKey: null,
            page: 1,
            hasMore: false,
            status: 'fetching',
            subfolders: [],
            asyncIndexing: false,
            indexingProgress: 0
        }, activeSubfolder, mediaFilter);
    });
}

/**
 * Load more media for a category (pagination / horizontal VS).
 */
export async function loadMoreMedia(categoryId) {
    const subfolderFilter = getSubfolderFilter();
    const categoryFilter = getCategoryIdFilter();
    const activeSubfolder = (subfolderFilter && categoryFilter === categoryId) ? subfolderFilter : null;
    const mediaFilter = getMediaFilter();
    const cache = getCategoryView(categoryId, activeSubfolder, mediaFilter)
        || (mediaFilter && mediaFilter !== 'all' ? getCategoryView(categoryId, activeSubfolder, 'all') : null);
    if (!cache || cache.status === 'fetching' || !cache.hasMore) return [];

    updateCategoryView(categoryId, { status: 'fetching' }, activeSubfolder, mediaFilter);
    try {
        const nextPage = cache.page + 1;
        const result = await fetchCategoryMedia(categoryId, nextPage, false, activeSubfolder);
        if (result.orderedIds.length > 0) {
            updateCategoryView(categoryId, {
                viewKey: result.viewKey || cache.viewKey || null,
                page: nextPage,
                hasMore: result.hasMore,
                status: 'ready',
                asyncIndexing: result.asyncIndexing === true,
                indexingProgress: result.indexingProgress || 0
            }, activeSubfolder, mediaFilter);
            return selectRecordsForView(result.viewKey);
        } else {
            updateCategoryView(categoryId, {
                hasMore: false,
                status: 'ready',
                asyncIndexing: result.asyncIndexing === true,
                indexingProgress: result.indexingProgress || 0
            }, activeSubfolder, mediaFilter);
            return [];
        }
    } catch (e) {
        console.error(`[StreamingLayout] Error loading more media for ${categoryId}:`, e);
        updateCategoryView(categoryId, { status: 'error' }, activeSubfolder, mediaFilter);
        return [];
    }
}

/**
 * Build continue watching data from video progress.
 */
export async function buildContinueWatchingData(forceRefresh = false) {
    setContinueWatchingLoading(true);

    try {
        const videos = await fetchVideoProgressData(50, forceRefresh);
        const categories = getCategoriesData();
        const categoryNameById = new Map(categories.map(c => [c.id, c.name]));
        const continueWatchingMap = new Map();
        const nextVideoProgressMap = {};

        const normalizeVideoUrl = (url) => {
            if (!url) return '';
            try {
                url = decodeURIComponent(url);
            } catch (_) { /* ignore */ }
            return String(url).split('#')[0].split('?')[0];
        };

        for (const v of videos) {
            const videoUrl = v.video_url || v.video_path;
            const timestamp = v.video_timestamp;
            if (!videoUrl || !timestamp || timestamp <= 0) continue;
            // Skip videos that were just marked completed (race-condition guard)
            if (isPendingDeletion(videoUrl)) continue;
            const lastWatched = v.last_watched || v.last_updated || 0;
            const entry = {
                videoUrl,
                categoryId: v.category_id,
                categoryName: categoryNameById.get(v.category_id) || 'Unknown',
                thumbnailUrl: v.thumbnail_url,
                videoTimestamp: timestamp,
                videoDuration: v.video_duration || 0,
                lastWatched
            };
            const normalizedUrl = normalizeVideoUrl(videoUrl) || videoUrl;
            const existing = continueWatchingMap.get(normalizedUrl);
            if (!existing || Number(existing.lastWatched || 0) <= Number(lastWatched || 0)) {
                continueWatchingMap.set(normalizedUrl, entry);
            }
            nextVideoProgressMap[normalizedUrl] = {
                video_timestamp: timestamp,
                video_duration: v.video_duration || 0
            };
        }

        const continueWatching = [...continueWatchingMap.values()];
        continueWatching.sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0));
        setVideoProgressMap(nextVideoProgressMap);
        setContinueWatchingData(continueWatching);
        return continueWatching;
    } catch (error) {
        console.error('[StreamingLayout] Error building Continue Watching data:', error);
        return [];
    } finally {
        setContinueWatchingLoading(false);
    }
}

/**
 * Get progress for a category from the correct source.
 */
export function getCategoryProgress(category) {
    let savedIndex = category.saved_index;
    let videoTimestamp = category.video_timestamp || 0;
    let videoDuration = category.video_duration || 0;
    let thumbnailUrl = category.thumbnailUrl;

    if (!hasActiveProfile()) {
        const localProgress = getLocalProgress(category.id);
        if (localProgress) {
            savedIndex = localProgress.index;
            videoTimestamp = localProgress.video_timestamp || 0;
            videoDuration = localProgress.video_duration || 0;
            if (localProgress.thumbnail_url) thumbnailUrl = localProgress.thumbnail_url;
        } else {
            savedIndex = null;
            videoTimestamp = 0;
            videoDuration = 0;
        }
    }

    return { savedIndex, videoTimestamp, videoDuration, thumbnailUrl };
}

export async function ensureProgressDBReady() {
    await ensureDBReady();
}

/**
 * Fetch newest media across all categories.
 */
export async function fetchNewestMedia(limit = 10, forceRefresh = false) {
    setWhatsNewLoading(true);
    try {
        const manifest = getMediaManifest();
        const ordering = getMediaOrdering();
        if (!manifest || !ordering) {
            setWhatsNewViewKey(null);
            setWhatsNewData([]);
            return [];
        }

        const mediaFilter = getMediaFilter();
        const viewKey = `whats_new::${mediaFilter || 'all'}::${limit}`;
        const order = await ordering.requestOrder(viewKey, 'whats_new', {
            limit,
            media_filter: mediaFilter || 'all',
            hydrate: 'true',
        }, {
            bypassClientCache: forceRefresh,
        });
        const orderedIds = order?.orderedIds || [];
        manifest.pin(viewKey, orderedIds);
        await manifest.hydrate(orderedIds);
        const media = selectRecordsForView(viewKey);
        setWhatsNewViewKey(viewKey);
        setWhatsNewData(media);
        return media;
    } catch (e) {
        console.error('[StreamingLayout] Error fetching newest media:', e);
        return [];
    } finally {
        setWhatsNewLoading(false);
    }
}

export function getLoadedCategoryCount() {
    return getCategoriesData().length;
}
