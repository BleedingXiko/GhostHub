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
    getMediaPerPage,
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
import { setupControls, createOrUpdateIndexingUI, updateSwipeIndicators } from './uiController.js';

/**
 * Load and display a media category
 * @param {string}         categoryId    – Category ID to view
 * @param {string[]|null}  [forced_order] – Optional array of media URLs to force a specific order
 * @param {number}         [startIndex=0] – Optional index to start rendering from
 * @returns {Promise} Resolves when loaded
 */
async function viewCategory(categoryId, forced_order = null, startIndex = 0) {
    console.log(`viewCategory: category=${categoryId}, forced_order=${forced_order ? 'yes' : 'no'}, startIndex=${startIndex}`);
  
    // Capture old map in case you want to preserve extra metadata
    const oldMap = new Map((app.state.fullMediaList || []).map(item => [item.url, item]));
  
    // If same cat+idx and no forced_order → nothing to do
    if (!forced_order &&
        app.state.currentCategoryId === categoryId &&
        app.state.currentMediaIndex === startIndex) {
      console.log('No-op: already at that category/index');
      return;
    }
    // If same category but diff index → just render that index
    if (!forced_order &&
        app.state.currentCategoryId === categoryId &&
        app.state.currentMediaIndex !== startIndex) {
      console.log(`Jumping to index ${startIndex} on same category`);
      renderMediaWindow(startIndex);
      return;
    }
  
    // If host in sync mode, broadcast cat change
    if (app.state.syncModeEnabled && app.state.isHost) {
      window.appModules.syncManager.sendSyncUpdate({
        category_id: categoryId,
        file_url:    null,
        index:       0
      }).then(ok => { if (!ok) console.warn('Sync update failed'); });
    }
  
    // Reset state
    app.state.currentCategoryId  = categoryId;
    app.state.currentPage        = 1;
    app.state.hasMoreMedia       = true;
    app.state.isLoading          = false;
    app.state.fullMediaList      = [];
    app.state.preloadQueue       = [];
    app.state.isPreloading       = false;
    app.state.currentMediaIndex  = startIndex;
  
    // Clear cache + abort
    app.mediaCache.clear();
    if (app.state.currentFetchController) app.state.currentFetchController.abort();
    app.state.currentFetchController = new AbortController();
  
    // Aggressive cleanup of DOM/resources
    clearResources(true);
    if (tiktokContainer) {
      tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => el.remove());
    }
  
    // Show spinner
    if (spinnerContainer) spinnerContainer.style.display = 'flex';
  
    // Decide page size - Always use getMediaPerPage() from core/app.js
    const pageSize = getMediaPerPage();
    const signal   = app.state.currentFetchController.signal;
  
    try {
      // ALWAYS fetch metadata from the server first
      if (forced_order) {
        console.log(`Forced order present (${forced_order.length} URLs) — fetching metadata until all are found or no more media.`);
        
        const forcedUrlsSet = new Set(forced_order);
        let allForcedItemsLoaded = false;

        // Keep fetching pages until all URLs in forced_order are found in fullMediaList,
        // or there's no more media to load from the server.
        while (!allForcedItemsLoaded && app.state.hasMoreMedia) {
          await loadMoreMedia(pageSize, signal, false);

          // Check if all forced_order URLs are now in fullMediaList
          let foundCount = 0;
          const currentLoadedUrls = new Set(app.state.fullMediaList.map(item => item.url));
          for (const url of forcedUrlsSet) {
            if (currentLoadedUrls.has(url)) {
              foundCount++;
            }
          }
          if (foundCount === forcedUrlsSet.size) {
            allForcedItemsLoaded = true;
            console.log('All items from forced_order have been loaded.');
          } else {
            console.log(`Still missing ${forcedUrlsSet.size - foundCount} items from forced_order. Current list size: ${app.state.fullMediaList.length}. Has more media: ${app.state.hasMoreMedia}`);
          }
        }
        
        // Now reorder based on forced_order
        const metaMap = new Map(app.state.fullMediaList.map(f => [f.url, f]));
        app.state.fullMediaList = forced_order.map(url => {
          const real = metaMap.get(url);
          if (real) {
            return real;
          } else {
            // This case should be rarer now. Log a warning if a forced URL wasn't found.
            console.warn(`URL from forced_order not found in loaded media after attempting to load all: ${url}. Using placeholder.`);
            return {
              url,
              name: url.split('/').pop(),
              type: /\.(jpe?g|png|gif)$/i.test(url) ? 'image'
                   : /\.(mp4|webm|mov)$/i.test(url) ? 'video'
                   : 'unknown',
              thumbnailUrl: '/static/icons/Ghosthub192.png'
            };
          }
        });
        app.state.hasMoreMedia = false; // This line might be reviewed depending on desired behavior after viewing a shared link.
      } else {
        // Normal first-page load
        await loadMoreMedia(pageSize, signal, false);
      }
  
      // Hide category view, show tiktok view
      categoryView.classList.add('hidden');
      mediaView.classList.add('hidden');
      tiktokContainer.classList.remove('hidden');
  
      setupMediaNavigation();
      renderMediaWindow(app.state.currentMediaIndex);
  
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('viewCategory error:', err);
        alert('Error loading media');
      }
      categoryView.classList.remove('hidden');
      mediaView.classList.add('hidden');
  
    } finally {
      if (spinnerContainer) spinnerContainer.style.display = 'none';
    }
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
    const limit = customLimit || getMediaPerPage();
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
    optimizeVideoElement
};
