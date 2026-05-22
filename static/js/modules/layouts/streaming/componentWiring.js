/**
 * Component Wiring — setup and event listeners for Streaming Layout Components
 *
 * Extracts heavy setup blocks (mountComponents, wireEvents) from index.js
 * to keep the coordinator module focused and clean.
 */

import { StreamingHeroComponent } from './hero.js';
import { StreamingFilterBarComponent } from './renderer.js';
import {
    streamingState,
    setMediaFilter,
    setActivePage,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter,
    getCategoriesData,
    isActive
} from './state.js';
import { updateCategoryFilterPill, resolveCategoryName } from '../../ui/categoryFilterPill.js';
import { buildContinueWatchingData } from './mediaDataSource.js';
import { APP_EVENTS } from '../../../core/appEvents.js';
import { createElement, append, clear, $, $$ } from '../../../libs/ragot.esm.min.js';
import { createLayoutFilterActions } from '../shared/filterActions.js';

/**
 * Mount and subscribe the Hero component.
 */
export function setupHeroComponent(layoutModule, heroSlot) {
    layoutModule._heroComp = new StreamingHeroComponent();
    layoutModule.adoptComponent(layoutModule._heroComp, {
        startMethod: 'mount', stopMethod: 'unmount', startArgs: [heroSlot]
    });
    streamingState.subscribe((_slice, s) => {
        layoutModule._heroComp.setState({
            continueWatchingData: s.continueWatchingData || [],
            categoriesData: s.categoriesData || []
        });
    }, {
        owner: layoutModule, immediate: true,
        selector: (s) => {
            const cw = s.continueWatchingData;
            if (cw && cw.length > 0) {
                const item = cw[0];
                return `cw|${item.videoUrl}|${item.videoTimestamp}|${item.videoDuration}`;
            }
            const cats = s.categoriesData;
            if (cats && cats.length > 0) {
                const fc = cats[0];
                return `cat|${fc.id}|${fc.thumbnailUrl || fc.thumbnail || ''}`;
            }
            return 'empty';
        }
    });
}

/**
 * Mount, subscribe, and wire click handlers for the Filter Bar component.
 */
export function setupFilterBarComponent(layoutModule, filterSlot, loadAndRender) {
    layoutModule._filterBarComp = new StreamingFilterBarComponent();
    layoutModule.adoptComponent(layoutModule._filterBarComp, {
        startMethod: 'mount', stopMethod: 'unmount', startArgs: [filterSlot]
    });
    streamingState.subscribe((_slice, s) => {
        layoutModule._filterBarComp.setState({
            mediaFilter: s.mediaFilter,
            categoryIdFilter: s.categoryIdFilter,
            subfolderFilter: s.subfolderFilter,
            parentNameFilter: s.parentNameFilter,
            categoryNameFilter: s.categoryNameFilter
        });
    }, {
        owner: layoutModule, immediate: true,
        selector: (s) =>
            `${s.mediaFilter}|${s.categoryIdFilter}|${s.subfolderFilter}|${s.parentNameFilter}|${s.categoryNameFilter}|${s.categoryIdsFilter}`
    });
    layoutModule._filterBarComp.setFilterClickHandler((filter) => {
        const activeFilter = streamingState.state.mediaFilter;
        const hasAnyNavFilter = streamingState.state.categoryIdFilter !== null ||
            streamingState.state.parentNameFilter !== null ||
            streamingState.state.subfolderFilter !== null;
        if (filter !== activeFilter || hasAnyNavFilter) {
            setMediaFilter(filter);
            setActivePage(1);
            setCategoryIdFilter(null);
            setCategoryNameFilter(null);
            setSubfolderFilter(null);
            setParentNameFilter(null);
            setCategoryIdsFilter(null);
            updateCategoryFilterPill(null);
            loadAndRender();
        }
    });
}

/**
 * Setup layout-level event listeners.
 */
export function setupEventListeners(layoutModule, { loadAndRender, _handleProgressUpdate, _handlePaginationClick }) {
    layoutModule.on(document, 'categoriesLoaded', async () => {
        if (!isActive()) return;
        await loadAndRender(false, { refreshContinueWatching: false, refreshWhatsNew: false });
    });

    layoutModule.listen(APP_EVENTS.SHOW_HIDDEN_TOGGLED, async () => {
        if (!isActive()) return;
        await loadAndRender(false, { refreshCategoryList: true, bypassMediaClientCache: true });
    });

    layoutModule.on(document, 'progressUpdated', () => {
        if (!isActive()) return;
        buildContinueWatchingData().catch(() => { });
    });

    layoutModule.listen(APP_EVENTS.LOCAL_PROGRESS_UPDATE, (detail) => {
        if (!isActive() || !detail) return;
        _handleProgressUpdate({ ...detail, __localProgress: true });
    });

    layoutModule.listen(APP_EVENTS.FILE_RENAMED_UPDATED, (detail) => {
        if (!isActive()) return;
        const { oldPath, newPath } = detail || {};
        if (!oldPath || !newPath) return;
        import('./state.js').then(({ updateContinueWatchingVideoUrl, updateVideoProgressMapUrl, invalidateCategoryViewRecords }) => {
            updateContinueWatchingVideoUrl(oldPath, newPath);
            updateVideoProgressMapUrl(oldPath, newPath);
            invalidateCategoryViewRecords(oldPath, newPath);
        }).catch(() => { });

        $$('.streaming-card[data-media-url]').forEach((card) => {
            const cardUrl = card.dataset.mediaUrl;
            if (!cardUrl) return;
            let decoded = null;
            try { decoded = decodeURIComponent(cardUrl); } catch (_) { decoded = cardUrl; }
            if (cardUrl === oldPath || cardUrl === encodeURI(oldPath) || decoded === oldPath) {
                card.dataset.mediaUrl = newPath;
                // Stale recordId — full VS rebuild will repopulate it. Clear
                // so a click in the brief window before rebuild falls back
                // to URL matching against the freshly-fetched orderedIds.
                card.dataset.recordId = '';
                const newFilename = newPath.split('/').pop();
                const newTitle = newFilename ? newFilename.replace(/\.[^/.]+$/, '') : '';
                if (newTitle) {
                    const titleEl = $('.streaming-card-title', card);
                    if (titleEl) { titleEl.textContent = newTitle; titleEl.title = newTitle; }
                }
            }
        });
    });

    const container = layoutModule._containerComp?.element;
    if (container) {
        layoutModule.on(container, 'click', (e) => {
            const btn = e.target.closest('.pagination-btn');
            if (btn) _handlePaginationClick(e);
        });
    }
}

/**
 * Create the layout's filter actions coordinator.
 */
export function createFilterActions(layoutModule, { loadAndRender }) {
    return createLayoutFilterActions({
        isActive,
        resolveCategoryName: (categoryId, categoryName = null) =>
            resolveCategoryName(categoryId, getCategoriesData(), categoryName),
        beforeFilterChange: () => layoutModule.unmountGrid(),
        applyCategoryState: ({ categoryId, resolvedName }) => {
            setActivePage(1);
            setCategoryIdFilter(categoryId);
            setCategoryNameFilter(resolvedName);
            setParentNameFilter(null);
            setSubfolderFilter(null);
            setCategoryIdsFilter(null);
            setMediaFilter('all');
        },
        applyParentState: ({ parentName, categoryIds = null }) => {
            setActivePage(1);
            setCategoryIdFilter(null);
            setCategoryNameFilter(null);
            setSubfolderFilter(null);
            setParentNameFilter(parentName);
            setCategoryIdsFilter(categoryIds);
            setMediaFilter('all');
        },
        applySubfolderState: ({ categoryId, subfolder, resolvedName }) => {
            setActivePage(1);
            setCategoryIdFilter(categoryId);
            setCategoryNameFilter(resolvedName);
            setSubfolderFilter(subfolder);
            setParentNameFilter(null);
            setCategoryIdsFilter(null);
            setMediaFilter('all');
        },
        refreshForFilter: () => loadAndRender(false)
    });
}

/**
 * Render error view when loading fails.
 */
export function renderLayoutError(loadAndRender) {
    const rowsContainer = document.getElementById('streaming-content-container');
    if (!rowsContainer) return;
    clear(rowsContainer);
    append(rowsContainer, createElement('div', {
        className: 'streaming-row-empty',
        style: { padding: '100px 20px', textAlign: 'center' }
    },
        createElement('p', { textContent: 'Failed to load content. Please try again.' }),
        createElement('button', {
            className: 'streaming-hero-btn secondary',
            style: { marginTop: '20px' },
            onClick: () => loadAndRender()
        }, 'Retry')
    ));
}
