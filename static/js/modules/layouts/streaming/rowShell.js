/**
 * Streaming Layout - Row Shell Helpers
 *
 * Pure DOM and projection helpers shared by every streaming row Component.
 * Has no state reads, no module state writes, and no lifecycle ownership.
 */

import { videoIcon, imageIcon, userIcon, usersIcon, folderFilledIcon } from '../../../utils/icons.js';
import { buildThumbnailPlaceholderLayerAttrs } from '../../../utils/mediaUtils.js';
import { createElement, append } from '../../../libs/ragot.esm.min.js';

export const CARDS_PER_CHUNK = 20;
export const MAX_CHUNKS = 5;
export const ROW_SCROLL_AMOUNT = 400;
export const ROW_PREFETCH_MULTIPLIER = 2;
export const THUMB_PRIME_BUFFER_PX = 520;

// Pre-load well outside the visible edge so rows feel populated before the
// user lands on the next shelf segment. One chunk (20 cards) is roughly
// 3500-4000px wide, so 1200px lookahead built the next chunk only after the
// user had scrolled into it. Bump to >1 chunk-width so renderChunk + image
// observation complete before the cards enter the viewport.
export const H_ROOT_MARGIN = '0px 4800px 0px 4800px';

export function shouldPrefetchNextChunk(scrollLeft, clientWidth, scrollWidth, multiplier = ROW_PREFETCH_MULTIPLIER) {
    return scrollLeft + clientWidth * multiplier >= scrollWidth;
}

export function isWithinPrimeWindow(rectLeft, rectRight, viewportWidth, bufferPx = THUMB_PRIME_BUFFER_PX) {
    return rectRight >= -bufferPx && rectLeft <= viewportWidth + bufferPx;
}

function formatPathSegment(segment) {
    return String(segment || '').trim().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getRowHeaderMeta(category, activeSubfolderFilter) {
    const name = category?.name || '';

    if (activeSubfolderFilter) {
        const parts = activeSubfolderFilter.split('/').map(formatPathSegment).filter(Boolean);
        return {
            title: parts[parts.length - 1] || name,
            breadcrumbPath: [name, ...parts.slice(0, -1)].filter(Boolean).join(' > ') || null
        };
    }

    const parenMatch = name.match(/^(.+?)\s*\((.+)\)$/);
    if (parenMatch) {
        return { title: parenMatch[1].trim(), breadcrumbPath: parenMatch[2].trim() };
    }

    return { title: name, breadcrumbPath: null };
}

export function filterMediaItems(mediaItems, mediaFilter) {
    if (!mediaFilter || mediaFilter === 'all') return mediaItems;
    return mediaItems.filter((m) => {
        const type = m?.type || (m?.url?.match(/\.(mp4|webm|mkv|avi|mov)$/i) ? 'video' : 'image');
        return mediaFilter === 'video' ? type === 'video' : type === 'image';
    });
}

export function buildRowShell(title, rowId, icon, count, activeUsers, categoryId, breadcrumbPath) {
    const countText = count === 1 ? '1 item' : `${count} items`;

    const leftBtn = createElement('button', {
        className: 'streaming-row-scroll-btn left at-start',
        'aria-label': 'Scroll left',
        innerHTML: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>'
    });
    const rightBtn = createElement('button', {
        className: 'streaming-row-scroll-btn right',
        'aria-label': 'Scroll right',
        innerHTML: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>'
    });
    const scrollContainer = createElement('div', { className: 'streaming-scroll-container' });
    const subfolderContainer = createElement('div', { className: 'streaming-subfolder-strip', hidden: true });
    const mediaContainer = createElement('div', { className: 'streaming-media-strip' });
    append(scrollContainer, [subfolderContainer, mediaContainer]);

    const rowEl = createElement('div', {
        className: 'streaming-row',
        id: `row-${rowId}`,
        ...(categoryId ? { dataset: { categoryId } } : {})
    });

    append(rowEl,
        createElement('div', { className: 'streaming-row-header' },
            createElement('div', { className: 'streaming-row-title-group' },
                createElement('h2', { className: 'streaming-row-title' },
                    createElement('span', { className: 'row-icon', innerHTML: icon }),
                    createElement('span', { className: 'streaming-row-title-text', textContent: ` ${title} ` }),
                    createElement('span', { className: 'streaming-row-count', textContent: `(${countText})` }),
                    activeUsers > 0 ? createElement('span', {
                        className: 'streaming-row-activity',
                        innerHTML: `${activeUsers === 1 ? userIcon(14) : usersIcon(14)} ${activeUsers} watching`
                    }) : null
                ),
                breadcrumbPath ? createElement('div', { className: 'streaming-row-breadcrumb', title: breadcrumbPath },
                    createElement('span', { className: 'streaming-row-breadcrumb-icon', innerHTML: folderFilledIcon(12) }),
                    createElement('span', { className: 'streaming-row-breadcrumb-path', textContent: breadcrumbPath })
                ) : null
            ),
            categoryId ? createElement('div', { className: 'streaming-row-progress-container' }) : null
        ),
        leftBtn,
        scrollContainer,
        rightBtn
    );

    return { rowEl, scrollContainer, subfolderContainer, mediaContainer, leftBtn, rightBtn };
}

export function buildLoadingCard(index) {
    return createElement('div', {
        className: 'streaming-card streaming-card-skeleton',
        style: { '--card-index': index },
        'aria-hidden': 'true'
    },
        createElement('div', {
            className: 'streaming-card-thumb-wrap',
            dataset: { thumbnailHost: '' }
        },
            createElement('div', buildThumbnailPlaceholderLayerAttrs({
                className: 'streaming-card-skeleton-placeholder',
                state: 'pending'
            }))
        ),
        createElement('div', { className: 'streaming-card-info' },
            createElement('div', { className: 'streaming-card-title streaming-card-skeleton-line' }),
            createElement('div', { className: 'streaming-card-meta streaming-card-skeleton-line short' })
        )
    );
}

export function buildLoadingRow(rowId, title, icon, cardCount = 6) {
    const { rowEl, scrollContainer } = buildRowShell(title, rowId, icon, cardCount, 0, null, null);
    for (let i = 0; i < cardCount; i++) {
        append(scrollContainer, buildLoadingCard(i));
    }
    return rowEl;
}

export function rowIconForCategory(category, hasVideos) {
    if (hasVideos) return videoIcon(18);
    if (category?.containsVideo) return videoIcon(18);
    return imageIcon(18);
}
