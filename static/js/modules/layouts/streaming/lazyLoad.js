import { getLazyLoadObserver, setLazyLoadObserver, streamingState } from './state.js';
import {
    createThumbnailLazyLoader,
    getAdaptiveRootMargin,
    isGeneratedThumbnailSrc,
    withThumbnailRetryParam
} from '../../../utils/mediaUtils.js';

let _loader = null;
let _loaderRoot = null;
let _observeRAF = null;
const _observeBuffer = [];
const _observeSet = new Set();

const getRootMargin = () => getAdaptiveRootMargin({ low: 1600, base: 2200, high: 2800, saveDataFloor: 1000, saveDataMult: 0.7 });

function viewportCenterY() {
    if (_loaderRoot && typeof _loaderRoot.getBoundingClientRect === 'function') {
        const rect = _loaderRoot.getBoundingClientRect();
        return (rect.top + rect.bottom) / 2;
    }
    return (window.innerHeight || document.documentElement.clientHeight || 0) / 2;
}

function distanceFromViewportCenter(img, centerY) {
    const rect = img.getBoundingClientRect();
    return Math.abs((rect.top + rect.bottom) / 2 - centerY);
}

function flushObservedImages() {
    _observeRAF = null;
    if (!_loader || _observeBuffer.length === 0) {
        _observeBuffer.length = 0;
        return;
    }

    const centerY = viewportCenterY();
    const drained = _observeBuffer.splice(0, _observeBuffer.length);
    // VS returns a detached chunk node from renderChunk and mounts it on a
    // later tick. If we filter out !isConnected here, every image in a newly
    // rendered chunk gets silently dropped before IO ever sees it — the card
    // shimmer never resolves. Re-queue disconnected images for the next RAF
    // instead so they get observed once the chunk lands in the DOM.
    const ready = [];
    for (const img of drained) {
        if (!img) continue;
        if (img.isConnected) {
            ready.push(img);
        } else {
            _observeBuffer.push(img);
        }
    }
    if (_observeBuffer.length > 0 && !_observeRAF) {
        _observeRAF = requestAnimationFrame(flushObservedImages);
    }
    ready.sort((a, b) => distanceFromViewportCenter(a, centerY) - distanceFromViewportCenter(b, centerY));
    ready.forEach((img) => _loader.observe(img));
}

function resetObserveScheduler() {
    if (_observeRAF) {
        cancelAnimationFrame(_observeRAF);
        _observeRAF = null;
    }
    _observeBuffer.length = 0;
    _observeSet.clear();
}

/**
 * Initialize streaming layout lazy loading
 */
export function initLazyLoading(root = null) {
    if (_loader && _loaderRoot === root) return;

    if (_loader) {
        resetObserveScheduler();
        _loader.destroy();
        _loader = null;
    }

    _loaderRoot = root;

    _loader = createThumbnailLazyLoader(streamingState, {
        selector: '.streaming-card-thumbnail[data-src]',
        root,
        rootMargin: getRootMargin(),
        concurrency: (navigator.deviceMemory || 4) <= 2 ? 4 : 8,
        retry: {
            maxAttempts: 5,
            baseDelayMs: 2000,
            backoffFactor: 2,
            shouldRetry: (img) => isGeneratedThumbnailSrc(img.src || img.dataset.src || ''),
            getNextSrc: (_img, attempt, currentSrc) => withThumbnailRetryParam(currentSrc, attempt),
            schedule: (fn, delayMs) => streamingState.timeout(fn, delayMs)
        }
    });

    setLazyLoadObserver(_loader);
}

export function observeLazyImage(img) {
    if (!_loader || !img || _observeSet.has(img)) return;
    _observeSet.add(img);
    _observeBuffer.push(img);
    if (!_observeRAF) {
        _observeRAF = requestAnimationFrame(flushObservedImages);
    }
}

export function resetLazyImage(img) {
    if (img) _observeSet.delete(img);
    if (_loader) _loader.reset(img);
}

export function primeLazyImage(img, options = {}) {
    if (_loader) _loader.prime(img, options);
}

/**
 * Re-scan the streaming container for any newly-injected lazy images.
 * Call after morphDOM rerenders rows (e.g. after hidden-content reveal or setState).
 */
export function refreshLazyLoader() {
    if (!_loader) return;
    const root = _loaderRoot || document;
    root.querySelectorAll?.('.streaming-card-thumbnail[data-src]').forEach((img) => observeLazyImage(img));
}

export function cleanupLazyLoading() {
    resetObserveScheduler();
    if (_loader) {
        _loader.destroy();
        _loader = null;
    }
    _loaderRoot = null;
    setLazyLoadObserver(null);
}
