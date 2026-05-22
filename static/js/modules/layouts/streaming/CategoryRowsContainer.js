/**
 * Streaming Layout - Rows Container Component
 *
 * Sole owner of the rows root inside #streaming-content-container. Subscribes
 * to streamingState with a selector that produces a fingerprint of:
 *   isLoading
 *   the ordered (categoryId, activeSubfolder, viewKey) tuples
 *   mediaFilter
 *
 * On every fingerprint change the container diffs its child set against the
 * desired list and mounts/unmounts ONLY the rows whose identity changed.
 * No view-data setState is ever pushed down — each child subscribes via
 * subscribeView for its own viewKey, and CW/WN subscribe to streamingState
 * for their lists.
 */

import { Component, createElement, append, clear } from '../../../libs/ragot.esm.min.js';
import { videoIcon, tvIcon, sparkleIcon } from '../../../utils/icons.js';
import { buildLoadingRow } from './rowShell.js';
import { CategoryRowComponent } from './CategoryRowComponent.js';
import { ContinueWatchingRowComponent } from './ContinueWatchingRowComponent.js';
import { WhatsNewRowComponent } from './WhatsNewRowComponent.js';
import { streamingState } from './state.js';
import { selectView } from '../../media/selectors.js';

function resolveActiveSubfolder(state, category) {
    return (state.subfolderFilter && state.categoryIdFilter === category?.id)
        ? state.subfolderFilter
        : null;
}

function fingerprintRow(state, category) {
    const activeSubfolder = resolveActiveSubfolder(state, category);
    const viewKey = category?.viewKey || '';
    return `${category?.id || ''}|${activeSubfolder || ''}|${viewKey}`;
}

function hasIndexingActivity(state) {
    const categories = state.categoriesData || [];
    if (!categories.length) return false;
    return categories.some((cat) => {
        if (cat?.asyncIndexing === true) return true;
        if (cat?.viewStatus === 'fetching') return true;
        const view = cat?.viewKey ? selectView(cat.viewKey) : null;
        return view?.status === 'fetching';
    });
}

export class CategoryRowsContainerComponent extends Component {
    constructor() {
        super({});
        this._cwComp = null;
        this._wnComp = null;
        // Map of fingerprint → CategoryRowComponent
        this._rows = new Map();
        // Last shape so we can short-circuit redundant DOM work.
        this._lastShape = null; // 'rows' | 'loading' | 'empty'
    }

    render() {
        return createElement('div', { className: 'streaming-rows-root' });
    }

    onStart() {
        if (!this.element) return;
        // Mount CW/WN once. They subscribe to streamingState themselves.
        this._cwComp = new ContinueWatchingRowComponent();
        this._cwComp.mount(this.element);

        this._wnComp = new WhatsNewRowComponent();
        this._wnComp.setShowLoadingFn(() => hasIndexingActivity(streamingState.state));
        this._wnComp.mount(this.element);

        this._reconcile(streamingState.state);

        streamingState.subscribe((_slice, s) => this._reconcile(s), {
            owner: this,
            immediate: false,
            selector: (s) => {
                const cats = s.categoriesData || [];
                const tuples = cats.map((c) => fingerprintRow(s, c)).join(';');
                return `${s.isLoading ? 1 : 0}|${s.mediaFilter || 'all'}|${cats.length}|${tuples}`;
            }
        });

        // Delegated keyboard navigation (roving tabindex) across all rows.
        this.on(this.element, 'keydown', (e) => this._onKeyDown(e));
    }

    onStop() {
        for (const comp of this._rows.values()) {
            try { comp.unmount(); } catch (_) { /* ignore */ }
        }
        this._rows.clear();
        if (this._cwComp) { try { this._cwComp.unmount(); } catch (_) { /* ignore */ } this._cwComp = null; }
        if (this._wnComp) { try { this._wnComp.unmount(); } catch (_) { /* ignore */ } this._wnComp = null; }
    }

    _reconcile(state) {
        if (!this.element) return;
        const categories = state.categoriesData || [];
        const isLoading = state.isLoading === true;

        if (categories.length === 0 && isLoading) {
            this._showLoadingShape();
            return;
        }
        if (categories.length === 0 && !isLoading) {
            this._showEmptyShape();
            return;
        }
        this._showRowsShape(state, categories);
    }

    _showLoadingShape() {
        if (this._lastShape === 'loading') return;
        this._teardownCategoryRows();
        this._removeShape('rows-loading');
        this._removeShape('rows-empty');
        const wrap = createElement('div', { dataset: { rowsShape: 'rows-loading' } });
        append(wrap, buildLoadingRow('loading-0', 'Loading Library', sparkleIcon(16)));
        append(wrap, buildLoadingRow('loading-1', 'Loading Shows', tvIcon(16)));
        append(wrap, buildLoadingRow('loading-2', 'Loading Movies', videoIcon(16)));
        append(this.element, wrap);
        this._lastShape = 'loading';
    }

    _showEmptyShape() {
        if (this._lastShape === 'empty') return;
        this._teardownCategoryRows();
        this._removeShape('rows-loading');
        this._removeShape('rows-empty');
        const wrap = createElement('div', { dataset: { rowsShape: 'rows-empty' } },
            createElement('div', { className: 'streaming-no-media' },
                createElement('p', { className: 'streaming-no-media-title', textContent: 'No media yet' }),
                createElement('p', { className: 'streaming-no-media-sub', textContent: 'Add a media folder in the admin panel to get started.' })
            )
        );
        append(this.element, wrap);
        this._lastShape = 'empty';
    }

    _removeShape(name) {
        const el = this.element?.querySelector(`[data-rows-shape="${name}"]`);
        if (el) el.remove();
    }

    _showRowsShape(state, categories) {
        // Tear down the loading/empty placeholder shape if we're coming from it.
        this._removeShape('rows-loading');
        this._removeShape('rows-empty');
        this._lastShape = 'rows';

        const desired = categories.map((category, idx) => ({
            fingerprint: fingerprintRow(state, category),
            category,
            activeSubfolder: resolveActiveSubfolder(state, category),
            viewKey: category?.viewKey || null,
            rowOrder: idx,
            mediaFilter: state.mediaFilter || 'all'
        }));
        const desiredKeys = new Set(desired.map((entry) => entry.fingerprint));

        // Unmount rows whose identity disappeared (page change, filter, viewKey rotation).
        for (const [key, comp] of this._rows) {
            if (!desiredKeys.has(key)) {
                try { comp.unmount(); } catch (_) { /* ignore */ }
                this._rows.delete(key);
            }
        }

        // Walk the desired list in order, ensuring DOM matches.
        // The header rows (CW, WN) are children of `this.element` and stay pinned
        // at the top of the container — we operate beyond them.
        let anchor = this._wnComp?.element || this._cwComp?.element || null;
        for (const entry of desired) {
            let comp = this._rows.get(entry.fingerprint);
            if (!comp) {
                comp = new CategoryRowComponent({
                    category: entry.category,
                    activeSubfolder: entry.activeSubfolder,
                    viewKey: entry.viewKey,
                    rowOrder: entry.rowOrder,
                    mediaFilter: entry.mediaFilter
                });
                comp.mount(this.element);
                this._rows.set(entry.fingerprint, comp);
            }
            // Reorder DOM in place if needed.
            const compEl = comp.element;
            if (compEl && compEl.parentNode === this.element) {
                const expectedNext = anchor ? anchor.nextSibling : this.element.firstChild;
                if (compEl !== expectedNext) {
                    this.element.insertBefore(compEl, anchor ? anchor.nextSibling : this.element.firstChild);
                }
                anchor = compEl;
            } else if (compEl) {
                anchor = compEl;
            }
        }
    }

    _teardownCategoryRows() {
        for (const comp of this._rows.values()) {
            try { comp.unmount(); } catch (_) { /* ignore */ }
        }
        this._rows.clear();
    }

    _onKeyDown(e) {
        const card = e.target.closest('.streaming-card');
        if (!card) return;
        const scrollContainer = card.closest('.streaming-scroll-container');
        if (!scrollContainer) return;

        let target = null;
        if (e.key === 'ArrowRight') {
            target = card.nextElementSibling;
            while (target && !target.classList.contains('streaming-card')) target = target.nextElementSibling;
        } else if (e.key === 'ArrowLeft') {
            target = card.previousElementSibling;
            while (target && !target.classList.contains('streaming-card')) target = target.previousElementSibling;
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const row = scrollContainer.closest('.streaming-row');
            const otherRow = e.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling;
            if (otherRow) {
                const otherCards = otherRow.querySelectorAll('.streaming-card');
                const cards = scrollContainer.querySelectorAll('.streaming-card');
                const idx = Array.prototype.indexOf.call(cards, card);
                target = otherCards[Math.min(idx, otherCards.length - 1)] || null;
            }
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
            return;
        }
        if (target) {
            e.preventDefault();
            card.setAttribute('tabindex', '-1');
            target.setAttribute('tabindex', '0');
            target.focus();
            target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
}
