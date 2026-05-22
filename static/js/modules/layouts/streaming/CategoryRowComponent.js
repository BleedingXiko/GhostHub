/**
 * Streaming Layout - Category Row Component
 *
 * One Component per category-subfolder pair. Subscribes to its own viewKey via
 * subscribeView; ordering/manifest changes fire vs.reset(). The Component holds
 * only its DOM refs, VS instance, and identity props passed in by its parent.
 * It never reads from streamingState beyond the props it was constructed with.
 *
 * Subfolder cards are rendered outside the VS chunk system so they survive
 * recycling.
 */

import { Component, VirtualScroller, createElement, append, $$ } from '../../../libs/ragot.esm.min.js';
import { selectChunkRecords, selectView, selectRecordsForView, subscribeView } from '../../media/selectors.js';
import { createMediaItemCard, createSubfolderCard } from './cards.js';
import { observeLazyImage, primeLazyImage } from './lazyLoad.js';
import { loadMoreMedia } from './mediaDataSource.js';
import { handleSubfolderClick as _handleSubfolderClick } from '../shared/subfolderNavigation.js';
import { isSubfolderFile } from '../../../utils/subfolderUtils.js';
import {
    CARDS_PER_CHUNK,
    MAX_CHUNKS,
    ROW_SCROLL_AMOUNT,
    H_ROOT_MARGIN,
    THUMB_PRIME_BUFFER_PX,
    buildRowShell,
    buildLoadingCard,
    filterMediaItems,
    getRowHeaderMeta,
    isWithinPrimeWindow,
    shouldPrefetchNextChunk,
    rowIconForCategory
} from './rowShell.js';
import { getSubfolderFilter, getCategoryIdFilter, streamingState } from './state.js';

export class CategoryRowComponent extends Component {
    constructor({ category, activeSubfolder = null, viewKey = null, rowOrder = 0, mediaFilter = 'all' } = {}) {
        super({});
        this._category = category || null;
        this._activeSubfolder = activeSubfolder || null;
        this._viewKey = viewKey || null;
        this._rowOrder = rowOrder | 0;
        this._mediaFilter = mediaFilter || 'all';

        this._vs = null;
        this._unsubscribeView = null;
        this._prefetchInFlight = false;
        this._subfolderContainer = null;
        this._mediaContainer = null;
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._scrollHandlers = null;
        // Tracks the orderedIds array we last rendered against. VS.reset()
        // only repositions sentinels — it does NOT re-render existing chunks.
        // When this reference changes (rename, delete, sort change), we must
        // tear down the VS and rebuild so chunk DOM picks up the new records
        // (and the cards' onClick closures get refreshed with current URLs).
        this._lastOrderedIdsRef = null;
        this._lastShapeSignature = null;
    }

    get categoryId() { return this._category?.id || null; }
    get viewKey() { return this._viewKey; }

    render() {
        const latestCategory = (streamingState.state.categoriesData || []).find((c) => String(c?.id) === String(this._category?.id)) || this._category || {};
        const activeSubfolder = this._activeSubfolder;
        const mediaFilter = this._mediaFilter;

        const view = selectView(this._viewKey) || {};
        const records = selectRecordsForView(this._viewKey);
        const subfolders = view?.viewMeta?.subfolders || latestCategory.subfolders || [];

        const filtered = filterMediaItems(records, mediaFilter);
        const directItems = activeSubfolder
            ? filtered
            : (subfolders.length > 0 ? filtered.filter((m) => !isSubfolderFile(m)) : filtered);

        const hasVideos = filtered.some((m) => m?.type === 'video') ||
            latestCategory.containsVideo === true ||
            subfolders.some((sf) => sf?.contains_video);

        const { title, breadcrumbPath } = getRowHeaderMeta(latestCategory, activeSubfolder);
        const icon = rowIconForCategory(latestCategory, hasVideos);
        const count = directItems.length + subfolders.length;

        const { rowEl, scrollContainer, subfolderContainer, mediaContainer, leftBtn, rightBtn } = buildRowShell(
            title,
            `category-${latestCategory.id}`,
            icon,
            count,
            latestCategory.active_users || 0,
            latestCategory.id,
            breadcrumbPath
        );

        this._subfolderContainer = subfolderContainer;
        this._mediaContainer = mediaContainer;
        this._scrollContainer = scrollContainer;
        this._leftBtn = leftBtn;
        this._rightBtn = rightBtn;

        subfolders.forEach((sf, idx) => {
            const card = createSubfolderCard(
                {
                    name: sf.name,
                    count: sf.count,
                    containsVideo: sf.contains_video,
                    thumbnailUrl: sf.thumbnail_url || null,
                    categoryId: latestCategory.id
                },
                (cId, sfName) => _handleSubfolderClick(cId, sfName, getSubfolderFilter, getCategoryIdFilter),
                idx
            );
            append(subfolderContainer, card);
        });
        subfolderContainer.hidden = subfolders.length === 0;

        const showShell = directItems.length === 0 && subfolders.length === 0 &&
            (view?.status === 'fetching' || latestCategory.asyncIndexing === true);
        if (showShell) {
            for (let i = 0; i < 3; i++) append(mediaContainer, buildLoadingCard(i));
            leftBtn.classList.add('at-start');
            rightBtn.classList.add('at-end');
        }

        return rowEl;
    }

    _applyViewState() {
        if (!this.element || !this._scrollContainer) return;
        const latestCategory = (streamingState.state.categoriesData || []).find((c) => String(c?.id) === String(this._category?.id)) || this._category || {};
        const view = selectView(this._viewKey) || {};
        const records = selectRecordsForView(this._viewKey);
        const subfolders = view?.viewMeta?.subfolders || latestCategory.subfolders || [];
        const sfCount = subfolders.length;
        const directItems = this._filteredDirectItems(records, subfolders);

        const showShell = directItems.length === 0 && sfCount === 0 &&
            (view?.status === 'fetching' || latestCategory.asyncIndexing === true);

        // Update the count element in the row header dynamically
        const count = directItems.length + sfCount;
        const countText = count === 1 ? '1 item' : `${count} items`;
        const countEl = this.element.querySelector('.streaming-row-count');
        if (countEl) {
            countEl.textContent = `(${countText})`;
        }

        if (directItems.length > 0 || sfCount > 0) {
            // Remove skeletons if they exist
            $$('.streaming-card-skeleton', this._scrollContainer).forEach((el) => el.remove());

            // Ensure subfolders are rendered
            this._renderSubfolders(subfolders);

            const prevOrderedIds = this._lastOrderedIdsRef || [];
            const nextOrderedIds = view.orderedIds || [];
            const nextShapeSignature = this._shapeSignature(view, subfolders);
            const shapeChanged = nextShapeSignature !== this._lastShapeSignature;
            const isAppendOnly = shapeChanged &&
                nextOrderedIds.length > prevOrderedIds.length &&
                prevOrderedIds.every((id, i) => id === nextOrderedIds[i]);
            this._lastOrderedIdsRef = nextOrderedIds;
            this._lastShapeSignature = nextShapeSignature;

            if (!this._vs) {
                this._mountVS(sfCount);
            } else if (isAppendOnly) {
                // Pagination appended ids to the end. Existing chunk DOM is
                // still valid; only totalItems() grew. vs.reset() repositions
                // the right sentinel so IO can request the new chunks lazily
                // without rebuilding what's already mounted.
                this._vs.reset?.();
            } else if (shapeChanged) {
                // Records or order shifted (rename, delete, sort, etc). Rebuild.
                this._vs.unmount();
                this._vs = null;
                // Strip leftover chunk/sentinel/placeholder nodes from the media rail.
                if (this._mediaContainer) this._mediaContainer.innerHTML = '';
                this._mountVS(sfCount);
            }
            this._wireScrollButtons(sfCount);
        } else if (showShell) {
            if (this._vs) {
                this._vs.unmount();
                this._vs = null;
            }
            // Render skeletons if they aren't already there
            const existingSkeletons = $$('.streaming-card-skeleton', this._mediaContainer || this._scrollContainer);
            if (existingSkeletons.length === 0) {
                if (this._mediaContainer) this._mediaContainer.innerHTML = '';
                for (let i = 0; i < 3; i++) {
                    append(this._mediaContainer || this._scrollContainer, buildLoadingCard(i));
                }
            }
            if (this._leftBtn && this._rightBtn) {
                this._leftBtn.classList.add('at-start');
                this._rightBtn.classList.add('at-end');
            }
        } else {
            if (this._vs) {
                this._vs.unmount();
                this._vs = null;
            }
            // Status is ready/stale/error but we have 0 items and 0 subfolders -> clear skeletons
            if (this._mediaContainer) this._mediaContainer.innerHTML = '';
            if (this._leftBtn && this._rightBtn) {
                this._leftBtn.classList.add('at-start');
                this._rightBtn.classList.add('at-end');
            }
        }
    }

    _renderSubfolders(subfolders) {
        if (!this._subfolderContainer) return;
        
        // Remove existing subfolder cards to prevent duplicates
        $$('.streaming-subfolder-card', this._subfolderContainer).forEach((el) => el.remove());
        this._subfolderContainer.hidden = subfolders.length === 0;
        
        const latestCategory = (streamingState.state.categoriesData || []).find((c) => String(c?.id) === String(this._category?.id)) || this._category || {};
        const categoryId = latestCategory.id;
        if (!categoryId) return;

        subfolders.forEach((sf, i) => {
            const card = createSubfolderCard(
                {
                    name: sf.name,
                    count: sf.count,
                    containsVideo: sf.contains_video,
                    thumbnailUrl: sf.thumbnail_url || null,
                    categoryId: categoryId
                },
                (cId, sfName) => _handleSubfolderClick(cId, sfName, getSubfolderFilter, getCategoryIdFilter),
                i
            );
            append(this._subfolderContainer, card);
        });
    }

    onStart() {
        if (!this.element || !this._scrollContainer) return;
        const latestCategory = (streamingState.state.categoriesData || []).find((c) => String(c?.id) === String(this._category?.id)) || this._category || {};
        const view = selectView(this._viewKey) || {};
        const records = selectRecordsForView(this._viewKey);
        const subfolders = view?.viewMeta?.subfolders || latestCategory.subfolders || [];
        const sfCount = subfolders.length;
        const directItems = this._filteredDirectItems(records, subfolders);

        if (this._mediaFilter && this._mediaFilter !== 'all' && directItems.length === 0 && sfCount === 0) {
            // Row has nothing to render under this filter; skip VS instantiation but keep the subscription wired
            this._subscribeToView();
            return;
        }

        this._subscribeToView();
        this._applyViewState();
    }

    onStop() {
        this._unsubscribeView?.();
        this._unsubscribeView = null;
        this._vs?.unmount();
        this._vs = null;
        this._clearScrollHandlers();
        this._subfolderContainer = null;
        this._mediaContainer = null;
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._lastOrderedIdsRef = null;
        this._lastShapeSignature = null;
    }

    _filteredDirectItems(records, subfolders) {
        const filtered = filterMediaItems(records, this._mediaFilter);
        if (this._activeSubfolder) return filtered;
        if (subfolders.length === 0) return filtered;
        return filtered.filter((m) => !isSubfolderFile(m));
    }

    _shapeSignature(view, subfolders) {
        const ids = view?.orderedIds || [];
        const subfolderSig = (subfolders || [])
            .map((sf) => `${sf?.name || ''}:${sf?.count || 0}:${sf?.thumbnail_url || ''}`)
            .join('|');
        return `${ids.join('|')}::${subfolderSig}::${view?.hasMore ? 1 : 0}`;
    }

    _mountVS(sfCount) {
        const scrollContainer = this._scrollContainer;
        const mediaContainer = this._mediaContainer;
        if (!scrollContainer || !mediaContainer) return;

        const latestCategory = (streamingState.state.categoriesData || []).find((c) => String(c?.id) === String(this._category?.id)) || this._category || {};
        const rowOrder = this._rowOrder;
        const viewKey = this._viewKey;

        this._vs = new VirtualScroller({
            chunkContainer: mediaContainer,
            root: scrollContainer,
            rootMargin: H_ROOT_MARGIN,
            chunkSize: CARDS_PER_CHUNK,
            maxChunks: MAX_CHUNKS,
            childPoolSize: MAX_CHUNKS,
            initialChunks: 1,
            totalItems: () => {
                const view = selectView(viewKey);
                if (!view) return 0;
                const records = selectRecordsForView(viewKey);
                const subfolders = view?.viewMeta?.subfolders || latestCategory?.subfolders || [];
                const items = this._filteredDirectItems(records, subfolders);
                return view.hasMore ? items.length + CARDS_PER_CHUNK : items.length;
            },
            renderChunk: async (chunkIndex) => {
                const items = await this._getChunkItems(chunkIndex);
                if (!items || items.length === 0) return null;

                const chunk = createElement('div', { style: { display: 'contents' } });
                items.forEach((media, idx) => {
                    const globalIdx = sfCount + chunkIndex * CARDS_PER_CHUNK + idx;
                    const card = createMediaItemCard(media, latestCategory.id, globalIdx, {
                        forceEager: rowOrder < 3 && chunkIndex === 0 && idx < 6
                    });
                    append(chunk, card);
                });
                $$('img[data-src]', chunk).forEach((img) => observeLazyImage(img));
                return chunk;
            },
            measureChunk: (el) => {
                let w = 0;
                for (const card of el.children) {
                    const style = getComputedStyle(card);
                    w += card.offsetWidth
                        + parseFloat(style.marginLeft || 0)
                        + parseFloat(style.marginRight || 0);
                }
                return w;
            },
            buildPlaceholder: (_i, px) => createElement('div', {
                style: `flex:none;width:${px}px;height:1px;pointer-events:none`
            }),
        });

        this._vs.mount(mediaContainer);
    }

    _subscribeToView() {
        if (this._unsubscribeView) {
            this._unsubscribeView();
            this._unsubscribeView = null;
        }
        if (!this._viewKey) return;
        
        const unsubView = subscribeView(this._viewKey, () => {
            if (!this.element || !this._isMounted) return;
            this._applyViewState();
        }, { owner: this });

        streamingState.subscribe((_slice, s) => {
            if (!this.element || !this._isMounted) return;
            this._applyViewState();
        }, {
            owner: this,
            immediate: false,
            selector: (s) => {
                const cat = (s.categoriesData || []).find((c) => String(c?.id) === String(this.categoryId));
                if (!cat) return '';
                const sfNames = (cat.subfolders || []).map(sf => sf.name).join(',');
                return `${cat.viewStatus || ''}|${cat.asyncIndexing ? 1 : 0}|${cat.indexingProgress || 0}|${sfNames}`;
            }
        });

        this._unsubscribeView = () => {
            unsubView();
        };
    }

    _wireScrollButtons(sfCount) {
        const scrollContainer = this._scrollContainer;
        const leftBtn = this._leftBtn;
        const rightBtn = this._rightBtn;
        if (!scrollContainer || !leftBtn || !rightBtn) return;

        this._clearScrollHandlers();

        const updateButtons = () => {
            const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
            leftBtn.classList.toggle('at-start', scrollLeft <= 0);
            rightBtn.classList.toggle('at-end', scrollWidth - clientWidth - scrollLeft <= 1);
            this._primeVisibleThumbnails();
            const view = selectView(this._viewKey);
            if (shouldPrefetchNextChunk(scrollLeft, clientWidth, scrollWidth) && view?.hasMore) {
                this._prefetchNext();
            }
        };
        const onLeftClick = () => scrollContainer.scrollBy({ left: -ROW_SCROLL_AMOUNT, behavior: 'smooth' });
        const onRightClick = () => scrollContainer.scrollBy({ left: ROW_SCROLL_AMOUNT, behavior: 'smooth' });

        this.on(scrollContainer, 'scroll', updateButtons, { passive: true });
        this.on(leftBtn, 'click', onLeftClick);
        this.on(rightBtn, 'click', onRightClick);
        this._scrollHandlers = { scrollContainer, leftBtn, rightBtn, updateButtons, onLeftClick, onRightClick };

        requestAnimationFrame(() => {
            updateButtons();
            this._primeVisibleThumbnails();
            const view = selectView(this._viewKey);
            if (this._rowOrder < 2 && view?.hasMore) this._prefetchNext();
        });
    }

    _clearScrollHandlers() {
        const h = this._scrollHandlers;
        if (!h) return;
        this.off(h.scrollContainer, 'scroll', h.updateButtons);
        this.off(h.leftBtn, 'click', h.onLeftClick);
        this.off(h.rightBtn, 'click', h.onRightClick);
        this._scrollHandlers = null;
    }

    _primeVisibleThumbnails() {
        const scrollContainer = this._scrollContainer;
        if (!scrollContainer) return;
        const viewportWidth = scrollContainer.clientWidth || window.innerWidth || 0;
        $$('img.streaming-card-thumbnail[data-src]', scrollContainer).forEach((img) => {
            const rect = img.getBoundingClientRect();
            if (!isWithinPrimeWindow(rect.left, rect.right, viewportWidth, THUMB_PRIME_BUFFER_PX)) return;
            primeLazyImage(img, { fetchPriority: rect.left >= 0 && rect.right <= viewportWidth ? 'high' : 'auto' });
        });
    }

    _prefetchNext() {
        if (this._prefetchInFlight) return;
        const categoryId = this._category?.id;
        if (!categoryId) return;
        this._prefetchInFlight = true;
        loadMoreMedia(categoryId).catch(() => []).finally(() => {
            this._prefetchInFlight = false;
        });
    }

    async _getChunkItems(chunkIndex) {
        const start = chunkIndex * CARDS_PER_CHUNK;
        const view = selectView(this._viewKey);
        const subfolders = view?.viewMeta?.subfolders || this._category?.subfolders || [];
        const chunkRecords = selectChunkRecords(this._viewKey, start, CARDS_PER_CHUNK, this._mediaFilter);
        const filtered = this._filteredDirectItems(chunkRecords, subfolders);

        if (filtered.length > 0) {
            return filtered;
        }
        if (!view?.hasMore) return [];

        const categoryId = this._category?.id;
        if (!categoryId) return [];
        const fetched = await loadMoreMedia(categoryId);
        if (!fetched || fetched.length === 0) return [];

        const freshView = selectView(this._viewKey);
        const freshSubfolders = freshView?.viewMeta?.subfolders || this._category?.subfolders || [];
        const freshChunkRecords = selectChunkRecords(this._viewKey, start, CARDS_PER_CHUNK, this._mediaFilter);
        return this._filteredDirectItems(freshChunkRecords, freshSubfolders);
    }
}
