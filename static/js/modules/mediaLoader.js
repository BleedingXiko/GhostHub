/**
 * Media Loader Module
 * Manages media loading, caching, and resource cleanup
 */

import { 
    app, 
    tiktokContainer, 
    spinnerContainer, 
    categoryView, 
    mediaView,
    MEDIA_PER_PAGE,
    MOBILE_DEVICE,
    MAX_CACHE_SIZE
} from '../core/app.js';

import { 
    addToCache, 
    getFromCache, 
    hasInCache, 
    performCacheCleanup 
} from '../utils/cacheManager.js';

import { renderMediaWindow } from './mediaNavigation.js';
import { setupMediaNavigation } from './eventHandlers.js';
import { setupControls } from './uiController.js';

/**
 * Load and display a media category
 * @param {string} categoryId - Category ID to view
 * @param {string[]|null} [forced_order=null] - Optional array of media URLs to force a specific order
 * @returns {Promise} Resolves when loaded
 */
function viewCategory(categoryId, forced_order = null) {
    return new Promise(async (resolve, reject) => {
        console.log(`Starting viewCategory for categoryId: ${categoryId}, Forced Order: ${forced_order ? 'Yes' : 'No'}`);
        
        // IMPORTANT: Check if we're already viewing this category *unless* a forced order is given
        if (!forced_order && app.state.currentCategoryId === categoryId) {
            console.log("Already viewing this category (no forced order), resolving immediately");
            resolve(); // Resolve immediately if already viewing and no forced order
            return;
        }
        
        // If sync mode is enabled and we're the host, send update to server
        // This needs to happen before changing the category to ensure proper sync
        if (app.state.syncModeEnabled && app.state.isHost) {
            console.log('Host changing category, sending sync update');
            
            // We don't have media info yet, so just send the category ID
            // The index will be set to 0 when the category loads
            window.appModules.syncManager.sendSyncUpdate({
                category_id: categoryId,
                file_url: null,
                index: 0
            }).then(success => {
                if (!success) {
                    console.warn('Sync update for category change was not successful');
                }
            });
        }
    
        // STEP 1: Reset state variables
        app.state.currentCategoryId = categoryId;
        app.state.currentPage = 1;
        app.state.hasMoreMedia = !forced_order; // No more media if order is forced
        app.state.isLoading = false;
        app.state.fullMediaList = [];
        app.state.preloadQueue = [];
        app.state.isPreloading = false;
        app.state.currentMediaIndex = 0;
        
        // STEP 2: Explicitly clear the media cache to prevent stale data
        app.mediaCache.clear();
        console.log("Media cache completely cleared for new category");
        
        // STEP 3: Abort any ongoing fetch requests from the previous category
        if (app.state.currentFetchController) {
            console.log("Aborting previous fetch request...");
            app.state.currentFetchController.abort();
        }
        // Create a new AbortController for this category's requests
        app.state.currentFetchController = new AbortController();

        // STEP 4: Stop any active media
        const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
        if (activeElement && activeElement.tagName === 'VIDEO') {
            try {
                activeElement.pause();
                activeElement.removeAttribute('src'); // Prevent further loading
                activeElement.load(); // Attempt to release resources
                console.log("Explicitly stopped active video.");
            } catch (e) {
                console.error("Error stopping active video:", e);
            }
        }
        
        // STEP 5: Clean up resources from previous category - use aggressive cleanup
        clearResources(true);

        // STEP 6: Explicitly clear previous media elements
        if (tiktokContainer) {
            tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => el.remove());
            console.log("Explicitly removed previous media elements.");
        }
        
        console.log("All state variables reset and resources cleared for new category");
        
        // Set a smaller page size on mobile for faster loading
        const pageSize = window.innerWidth <= 768 ? 5 : 10;
        
        // STEP 7: Introduce a small delay to allow the browser to process cleanup before loading
        setTimeout(async () => {
            console.log(`Starting load for category ${categoryId} after delay.`);
            try {
                // Show spinner before fetching
                if (spinnerContainer) spinnerContainer.style.display = 'flex';

                if (forced_order) {
                    console.log("Using forced media order.");
                    // Reconstruct fullMediaList based on forced_order URLs
                    // This is a simplified version - assumes URLs are unique identifiers
                    // A more robust version might need to fetch metadata if objects aren't readily available
                    
                    // Try to find existing file objects matching the URLs
                    const tempMap = new Map();
                    app.state.fullMediaList.forEach(item => { if (item) tempMap.set(item.url, item); });
                    
                    app.state.fullMediaList = forced_order.map(url => {
                        // Basic reconstruction - assumes URL is enough or we find it in a previous list
                        // This might need enhancement if full file objects are required immediately
                        return tempMap.get(url) || { url: url, name: url.split('/').pop(), type: url.match(/\.(jpg|jpeg|png|gif)$/i) ? 'image' : (url.match(/\.(mp4|webm|mov)$/i) ? 'video' : 'unknown') };
                    });
                    
                    app.state.hasMoreMedia = false; // No more pages when using forced order
                    console.log(`Reconstructed list with ${app.state.fullMediaList.length} items from forced order.`);
                    if (spinnerContainer) spinnerContainer.style.display = 'none'; // Hide spinner
                    
                } else {
                    // STEP 8: Fetch the first page of media if no forced order
                    const shouldForceRefresh = false; 
                    console.log(`Loading category with forceRefresh: ${shouldForceRefresh}`);
                    await loadMoreMedia(pageSize, app.state.currentFetchController.signal, shouldForceRefresh);

                    // Check if the fetch was aborted
                    if (app.state.currentFetchController.signal.aborted) {
                        console.log("Fetch aborted during initial load, stopping viewCategory.");
                        if (spinnerContainer) spinnerContainer.style.display = 'none';
                        return; 
                    }
                }

                // Proceed if we have media (either from fetch or forced order)
                if (app.state.fullMediaList && app.state.fullMediaList.length > 0) {
                    console.log("Showing unified TikTok view.");
                    categoryView.classList.add('hidden');
                    mediaView.classList.add('hidden'); 
                    tiktokContainer.classList.remove('hidden');
                    
                    setupMediaNavigation(); 
                    renderMediaWindow(0); // Render starting at index 0
                    
                    resolve(); 
                } else if (!forced_order) {
                    // Handle no media only if not using forced order
                    handleNoMediaFiles(categoryId, pageSize, resolve, reject);
                } else {
                    // If forced order resulted in empty list (shouldn't happen if parsing works)
                    console.error("Forced order resulted in an empty media list.");
                    reject(new Error("Failed to load media from shared order."));
                }
            

            } catch (error) {
                // Handle errors specifically from loadMoreMedia or rendering
                if (error.name !== 'AbortError') { // Don't alert on aborts
                    console.error('!!! Error viewing category (main catch block):', error);
                    alert('Error loading or displaying media files');
                } else {
                    console.log("Caught AbortError in viewCategory catch block.");
                }
                mediaView.classList.add('hidden');
                categoryView.classList.remove('hidden');
                reject(error); // Reject the promise on error
            } 
        }, 10); // Small delay (10ms)
    });
}

/**
 * Load additional media items
 * @param {number|null} customLimit - Items per page
 * @param {AbortSignal|null} signal - For cancellation
 * @param {boolean} forceRefresh - Force server refresh
 * @param {number|null} targetPage - Specific page to load
 */
async function loadMoreMedia(customLimit = null, signal = null, forceRefresh = false, targetPage = null) {
    const effectiveSignal = signal || (app.state.currentFetchController ? app.state.currentFetchController.signal : null);
    const pageToLoad = targetPage || app.state.currentPage; // Use targetPage if provided
    
    console.log(`loadMoreMedia called: pageToLoad=${pageToLoad}, hasMoreMedia=${app.state.hasMoreMedia}, isLoading=${app.state.isLoading}, currentMediaIndex=${app.state.currentMediaIndex}, fullMediaList.length=${app.state.fullMediaList.length}`);
    
    // Check if the signal has been aborted
    if (effectiveSignal && effectiveSignal.aborted) {
        console.log("loadMoreMedia skipped: signal was aborted.");
        return;
    }
    
    if (!app.state.hasMoreMedia || app.state.isLoading) {
        console.log(`Load more skipped: hasMoreMedia=${app.state.hasMoreMedia}, isLoading=${app.state.isLoading}`);
        return; // Don't load if no more items or already loading
    }

    app.state.isLoading = true;
    const limit = customLimit || MEDIA_PER_PAGE;
    console.log(`Loading page ${pageToLoad} with limit ${limit}...`); // Use pageToLoad
    
    // Show loading indicator
    if (spinnerContainer) spinnerContainer.style.display = 'flex';

    try {
        // Add cache-busting parameter, force_refresh parameter, and the effective AbortSignal
        const cacheBuster = Date.now();
        // Only use forceRefresh parameter as provided, don't default to true for first page
        const forceRefreshParam = forceRefresh ? '&force_refresh=true' : '';
        const fetchOptions = {
            signal: effectiveSignal // Use the determined signal
        };
        console.log(`Fetching media with forceRefresh: ${forceRefresh}, syncModeEnabled: ${app.state.syncModeEnabled}`);
        // Always set shuffle=false in sync mode to ensure consistent ordering
        const shuffleParam = app.state.syncModeEnabled ? '&shuffle=false' : '';
        // Add a sync parameter to ensure the server knows this is a sync request
        const syncParam = app.state.syncModeEnabled ? '&sync=true' : '';
        const response = await fetch(`/api/categories/${app.state.currentCategoryId}/media?page=${pageToLoad}&limit=${limit}${forceRefreshParam}${shuffleParam}${syncParam}&_=${cacheBuster}`, fetchOptions); // Use pageToLoad
        
        if (!response.ok) {
            // Don't throw error if fetch was aborted, just return
            if (effectiveSignal && effectiveSignal.aborted) {
                console.log("Fetch aborted during loadMoreMedia response check.");
                app.state.isLoading = false; // Reset loading flag
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        if (data.error) {
            console.error("Server error fetching more media:", data.error);
            alert(`Error loading more media: ${data.error}`);
            app.state.hasMoreMedia = false; // Stop trying if server reports error
        } else if (data.async_indexing) {
            // Handle async indexing response
            console.log(`Received async indexing response with progress: ${data.indexing_progress}%`);
            
            // Show indexing progress to the user
            if (!app.state.indexingProgressElement) {
                // Create progress indicator if it doesn't exist
                const progressElement = document.createElement('div');
                progressElement.className = 'indexing-progress';
                progressElement.style.position = 'fixed';
                progressElement.style.top = '10px';
                progressElement.style.left = '50%';
                progressElement.style.transform = 'translateX(-50%)';
                progressElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                progressElement.style.color = 'white';
                progressElement.style.padding = '10px 20px';
                progressElement.style.borderRadius = '5px';
                progressElement.style.zIndex = '1000';
                document.body.appendChild(progressElement);
                app.state.indexingProgressElement = progressElement;
            }
            
            // Update progress text
            app.state.indexingProgressElement.textContent = `Indexing media files: ${data.indexing_progress}%`;
            
            // Process any available files
            if (data.files && data.files.length > 0) {
                console.log(`Received ${data.files.length} media items during indexing.`);
                // Add only new files to avoid duplicates
                const existingUrls = new Set(app.state.fullMediaList.map(f => f.url));
                const newFiles = data.files.filter(f => !existingUrls.has(f.url));
                
                if (newFiles.length > 0) {
                    app.state.fullMediaList.push(...newFiles);
                    console.log(`Added ${newFiles.length} new media items.`);
                    
                    // Update swipe indicators if the view is active
                    if (!tiktokContainer.classList.contains('hidden')) {
                        updateSwipeIndicators(app.state.currentMediaIndex, app.state.fullMediaList.length);
                    }
                }
            }
            
            // Set hasMore based on indexing progress
            app.state.hasMoreMedia = data.pagination.hasMore || data.indexing_progress < 100;
            
            // If indexing is still in progress, poll for updates
            if (data.indexing_progress < 100) {
                // Schedule another request after a delay
                setTimeout(() => {
                    if (app.state.currentCategoryId) { // Only if still viewing this category
                        console.log("Polling for indexing progress updates...");
                        loadMoreMedia(limit, effectiveSignal, false, pageToLoad);
                    }
                }, 2000); // Poll every 2 seconds
            } else {
                // Indexing complete, remove progress indicator
                if (app.state.indexingProgressElement) {
                    document.body.removeChild(app.state.indexingProgressElement);
                    app.state.indexingProgressElement = null;
                }
                
                // Only increment currentPage if we loaded the *next* sequential page
                if (!targetPage) {
                    app.state.currentPage++;
                }
            }
        } else if (data.files && data.files.length > 0) {
            console.log(`Received ${data.files.length} new media items.`);
            // Add only new files to avoid duplicates if a page was re-fetched
            const existingUrls = new Set(app.state.fullMediaList.map(f => f.url));
            const newFiles = data.files.filter(f => !existingUrls.has(f.url));
            
            if (newFiles.length > 0) {
                // If a specific page was loaded, we might need to insert/replace
                // For simplicity now, just append and rely on server order + rendering logic
                app.state.fullMediaList.push(...newFiles);
                console.log(`Added ${newFiles.length} new media items.`);
            } else {
                console.log("Received files, but they were already present in the list.");
            }

            app.state.hasMoreMedia = data.pagination.hasMore;
            // Only increment currentPage if we loaded the *next* sequential page
            if (!targetPage) {
                app.state.currentPage++; 
            }
            console.log(`Total media now: ${app.state.fullMediaList.length}, hasMore: ${app.state.hasMoreMedia}, nextPageToLoad=${app.state.currentPage}`);
            
            // Update swipe indicators if the view is active
            if (!tiktokContainer.classList.contains('hidden')) {
                updateSwipeIndicators(app.state.currentMediaIndex, app.state.fullMediaList.length);
            }
            
            // Remove any indexing progress indicator if it exists
            if (app.state.indexingProgressElement) {
                document.body.removeChild(app.state.indexingProgressElement);
                app.state.indexingProgressElement = null;
            }
        } else {
            console.log("No more media files received from server.");
            app.state.hasMoreMedia = false; // No more files returned
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Fetch aborted (loadMoreMedia).');
            // Don't show an alert for abort errors
        } else {
            console.error('Error loading more media:', error);
            alert('Failed to load more media. Please try again later.');
            // Optionally set hasMoreMedia = false or implement retry logic
        }
    } finally {
        app.state.isLoading = false;
        console.log("Loading finished.");
        // Hide loading indicator here reliably
        if (spinnerContainer) spinnerContainer.style.display = 'none';
    }
}

/**
 * Clean up media resources
 * @param {boolean} aggressive - Deep cleanup if true
 */
function clearResources(aggressive = false) {
    console.log(`Clearing resources (aggressive: ${aggressive})`);
    
    // Clear media elements
    tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => {
        try {
            if (el.tagName === 'VIDEO') {
                el.pause();
                el.removeAttribute('src');
                el.load(); // Force release of video resources
            }
            el.remove();
        } catch (e) {
            console.error('Error cleaning up media element:', e);
        }
    });
    
    // Clear controls
    const existingControls = tiktokContainer.querySelector('.controls-wrapper');
    if (existingControls) {
        existingControls.remove();
    }
    
    // Clear indicators
    tiktokContainer.querySelectorAll('.swipe-indicator').forEach(el => el.remove());
    
    // Clear preload queue
    app.state.preloadQueue = [];
    app.state.isPreloading = false;
    
    // More aggressive cleanup on mobile or when explicitly requested
    if (aggressive || window.innerWidth <= 768) {
        console.log('Performing aggressive cleanup');
        // Clear the entire cache on aggressive cleanup
        app.mediaCache.clear();
        
        // Remove any detached video elements from the DOM
        document.querySelectorAll('video').forEach(video => {
            if (!document.body.contains(video.parentElement)) {
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                    video.remove();
                } catch (e) {
                    console.error('Error removing detached video:', e);
                }
            }
        });
        
        // Use the performCacheCleanup function from cacheManager.js
        performCacheCleanup(true);
    } else {
        // Regular cleanup - limit cache size
        performCacheCleanup();
    }
}

/**
 * Preload next media items in background
 */
function preloadNextMedia() {
    if (app.state.isPreloading || app.state.preloadQueue.length === 0) return;
    
    // Get device memory if available, default to 4GB if not
    const deviceMemory = navigator.deviceMemory || 4;
    
    // Adjust MAX_CACHE_SIZE based on device memory
    // For low-memory devices (<=2GB), use a smaller cache
    const adjustedMaxCacheSize = deviceMemory <= 2 ? Math.min(MAX_CACHE_SIZE, 10) : MAX_CACHE_SIZE;
    
    // Skip preloading if cache is getting too large
    if (app.mediaCache.size >= adjustedMaxCacheSize) {
        console.log(`Cache size (${app.mediaCache.size}) >= adjusted MAX_CACHE_SIZE (${adjustedMaxCacheSize}), skipping preload.`);
        // Force cache cleanup when we're at the limit
        performCacheCleanup(true);
        app.state.isPreloading = false;
        return;
    }
    
    // Check if browser is likely to be under memory pressure
    const isLowMemory = deviceMemory <= 2 || 
                        (typeof navigator.deviceMemory === 'undefined' && window.innerWidth <= 768);
    
    // Limit concurrent preloads based on device capabilities
    const maxConcurrentPreloads = isLowMemory ? 1 : 2;
    
    // Count active preloads (elements with preload attribute)
    const activePreloads = document.querySelectorAll('video[preload="metadata"], img[fetchpriority="high"]').length;
    
    if (activePreloads >= maxConcurrentPreloads) {
        console.log(`Too many active preloads (${activePreloads}), deferring preload.`);
        // Try again later with a longer delay
        setTimeout(preloadNextMedia, 1000); // Increased from 500ms to 1000ms
        return;
    }
    
    app.state.isPreloading = true;
    
    // Prioritize next item for immediate viewing
    const nextItems = app.state.preloadQueue.slice(0, 1); // Only preload 1 at a time
    const currentIndex = app.state.currentMediaIndex;
    
    // Get the next file to preload
    const file = app.state.preloadQueue.shift();
    
    if (!file || hasInCache(file.url)) {
        app.state.isPreloading = false;
        // Continue preloading next items immediately
        setTimeout(preloadNextMedia, 0);
        return;
    }
    
    console.log(`Preloading ${file.type}: ${file.name}`);
    let mediaElement;
    
    if (file.type === 'video') {
        // If the file has a thumbnailUrl, preload the thumbnail image instead of the video metadata
        if (file.thumbnailUrl) {
            console.log(`Preloading video thumbnail for: ${file.name}`);
            mediaElement = new Image();
            mediaElement.style.display = 'none'; // Keep it hidden

            // Add fetch priority hint for next items
            if (nextItems.includes(file)) {
                mediaElement.setAttribute('fetchpriority', 'high');
            }

            // Use a single onload handler with timeout clearing
            const loadTimeout = setTimeout(() => {
                console.warn(`Video thumbnail load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                app.state.isPreloading = false;
                setTimeout(preloadNextMedia, 0); // Continue preloading
            }, 5000); // 5 second timeout

            mediaElement.onload = () => {
                clearTimeout(loadTimeout); // Clear timeout on successful load
                console.log(`Video thumbnail loaded: ${file.name}`);
                // Store the thumbnail IMAGE in the cache using the VIDEO'S URL as the key
                addToCache(file.url, mediaElement);
                // No need to remove from body here, it's already display:none
                // if (document.body.contains(mediaElement)) {
                //     document.body.removeChild(mediaElement);
                // }
                app.state.isPreloading = false;
                setTimeout(preloadNextMedia, 0); // Continue preloading
            };

            mediaElement.onerror = () => {
                clearTimeout(loadTimeout); // Clear timeout on error
                console.error(`Error preloading video thumbnail: ${file.thumbnailUrl}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                app.state.isPreloading = false;
                setTimeout(preloadNextMedia, 0); // Continue preloading
            };

            document.body.appendChild(mediaElement); // Append to trigger load
            mediaElement.src = file.thumbnailUrl; // Set src to start loading
        } else {
            // If no thumbnail URL, create a minimal video element that only loads metadata
            console.log(`Preloading video metadata for: ${file.name} (no thumbnail)`);
            mediaElement = document.createElement('video');

            // Set video attributes for minimal loading
            mediaElement.preload = 'metadata'; // Load only metadata
            mediaElement.playsInline = true;
            mediaElement.setAttribute('playsinline', 'true');
            mediaElement.setAttribute('webkit-playsinline', 'true');
            mediaElement.setAttribute('controlsList', 'nodownload nofullscreen');
            mediaElement.disablePictureInPicture = true;
            mediaElement.muted = true;
            mediaElement.style.display = 'none';
            
            // Add fetch priority hint for next items
            if (nextItems.includes(file)) {
                mediaElement.setAttribute('fetchpriority', 'high');
            }
            
            // Add error handling for videos
            mediaElement.onerror = function() {
                console.error(`Error preloading video: ${file.url}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                app.state.isPreloading = false;
                // Continue preloading immediately
                setTimeout(preloadNextMedia, 0);
            };
            
            // For videos, only preload metadata
            mediaElement.addEventListener('loadedmetadata', () => {
                console.log(`Video metadata loaded: ${file.name}`);
                addToCache(file.url, mediaElement);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                app.state.isPreloading = false;
                // Continue preloading immediately
                setTimeout(preloadNextMedia, 0);
            });
            
            // Set a shorter timeout for faster recovery from stalled loading
            const loadTimeout = setTimeout(() => {
                console.warn(`Video metadata load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                app.state.isPreloading = false;
                // Continue preloading immediately
                setTimeout(preloadNextMedia, 0);
            }, 3000); // Reduced from 5s to 3s
            
            mediaElement.addEventListener('loadedmetadata', () => {
                clearTimeout(loadTimeout);
            });
            
            // Use a data URL for the poster to avoid an extra network request
            mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
            
            document.body.appendChild(mediaElement);
            
            // Add source with type for better loading
            const source = document.createElement('source');
            source.src = file.url;
            source.type = 'video/mp4'; // Assume MP4 for better browser compatibility
            mediaElement.appendChild(source);
            
            // Force load metadata only
            mediaElement.load();
        }
    } else if (file.type === 'image') {
        mediaElement = new Image();
        mediaElement.style.display = 'none';
        
        // Add fetch priority hint for next items
        if (nextItems.includes(file)) {
            mediaElement.setAttribute('fetchpriority', 'high');
        }
        
        mediaElement.onload = () => {
            console.log(`Image loaded: ${file.name}`);
            addToCache(file.url, mediaElement);
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            app.state.isPreloading = false;
            // Continue preloading immediately
            setTimeout(preloadNextMedia, 0);
        };
        
        mediaElement.onerror = () => {
            console.error(`Error preloading image: ${file.url}`);
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            app.state.isPreloading = false;
            // Continue preloading immediately
            setTimeout(preloadNextMedia, 0);
        };
        
        // Set a shorter timeout for faster recovery
        const loadTimeout = setTimeout(() => {
            console.warn(`Image load timeout: ${file.name}`);
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            app.state.isPreloading = false;
            // Continue preloading immediately
            setTimeout(preloadNextMedia, 0);
        }, 5000); // Reduced from 10s to 5s
        
        mediaElement.onload = () => {
            clearTimeout(loadTimeout);
            console.log(`Image loaded: ${file.name}`);
            addToCache(file.url, mediaElement);
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            app.state.isPreloading = false;
            // Continue preloading immediately
            setTimeout(preloadNextMedia, 0);
        };
        
        document.body.appendChild(mediaElement);
        
        // Add cache-busting parameter for images that might be cached incorrectly
        mediaElement.src = `${file.url}${file.url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    } else {
        // For unknown file types, create a placeholder element and cache it
        console.log(`Preloading unknown file type for ${file.name}: ${file.type}`);
        
        // Create placeholder element (simplified for performance)
        mediaElement = document.createElement('div');
        mediaElement.className = 'unknown-file-placeholder';
        mediaElement.style.backgroundColor = '#333';
        mediaElement.style.display = 'flex';
        mediaElement.style.alignItems = 'center';
        mediaElement.style.justifyContent = 'center';
        mediaElement.style.color = 'white';
        mediaElement.style.height = '100%';
        mediaElement.style.width = '100%';
        mediaElement.innerHTML = `<div style="text-align:center"><div style="font-size:64px">📄</div><div>${file.name}</div></div>`;
        
        // Cache the placeholder
        addToCache(file.url, mediaElement);
        app.state.isPreloading = false;
        // Continue preloading immediately
        setTimeout(preloadNextMedia, 0);
    }
}

/**
 * Apply performance optimizations to video element
 * @param {HTMLVideoElement} videoElement - Video to optimize
 */
function optimizeVideoElement(videoElement) {
    // Set video attributes for faster loading
    videoElement.preload = 'metadata';
    videoElement.playsInline = true;
    videoElement.setAttribute('playsinline', 'true');
    videoElement.setAttribute('webkit-playsinline', 'true');
    
    // Add performance attributes
    videoElement.setAttribute('disableRemotePlayback', 'true');
    videoElement.disablePictureInPicture = true;
    
    // Set initial muted state for faster loading
    videoElement.muted = true;
    
    // Use a data URL for the poster to avoid an extra network request
    videoElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
    
    // iOS specific optimizations
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        // These attributes are needed for proper iOS video behavior
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('webkit-playsinline', 'true');
        videoElement.setAttribute('x-webkit-airplay', 'allow');
        
        // For iOS fullscreen support
        videoElement.setAttribute('webkit-allows-inline-media-playback', 'true');
        
        // For iOS 10+ fullscreen support
        if (typeof videoElement.webkitEnterFullscreen === 'function') {
            // Make sure the video can be played
            videoElement.addEventListener('canplay', () => {
                // Add a fullscreen button if needed
                if (window.appModules && window.appModules.fullscreenManager) {
                    window.appModules.fullscreenManager.addFullscreenButton(videoElement);
                }
            });
        }
    }
    
    // Add event listeners for better performance monitoring
    videoElement.addEventListener('loadstart', () => console.log('Video loadstart'));
    videoElement.addEventListener('loadedmetadata', () => console.log('Video loadedmetadata'));
    videoElement.addEventListener('loadeddata', () => console.log('Video canplay'));
    
    return videoElement;
}

/**
 * Create or update the indexing progress UI
 * @param {number} progress - The indexing progress (0-100)
 */
function createOrUpdateIndexingUI(progress) {
    // Create progress indicator if it doesn't exist
    if (!app.state.indexingProgressElement) {
        const progressElement = document.createElement('div');
        progressElement.className = 'indexing-progress';
        progressElement.style.position = 'fixed';
        progressElement.style.top = '10px';
        progressElement.style.left = '50%';
        progressElement.style.transform = 'translateX(-50%)';
        progressElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        progressElement.style.color = 'white';
        progressElement.style.padding = '10px 20px';
        progressElement.style.borderRadius = '5px';
        progressElement.style.zIndex = '1000';
        document.body.appendChild(progressElement);
        app.state.indexingProgressElement = progressElement;
    }
    
    // Update progress text
    app.state.indexingProgressElement.textContent = `Indexing media files: ${progress}%`;
}

/**
 * Update navigation indicators
 * @param {number} currentIndex - Current position
 * @param {number} totalItems - Total available items
 */
function updateSwipeIndicators(currentIndex, totalItems) {
    // Create indicators if they don't exist
    if (!tiktokContainer.querySelector('.swipe-indicator.up')) {
        const upIndicator = document.createElement('div');
        upIndicator.className = 'swipe-indicator up';
        upIndicator.innerHTML = '⬆️';
        tiktokContainer.appendChild(upIndicator);
        
        const downIndicator = document.createElement('div');
        downIndicator.className = 'swipe-indicator down';
        downIndicator.innerHTML = '⬇️';
        tiktokContainer.appendChild(downIndicator);
    }
    
    const upIndicator = tiktokContainer.querySelector('.swipe-indicator.up');
    const downIndicator = tiktokContainer.querySelector('.swipe-indicator.down');
    
    // Show up arrow if not the first item
    upIndicator.classList.toggle('visible', currentIndex > 0);
    // Show down arrow if not the last item or if more media might be loading
    downIndicator.classList.toggle('visible', currentIndex < totalItems - 1 || app.state.hasMoreMedia);
}

/**
 * Handle the case when no media files are found
 * @param {string} categoryId - The category ID
 * @param {number} pageSize - The page size for loading more media
 * @param {Function} resolve - The promise resolve function
 * @param {Function} reject - The promise reject function
 */
async function handleNoMediaFiles(categoryId, pageSize, resolve, reject) {
    try {
        // Check if this is an async indexing response with no files yet
        const response = await fetch(`/api/categories/${categoryId}/media?page=1&limit=1&_=${Date.now()}`);
        const checkData = await response.json();
        
        if (checkData.async_indexing && checkData.indexing_progress < 100) {
            // This is an async indexing in progress - show a message and wait
            console.log('Async indexing in progress, waiting for files...');
            createOrUpdateIndexingUI(checkData.indexing_progress);
        }
    } catch (checkError) {
        console.error("Error checking async indexing status:", checkError);
    }
    
    // Set up the view for waiting
    categoryView.classList.add('hidden');
    mediaView.classList.add('hidden');
    tiktokContainer.classList.remove('hidden');
    
    // Hide spinner
    if (spinnerContainer) spinnerContainer.style.display = 'none';
    
    // Special handling for sync mode as guest
    if (app.state.syncModeEnabled && !app.state.isHost) {
        console.log('In sync mode as guest with no media yet - waiting for sync updates');
        setupMediaNavigation();
        resolve();
        return;
    }
    
    // Create a simple loading message
    console.log('No media files found in response or files array is empty after load.');
    const loadingMessage = document.createElement('div');
    loadingMessage.className = 'loading-message';
    loadingMessage.style.position = 'absolute';
    loadingMessage.style.top = '50%';
    loadingMessage.style.left = '50%';
    loadingMessage.style.transform = 'translate(-50%, -50%)';
    loadingMessage.style.color = 'white';
    loadingMessage.style.textAlign = 'center';
    loadingMessage.style.padding = '20px';
    loadingMessage.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    loadingMessage.style.borderRadius = '10px';
    loadingMessage.style.zIndex = '1000';
    loadingMessage.innerHTML = `
        <div style="font-size: 24px; margin-bottom: 10px;">Loading Media</div>
        <div>Please wait while files are being loaded...</div>
    `;
    tiktokContainer.appendChild(loadingMessage);
    
    // Store the element for later removal
    app.state.loadingMessage = loadingMessage;
    
    // Poll for updates
    setTimeout(() => {
        if (app.state.currentCategoryId === categoryId) {
            loadMoreMedia(pageSize, app.state.currentFetchController.signal, false);
            
            // Remove the loading message after a delay
            setTimeout(() => {
                if (app.state.loadingMessage && document.body.contains(app.state.loadingMessage)) {
                    app.state.loadingMessage.remove();
                    app.state.loadingMessage = null;
                }
            }, 5000);
        }
    }, 2000);
    
    // Resolve the promise - we'll wait for updates
    resolve();
}

export {
    viewCategory,
    loadMoreMedia,
    clearResources,
    preloadNextMedia,
    updateSwipeIndicators,
    optimizeVideoElement,
    createOrUpdateIndexingUI
};
