/**
 * Streaming Layout - Card Factories
 *
 * Pure factory functions that create card DOM elements.
 * No lifecycle ownership — cards are created and owned by the row/grid components.
 * ThumbnailProgress callbacks are tracked externally so callers can unregister on eviction.
 */

import { extractTitle, calculateProgress, urlsMatch } from '../../../utils/layoutUtils.js';
import { videoIcon, folderIcon } from '../../../utils/icons.js';
import { appendShowHiddenParam } from '../../../utils/showHiddenManager.js';
import {
    buildThumbnailImageAttrs,
    buildThumbnailPlaceholderLayerAttrs,
    attachDirectEagerThumbnail,
    createThumbnailShell,
    setThumbnailImageState,
    setThumbnailPlaceholderState
} from '../../../utils/mediaUtils.js';
import { getVideoProgressMap } from './state.js';
import { observeLazyImage } from './lazyLoad.js';
import { openViewerByUrl } from './navigation.js';
import ThumbnailProgress from '../../shared/thumbnailProgress.js';
import { createSimpleProgressBar, updateSimpleProgressBar } from '../../shared/thumbnailProgressUI.js';
import { createElement, clear, append, insertBefore, $ } from '../../../libs/ragot.esm.min.js';

function createThumbnailPlaceholderLayer(className = '', state = 'pending') {
    return createElement('div', buildThumbnailPlaceholderLayerAttrs({ className, state }));
}

function setThumbnailLoadedState(img) {
    if (!img) return;
    setThumbnailImageState(img, 'loaded');
    setThumbnailPlaceholderState(img, { visible: false, state: 'loaded' });
}

function shouldTrackThumbnailProgress(media, categoryId) {
    if (!media?.url || media.type !== 'video') return false;
    if (!media.thumbnailUrl) return true;

    const status = ThumbnailProgress.getThumbnailStatus(categoryId);
    if (!status || (status.status !== 'generating' && status.status !== 'pending')) return false;
    return Boolean(status.mediaUrl && urlsMatch(status.mediaUrl, media.url));
}

// ── Continue Watching card ───────────────────────────────────────────────────

/**
 * Create a Continue Watching card for an individual video.
 * @param {Object} item
 * @returns {HTMLElement}
 */
export function createContinueWatchingCard(item, index = 0, options = {}) {
    const { showPlaceholderShell = true } = options;
    const title = extractTitle(item.videoUrl) || item.categoryName || 'Video';
    const progressPercent = calculateProgress(item.videoTimestamp, item.videoDuration);
    const finalThumbnailSrc = item.thumbnailUrl ? appendShowHiddenParam(item.thumbnailUrl) : null;

    const card = createElement('div', {
        className: 'streaming-card gh-stagger continue-watching-card',
        tabIndex: index === 0 ? 0 : -1,
        role: 'link',
        style: { '--card-index': index },
        dataset: { videoUrl: item.videoUrl || '' },
        onClick: () => {
            if (item.videoUrl && item.categoryId) {
                openViewerByUrl(item.categoryId, item.videoUrl);
            }
        }
    });

    const thumbWrap = createThumbnailShell({
        shellClassName: 'streaming-card-thumb-wrap',
        finalSrc: finalThumbnailSrc,
        includePlaceholder: showPlaceholderShell,
        alt: title,
        imageClassName: 'streaming-card-thumbnail gh-img-reveal',
        eager: true,
        eagerMode: 'direct',
        showPendingState: false
    });
    if (item.thumbnailUrl) {
        let thumbImg = $('img.streaming-card-thumbnail', thumbWrap);
        if (!thumbImg && !showPlaceholderShell) {
            thumbImg = createElement('img', buildThumbnailImageAttrs({
                className: 'gh-thumbnail-image streaming-card-thumbnail gh-img-reveal',
                finalSrc: finalThumbnailSrc,
                alt: title,
                eager: true,
                eagerMode: 'direct',
                showPendingState: false
            }));
            append(thumbWrap, thumbImg);
        }
        attachDirectEagerThumbnail(thumbImg, {
            finalSrc: finalThumbnailSrc,
            onPending: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'pending' }),
            onLoad: setThumbnailLoadedState,
            onError: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'error' }),
            preservePlaceholderOnError: showPlaceholderShell
        });
    }

    append(thumbWrap, createElement('div', {
        className: 'streaming-card-progress',
        children: [createElement('div', {
            className: 'streaming-card-progress-fill',
            style: { width: `${progressPercent}%` }
        })]
    }));

    append(card,
        thumbWrap,
        createElement('div', {
            className: 'streaming-card-info',
            children: [createElement('div', {
                className: 'streaming-card-title',
                title,
                textContent: title
            })]
        })
    );

    return card;
}

/**
 * Patch an existing Continue Watching card in place when keyed row items refresh.
 * @param {HTMLElement} card
 * @param {Object} item
 */
export function updateContinueWatchingCard(card, item) {
    if (!card || !item) return;

    const title = extractTitle(item.videoUrl) || item.categoryName || 'Video';
    const progressPercent = calculateProgress(item.videoTimestamp, item.videoDuration);
    const finalThumbnailSrc = item.thumbnailUrl ? appendShowHiddenParam(item.thumbnailUrl) : null;

    card.dataset.videoUrl = item.videoUrl || '';

    const titleEl = $('.streaming-card-title', card);
    if (titleEl) {
        titleEl.textContent = title;
        titleEl.title = title;
    }

    const thumbWrap = $('.streaming-card-thumb-wrap', card);
    if (thumbWrap && finalThumbnailSrc) {
        let thumbImg = $('img.streaming-card-thumbnail', thumbWrap);
        if (!thumbImg) {
            thumbImg = createElement('img', buildThumbnailImageAttrs({
                className: 'gh-thumbnail-image streaming-card-thumbnail gh-img-reveal',
                finalSrc: finalThumbnailSrc,
                alt: title,
                eager: true,
                eagerMode: 'direct',
                showPendingState: false
            }));
            append(thumbWrap, thumbImg);
        } else {
            thumbImg.alt = title;
        }

        const currentSrc = thumbImg.dataset.eagerSrc || thumbImg.currentSrc || thumbImg.getAttribute('src');
        if (currentSrc !== finalThumbnailSrc) {
            attachDirectEagerThumbnail(thumbImg, {
                finalSrc: finalThumbnailSrc,
                onPending: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'pending' }),
                onLoad: setThumbnailLoadedState,
                onError: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'error' }),
                preservePlaceholderOnError: true
            });
        }
    }

    updateCardProgress(card, progressPercent);
}

// ── Media item card ──────────────────────────────────────────────────────────

/**
 * Create a media item card for a category row or grid.
 *
 * @param {Object} media
 * @param {string} categoryId
 * @param {number} index
 * @param {Object} options
 * @param {boolean} options.forceEager  - Skip lazy loader for first above-fold cards
 * @param {Set}    [options.unregisterSet] - If provided, ThumbnailProgress unregister fns are added here
 * @returns {HTMLElement}
 */
export function createMediaItemCard(media, categoryId, index, options = {}) {
    const {
        forceEager = false,
        eagerModeOverride = null,
        unregisterSet = null,
        showPlaceholderShell = true
    } = options;

    const filename = media.displayName || media.name || media.filename || 'Untitled';
    const displayTitle = filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
    const isVideo = media.type === 'video';
    const thumbnailUrl = isVideo ? (media.thumbnailUrl || null) : (media.thumbnailUrl || media.url);
    const shouldEager = forceEager && !!thumbnailUrl;
    const eagerMode = eagerModeOverride || 'direct';
    const finalThumbnailSrc = thumbnailUrl ? appendShowHiddenParam(thumbnailUrl) : null;

    // Progress bar from video progress map
    let progressPercent = 0;
    if (isVideo && media.url) {
        const vpm = getVideoProgressMap();
        let vp = vpm[media.url];
        if (!vp) { try { vp = vpm[encodeURI(media.url)]; } catch (_) { /* ignore */ } }
        if (!vp) { try { vp = vpm[decodeURIComponent(media.url)]; } catch (_) { /* ignore */ } }
        if (vp && vp.video_timestamp > 0 && vp.video_duration > 0) {
            progressPercent = calculateProgress(vp.video_timestamp, vp.video_duration);
        }
    }

    const card = createElement('div', {
        className: 'streaming-card gh-stagger',
        tabIndex: index === 0 ? 0 : -1,
        role: 'link',
        style: { '--card-index': index },
        dataset: {
            categoryId,
            index,
            mediaUrl: media.url || '',
            mediaType: media.type || 'unknown',
            // Stable id beats URL: indexOf in the manifest's orderedIds is
            // exact (no encoding/normalize ambiguity, no closure staleness).
            recordId: media.id || '',
        },
        onClick: (e) => {
            const el = e.currentTarget || card;
            openViewerByUrl(
                el.dataset.categoryId || categoryId,
                el.dataset.mediaUrl || media.url,
                el.dataset.recordId || media.id || null,
            );
        }
    });

    const thumbWrap = createThumbnailShell({
        shellClassName: 'streaming-card-thumb-wrap',
        finalSrc: finalThumbnailSrc,
        includePlaceholder: showPlaceholderShell,
        alt: displayTitle,
        imageClassName: 'streaming-card-thumbnail gh-img-reveal',
        eager: shouldEager,
        eagerMode,
        showPendingState: false,
        fetchPriority: 'low'
    });

    if (thumbnailUrl && !showPlaceholderShell) {
        append(thumbWrap, createElement('img', buildThumbnailImageAttrs({
            className: 'gh-thumbnail-image streaming-card-thumbnail gh-img-reveal',
            finalSrc: finalThumbnailSrc,
            alt: displayTitle,
            eager: shouldEager,
            eagerMode,
            showPendingState: false,
            fetchPriority: 'low'
        })));
    }

    // Thumbnail generation progress slot (for videos without a thumbnail yet)
    append(thumbWrap, createElement('div', { className: 'streaming-card-thumbnail-progress' }));

    if (isVideo) {
        append(thumbWrap, createElement('span', { className: 'streaming-card-type-badge', textContent: '▶' }));
    }

    if (progressPercent > 0 && progressPercent < 100) {
        append(thumbWrap, createElement('div', {
            className: 'streaming-card-progress',
            children: [createElement('div', {
                className: 'streaming-card-progress-fill',
                style: { width: `${progressPercent}%` }
            })]
        }));
    }

    append(card,
        thumbWrap,
        createElement('div', {
            className: 'streaming-card-info',
            children: [createElement('div', {
                className: 'streaming-card-title',
                title: displayTitle,
                textContent: displayTitle
            })]
        })
    );

    // Eager: attach retry; lazy: lazyLoad.js handles error
    const cardImg = $('img.streaming-card-thumbnail', card);
    if (cardImg && shouldEager) {
        attachDirectEagerThumbnail(cardImg, {
            finalSrc: finalThumbnailSrc,
            onPending: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'pending' }),
            onLoad: setThumbnailLoadedState,
            onError: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'error' }),
            preservePlaceholderOnError: showPlaceholderShell
        });
    }

    const lazyImg = $('img.lazy', card);
    if (lazyImg) {
        observeLazyImage(lazyImg);
    }

    // ThumbnailProgress tracking for videos still generating
    if (shouldTrackThumbnailProgress(media, categoryId)) {
        const progressContainer = $('.streaming-card-thumbnail-progress', card);
        if (progressContainer) {
            const progressBar = createSimpleProgressBar({ categoryId, showPercentage: true });
            append(progressContainer, progressBar);

            const unregister = ThumbnailProgress.registerCallback(categoryId, (status) => {
                if (!card.isConnected) { unregister(); return; }
                updateSimpleProgressBar(progressBar, status);
                if (status.thumbnailUrl && status.mediaUrl && urlsMatch(status.mediaUrl, media.url)) {
                    _updateCardThumbnail(card, status.thumbnailUrl);
                    unregister();
                    if (unregisterSet) unregisterSet.delete(unregister);
                }
                if (status.status === 'complete' || status.status === 'idle') {
                    unregister();
                    if (unregisterSet) unregisterSet.delete(unregister);
                }
            }, {
                mediaUrl: media.url || null
            });

            if (unregisterSet) unregisterSet.add(unregister);
        }
    }

    return card;
}

// ── Internal thumbnail update ────────────────────────────────────────────────

function _updateCardThumbnail(card, thumbnailUrl) {
    if (!card || !thumbnailUrl) return;
    const thumbWrap = $('.streaming-card-thumb-wrap', card);
    if (!thumbWrap) return;

    const finalSrc = appendShowHiddenParam(thumbnailUrl);
    let img = $('img.streaming-card-thumbnail', thumbWrap);

    if (!img) {
        if (!$('.gh-thumbnail-placeholder-layer', thumbWrap)) {
            append(thumbWrap, createThumbnailPlaceholderLayer());
        }
        img = createElement('img', buildThumbnailImageAttrs({
            className: 'gh-thumbnail-image streaming-card-thumbnail gh-img-reveal',
            finalSrc,
            alt: $('.streaming-card-title', card)?.title || '',
            eager: true,
            eagerMode: 'direct',
            showPendingState: false
        }));
        const progressContainer = $('.streaming-card-thumbnail-progress', thumbWrap);
        insertBefore(thumbWrap, img, progressContainer);
    }

    img.removeAttribute('hidden');
    img.classList.remove('lazy', 'lazy-load');
    delete img.dataset.src;
    delete img.dataset.imageState;
    img.dataset.eagerSrc = finalSrc;
    attachDirectEagerThumbnail(img, {
        finalSrc,
        onPending: (node) => setThumbnailPlaceholderState(node, { visible: true, state: 'pending' }),
        onLoad: setThumbnailLoadedState,
        onError: (node) => setThumbnailPlaceholderState(node, { visible: true, state: 'error' }),
        preservePlaceholderOnError: true
    });
    setThumbnailPlaceholderState(img, { visible: true, state: 'pending' });

    const progressContainer = $('.streaming-card-thumbnail-progress', card);
    if (progressContainer) clear(progressContainer);
}

// ── Progress bar update ──────────────────────────────────────────────────────

/**
 * Update or create a progress bar on an existing media card.
 * @param {HTMLElement} card
 * @param {number} progressPercent - 0-100
 */
export function updateCardProgress(card, progressPercent) {
    if (!card) return;
    let progressBar = $('.streaming-card-progress', card);
    const hasProgress = progressPercent > 0 && progressPercent < 100;

    if (hasProgress) {
        if (!progressBar) {
            progressBar = createElement('div', {
                className: 'streaming-card-progress',
                children: [createElement('div', {
                    className: 'streaming-card-progress-fill',
                    style: { width: `${progressPercent}%` }
                })]
            });
            const infoSection = $('.streaming-card-info', card);
            if (infoSection) insertBefore(card, progressBar, infoSection);
            else append(card, progressBar);
        } else {
            const fill = $('.streaming-card-progress-fill', progressBar);
            if (fill) fill.style.width = `${progressPercent}%`;
        }
    } else if (progressBar) {
        progressBar.remove();
    }
}

// ── Subfolder card ───────────────────────────────────────────────────────────

/**
 * Create a subfolder navigation card.
 * @param {Object} subfolder - { name, count, containsVideo, thumbnailUrl, categoryId }
 * @param {Function} onClickHandler - (categoryId, subfolderName)
 * @param {number} index
 * @returns {HTMLElement}
 */
export function createSubfolderCard(subfolder, onClickHandler, index = 0) {
    const displayName = subfolder.name
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    const countLabel = subfolder.count === 1 ? '1 item' : `${subfolder.count} items`;
    const finalThumbnailSrc = subfolder.thumbnailUrl
        ? appendShowHiddenParam(subfolder.thumbnailUrl)
        : null;

    const card = createElement('div', {
        className: 'streaming-card streaming-subfolder-card',
        tabIndex: index === 0 ? 0 : -1,
        role: 'link',
        style: { '--card-index': index },
        dataset: { categoryId: subfolder.categoryId, subfolderName: subfolder.name },
        onClick: () => { if (onClickHandler) onClickHandler(subfolder.categoryId, subfolder.name); }
    });

    const thumbWrap = createThumbnailShell({
        shellClassName: 'streaming-card-thumb-wrap subfolder-thumb-wrap',
        placeholderClassName: 'subfolder-placeholder',
        finalSrc: finalThumbnailSrc,
        alt: displayName,
        imageClassName: 'subfolder-thumb-img gh-img-reveal',
        eager: true,
        eagerMode: 'direct',
        showPendingState: false
    });

    if (finalThumbnailSrc) {
        const thumbImg = $('img.subfolder-thumb-img', thumbWrap);
        attachDirectEagerThumbnail(thumbImg, {
            finalSrc: finalThumbnailSrc,
            onPending: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'pending' }),
            onLoad: setThumbnailLoadedState,
            onError: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'error' }),
            preservePlaceholderOnError: true
        });
    }

    append(thumbWrap, createElement('div', {
        className: 'subfolder-placeholder-overlay',
        children: [
            createElement('div', { className: 'subfolder-icon', innerHTML: folderIcon(24) }),
            createElement('div', { className: 'subfolder-count', textContent: countLabel })
        ]
    }));

    append(card,
        thumbWrap,
        createElement('div', {
            className: 'streaming-card-info',
            children: [createElement('div', {
                className: 'streaming-card-title subfolder-title',
                title: displayName,
                textContent: displayName
            })]
        })
    );

    return card;
}
