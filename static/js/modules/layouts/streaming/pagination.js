/**
 * Pagination — renders and handles pagination controls for category rows
 *
 * Uses a factory pattern to receive `loadAndRender` and module accessor,
 * avoiding circular imports back to index.js.
 */

import {
    streamingState,
    setActivePage,
    getCategoryIdFilter,
    getSubfolderFilter,
    setCategoryIdFilter,
    setCategoryNameFilter,
    setSubfolderFilter,
    setParentNameFilter,
    setCategoryIdsFilter
} from './state.js';
import { updateCategoryFilterPill } from '../../ui/categoryFilterPill.js';
import { createElement, append } from '../../../libs/ragot.esm.min.js';

/**
 * @param {Object} deps
 * @param {Function} deps.loadAndRender — the main load-and-render function
 * @param {Function} deps.getModule — returns the StreamingLayoutModule singleton
 * @returns {{ renderPaginationControls: Function, handlePaginationClick: Function }}
 */
export function createPaginationHandlers({ loadAndRender, getModule }) {

    function renderPaginationControls() {
        const container = document.getElementById('streaming-container');
        if (!container) return;
        const totalPages = streamingState.state.totalPages;
        const activePage = streamingState.state.activePage;
        if (totalPages <= 1) {
            const existing = container.querySelector('.pagination-container');
            if (existing) existing.remove();
            return;
        }

        const maxVisible = 5;
        let startPage = Math.max(1, activePage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

        const makeBtn = (text, cls, dataPage, disabled) => createElement('button', {
            className: `pagination-btn ${cls}${disabled ? ' disabled' : ''}`,
            ...(dataPage !== null ? { dataset: { page: String(dataPage) } } : {}),
            ...(disabled ? { disabled: true } : {}),
            textContent: text
        });

        const pageChildren = [];
        if (startPage > 1) {
            pageChildren.push(makeBtn('1', 'pagination-page', 1, false));
            if (startPage > 2) pageChildren.push(createElement('span', { className: 'pagination-ellipsis', textContent: '…' }));
        }
        for (let i = startPage; i <= endPage; i++) {
            pageChildren.push(makeBtn(String(i), `pagination-page${i === activePage ? ' active' : ''}`, i, false));
        }
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) pageChildren.push(createElement('span', { className: 'pagination-ellipsis', textContent: '…' }));
            pageChildren.push(makeBtn(String(totalPages), 'pagination-page', totalPages, false));
        }

        const newEl = createElement('div', { className: 'pagination-container' },
            makeBtn('‹ Prev', 'pagination-prev', null, activePage <= 1),
            createElement('div', { className: 'pagination-pages' }, ...pageChildren),
            makeBtn('Next ›', 'pagination-next', null, activePage >= totalPages)
        );
        const existing = container.querySelector('.pagination-container');
        if (existing) existing.replaceWith(newEl);
        else append(container, newEl);
    }

    async function handlePaginationClick(e) {
        const target = e.target.closest('.pagination-btn');
        if (!target || target.disabled || target.classList.contains('active')) return;
        const page = target.dataset.page;
        if (page) setActivePage(parseInt(page));
        else if (target.classList.contains('pagination-prev')) setActivePage(Math.max(1, streamingState.state.activePage - 1));
        else if (target.classList.contains('pagination-next')) setActivePage(streamingState.state.activePage + 1);

        if (getCategoryIdFilter() !== null || getSubfolderFilter() !== null ||
            streamingState.state.parentNameFilter !== null || streamingState.state.categoryIdsFilter !== null) {
            setCategoryIdFilter(null);
            setCategoryNameFilter(null);
            setSubfolderFilter(null);
            setParentNameFilter(null);
            setCategoryIdsFilter(null);
            updateCategoryFilterPill(null);
        }
        const mod = getModule();
        if (mod._containerComp) mod._containerComp.scrollToTop();
        await loadAndRender(false, { refreshContinueWatching: false, refreshWhatsNew: false });
    }

    return { renderPaginationControls, handlePaginationClick };
}
