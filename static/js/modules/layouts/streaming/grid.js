/**
 * Streaming Layout - Chunked Grid View
 *
 * StreamingGridComponent renders a responsive CSS grid for single-category / subfolder views.
 * Uses VirtualScroller with chunkContainer to keep sentinels outside the CSS grid.
 *
 * No module-level singleton. The module in index.js owns and adopts this component.
 * Export: StreamingGridComponent class only.
 */

import { createMediaItemCard, createSubfolderCard } from './cards.js';
import { observeLazyImage } from './lazyLoad.js';
import { fetchCategoryMedia } from './mediaDataSource.js';
import { isSubfolderFile } from '../../../utils/subfolderUtils.js';
import { videoIcon, imageIcon, folderFilledIcon } from '../../../utils/icons.js';
import { getRowHeaderMeta } from './rowShell.js';
import { Component, VirtualScroller, createElement, append, $, $$ } from '../../../libs/ragot.esm.min.js';
import { handleSubfolderClick as _handleSubfolderClick } from '../shared/subfolderNavigation.js';
import { selectChunkRecords, selectRecordsForView, selectView, subscribeView } from '../../media/selectors.js';
import {
    getCategoryIdFilter,
    getSubfolderFilter,
    getMediaFilter,
    getCategoryView,
    updateCategoryView,
    setGridMode,
    setGridTotalItems,
    getGridTotalItems
} from './state.js';

// ── Constants ────────────────────────────────────────────────────────────────

const CARDS_PER_CHUNK = 30;
const MAX_RENDERED_CHUNKS = 5;
const CHUNK_PRELOAD_MARGIN = '400px 0px 1200px 0px';

// ── Helpers ──────────────────────────────────────────────────────────────────

function filterByMediaType(items) {
    const filter = getMediaFilter();
    if (filter === 'all') return items;
    return items.filter(m => {
        const type = m.type || (m.url?.match(/\.(mp4|webm|mkv|avi|mov)$/i) ? 'video' : 'image');
        if (filter === 'video') return type === 'video';
        if (filter === 'image') return type === 'image';
        return true;
    });
}

function estimateChunkHeight(gridWidth) {
    const width = gridWidth || 800;
    const minCardWidth = 180;
    const gap = 12;
    const columns = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
    const cardHeight = Math.round((minCardWidth * 9) / 16) + 40 + gap;
    const rows = Math.ceil(CARDS_PER_CHUNK / columns);
    return rows * cardHeight;
}

// ── StreamingGridComponent ────────────────────────────────────────────────────

/**
 * @param {Object} category       - Category object
 * @param {Object} cache          - Initial cache entry {media, subfolders, hasMore, page}
 * @param {HTMLElement} scrollRoot - The scroll container element (streaming-container)
 */
export class StreamingGridComponent extends Component {
    constructor(category, cache, scrollRoot) {
        super({});

        this._categoryId = category.id;
        this._subfolder = getSubfolderFilter();
        this._category = category;
        this._cache = cache;
        this._scrollRoot = scrollRoot;

        this._fetchedPages = new Map();
        this._pendingFetches = new Set();
        this._staleRefreshPromise = null;
        this._unregisterSet = new Set();
        this._vs = null;
        this._viewSubscription = null;
        this._lastShapeSignature = null;
        this._lastOrderedIdsRef = null;
    }

    // ── Render ─────────────────────────────────────────────────────────────

    render() {
        const { category, cache, categoryId, subfolder } = this._resolveRenderData();

        const media = selectRecordsForView(cache?.viewKey);
        const subfolders = this._subfoldersForRender(cache);
        const totalItems = getGridTotalItems() || 0;

        this._fetchedPages.set(1, this._canonicalChunk(0, cache?.viewKey));

        const directItems = (subfolder || subfolders.length === 0)
            ? media
            : media.filter(m => !isSubfolderFile(m));
        const filteredItems = filterByMediaType(directItems);

        // Header
        const headerMeta = getRowHeaderMeta(category, subfolder);
        const itemCount = totalItems > 0 ? totalItems : filteredItems.length;
        const countText = itemCount === 1 ? '1 item' : `${itemCount} items`;
        const hasVideos = media.some(m => m.type === 'video') || category.containsVideo === true;
        const headerIcon = hasVideos ? videoIcon(18) : imageIcon(18);

        const header = createElement('div', { className: 'streaming-grid-header' },
            createElement('div', { className: 'streaming-row-title-group' },
                createElement('h2', { className: 'streaming-row-title' },
                    createElement('span', { className: 'row-icon', innerHTML: headerIcon }),
                    createElement('span', { className: 'streaming-row-title-text', textContent: ` ${headerMeta.title} ` }),
                    createElement('span', { className: 'streaming-row-count', textContent: `(${countText})` })
                ),
                headerMeta.breadcrumbPath ? createElement('div', {
                    className: 'streaming-row-breadcrumb',
                    title: headerMeta.breadcrumbPath
                },
                    createElement('span', { className: 'streaming-row-breadcrumb-icon', 'aria-hidden': 'true', innerHTML: folderFilledIcon(12) }),
                    createElement('span', { className: 'streaming-row-breadcrumb-path', textContent: headerMeta.breadcrumbPath })
                ) : null
            )
        );

        // Grid container — VirtualScroller chunks go here via chunkContainer option
        const grid = createElement('div', { className: 'streaming-grid', id: 'streaming-grid' });

        // Subfolder cards (always rendered, outside chunk system)
        if (subfolders.length > 0) {
            const sfSection = createElement('div', { className: 'streaming-grid-subfolders' });
            subfolders.forEach(sf => {
                const card = createSubfolderCard({
                    name: sf.name,
                    count: sf.count,
                    containsVideo: sf.contains_video,
                    thumbnailUrl: sf.thumbnail_url || null,
                    categoryId
                }, (cId, sfName) => _handleSubfolderClick(cId, sfName, getSubfolderFilter, getCategoryIdFilter));
                append(sfSection, card);
            });
            append(grid, sfSection);
        }

        const wrapper = createElement('div', {
            className: 'streaming-grid-wrapper',
            id: 'streaming-grid-wrapper'
        });
        append(wrapper, header, grid);
        return wrapper;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    onStart() {
        this._gridEl = this.element ? $('.streaming-grid', this.element) : null;
        if (!this._gridEl) return;

        setGridMode(true);

        const cache = this._cache;
        const media = selectRecordsForView(cache?.viewKey);
        const subfolder = this._subfolder;
        const subfolders = this._subfoldersForRender(cache);
        const directItems = (subfolder || subfolders.length === 0)
            ? media
            : media.filter(m => !isSubfolderFile(m));
        const filteredItems = filterByMediaType(directItems);
        const totalItems = getGridTotalItems() || 0;
        const totalDirect = totalItems > 0
            ? Math.max(totalItems, filteredItems.length)
            : (cache.hasMore ? filteredItems.length + CARDS_PER_CHUNK : filteredItems.length);

        this._vs = new VirtualScroller({
            chunkContainer: this._gridEl,
            root: this._scrollRoot,
            rootMargin: CHUNK_PRELOAD_MARGIN,
            chunkSize: CARDS_PER_CHUNK,
            maxChunks: MAX_RENDERED_CHUNKS,
            childPoolSize: MAX_RENDERED_CHUNKS,
            initialChunks: 1,
            totalItems: () => {
                const c = getCategoryView(this._categoryId, this._subfolder, getMediaFilter());
                if (!c) return totalDirect;
                const total = getGridTotalItems() || selectRecordsForView(c?.viewKey).length;
                return c.hasMore ? total + CARDS_PER_CHUNK : total;
            },

            renderChunk: async (chunkIndex) => {
                const items = await this._getChunkItems(chunkIndex);
                if (!items || items.length === 0) return null;

                const chunk = createElement('div', { style: { display: 'contents' } });
                items.forEach((m, idx) => {
                    const card = createMediaItemCard(m, this._categoryId, chunkIndex * CARDS_PER_CHUNK + idx, {
                        forceEager: chunkIndex === 0 && idx < 12,
                        unregisterSet: this._unregisterSet
                    });
                    append(chunk, card);
                });

                // Observe lazy images
                $$('img[data-src]', chunk).forEach(img => observeLazyImage(img));
                return chunk;
            },

            measureChunk: (el) => {
                // display:contents means el.offsetHeight = 0 — measure via card rects
                const cards = el.querySelectorAll('.streaming-card');
                if (!cards.length) return estimateChunkHeight(this._gridEl ? this._gridEl.clientWidth : 800);
                const first = cards[0].getBoundingClientRect();
                const last = cards[cards.length - 1].getBoundingClientRect();
                return last.bottom - first.top;
            },

            buildPlaceholder: (_i, px) => createElement('div', {
                style: `display:block;height:${px}px;grid-column:1 / -1`
            }),
        });

        // Mount VS sentinels into wrapper (outside the CSS grid)
        this._vs.mount(this.element);
        this._lastShapeSignature = this._shapeSignature(cache);
        this._lastOrderedIdsRef = selectView(cache?.viewKey)?.orderedIds || [];
        this._subscribeView(cache?.viewKey);
    }

    onStop() {
        this._viewSubscription?.unsubscribe?.();
        this._viewSubscription = null;
        setGridMode(false);
        setGridTotalItems(0);
        this._unregisterSet.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
        this._unregisterSet.clear();
        if (this._vs) { this._vs.unmount(); this._vs = null; }
        this._gridEl = null;
        this._lastShapeSignature = null;
        this._lastOrderedIdsRef = null;
    }

    // ── Public: rebind to new category without remounting ─────────────────

    /**
     * Switch this grid to a new category/cache without unmounting and remounting.
     * Recycles the existing VirtualScroller and patches header/subfolders in-place.
     * Called by StreamingLayoutModule.mountGrid() when the component is already mounted.
     *
     * @param {Object} category - New category object
     * @param {Object} cache    - Initial cache entry for the new category
     */
    rebind(category, cache) {
        // ── Reset instance data ──
        this._categoryId = category.id;
        this._subfolder = getSubfolderFilter();
        this._category = category;
        this._cache = cache;
        this._lastShapeSignature = this._shapeSignature(cache);
        this._lastOrderedIdsRef = selectView(cache?.viewKey)?.orderedIds || [];
        this._fetchedPages = new Map();
        this._pendingFetches = new Set();
        this._staleRefreshPromise = null;
        this._subscribeView(cache?.viewKey);

        // Unregister old card listeners before replacing chunk content
        this._unregisterSet.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
        this._unregisterSet.clear();

        // ── Patch header in-place ──
        const headerMeta = getRowHeaderMeta(category, this._subfolder);
        const media = selectRecordsForView(cache?.viewKey);
        const subfolders = this._subfoldersForRender(cache);
        const totalItems = getGridTotalItems() || 0;
        const directItems = (this._subfolder || subfolders.length === 0)
            ? media
            : media.filter(m => !isSubfolderFile(m));
        const filteredItems = filterByMediaType(directItems);
        const itemCount = totalItems > 0 ? totalItems : filteredItems.length;
        const hasVideos = media.some(m => m.type === 'video') || category.containsVideo === true;

        const titleTextEl = this.element?.querySelector('.streaming-row-title-text');
        if (titleTextEl) titleTextEl.textContent = ` ${headerMeta.title} `;

        const countEl = this.element?.querySelector('.streaming-row-count');
        if (countEl) countEl.textContent = `(${itemCount === 1 ? '1 item' : `${itemCount} items`})`;

        const iconEl = this.element?.querySelector('.row-icon');
        if (iconEl) iconEl.innerHTML = hasVideos ? videoIcon(18) : imageIcon(18);

        const breadcrumbEl = this.element?.querySelector('.streaming-row-breadcrumb');
        if (headerMeta.breadcrumbPath) {
            if (breadcrumbEl) {
                const pathEl = breadcrumbEl.querySelector('.streaming-row-breadcrumb-path');
                if (pathEl) { pathEl.textContent = headerMeta.breadcrumbPath; breadcrumbEl.title = headerMeta.breadcrumbPath; }
            } else {
                const titleGroup = this.element?.querySelector('.streaming-row-title-group');
                if (titleGroup) {
                    const newBreadcrumb = createElement('div', { className: 'streaming-row-breadcrumb', title: headerMeta.breadcrumbPath },
                        createElement('span', { className: 'streaming-row-breadcrumb-icon', 'aria-hidden': 'true', innerHTML: folderFilledIcon(12) }),
                        createElement('span', { className: 'streaming-row-breadcrumb-path', textContent: headerMeta.breadcrumbPath })
                    );
                    append(titleGroup, newBreadcrumb);
                }
            }
        } else if (breadcrumbEl) {
            breadcrumbEl.remove();
        }

        // ── Rebuild subfolder cards ──
        const grid = this._gridEl;
        if (grid) {
            const existingSfSection = grid.querySelector('.streaming-grid-subfolders');
            if (existingSfSection) existingSfSection.remove();
            if (subfolders.length > 0) {
                const sfSection = createElement('div', { className: 'streaming-grid-subfolders' });
                subfolders.forEach(sf => {
                    const card = createSubfolderCard({
                        name: sf.name,
                        count: sf.count,
                        containsVideo: sf.contains_video,
                        thumbnailUrl: sf.thumbnail_url || null,
                        categoryId: category.id
                    }, (cId, sfName) => _handleSubfolderClick(cId, sfName, getSubfolderFilter, getCategoryIdFilter));
                    append(sfSection, card);
                });
                grid.insertBefore(sfSection, grid.firstChild);
            }
        }

        // ── Recycle and rebind VS ──
        if (!this._vs || !grid) return;

        this._fetchedPages.set(1, this._canonicalChunk(0, cache?.viewKey));
        const totalDirect = totalItems > 0
            ? Math.max(totalItems, filteredItems.length)
            : (cache.hasMore ? filteredItems.length + CARDS_PER_CHUNK : filteredItems.length);

        this._vs.recycle();
        this._vs.rebind({
            chunkContainer: grid,
            root: this._scrollRoot,
            totalItems: () => {
                const c = getCategoryView(this._categoryId, this._subfolder, getMediaFilter());
                if (!c) return totalDirect;
                const total = getGridTotalItems() || selectRecordsForView(c?.viewKey).length;
                return c.hasMore ? total + CARDS_PER_CHUNK : total;
            },
            renderChunk: async (chunkIndex) => {
                const items = await this._getChunkItems(chunkIndex);
                if (!items || items.length === 0) return null;
                const chunk = createElement('div', { style: { display: 'contents' } });
                items.forEach((m, idx) => {
                    const card = createMediaItemCard(m, this._categoryId, chunkIndex * CARDS_PER_CHUNK + idx, {
                        forceEager: chunkIndex === 0 && idx < 12,
                        unregisterSet: this._unregisterSet
                    });
                    append(chunk, card);
                });
                $$('img[data-src]', chunk).forEach(img => observeLazyImage(img));
                return chunk;
            },
        }, this.element);
    }

    _subscribeView(viewKey) {
        if (this._viewSubscription?.viewKey === viewKey) return;
        this._viewSubscription?.unsubscribe?.();
        this._viewSubscription = null;
        if (!viewKey) return;
        const unsubscribe = subscribeView(viewKey, () => {
            this._cache = getCategoryView(this._categoryId, this._subfolder, getMediaFilter()) || this._cache;
            const signature = this._shapeSignature(this._cache);
            if (signature === this._lastShapeSignature) return;

            // Mirror CategoryRowComponent: distinguish append-only growth
            // (pagination) from genuine shape change (rename, delete, sort,
            // visibility). vs.reset() only repositions sentinels — it does
            // NOT re-render mounted chunk DOM. So a rename leaves stale
            // dataset.mediaUrl / dataset.recordId / onClick closures on
            // every mounted card until the user scrolls them out.
            const prevIds = this._lastOrderedIdsRef || [];
            const nextIds = selectView(this._cache?.viewKey)?.orderedIds || [];
            const isAppendOnly = nextIds.length > prevIds.length &&
                prevIds.every((id, i) => id === nextIds[i]);

            this._lastShapeSignature = signature;
            this._lastOrderedIdsRef = nextIds;

            if (isAppendOnly) {
                this._vs?.reset?.();
                return;
            }
            this._rebuildChunks();
        }, { owner: this });
        this._viewSubscription = { viewKey, unsubscribe };
    }

    _rebuildChunks() {
        // Drop cached pages so _getChunkItems re-projects from the manifest
        // with the fresh orderedIds.
        this._fetchedPages = new Map();
        // Release any card-listener registrations on the chunks we're about
        // to wipe so they don't leak.
        this._unregisterSet.forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
        this._unregisterSet.clear();

        const grid = this._gridEl;
        if (!grid || !this._vs) return;
        // Preserve the subfolder section; strip every chunk + sentinel + placeholder.
        const sfSection = grid.querySelector('.streaming-grid-subfolders');
        Array.from(grid.children).forEach((child) => {
            if (child !== sfSection) child.remove();
        });
        // recycle() drops VS-tracked chunk state without tearing down config;
        // rebind() with the current callbacks repositions sentinels and lets
        // IO re-request chunks against the new ordering.
        this._vs.recycle();
        this._vs.rebind({
            chunkContainer: grid,
            root: this._scrollRoot,
            totalItems: () => {
                const c = getCategoryView(this._categoryId, this._subfolder, getMediaFilter());
                if (!c) return 0;
                const total = getGridTotalItems() || selectRecordsForView(c?.viewKey).length;
                return c.hasMore ? total + CARDS_PER_CHUNK : total;
            },
            renderChunk: async (chunkIndex) => {
                const items = await this._getChunkItems(chunkIndex);
                if (!items || items.length === 0) return null;
                const chunk = createElement('div', { style: { display: 'contents' } });
                items.forEach((m, idx) => {
                    const card = createMediaItemCard(m, this._categoryId, chunkIndex * CARDS_PER_CHUNK + idx, {
                        forceEager: chunkIndex === 0 && idx < 12,
                        unregisterSet: this._unregisterSet
                    });
                    append(chunk, card);
                });
                $$('img[data-src]', chunk).forEach((img) => observeLazyImage(img));
                return chunk;
            },
        }, this.element);
    }

    // ── Private helpers ────────────────────────────────────────────────────

    _resolveRenderData() {
        return {
            category: this._category,
            cache: this._cache,
            categoryId: this._categoryId,
            subfolder: this._subfolder
        };
    }

    _subfoldersForRender(cache) {
        return cache?.subfolders || [];
    }

    async _getChunkItems(chunkIndex) {
        const page = chunkIndex + 1;
        const start = chunkIndex * CARDS_PER_CHUNK;

        if (this._fetchedPages.has(page)) {
            return this._filterItems(this._fetchedPages.get(page));
        }

        const currentChunk = this._canonicalChunk(start);
        if (currentChunk.length > 0) {
            this._fetchedPages.set(page, currentChunk);
            return this._filterItems(currentChunk);
        }

        if (this._pendingFetches.has(page)) return [];
        this._pendingFetches.add(page);

        try {
            const result = await fetchCategoryMedia(
                this._categoryId, page, false, this._subfolder,
                { includeTotal: false, limit: CARDS_PER_CHUNK }
            );
            const pageIds = (selectView(result.viewKey)?.orderedIds || []).slice(start, start + CARDS_PER_CHUNK);
            const pageRecords = this._canonicalChunk(start, result.viewKey);
            this._fetchedPages.set(page, pageRecords);

            const cache = getCategoryView(this._categoryId, this._subfolder, getMediaFilter());
            if (cache) {
                const existingIds = new Set(cache.orderedIds || []);
                const newIds = pageIds.filter((id) => !existingIds.has(id));
                if (newIds.length > 0) {
                    updateCategoryView(this._categoryId, {
                        viewKey: result.viewKey || cache.viewKey || null,
                        page: Math.max(cache.page, page),
                        hasMore: result.hasMore
                    }, this._subfolder, getMediaFilter());
                }
            }

            return this._filterItems(pageRecords);
        } catch (e) {
            console.error(`[StreamingGrid] Failed to load chunk ${chunkIndex}:`, e);
            return [];
        } finally {
            this._pendingFetches.delete(page);
        }
    }

    _filterItems(items) {
        const cache = getCategoryView(this._categoryId, this._subfolder, getMediaFilter());
        const subfolders = cache?.subfolders || [];
        const direct = (this._subfolder || subfolders.length === 0)
            ? items
            : items.filter(m => !isSubfolderFile(m));
        return filterByMediaType(direct);
    }

    _canonicalChunk(start, viewKey = this._cache?.viewKey || this._viewKey) {
        if (!viewKey) return [];
        return selectChunkRecords(viewKey, start, CARDS_PER_CHUNK, getMediaFilter());
    }

    _shapeSignature(cache = this._cache) {
        const view = selectView(cache?.viewKey);
        const ids = view?.orderedIds || [];
        const subfolders = cache?.subfolders || [];
        const subfolderSig = subfolders.map((sf) => `${sf?.name || ''}:${sf?.count || 0}:${sf?.thumbnail_url || ''}`).join('|');
        return `${ids.join('|')}::${subfolderSig}::${view?.hasMore ? 1 : 0}`;
    }
}
