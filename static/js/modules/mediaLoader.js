/**
 * Media Loader Module
 * Handles media loading, resource management, and cleanup
 */

import { 
    app, 
    tiktokContainer, 
    spinnerContainer, 
    categoryView, 
    mediaView,
    MEDIA_PER_PAGE
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
 * View a category and its media - optimized version
 * Returns a Promise that resolves when the category is loaded and initial media is rendered.
 * @param {string} categoryId - The ID of the category to view
 * @returns {Promise} - A promise that resolves when the category is loaded
 */
function viewCategory(categoryId) {
    return new Promise(async (resolve, reject) => {
        console.log(`Starting viewCategory for categoryId: ${categoryId}`);
        
        // IMPORTANT: First check if we're already viewing this category
        if (app.state.currentCategoryId === categoryId) {
            console.log("Already viewing this category, resolving immediately");
            resolve(); // Resolve immediately if already viewing
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
    
        // STEP 1: Reset all state variables FIRST before any other operations
        app.state.currentCategoryId = categoryId;
        app.state.currentPage = 1; 
        app.state.hasMoreMedia = true; 
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

                // STEP 8: Always force refresh when loading a new category
                console.log("Forcing refresh for new category load");
                
                // Fetch the first page of media, passing the specific signal for this view
                await loadMoreMedia(pageSize, app.state.currentFetchController.signal, true); // Added true for forceRefresh

                // Check if the fetch was aborted (e.g., user switched category again quickly)
                if (app.state.currentFetchController.signal.aborted) {
                    console.log("Fetch aborted during initial load, stopping viewCategory.");
                    if (spinnerContainer) spinnerContainer.style.display = 'none'; // Hide spinner if aborted
                    return; 
                }

                // --- REVISED LOGIC: Only proceed if media was successfully loaded ---
                if (app.state.fullMediaList && app.state.fullMediaList.length > 0) {
                    // Unified TikTok View for Images and Videos
                    console.log("Showing unified TikTok view.");
                    categoryView.classList.add('hidden');
                    mediaView.classList.add('hidden'); // Ensure old view is hidden
                    tiktokContainer.classList.remove('hidden');
                    
                    // Setup navigation (index is already 0)
                    setupMediaNavigation(); 
                    
                    // Render initial window
                    renderMediaWindow(0); // This function handles its own DOM clearing now
                    
                    // Spinner is hidden by loadMoreMedia's finally block
                    resolve(); // Resolve the promise when everything is loaded

                } else {
                    // Handle case where no media was found or loaded
                    // Ensure spinner is hidden if no media is loaded
                    if (spinnerContainer) spinnerContainer.style.display = 'none';
                    console.log('No media files found in response or files array is empty after load.');
                    alert('No media files found or error loading media.');
                    // Go back to category view
                    tiktokContainer.classList.add('hidden');
                    categoryView.classList.remove('hidden');
                    if (spinnerContainer) spinnerContainer.style.display = 'none';
                    reject(new Error('No media files found')); // Reject the promise
                }
                // --- END REVISED LOGIC ---

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
 * Load more media items when scrolling near the end - optimized version
 * @param {number|null} customLimit - Optional limit for the number of items to load.
 * @param {AbortSignal|null} signal - Optional AbortSignal to use for the fetch.
 * @param {boolean} forceRefresh - Whether to force a refresh from the server.
 * @param {number|null} targetPage - Optional specific page number to load.
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
        // Use the forceRefresh parameter or default to first page
        const forceRefreshParam = forceRefresh || app.state.currentPage === 1 ? '&force_refresh=true' : '';
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
 * Clear resources to prevent memory leaks - optimized version
 * @param {boolean} aggressive - Whether to perform aggressive cleanup
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
        
        // Hint to browser to garbage collect
        if (window.gc) window.gc();
    } else {
        // Regular cleanup - limit cache size
        performCacheCleanup();
    }
}

/**
 * Preload media in the background with optimized performance
 */
function preloadNextMedia() {
    if (app.state.isPreloading || app.state.preloadQueue.length === 0) return;
    
    // Skip preloading if cache is getting too large
    if (app.mediaCache.size >= window.appModules.cacheManager.MAX_CACHE_SIZE) {
        console.log("Cache size limit reached, skipping preload");
        app.state.isPreloading = false;
        return;
    }
    
    app.state.isPreloading = true;
    
    // Prioritize next 2 items for immediate viewing
    const nextItems = app.state.preloadQueue.slice(0, 2);
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
        mediaElement = document.createElement('video');
        
        // Set video attributes for faster loading
        mediaElement.preload = 'auto'; // Changed from 'metadata' to 'auto' for faster loading
        mediaElement.playsInline = true;
        mediaElement.setAttribute('playsinline', 'true');
        mediaElement.setAttribute('webkit-playsinline', 'true');
        mediaElement.setAttribute('controlsList', 'nodownload nofullscreen');
        mediaElement.disablePictureInPicture = true;
        mediaElement.muted = true; // Muted for faster loading
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
        
        // For videos, preload both metadata and some content
        mediaElement.addEventListener('loadeddata', () => {
            console.log(`Video data loaded: ${file.name}`);
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
            console.warn(`Video load timeout: ${file.name}`);
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            app.state.isPreloading = false;
            // Continue preloading immediately
            setTimeout(preloadNextMedia, 0);
        }, 5000); // Reduced from 10s to 5s
        
        mediaElement.addEventListener('loadeddata', () => {
            clearTimeout(loadTimeout);
        });
        
        // Add a small amount of buffering for smoother playback
        mediaElement.addEventListener('canplay', () => {
            // If this is the next video to be played, buffer a bit more
            if (app.state.fullMediaList[currentIndex + 1] && 
                app.state.fullMediaList[currentIndex + 1].url === file.url) {
                console.log(`Buffering next video: ${file.name}`);
                // Start playing muted to buffer, then pause
                mediaElement.play().then(() => {
                    setTimeout(() => {
                        mediaElement.pause();
                    }, 500); // Buffer for 500ms
                }).catch(e => {
                    console.warn(`Could not buffer video: ${e}`);
                });
            }
        });
        
        // Use a data URL for the poster to avoid an extra network request
        mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
        
        document.body.appendChild(mediaElement);
        
        // Add source with type for better loading
        const source = document.createElement('source');
        source.src = file.url;
        source.type = 'video/mp4'; // Assume MP4 for better browser compatibility
        mediaElement.appendChild(source);
        
        // Force load
        mediaElement.load();
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
 * Optimize video element for faster loading
 * @param {HTMLVideoElement} videoElement - The video element to optimize
 */
function optimizeVideoElement(videoElement) {
    // Set video attributes for faster loading
    videoElement.preload = 'auto';
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
    
    // Add event listeners for better performance monitoring
    videoElement.addEventListener('loadstart', () => console.log('Video loadstart'));
    videoElement.addEventListener('loadedmetadata', () => console.log('Video loadedmetadata'));
    videoElement.addEventListener('loadeddata', () => console.log('Video loadeddata'));
    videoElement.addEventListener('canplay', () => console.log('Video canplay'));
    
    return videoElement;
}

/**
 * Update swipe indicators
 * @param {number} currentIndex - The current media index
 * @param {number} totalItems - The total number of media items
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

export {
    viewCategory,
    loadMoreMedia,
    clearResources,
    preloadNextMedia,
    updateSwipeIndicators,
    optimizeVideoElement
};
