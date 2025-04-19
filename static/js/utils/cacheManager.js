/**
 * Cache Manager Utility
 * Handles media caching, size management, and resource cleanup
 */

import { MAX_CACHE_SIZE, app } from '../core/app.js';

/**
 * Add an item to the media cache with size management
 * @param {string} key - The cache key (usually the media URL)
 * @param {HTMLElement} element - The element to cache
 */
function addToCache(key, element) {
    if (!key || !element) return;
    
    // Add to cache
    app.mediaCache.set(key, element.cloneNode(true));
    
    // Check if we need to prune the cache
    if (app.mediaCache.size > MAX_CACHE_SIZE) {
        pruneCache();
    }
}

/**
 * Get an item from the media cache
 * @param {string} key - The cache key to retrieve
 * @returns {HTMLElement|null} - The cached element or null if not found
 */
function getFromCache(key) {
    if (!key || !app.mediaCache.has(key)) return null;
    
    const element = app.mediaCache.get(key);
    return element ? element.cloneNode(true) : null;
}

/**
 * Check if an item exists in the cache
 * @param {string} key - The cache key to check
 * @returns {boolean} - Whether the item exists in cache
 */
function hasInCache(key) {
    return key && app.mediaCache.has(key);
}

/**
 * Prune the cache when it exceeds the maximum size
 */
function pruneCache() {
    console.log(`Cache size (${app.mediaCache.size}) exceeds limit, pruning...`);
    const keysToDelete = Array.from(app.mediaCache.keys()).slice(0, app.mediaCache.size - MAX_CACHE_SIZE);
    keysToDelete.forEach(key => app.mediaCache.delete(key));
    console.log(`Pruned cache to ${app.mediaCache.size} items`);
}

/**
 * Clear the entire cache
 */
function clearCache() {
    app.mediaCache.clear();
    console.log("Media cache completely cleared");
}

/**
 * Perform periodic cleanup of the cache
 * @param {boolean} aggressive - Whether to perform aggressive cleanup
 */
function performCacheCleanup(aggressive = false) {
    const now = Date.now();
    
    if (aggressive || now - app.state.lastCleanupTime > 60000) { // Every minute or when forced
        console.log('Performing aggressive cache cleanup');
        clearCache();
        if (window.gc) window.gc();
        app.state.lastCleanupTime = now;
    }
}

export {
    addToCache,
    getFromCache,
    hasInCache,
    pruneCache,
    clearCache,
    performCacheCleanup
};
