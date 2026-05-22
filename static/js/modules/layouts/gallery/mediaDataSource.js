/**
 * Gallery Layout - Normalized Media Bindings
 * Bridges timeline/month views to mediaOrdering and mediaManifest.
 */

import {
    setAllMediaIds,
    appendMediaIds,
    clearAllMedia,
    setCategoriesData,
    getCategoriesData,
    getMediaFilter,
    getCategoryIdFilter,
    getCategoryIdsFilter,
    getParentNameFilter,
    getMediaByDate,
    setDateTotals,
    mergeDateTotals,
    getDateTotal,
    getDatesPage,
    setDatesPage,
    getHasMoreDates,
    setHasMoreDates,
    setIsLoading,
    setAllYearsData,
    setGalleryTimelineViewKey
} from './state.js';

import { getShowHiddenHeaders } from '../../../utils/showHiddenManager.js';
import { cachedFetch } from '../../../utils/requestCache.js';
import { rememberCategoryNames } from '../../ui/categoryFilterPill.js';
import { selectRecordsForView } from '../../media/selectors.js';

function getMediaManifest() {
    return window.ragotModules?.mediaManifest || null;
}

function getMediaOrdering() {
    return window.ragotModules?.mediaOrdering || null;
}

async function requestMediaView(viewKey, viewType, params, options = {}) {
    const manifest = getMediaManifest();
    const ordering = getMediaOrdering();
    if (!manifest || !ordering) {
        return {
            viewKey,
            viewType,
            orderedIds: [],
            hasMore: false,
            pageToken: null,
            viewMeta: {},
            status: 'error',
            error: 'Media view modules are not initialized',
        };
    }
    const orderOptions = { ...options };
    // Forward external abort signal so rapid navigation cancels in-flight fetches
    if (options.signal) {
        orderOptions.signal = options.signal;
    }
    const order = await ordering.requestOrder(viewKey, viewType, {
        ...(params || {}),
        hydrate: 'true',
    }, orderOptions);
    const orderedIds = order?.orderedIds || [];
    manifest.pin(viewKey, orderedIds);
    if (options.signal?.aborted) {
        return {
            ...order,
            viewKey,
            viewType,
            orderedIds,
        };
    }
    await manifest.hydrate(orderedIds, 15000, options.signal);
    return {
        ...order,
        viewKey,
        viewType,
        orderedIds,
    };
}

/**
 * Fetch hardware tier from backend
 * Returns: 'LITE' (2GB), 'STANDARD' (4GB), or 'PRO' (8GB+)
 */
export async function fetchHardwareTier() {
    try {
        const response = await fetch('/api/storage/upload/negotiate');
        if (response.ok) {
            const data = await response.json();
            return data.hardware_tier || 'LITE';
        }
    } catch (error) {
        console.debug('[GalleryData] Failed to fetch hardware tier:', error);
    }
    return 'LITE'; // Default to base tier
}

/**
 * Fetch all categories
 * @param {boolean} forceRefresh - If true, bypass server cache
 */
export async function fetchCategories(forceRefresh = false) {
    try {
        const params = new URLSearchParams();
        if (forceRefresh) params.append('force_refresh', 'true');
        const categoryIdFilter = getCategoryIdFilter();
        const categoryIdsFilter = getCategoryIdsFilter();
        const parentNameFilter = getParentNameFilter();

        if (categoryIdFilter) {
            params.append('category_id', categoryIdFilter);
        }

        // Prioritize specific category IDs over parent name
        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        } else if (parentNameFilter) {
            params.append('parent_name', parentNameFilter);
        }

        const url = `/api/categories?${params}`;
        const response = await cachedFetch(url, {
            headers: getShowHiddenHeaders()
        });
        if (!response.ok) throw new Error('Failed to fetch categories');

        const data = await response.json();
        const categories = data.categories || [];
        setCategoriesData(categories);
        rememberCategoryNames(categories);
        return categories;
    } catch (e) {
        console.error('[GalleryLayout] Error fetching categories:', e);
        return [];
    }
}

/**
 * Fetch media grouped by date with pagination
 * @param {number} page - Page of dates to load (default 1)
 */
export async function fetchTimelineMedia(page = 1) {
    const filter = getMediaFilter();
    const categoryId = getCategoryIdFilter();
    const categoryIdsFilter = getCategoryIdsFilter();

    try {
        const params = new URLSearchParams({
            media_filter: filter,
            items_per_date: 9,
            dates_page: page,
            dates_limit: 15
        });

        if (categoryId) {
            params.append('category_id', categoryId);
        }

        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        }

        const viewKey = `gallery_timeline::${categoryId || ''}::${categoryIdsFilter?.join(',') || ''}::${filter}`;
        const pageViewKey = `${viewKey}::${page}`;
        const view = await requestMediaView(
            pageViewKey,
            'gallery_timeline',
            Object.fromEntries(params.entries())
        );
        const viewMeta = view?.viewMeta || {};
        return {
            ...view,
            viewKey,
            pageViewKey,
            records: selectRecordsForView(pageViewKey),
            orderedIds: view.orderedIds || [],
            dateTotals: viewMeta.dateTotals || {},
            hasMoreDates: viewMeta.hasMoreDates || false
        };
    } catch (e) {
        console.error('[GalleryLayout] Error fetching timeline records:', e);
        return { records: [], orderedIds: [], dateTotals: {}, hasMoreDates: false };
    }
}

/**
 * Fetch more items for a specific date
 * Used by "Show more" button per date group
 */
export async function fetchMoreForDate(dateKey, offset) {
    const filter = getMediaFilter();
    const categoryId = getCategoryIdFilter();
    const categoryIdsFilter = getCategoryIdsFilter();

    try {
        const params = new URLSearchParams({
            media_filter: filter,
            date: dateKey,
            date_offset: offset,
            items_per_date: 9
        });

        if (categoryId) {
            params.append('category_id', categoryId);
        }

        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        }

        const viewKey = `gallery_date::${categoryId || ''}::${categoryIdsFilter?.join(',') || ''}::${filter}::${dateKey}::${offset}`;
        const view = await requestMediaView(
            viewKey,
            'gallery_timeline',
            Object.fromEntries(params.entries()),
            { bypassClientCache: true }
        );
        return {
            ...view,
            records: selectRecordsForView(viewKey),
            orderedIds: view.orderedIds || [],
            hasMore: view?.hasMore || false,
            totalForDate: view?.viewMeta?.dateTotals?.[dateKey] || 0
        };
    } catch (e) {
        console.error('[GalleryLayout] Error fetching more for date:', e);
        return { records: [], orderedIds: [], hasMore: false, totalForDate: 0 };
    }
}

/**
 * Fetch all available years for timeline navigation
 * This allows the timeline to show all years even before they're paginated
 */
export async function fetchAllYears() {
    const filter = getMediaFilter();
    const categoryId = getCategoryIdFilter();
    const categoryIdsFilter = getCategoryIdsFilter();

    try {
        const params = new URLSearchParams({ filter });

        if (categoryId) {
            params.append('category_id', categoryId);
        }

        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        }

        const response = await fetch(`/api/media/timeline/years?${params}`, {
            headers: getShowHiddenHeaders()
        });

        if (!response.ok) {
            throw new Error('Failed to fetch timeline years');
        }

        const data = await response.json();
        setAllYearsData(data.years || []);
        return data.years || [];
    } catch (e) {
        console.error('[GalleryLayout] Error fetching timeline years:', e);
        return [];
    }
}

/**
 * Load initial media for gallery
 * Fetches first page of dates with limited items per date
 * @param {boolean} forceRefresh - If true, bypass server cache
 */
export async function loadInitialMedia(forceRefresh = false) {
    setIsLoading(true);
    clearAllMedia();

    try {
        await fetchCategories(forceRefresh);

        // Fetch all years for timeline navigation (parallel with media)
        const [yearsResult, mediaResult] = await Promise.all([
            fetchAllYears(),
            fetchTimelineMedia(1)
        ]);

        setGalleryTimelineViewKey(mediaResult.viewKey || null);
        setAllMediaIds(mediaResult.orderedIds || [], mediaResult);
        setDateTotals(mediaResult.dateTotals);
        setDatesPage(1);
        setHasMoreDates(mediaResult.hasMoreDates);

        return mediaResult.records;
    } catch (e) {
        console.error('[GalleryLayout] Error loading initial records:', e);
        return [];
    } finally {
        setIsLoading(false);
    }
}

/**
 * Jump to a specific date by loading the page containing that date
 * @param {string} dateKey - The date key to jump to (e.g., "2024-05-31")
 * @returns {Promise<boolean>} - True if successful
 */
export async function jumpToDate(dateKey) {
    if (!dateKey) return false;

    const filter = getMediaFilter();
    const categoryId = getCategoryIdFilter();
    const categoryIdsFilter = getCategoryIdsFilter();

    try {
        const params = new URLSearchParams({
            media_filter: filter,
            items_per_date: 9,
            jump_to_date: dateKey,
            dates_limit: 15
        });

        if (categoryId) {
            params.append('category_id', categoryId);
        }

        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        }

        const viewKey = `gallery_jump::${categoryId || ''}::${categoryIdsFilter?.join(',') || ''}::${filter}::${dateKey}`;
        const view = await requestMediaView(
            viewKey,
            'gallery_timeline',
            Object.fromEntries(params.entries())
        );
        const viewMeta = view?.viewMeta || {};
        const records = selectRecordsForView(viewKey);

        if (records && records.length > 0) {
            // Merge date totals
            mergeDateTotals(viewMeta.dateTotals || {});

            // IMPORTANT: Update datesPage to the page we just loaded
            if (viewMeta.datesPage) {
                setDatesPage(viewMeta.datesPage);
            }

            appendMediaIds(view.orderedIds || []);
            setHasMoreDates(viewMeta.hasMoreDates || false);

            return true;
        }

        return false;
    } catch (e) {
        console.error('[GalleryLayout] Error jumping to date:', e);
        return false;
    }
}

/**
 * Jump to a specific year by loading pages until we have data for that year
 * @param {number} targetYear - The year to jump to (e.g., 2022)
 * @returns {Promise<string|null>} - The first date key found for that year, or null
 */
export async function jumpToYear(targetYear) {
    const mediaByDate = getMediaByDate();
    const yearPrefix = `${targetYear}-`;

    // Check if we already have data for this year
    const existingDate = Object.keys(mediaByDate).find(d => d.startsWith(yearPrefix));
    if (existingDate) {
        return existingDate;
    }

    // Need to load more pages until we find this year
    // Force load even if hasMoreDates is false - the API might have more data
    let maxAttempts = 50; // Increased limit for large libraries
    let dateCursorPage = getDatesPage();

    while (maxAttempts > 0) {
        // Force fetch next page directly (bypass hasMoreDates check)
        dateCursorPage++;
        const result = await fetchTimelineMedia(dateCursorPage);

        if (result.records.length === 0) {
            // No more data from server
            break;
        }

        mergeDateTotals(result.dateTotals);
        setDatesPage(dateCursorPage);
        appendMediaIds(result.orderedIds || []);
        setHasMoreDates(result.hasMoreDates);

        // Check if we now have data for the target year
        const newMediaByDate = getMediaByDate();
        const foundDate = Object.keys(newMediaByDate).find(d => d.startsWith(yearPrefix));
        if (foundDate) {
            return foundDate;
        }

        // Check if we've gone past the target year (dates are sorted newest first)
        const allDates = Object.keys(newMediaByDate).sort();
        const oldestLoadedDate = allDates[0];
        if (oldestLoadedDate && parseInt(oldestLoadedDate.split('-')[0]) < targetYear) {
            // We've loaded past this year, it doesn't exist
            return null;
        }

        // Stop if server says no more
        if (!result.hasMoreDates) {
            break;
        }

        maxAttempts--;
    }

    return null;
}

/**
 * Load more dates (next page of dates)
 * Called by "Load more" button at bottom
 */
export async function loadMoreDates() {
    if (!getHasMoreDates()) return { records: [], hasMore: false };

    const nextPage = getDatesPage() + 1;
    try {
        const result = await fetchTimelineMedia(nextPage);

        if (result.records && result.records.length > 0) {
            // Merge date totals (preserves existing totals)
            mergeDateTotals(result.dateTotals);

            setDatesPage(nextPage);
            appendMediaIds(result.orderedIds || []);
            setHasMoreDates(result.hasMoreDates);
        } else {
            // Only set to false if the server explicitly says no more or we reached the end
            // Otherwise we might want to allow a retry
            setHasMoreDates(result.hasMoreDates || false);
        }

        return {
            records: result.records,
            orderedIds: result.orderedIds || [],
            hasMore: result.hasMoreDates
        };
    } catch (e) {
        console.error('[GalleryLayout] Error loading more dates:', e);
        return { records: [], orderedIds: [], hasMore: false };
    }
}

/**
 * Load more items for a specific date
 * Called by "Show more" button per date group
 */
export async function loadMoreForDate(dateKey) {
    const mediaByDate = getMediaByDate();
    const currentItems = mediaByDate[dateKey] || [];
    const offset = currentItems.length;

    try {
        const result = await fetchMoreForDate(dateKey, offset);

        if (result.records.length > 0) {
            // Avoid duplicates by checking existing URLs
            const existingUrls = new Set(currentItems.map(m => m.url));
            const newMedia = result.records.filter(m => !existingUrls.has(m.url));

            if (newMedia.length > 0) {
                appendMediaIds((result.orderedIds || []).filter((id) => id));
            }
        }

        return {
            records: result.records,
            orderedIds: result.orderedIds || [],
            hasMore: result.hasMore
        };
    } catch (e) {
        console.error('[GalleryLayout] Error loading more for date:', e);
        return { records: [], orderedIds: [], hasMore: false };
    }
}

/**
 * Fetch all media for a specific year/month (used by the month overlay).
 * @param {number} year
 * @param {number} month - 1-12
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{records: Array, dateTotals: Object, error: string|null, aborted?: boolean}>}
 */
export async function fetchMonthMedia(year, month, options = {}) {
    const filter = getMediaFilter();
    const categoryId = getCategoryIdFilter();
    const categoryIdsFilter = getCategoryIdsFilter();
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    try {
        const params = new URLSearchParams({
            media_filter: filter,
            month_filter: monthStr,
            items_per_date: 300,
            dates_limit: 31,
            dates_page: 1,
        });

        if (categoryId) params.append('category_id', categoryId);
        if (categoryIdsFilter && categoryIdsFilter.length > 0) {
            params.append('category_ids', categoryIdsFilter.join(','));
        }

        const viewKey = `gallery_month::${categoryId || ''}::${categoryIdsFilter?.join(',') || ''}::${filter}::${monthStr}`;
        const requestOptions = { bypassClientCache: true };
        if (options.signal) requestOptions.signal = options.signal;
        const view = await requestMediaView(
            viewKey,
            'gallery_month',
            Object.fromEntries(params.entries()),
            requestOptions
        );
        if (options.signal?.aborted) {
            return { records: [], orderedIds: [], dateTotals: {}, error: null, aborted: true };
        }
        return {
            ...view,
            records: selectRecordsForView(viewKey),
            orderedIds: view.orderedIds || [],
            dateTotals: view?.viewMeta?.dateTotals || {},
            error: view?.status === 'error' ? `Couldn't load ${monthStr}. Please try again.` : null
        };
    } catch (e) {
        if (e?.name === 'AbortError') {
            return { records: [], orderedIds: [], dateTotals: {}, error: null, aborted: true };
        }
        console.error('[GalleryData] Error fetching month records:', e);
        return {
            records: [],
            orderedIds: [],
            dateTotals: {},
            error: `Couldn't load ${monthStr}. Please try again.`
        };
    }
}
