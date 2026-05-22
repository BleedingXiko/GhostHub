/**
 * Subfolder Instant Navigation — instant drill-down into category subfolders
 *
 * Handles the transition to a single-category grid view when navigating
 * into a subfolder, with placeholder-then-fetch UX pattern.
 */

import {
    isActive,
    getCategoriesData,
    getCategoryView,
    setCategoryView,
    setGridTotalItems,
    streamingState
} from './state.js';
import { fetchCategoryMedia } from './mediaDataSource.js';
import { refreshLazyLoader } from './lazyLoad.js';
import { resolveCategoryName, updateCategoryFilterPill } from '../../ui/categoryFilterPill.js';
import { withOptionalViewTransition } from '../../../utils/viewTransitions.js';

export function formatSubfolderPillName(subfolder, fallbackName = null) {
    if (!subfolder) return fallbackName;
    const leaf = subfolder.split('/').pop();
    if (!leaf) return fallbackName;
    return leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @param {Object} deps
 * @param {Function} deps.getModule — returns the StreamingLayoutModule singleton
 * @param {Function} deps.getAbortController — returns current _loadAbortController
 * @param {Function} deps.setAbortController — sets _loadAbortController
 * @param {Function} deps.cancelPendingRefresh — socketHandlerManager.cancelPendingRefresh
 * @param {Function} deps.transitionToSingleCategoryGrid — from index.js
 * @returns {{ navigateToSubfolderInstant: Function, formatSubfolderPillName: Function }}
 */
export function createSubfolderNavigation({ getModule, getAbortController, setAbortController, cancelPendingRefresh, transitionToSingleCategoryGrid }) {

    async function navigateToSubfolderInstant(categoryId, subfolder, categoryName = null) {
        if (!isActive() || !categoryId || !subfolder) return;
        
        const oldCtrl = getAbortController();
        if (oldCtrl) { oldCtrl.abort(); }
        
        const newCtrl = new AbortController();
        setAbortController(newCtrl);
        cancelPendingRefresh();

        const existingCategories = getCategoriesData() || [];
        const resolvedName = resolveCategoryName(categoryId, existingCategories, categoryName);
        const fallbackCategory = { id: categoryId, name: resolvedName || formatSubfolderPillName(subfolder, 'Subfolder') };
        const category = existingCategories.find((item) => item?.id === categoryId) || fallbackCategory;
        const mediaFilter = 'all';

        const mod = getModule();
        const container = document.getElementById('streaming-container');

        streamingState.setState({ isLoading: true });

        try {
            const result = await fetchCategoryMedia(categoryId, 1, false, subfolder, {
                includeTotal: true, limit: 30, bypassClientCache: true, signal: newCtrl.signal
            });

            if (newCtrl.signal.aborted || getAbortController() !== newCtrl) {
                return;
            }

            const nextCache = {
                viewKey: result.viewKey || null,
                page: 1,
                hasMore: result.hasMore || false,
                status: result.status || 'ready',
                subfolders: result.subfolders || []
            };

            if (result.total !== null && result.total !== undefined) {
                setGridTotalItems(result.total);
            }
            setCategoryView(categoryId, nextCache, subfolder, mediaFilter);

            const transition = withOptionalViewTransition(() => {
                mod.unmountRows();
                mod.mountGrid(category, getCategoryView(categoryId, subfolder, mediaFilter) || nextCache);

                streamingState.batchState((s) => {
                    s.activePage = 1;
                    s.categoryIdFilter = categoryId;
                    s.categoryNameFilter = resolvedName;
                    s.subfolderFilter = subfolder;
                    s.parentNameFilter = null;
                    s.categoryIdsFilter = null;
                    s.mediaFilter = mediaFilter;
                    s.categoriesData = [category];
                    s.gridTotalItems = result.total || 0;
                });
                updateCategoryFilterPill(formatSubfolderPillName(subfolder, resolvedName));

                const existingPagination = document.querySelector('#streaming-container .pagination-container');
                if (existingPagination) existingPagination.remove();

                if (container) {
                    container.scrollTo({ top: 0, behavior: 'instant' });
                }
            }, { fallbackClass: 'gh-transition-surface' });

            requestAnimationFrame(() => refreshLazyLoader());

        } catch (error) {
            if (newCtrl.signal.aborted || getAbortController() !== newCtrl) {
                return;
            }
            console.error('[StreamingLayout] navigateToSubfolderInstant error:', error);
            
            const errorCache = { viewKey: null, page: 1, hasMore: false, status: 'error', subfolders: [] };
            setCategoryView(categoryId, errorCache, subfolder, mediaFilter);

            const transition = withOptionalViewTransition(() => {
                mod.unmountRows();
                mod.mountGrid(category, getCategoryView(categoryId, subfolder, mediaFilter) || errorCache);

                streamingState.batchState((s) => {
                    s.activePage = 1;
                    s.categoryIdFilter = categoryId;
                    s.categoryNameFilter = resolvedName;
                    s.subfolderFilter = subfolder;
                    s.parentNameFilter = null;
                    s.categoryIdsFilter = null;
                    s.mediaFilter = mediaFilter;
                    s.categoriesData = [category];
                    s.gridTotalItems = 0;
                });
                updateCategoryFilterPill(formatSubfolderPillName(subfolder, resolvedName));

                if (container) {
                    container.scrollTo({ top: 0, behavior: 'instant' });
                }
            }, { fallbackClass: 'gh-transition-surface' });
        } finally {
            if (getAbortController() === newCtrl) {
                streamingState.setState({ isLoading: false });
            }
        }
    }

    return { navigateToSubfolderInstant, formatSubfolderPillName };
}
