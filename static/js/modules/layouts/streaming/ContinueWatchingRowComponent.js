/**
 * Streaming Layout - Continue Watching Row Component
 *
 * Subscribes to streamingState.continueWatchingData (which is a stable list
 * built from video progress, not a media-ordering view). Uses renderList to
 * patch cards in-place when entries change.
 *
 * The component is one of two "secondary" rows (CW and What's New) that do
 * not flow through mediaOrdering+mediaManifest, so they don't subscribe via
 * subscribeView — only via streamingState.
 */

import { Component, createElement, renderList } from '../../../libs/ragot.esm.min.js';
import { tvIcon } from '../../../utils/icons.js';
import { buildRowShell, buildLoadingRow, ROW_SCROLL_AMOUNT } from './rowShell.js';
import { createContinueWatchingCard, updateContinueWatchingCard } from './cards.js';
import { streamingState } from './state.js';

export class ContinueWatchingRowComponent extends Component {
    constructor() {
        super({});
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._scrollHandlers = null;
        this._lastShape = null; // 'list' | 'loading' | 'empty'
    }

    render() {
        return this._buildShellForCurrentState();
    }

    onStart() {
        if (!this.element) return;
        streamingState.subscribe((_slice, s) => {
            this._reconcile(s.continueWatchingData || [], s.continueWatchingLoading === true);
        }, {
            owner: this,
            immediate: false,
            selector: (s) => `${(s.continueWatchingData || []).length}|${s.continueWatchingLoading === true ? 1 : 0}|${(s.continueWatchingData || []).map((item) => `${item?.videoUrl || ''}:${item?.videoTimestamp || 0}:${item?.videoDuration || 0}`).join(',')}`
        });
        if (this._lastShape === 'list') {
            this._wireScrollButtons();
        }
    }

    onStop() {
        this._clearScrollHandlers();
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
    }

    _buildShellForCurrentState() {
        const data = streamingState.state.continueWatchingData || [];
        const loading = streamingState.state.continueWatchingLoading === true;
        if (data.length > 0) {
            const { rowEl, scrollContainer, leftBtn, rightBtn } = buildRowShell(
                'Continue Watching', 'continue-watching', tvIcon(16), data.length, 0, null, null
            );
            renderList(
                scrollContainer,
                data,
                (item) => item.videoUrl,
                (item) => createContinueWatchingCard(item),
                updateContinueWatchingCard
            );
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
            return buildLoadingRow('continue-watching', 'Continue Watching', tvIcon(16), 4);
        }
        this._scrollContainer = null;
        this._leftBtn = null;
        this._rightBtn = null;
        this._lastShape = 'empty';
        return createElement('div', { id: 'row-continue-watching', style: { display: 'none' } });
    }

    _reconcile(data, loading) {
        if (!this.element) return;
        const desiredShape = data.length > 0 ? 'list' : (loading ? 'loading' : 'empty');

        if (desiredShape === 'list' && this._lastShape === 'list' && this._scrollContainer) {
            // In-place patch.
            renderList(
                this._scrollContainer,
                data,
                (item) => item.videoUrl,
                (item) => createContinueWatchingCard(item),
                updateContinueWatchingCard
            );
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
