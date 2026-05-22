/**
 * Streaming Layout - Hero Component
 *
 * StreamingHeroComponent owns the #streaming-hero DOM element.
 * It is adopted by StreamingLayoutModule (index.js) and receives state pushes
 * via streamingState.subscribe() whenever continueWatchingData or categoriesData changes.
 *
 * NO singletons. NO module-level mutable let. The module holds the ref.
 */

import { extractTitle, calculateProgress } from '../../../utils/layoutUtils.js';
import { appendShowHiddenParam } from '../../../utils/showHiddenManager.js';
import { playIcon } from '../../../utils/icons.js';
import {
    buildThumbnailImageAttrs,
    buildThumbnailPlaceholderLayerAttrs,
    attachDirectEagerThumbnail,
    setThumbnailPlaceholderState
} from '../../../utils/mediaUtils.js';
import { Component, createElement } from '../../../libs/ragot.esm.min.js';
import { openViewer, openViewerByUrl } from './navigation.js';

// ── StreamingHeroComponent ──────────────────────────────────────────────────

/**
 * State shape:
 *   continueWatchingData  — array from streamingState
 *   categoriesData        — array from streamingState
 */
export class StreamingHeroComponent extends Component {
    constructor() {
        super({
            continueWatchingData: [],
            categoriesData: [],
        });
        // Last rendered hero item — used to skip or surgically patch re-renders.
        this._lastHeroItem = null;
    }

    // ── Internal hero item resolution ──────────────────────────────────────

    _getHeroItem() {
        const { continueWatchingData, categoriesData } = this.state;

        // Priority 1: most recent Continue Watching item
        if (continueWatchingData.length > 0) {
            const item = continueWatchingData[0];
            const progress = calculateProgress(item.videoTimestamp, item.videoDuration);
            const title = extractTitle(item.videoUrl) || item.categoryName;
            return {
                categoryName: title,
                thumbnailUrl: item.thumbnailUrl,
                categoryId: item.categoryId,
                videoUrl: item.videoUrl,
                progress
            };
        }

        // Priority 2/3: use the first category's own thumbnail.
        // We intentionally do NOT use media[0].thumbnailUrl here — the category
        // thumbnail from /api/categories is available immediately (no cache needed)
        // and stays stable across row view hydration, preventing image flicker.
        if (categoriesData.length > 0) {
            const firstCat = categoriesData[0];
            const catName = firstCat.name;
            const catThumb = firstCat.thumbnailUrl || firstCat.thumbnail;

            return {
                categoryName: catName,
                thumbnailUrl: catThumb,
                categoryId: firstCat.id,
                index: 0,
                progress: 0
            };
        }

        return null;
    }

    /**
     * Override setState: resolve the new hero item first, then either:
     *   - do nothing (item identity unchanged)
     *   - surgically patch text/src nodes in-place (image/title/progress same structure)
     *   - fall through to super.setState for a full re-render (structure change)
     */
    setState(newState) {
        // Speculatively compute the incoming hero item without mutating this.state
        const prev = this.state;
        this.state = { ...prev, ...newState };
        const next = this._getHeroItem();
        this.state = prev;

        const last = this._lastHeroItem;

        // Nothing visible changed — skip entirely
        if (_heroItemsEqual(last, next)) return;

        // Guard against transient CW-clear flicker: if we currently show a CW item
        // (videoUrl set) and the incoming state has no CW but has category fallback,
        // don't downgrade — the CW data is being rebuilt and will arrive shortly.
        if (last?.videoUrl && !next?.videoUrl && next !== null) {
            this.state = { ...prev, ...newState };
            return;
        }

        // If the component is mounted and the image hasn't changed,
        // patch only the text nodes directly — never call super.setState so
        // morphDOM never runs and the image is never touched.
        if (this._isMounted && this.element && last !== null && next !== null &&
            last.thumbnailUrl === next.thumbnailUrl) {
            this._lastHeroItem = next;
            // Keep this.state in sync so future _getHeroItem calls are correct
            this.state = { ...prev, ...newState };
            this._patchText(next);
            return;
        }

        // Structure changed (different image, or null↔item transition) — full re-render
        this._lastHeroItem = next;
        super.setState(newState);
    }

    /**
     * Surgically update only the text/button nodes without touching the image.
     * Called when the image hasn't changed but title/progress/button-label might have.
     */
    _patchText(item) {
        if (!this.element) return;

        const titleEl = this.element.querySelector('.streaming-hero-title');
        const metaEl = this.element.querySelector('.streaming-hero-meta');
        const btn = this.element.querySelector('.streaming-hero-btn.primary');

        const titleText = item.categoryName || 'GhostHub';
        const metaText = item.progress ? `${Math.round(item.progress)}% watched` : 'Ready to watch';
        const btnLabel = item.progress ? ' Resume' : ' Play';

        if (titleEl && titleEl.textContent !== titleText) {
            titleEl.textContent = titleText;
        }
        if (metaEl && metaEl.textContent !== metaText) {
            metaEl.textContent = metaText;
        }
        if (btn) {
            // The button has [span(icon), textNode(label)] — patch just the text node
            const nodes = Array.from(btn.childNodes);
            const textNode = nodes.find(n => n.nodeType === Node.TEXT_NODE);
            if (textNode && textNode.nodeValue !== btnLabel) {
                textNode.nodeValue = btnLabel;
            }
            // Update the data-action attribute too (category may differ)
            if (btn.dataset.category !== String(item.categoryId)) {
                btn.dataset.category = item.categoryId;
            }
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────

    render() {
        const heroItem = this._getHeroItem();

        if (!heroItem) {
            return createElement('div', {
                className: 'streaming-hero',
                id: 'streaming-hero',
                style: { display: 'none' }
            });
        }

        const playAction = () => {
            if (heroItem.videoUrl) openViewerByUrl(heroItem.categoryId, heroItem.videoUrl);
            else openViewer(heroItem.categoryId, 0);
        };

        const children = [];

        if (heroItem.thumbnailUrl) {
            const finalSrc = appendShowHiddenParam(heroItem.thumbnailUrl);
            children.push(createElement('div', buildThumbnailPlaceholderLayerAttrs({
                className: 'streaming-hero-placeholder',
                state: 'pending'
            })));
            const imgAttrs = buildThumbnailImageAttrs({
                className: 'streaming-hero-backdrop gh-img-reveal',
                finalSrc,
                eager: true,
                eagerMode: 'direct',
                fetchPriority: 'low',
                showPendingState: false
            });
            const heroImg = createElement('img', imgAttrs);
            attachDirectEagerThumbnail(heroImg, {
                finalSrc,
                onPending: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'pending' }),
                onLoad: (img) => setThumbnailPlaceholderState(img, { visible: false, state: 'loaded' }),
                onError: (img) => setThumbnailPlaceholderState(img, { visible: true, state: 'error' }),
                preservePlaceholderOnError: true
            });
            children.push(heroImg);
        }

        children.push(createElement('div', { className: 'streaming-hero-content' },
            createElement('h1', { className: 'streaming-hero-title', textContent: heroItem.categoryName || 'GhostHub' }),
            createElement('div', {
                className: 'streaming-hero-meta',
                textContent: heroItem.progress ? `${Math.round(heroItem.progress)}% watched` : 'Ready to watch'
            }),
            createElement('div', { className: 'streaming-hero-actions' },
                createElement('button', {
                    className: 'streaming-hero-btn primary',
                    dataset: { action: 'play', category: heroItem.categoryId },
                    onClick: playAction
                },
                    createElement('span', { innerHTML: playIcon(20, null, 'currentColor') }),
                    heroItem.progress ? ' Resume' : ' Play'
                )
            )
        ));

        return createElement('div', {
            className: 'streaming-hero',
            id: 'streaming-hero',
            dataset: { thumbnailHost: '' }
        }, ...children);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    onStart() {
        // Capture initial hero item so subsequent setState calls can diff against it
        this._lastHeroItem = this._getHeroItem();
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if two resolved hero items are visually identical.
 * null === null is also equal.
 */
function _heroItemsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.thumbnailUrl === b.thumbnailUrl &&
        a.categoryName === b.categoryName &&
        a.videoUrl === b.videoUrl &&
        // Round progress to nearest integer to avoid re-renders from sub-percent drift
        Math.round(a.progress || 0) === Math.round(b.progress || 0)
    );
}
