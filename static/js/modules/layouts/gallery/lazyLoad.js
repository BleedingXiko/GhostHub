import { setLazyLoadObserver, galleryState } from './state.js';
import { createThumbnailLazyLoader, getAdaptiveRootMargin, isGeneratedThumbnailSrc, withThumbnailRetryParam } from '../../../utils/mediaUtils.js';

let _loader = null;

const getRootMargin = () => getAdaptiveRootMargin({ low: 900, base: 1200, high: 1600, saveDataFloor: 700 });

/**
 * Initialize gallery layout lazy loading
 */
export function initLazyLoading() {
    if (_loader) return;

    _loader = createThumbnailLazyLoader(galleryState, {
        selector: '.gallery-item-thumbnail[data-src]',
        rootMargin: getRootMargin(),
        concurrency: (navigator.deviceMemory || 4) <= 2 ? 4 : 6,
        retry: {
            maxAttempts: 5,
            baseDelayMs: 2000,
            backoffFactor: 2,
            shouldRetry: (img) => isGeneratedThumbnailSrc(img.src || img.dataset?.src || ''),
            getNextSrc: (_img, attempt, currentSrc) => withThumbnailRetryParam(currentSrc, attempt),
            schedule: (fn, delayMs) => galleryState.timeout(fn, delayMs)
        }
    });

    setLazyLoadObserver(_loader);
}

/**
 * Observe an image for lazy loading
 */
export function observeLazyImage(img) {
    if (_loader) _loader.observe(img);
}

export function resetLazyImage(img) {
    if (_loader) _loader.reset(img);
}

/**
 * Cleanup lazy loading
 */
export function cleanupLazyLoading() {
    if (_loader) {
        _loader.destroy();
        _loader = null;
    }
    setLazyLoadObserver(null);
}
