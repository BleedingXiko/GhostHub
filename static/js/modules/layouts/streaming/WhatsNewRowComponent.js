/**
 * Streaming Layout - What's New Row Component
 *
 * Subscribes to streamingState.whatsNewData and the backing media-ordering
 * view so manifest/order invalidations reconcile the row in place.
 */

import { Component, createElement, append, renderList } from '../../../libs/ragot.esm.min.js';
import { sparkleIcon } from '../../../utils/icons.js';
import { selectRecordsForView, subscribeView } from '../../media/selectors.js';
import { buildRowShell, buildLoadingRow, ROW_SCROLL_AMOUNT } from './rowShell.js';
import { createMediaItemCard } from './cards.js';
import { setWhatsNewData, streamingState } from './state.js';

function createWhatsNewCard(media) {
    const card = createMediaItemCard(media, media.categoryId, 0, { forceEager: true });
    append(card, createElement('span', { className: 'streaming-card-category-badge', textContent: media.categoryName || '' }));
    return card;
}

export class WhatsNewRowComponent extends Component {
    constructor() {
        super({});
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._scrollHandlers = null;
        this._lastShape = null;
        this._showLoadingFn = null;
        this._unsubscribeWhatsNewView = null;
    }

    /**
     * Parent supplies a getter for the auxiliary "still indexing" signal that
     * also triggers the What's New loading shell — keeps this Component from
     * snapshotting categories data directly.
     */
    setShowLoadingFn(fn) {
        this._showLoadingFn = typeof fn === 'function' ? fn : null;
    }

    render() {
        return this._buildShellForCurrentState();
    }

    onStart() {
        if (!this.element) return;
        streamingState.subscribe((viewKey) => {
            this._unsubscribeWhatsNewView?.();
            this._unsubscribeWhatsNewView = null;
            if (!viewKey) return;
            this._unsubscribeWhatsNewView = subscribeView(viewKey, () => {
                setWhatsNewData(selectRecordsForView(viewKey));
            }, { owner: this });
        }, {
            owner: this,
            immediate: true,
            selector: (s) => s.whatsNewViewKey || null,
        });
        streamingState.subscribe((_slice, s) => {
            const data = s.whatsNewData || [];
            const loading = s.whatsNewLoading === true || (this._showLoadingFn?.() === true);
            this._reconcile(data, loading);
        }, {
            owner: this,
            immediate: false,
            selector: (s) => {
                const list = s.whatsNewData || [];
                return `${list.length}|${s.whatsNewLoading === true ? 1 : 0}|${list.map((m) => m?.url || '').join(',')}|${(s.categoriesData || []).map((c) => c?.id || '').join(',')}`;
            }
        });
        if (this._lastShape === 'list') {
            this._wireScrollButtons();
        }
    }

    onStop() {
        this._unsubscribeWhatsNewView?.();
        this._unsubscribeWhatsNewView = null;
        this._clearScrollHandlers();
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._showLoadingFn = null;
    }

    _buildShellForCurrentState() {
        const data = streamingState.state.whatsNewData || [];
        const loading = streamingState.state.whatsNewLoading === true || (this._showLoadingFn?.() === true);
        if (data.length > 0) {
            const { rowEl, scrollContainer, leftBtn, rightBtn } = buildRowShell(
                "What's New", 'whats-new', sparkleIcon(16), data.length, 0, null, null
            );
            renderList(scrollContainer, data, (media) => media.url, createWhatsNewCard);
            this._scrollContainer = scrollContainer;
            this._leftBtn = leftBtn;
            this._rightBtn = rightBtn;
            this._lastShape = 'list';
            return rowEl;
        }
        if (loading) {
            this._scrollContainer = null;
            this._leftBtn = null;
            this._rightBtn = null;
            this._lastShape = 'loading';
            return buildLoadingRow('whats-new', "What's New", sparkleIcon(16), 4);
        }
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._lastShape = 'empty';
        return createElement('div', { id: 'row-whats-new', style: { display: 'none' } });
    }

    _reconcile(data, loading) {
        if (!this.element) return;

        const desiredShape = data.length > 0 ? 'list' : (loading ? 'loading' : 'empty');

        if (desiredShape === 'list' && this._lastShape === 'list' && this._scrollContainer) {
            renderList(this._scrollContainer, data, (media) => media.url, createWhatsNewCard);
            const countEl = this.element.querySelector('.streaming-row-count');
            if (countEl) countEl.textContent = `(${data.length === 1 ? '1 item' : `${data.length} items`})`;
            return;
        }

        const next = this._buildShellForCurrentState();
        const parent = this.element.parentNode;
        if (parent) parent.replaceChild(next, this.element);
        this.element = next;

        if (this._lastShape === 'list') {
            this._wireScrollButtons();
        }
    }

    _wireScrollButtons() {
        const scrollContainer = this._scrollContainer;
        const leftBtn = this._leftBtn;
        const rightBtn = this._rightBtn;
        if (!scrollContainer || !leftBtn || !rightBtn) return;

        this._clearScrollHandlers();

        const updateButtons = () => {
            const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
            leftBtn.classList.toggle('at-start', scrollLeft <= 0);
            rightBtn.classList.toggle('at-end', scrollWidth - clientWidth - scrollLeft <= 1);
        };
        const onLeftClick = () => scrollContainer.scrollBy({ left: -ROW_SCROLL_AMOUNT, behavior: 'smooth' });
        const onRightClick = () => scrollContainer.scrollBy({ left: ROW_SCROLL_AMOUNT, behavior: 'smooth' });

        this.on(scrollContainer, 'scroll', updateButtons, { passive: true });
        this.on(leftBtn, 'click', onLeftClick);
        this.on(rightBtn, 'click', onRightClick);
        this._scrollHandlers = { scrollContainer, leftBtn, rightBtn, updateButtons, onLeftClick, onRightClick };
        requestAnimationFrame(updateButtons);
    }

    _clearScrollHandlers() {
        const h = this._scrollHandlers;
        if (!h) return;
        this.off(h.scrollContainer, 'scroll', h.updateButtons);
        this.off(h.leftBtn, 'click', h.onLeftClick);
        this.off(h.rightBtn, 'click', h.onRightClick);
        this._scrollHandlers = null;
    }
}
