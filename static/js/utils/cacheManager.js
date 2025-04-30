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
 * Prune the cache when it exceeds the maximum size with improved prioritization
 */
function pruneCache() {
    console.log(`Cache size (${app.mediaCache.size}) exceeds limit, pruning...`);
    
    // Get the current index for proximity calculations
    const currentIndex = app.state.currentMediaIndex || 0;
    
    // Create a prioritized list of cache keys
    const cacheEntries = Array.from(app.mediaCache.entries()).map(([key, element]) => {
        // Default priority (higher is better to keep)
        let priority = 0;
        
        // Find the item in the media list to determine its index
        const mediaIndex = app.state.fullMediaList ? 
            app.state.fullMediaList.findIndex(item => item && item.url === key) : -1;
        
        // Prioritize by proximity to current index (if found in the list)
        if (mediaIndex >= 0) {
            // Calculate distance from current index (closer = higher priority)
            const distance = Math.abs(mediaIndex - currentIndex);
            
            // Prioritize items close to current index
            if (distance <= 2) {
                priority += 100; // Very high priority for immediate neighbors
            } else if (distance <= 5) {
                priority += 50;  // High priority for nearby items
            } else if (distance <= 10) {
                priority += 20;  // Medium priority
            }
            
            // Prioritize upcoming items over previous items
            if (mediaIndex > currentIndex) {
                priority += 10; // Slightly prefer items ahead in the sequence
            }
        }
        
        // Prioritize by media type (images are smaller and load faster)
        if (element.tagName === 'IMG') {
            priority += 5; // Slightly prefer images over videos
        }
        
        return { key, priority, mediaIndex };
    });
    
    // Sort by priority (lowest first, so we remove these first)
    cacheEntries.sort((a, b) => a.priority - b.priority);
    
    // Calculate how many items to remove
    const itemsToRemove = app.mediaCache.size - MAX_CACHE_SIZE;
    
    // Get the keys to delete (lowest priority first)
    const keysToDelete = cacheEntries.slice(0, itemsToRemove).map(entry => entry.key);
    
    // Delete the selected keys
    keysToDelete.forEach(key => app.mediaCache.delete(key));
    
    console.log(`Pruned cache to ${app.mediaCache.size} items using priority-based strategy`);
}

/**
 * Clear the entire cache
 */
function clearCache() {
    app.mediaCache.clear();
    console.log("Media cache completely cleared");
}

/**
 * Perform periodic cleanup of the cache with bandwidth-aware optimizations
 * @param {boolean} aggressive - Whether to perform aggressive cleanup
 */
function performCacheCleanup(aggressive = false) {
    const now = Date.now();
    
    // Use the MEMORY_CLEANUP_INTERVAL from server config if available
    const cleanupInterval = (window.serverConfig && window.serverConfig.MEMORY_CLEANUP_INTERVAL) || 60000;
    
    // Use the mobile cleanup interval from app.js if on mobile
    const effectiveInterval = MOBILE_DEVICE ? MOBILE_CLEANUP_INTERVAL : cleanupInterval;
    
    // Check if we need to perform cleanup
    if (aggressive || now - app.state.lastCleanupTime > effectiveInterval) {
        console.log(`Performing ${aggressive ? 'aggressive' : 'periodic'} cache cleanup`);
        
        // Check for network conditions if the API is available
        let isLowBandwidth = false;
        if (navigator.connection) {
            isLowBandwidth = navigator.connection.saveData || 
                             navigator.connection.effectiveType === 'slow-2g' ||
                             navigator.connection.effectiveType === '2g' ||
                             (navigator.connection.downlink && navigator.connection.downlink < 0.5);
            
            console.log(`Network conditions: effectiveType=${navigator.connection.effectiveType}, downlink=${navigator.connection.downlink}Mbps, saveData=${navigator.connection.saveData}`);
        }
        
        // Adjust cache size based on network conditions
        const adjustedCacheSize = isLowBandwidth ? 
            Math.floor(MAX_CACHE_SIZE / 2) : // Smaller cache on low bandwidth
            MAX_CACHE_SIZE;
        
        // Instead of clearing the entire cache, we'll be more selective
        if (aggressive) {
        // In aggressive mode, be more careful about what we clear
            const currentIndex = app.state.currentMediaIndex;
            const listLength = app.state.fullMediaList ? app.state.fullMediaList.length : 0;
            
            if (listLength > 0) {
                // Create a set of URLs for essential media items we want to keep
                const essentialUrls = new Set();
                
                // Keep more items around the current index to prevent reloading issues
                const essentialWindow = 2;
                for (let i = Math.max(0, currentIndex - essentialWindow); 
                     i <= Math.min(listLength - 1, currentIndex + essentialWindow); i++) {
                    const file = app.state.fullMediaList[i];
                    if (file && file.url) {
                        essentialUrls.add(file.url);
                    }
                }
                
                // Delete items except essential ones, explicitly protecting the current video's cache entry
                const currentVideoUrl = app.state.fullMediaList[currentIndex]?.url;
                const urlsToDelete = [];
                
                for (const url of app.mediaCache.keys()) {
                    // Check if the URL is essential OR if it's the currently active video URL
                    const isEssential = essentialUrls.has(url);
                    const isActiveVideo = url === currentVideoUrl;
                    
                    if (!isEssential && !isActiveVideo) {
                        urlsToDelete.push(url);
                    }
                }
                
                // Delete the non-essential items
                urlsToDelete.forEach(url => {
                    console.log(`Aggressive cleanup: Removing ${url} from cache`);
                    app.mediaCache.delete(url);
                });
                
                console.log(`Aggressive cache cleanup: kept ${app.mediaCache.size} items (${essentialUrls.size} essential, including active: ${app.mediaCache.has(currentVideoUrl)}), removed ${urlsToDelete.length}`);
            } else {
                // If no media list, still be careful not to clear everything
                // Just reduce the cache size significantly
                const keysToKeep = Array.from(app.mediaCache.keys()).slice(-5); // Keep last 5 items
                const keysToDelete = Array.from(app.mediaCache.keys()).filter(key => !keysToKeep.includes(key));
                keysToDelete.forEach(key => app.mediaCache.delete(key));
                console.log(`No media list, reduced cache from ${keysToDelete.length + keysToKeep.length} to ${keysToKeep.length} items`);
            }
        } else {
            // In normal mode, use the improved priority-based pruning
            const currentIndex = app.state.currentMediaIndex;
            const listLength = app.state.fullMediaList ? app.state.fullMediaList.length : 0;
            
            if (listLength > 0 && app.mediaCache.size > adjustedCacheSize / 2) {
                // Create a prioritized list of cache entries
                const cacheEntries = Array.from(app.mediaCache.entries()).map(([key, element]) => {
                    // Default priority (higher is better to keep)
                    let priority = 0;
                    
                    // Find the item in the media list to determine its index
                    const mediaIndex = app.state.fullMediaList.findIndex(item => item && item.url === key);
                    
                    // Prioritize by proximity to current index (if found in the list)
                    if (mediaIndex >= 0) {
                        // Calculate distance from current index (closer = higher priority)
                        const distance = Math.abs(mediaIndex - currentIndex);
                        
                        // Prioritize items close to current index
                        if (distance === 0) {
                            priority += 200; // Current item - highest priority
                        } else if (distance === 1) {
                            priority += 100; // Immediate neighbors
                        } else if (distance <= 3) {
                            priority += 50;  // Near neighbors
                        } else if (distance <= 5) {
                            priority += 20;  // Medium proximity
                        }
                        
                        // Prioritize upcoming items over previous items
                        if (mediaIndex > currentIndex) {
                            priority += 10; // Prefer items ahead in the sequence
                        }
                    }
                    
                    // Prioritize by media type (images are smaller and load faster)
                    if (element.tagName === 'IMG') {
                        priority += 5; // Prefer images over videos
                    }
                    
                    return { key, priority, mediaIndex };
                });
                
                // Sort by priority (lowest first, so we remove these first)
                cacheEntries.sort((a, b) => a.priority - b.priority);
                
                // Calculate how many items to remove to get to target size
                const targetSize = isLowBandwidth ? 
                    Math.floor(adjustedCacheSize / 2) : // Even smaller on low bandwidth
                    Math.floor(adjustedCacheSize * 0.75); // Target 75% of max size for normal cleanup
                
                const itemsToRemove = Math.max(0, app.mediaCache.size - targetSize);
                
                if (itemsToRemove > 0) {
                    // Get the keys to delete (lowest priority first)
                    const keysToDelete = cacheEntries.slice(0, itemsToRemove).map(entry => entry.key);
                    
                    // Delete the selected keys
                    keysToDelete.forEach(key => app.mediaCache.delete(key));
                    
                    console.log(`Selective cache cleanup: removed ${itemsToRemove} low-priority items, kept ${app.mediaCache.size}`);
                } else {
                    console.log(`Cache size ${app.mediaCache.size} is below target ${targetSize}, no cleanup needed`);
                }
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
