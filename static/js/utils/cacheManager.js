/**
 * Cache Manager Utility
 * Handles media caching, size management, and resource cleanup
 */

import { MAX_CACHE_SIZE, MOBILE_DEVICE, MOBILE_CLEANUP_INTERVAL, app } from '../core/app.js';

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
    
    // Use the MEMORY_CLEANUP_INTERVAL from server config if available
    const cleanupInterval = (window.serverConfig && window.serverConfig.MEMORY_CLEANUP_INTERVAL) || 60000;
    
    // Use the mobile cleanup interval from app.js if on mobile
    const effectiveInterval = MOBILE_DEVICE ? MOBILE_CLEANUP_INTERVAL : cleanupInterval;
    
    if (aggressive || now - app.state.lastCleanupTime > effectiveInterval) {
        console.log(`Performing ${aggressive ? 'aggressive' : 'periodic'} cache cleanup`);
        
        // Instead of clearing the entire cache, we'll be more selective
        if (aggressive) {
            // In aggressive mode, clear the entire cache
            clearCache();
        } else {
            // In normal mode, only prune the cache to a reasonable size
            // Keep items that are likely to be needed soon
            const currentIndex = app.state.currentMediaIndex;
            const listLength = app.state.fullMediaList ? app.state.fullMediaList.length : 0;
            
            if (listLength > 0 && app.mediaCache.size > MAX_CACHE_SIZE / 2) {
                // Create a set of URLs for media items we want to keep
                const keepUrls = new Set();
                
                // Keep items near the current index
                const keepWindow = Math.min(10, Math.floor(MAX_CACHE_SIZE / 4));
                for (let i = Math.max(0, currentIndex - keepWindow); 
                     i <= Math.min(listLength - 1, currentIndex + keepWindow); i++) {
                    const file = app.state.fullMediaList[i];
                    if (file && file.url) {
                        keepUrls.add(file.url);
                    }
                }
                
                // Delete items from cache that aren't in the keep set
                for (const url of app.mediaCache.keys()) {
                    if (!keepUrls.has(url)) {
                        app.mediaCache.delete(url);
                    }
                }
                
                console.log(`Selective cache cleanup: kept ${keepUrls.size} items, removed ${app.mediaCache.size - keepUrls.size} items`);
            }
        }
        
        // Clear any media elements that might be detached but still referenced
        if (aggressive) {
            // Try to clear any detached media elements
            const mediaElements = document.querySelectorAll('video, audio, img');
            mediaElements.forEach(element => {
                if (!document.body.contains(element) && element.parentNode) {
                    try {
                        // Remove from parent if it exists but is not in body
                        element.parentNode.removeChild(element);
                    } catch (e) {
                        // Ignore errors
                    }
                }
                
                // For videos and audio, explicitly release resources
                if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
                    try {
                        element.pause();
                        element.src = '';
                        element.load();
                    } catch (e) {
                        // Ignore errors
                    }
                }
            });
        }
        
        // Force a small garbage collection by creating and releasing objects
        // This is more cross-browser compatible than window.gc()
        try {
            const garbageArray = [];
            // Create fewer objects on mobile to avoid excessive memory pressure
            const objectCount = MOBILE_DEVICE ? 1000 : 10000;
            const bufferSize = MOBILE_DEVICE ? 512 : 1024;
            
            // Create a bunch of objects to force memory pressure
            for (let i = 0; i < objectCount; i++) {
                garbageArray.push(new ArrayBuffer(bufferSize));
            }
            // Clear the array to release the objects
            garbageArray.length = 0;
        } catch (e) {
            console.log('Memory cleanup operation completed');
        }
        
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
