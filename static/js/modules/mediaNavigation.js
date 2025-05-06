/**
 * Media Navigation Module
 * Handles navigation between media items and rendering the media window
 */

import { 
    app, 
    tiktokContainer, 
    spinnerContainer, 
    LOAD_MORE_THRESHOLD, 
    renderWindowSize,
    MOBILE_DEVICE
} from '../core/app.js';

import { 
    getFromCache, 
    hasInCache, 
    addToCache,
    performCacheCleanup
} from '../utils/cacheManager.js';

import { loadMoreMedia, preloadNextMedia, updateSwipeIndicators } from './mediaLoader.js';
import { setupControls } from './uiController.js';

// Need access to the socket instance for state updates
// Socket instance (initialized via initMediaNavigation)
let socket = null;
// Flag to ensure the delegated listener is attached only once
let thumbnailClickListenerAttached = false;

/**
 * Sets up a delegated event listener on the main container for thumbnail clicks.
 */
function setupThumbnailClickListener() {
    if (thumbnailClickListenerAttached || !tiktokContainer) return;

    console.log("Setting up delegated thumbnail click listener.");
    tiktokContainer.addEventListener('click', function(e) {
        // Find the closest thumbnail container ancestor
        const thumbnailContainer = e.target.closest('.video-thumbnail-container');

        if (thumbnailContainer) {
            e.preventDefault(); // Prevent default link behavior if wrapped
            e.stopPropagation(); // Stop event bubbling

            // Prevent multiple rapid clicks
            if (thumbnailContainer.classList.contains('loading-video')) {
                console.log(`Delegated click ignored for ${thumbnailContainer.dataset.videoSrc}: already loading.`);
                return;
            }
            thumbnailContainer.classList.add('loading-video');

            const videoSrc = thumbnailContainer.dataset.videoSrc;
            const fileInfo = JSON.parse(thumbnailContainer.dataset.fileInfo);
            const currentDataIndex = thumbnailContainer.dataset.index;

            console.log(`Delegated thumbnail click detected for index: ${currentDataIndex}, file: ${fileInfo.name}`);

            try {
                // Create the actual video element, initially muted and with preload='none'
                const videoElement = createActualVideoElement(fileInfo, false); // Pass isActive = false

                // Ensure the new video element has the correct classes and attributes before replacing
                videoElement.classList.add('tiktok-media', 'active'); // Still mark as active visually
                if (currentDataIndex) {
                    videoElement.setAttribute('data-index', currentDataIndex); // Copy index
                }
                videoElement.style.transform = 'translateY(0)'; // Ensure it's positioned correctly

                // Replace the thumbnail container with the video element
                if (thumbnailContainer.parentNode) {
                    thumbnailContainer.parentNode.replaceChild(videoElement, thumbnailContainer);
                    console.log(`Replaced thumbnail with video for index: ${currentDataIndex}`);

                    // Add fullscreen button after replacing
                    setTimeout(() => {
                        if (window.appModules && window.appModules.fullscreenManager) {
                            window.appModules.fullscreenManager.addFullscreenButton(videoElement);
                        }
                    }, 100);

                    // Start loading and playing the video AFTER it's in the DOM
                    setTimeout(() => {
                        videoElement.preload = 'auto'; // Now set preload to auto
                        videoElement.muted = false;   // Unmute before playing
                        videoElement.play().then(() => {
                            console.log(`Video playback started for index: ${currentDataIndex}`);
                        }).catch(err => {
                            console.error(`Error playing video after click for index ${currentDataIndex}:`, err);
                            // If unmuted play fails, try muted as a fallback (though less likely needed now)
                            videoElement.muted = true;
                            videoElement.play().catch(e2 => console.error(`Muted playback also failed for index ${currentDataIndex}:`, e2));
                        });
                    }, 50); // Small delay to ensure DOM is ready
                } else {
                    console.error("Cannot replace thumbnail container - no parent node found.");
                    thumbnailContainer.classList.remove('loading-video'); // Remove loading lock if replacement fails
                }
            } catch (error) {
                 console.error(`Error creating or replacing video for ${fileInfo.name}:`, error);
                 thumbnailContainer.classList.remove('loading-video'); // Ensure loading class is removed on error
            }
        }
    });

    thumbnailClickListenerAttached = true; // Set flag
}


/**
 * Navigate between media items with performance optimizations
 * @param {string} direction - The direction to navigate ('next', 'prev', or undefined for play/pause)
 * @param {Event} event - Optional event object that triggered the navigation
 */
function navigateMedia(direction, event) {
    // Check if the event originated from the chat container
    if (event && event.target && event.target.closest('#chat-container')) {
        console.log('Navigation ignored: event originated from chat container');
        return;
    }
    
    // Check if we've recently exited fullscreen mode
    if (window.fullscreenExited) {
        console.log('Navigation ignored: recently exited fullscreen');
        return;
    }
    
    // Check if navigation is disabled (for guests in sync mode)
    if (app.state.navigationDisabled && (direction === 'next' || direction === 'prev')) {
        console.log('Navigation ignored: user is a guest in sync mode');
        return;
    }
    
    let nextIndex = app.state.currentMediaIndex;
    const listLength = app.state.fullMediaList.length;
    const currentMediaElement = tiktokContainer.querySelector('.tiktok-media.active');

    // Performance optimization: Clean up old media elements
    // Keep only the currently visible and a few nearby elements
    const visibleIndices = new Set([app.state.currentMediaIndex]);
    if (app.state.currentMediaIndex > 0) visibleIndices.add(app.state.currentMediaIndex - 1);
    if (app.state.currentMediaIndex < listLength - 1) visibleIndices.add(app.state.currentMediaIndex + 1);
    
    // Use requestAnimationFrame to avoid blocking the UI thread during cleanup
    requestAnimationFrame(() => {
        tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => {
            const index = parseInt(el.getAttribute('data-index'), 10);
            if (!visibleIndices.has(index) && el !== currentMediaElement) {
                // Remove elements that are far from current view to save memory
                if (el.tagName === 'VIDEO') {
                    try {
                        el.pause();
                        el.removeAttribute('src');
                        el.load(); // Force release of video resources
                    } catch (e) {
                        console.warn('Error cleaning up video:', e);
                    }
                }
                el.remove();
            }
        });
    });

    if (direction === 'next') {
        // Check if we need to load more before calculating next index
        if (app.state.hasMoreMedia && !app.state.isLoading && app.state.currentMediaIndex >= listLength - LOAD_MORE_THRESHOLD) {
            console.log("Approaching end, loading more media...");
            // Use setTimeout to avoid blocking the UI thread
            setTimeout(() => {
                loadMoreMedia(); // Load more in the background
            }, 0);
        }
        
        if (app.state.currentMediaIndex < listLength - 1) {
            nextIndex = app.state.currentMediaIndex + 1;
        } else {
            console.log("Reached end of loaded media.");
            if (!app.state.hasMoreMedia) return; // Stop if no more media to load
        }
    } else if (direction === 'prev') {
        if (app.state.currentMediaIndex > 0) {
            nextIndex = app.state.currentMediaIndex - 1;
        } else {
            console.log("Already at the beginning.");
            return; // Stay at the first item
        }
    } else {
        // Handle tap/click to play/pause
        if (currentMediaElement && currentMediaElement.tagName === 'VIDEO') {
            // Ensure loop is set before playing
            currentMediaElement.loop = true;
            currentMediaElement.setAttribute('loop', 'true');
            
            if (currentMediaElement.paused) {
                currentMediaElement.play().catch(e => console.error("Resume play failed:", e));
            } else {
                currentMediaElement.pause();
            }
        }
        return; // Don't navigate if direction is not next/prev
    }

    // Pause current video before transition
    if (currentMediaElement && currentMediaElement.tagName === 'VIDEO') {
        try {
            currentMediaElement.pause();
        } catch (e) {
            console.warn('Error pausing video:', e);
        }
    }

    // Render the new window centered on nextIndex, only if index changed
    if (nextIndex !== app.state.currentMediaIndex) {
        renderMediaWindow(nextIndex);

        // REMOVED: All automatic playback logic after navigation/render.
        // Playback is now ONLY initiated by the delegated thumbnail click handler
        // or the manual play/pause tap handler within navigateMedia itself.

        // Update media info overlay if file exists
        if (app.state.fullMediaList && app.state.fullMediaList.length > nextIndex && app.state.fullMediaList[nextIndex]) {
            updateMediaInfoOverlay(app.state.fullMediaList[nextIndex]);
            
            // If sync mode is enabled and we're the host, send update to server
            if (app.state.syncModeEnabled && app.state.isHost) {
                const currentFile = app.state.fullMediaList[nextIndex];
                console.log('Host sending sync update for index:', nextIndex);
                
                // Use the improved sendSyncUpdate function
                window.appModules.syncManager.sendSyncUpdate({
                    category_id: app.state.currentCategoryId,
                    file_url: currentFile.url,
                    index: nextIndex
                }).then(success => {
                    if (!success) {
                        console.warn('Sync update was not successful');
                    }
                });
            }
        }
        
        // Emit state update after navigation
        emitMyStateUpdate(app.state.currentCategoryId, nextIndex);
    }
}

/**
 * Render media window with optimized loading
 * @param {number} index - The index of the media to render
 */
function renderMediaWindow(index) {
    try {
      // Ensure delegated click listener is in place
      setupThumbnailClickListener();
  
      // Save & clear spinner
      const savedSpinner = spinnerContainer ? spinnerContainer.cloneNode(true) : null;
      tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => el.remove());
      tiktokContainer.querySelectorAll('.fullscreen-btn').forEach(el => el.remove());
  
      // Track render time & remove leftover loading messages
      app.state.lastRenderTime = Date.now();
      if (app.state.loadingMessage && document.body.contains(app.state.loadingMessage)) {
        app.state.loadingMessage.remove();
        app.state.loadingMessage = null;
      }
  
      // Re-add spinner if needed
      if (savedSpinner && !tiktokContainer.querySelector('.spinner-container')) {
        tiktokContainer.appendChild(savedSpinner);
      }
  
      // Update current index & overlay
      const previousIndex = app.state.currentMediaIndex;
      app.state.currentMediaIndex = index;
      if (app.state.fullMediaList && app.state.fullMediaList[index]) {
        updateMediaInfoOverlay(app.state.fullMediaList[index]);
      }
  
      // Compute window of items
      const startIndex = Math.max(0, index - renderWindowSize);
      const endIndex   = Math.min(app.state.fullMediaList.length - 1, index + renderWindowSize);
      console.log(`Rendering window: ${startIndex} to ${endIndex} (current: ${index})`);
  
      // Sync-host broadcast on direct renders
      if (app.state.syncModeEnabled && app.state.isHost && previousIndex !== index) {
        const currentFile = app.state.fullMediaList[index];
        console.log('Host sending sync update for direct index change');
        window.appModules.syncManager.sendSyncUpdate({
          category_id: app.state.currentCategoryId,
          file_url: currentFile.url,
          index
        }).then(success => {
          if (!success) console.warn('Sync update failed');
        });
      }
  
      // Render loop
      for (let i = startIndex; i <= endIndex; i++) {
        const file = app.state.fullMediaList[i];
        if (!file || file.type === 'error') continue;
  
        let mediaElement;
        let useCache = false;
  
        // Bypass cache for the active index so we always rebuild its thumbnail+play overlay
        const isActiveVideo = file.type === 'video' && i === index;
        if (isActiveVideo) {
          console.log(`Bypassing cache for active video "${file.name}"`);
        } else if (hasInCache(file.url)) {
          const cached = getFromCache(file.url);
          // Only reuse if not a bare <img> thumbnail for a video
          if (!(file.type === 'video' && cached.tagName === 'IMG')) {
            mediaElement = cached;
            useCache     = true;
            if (mediaElement.tagName === 'VIDEO') {
              mediaElement.muted = false;
              mediaElement.loop  = true;
              mediaElement.setAttribute('loop', 'true');
            }
          } else {
            console.log(`Ignoring cached <img> thumbnail for video "${file.name}"`);
          }
        }
  
        // If we didn't reuse cache, build new
        if (!useCache) {
          if (file.type === 'video') {
            mediaElement = createVideoElement(file, i === index);
          } else if (file.type === 'image') {
            mediaElement = createImageElement(file);
          } else {
            mediaElement = createPlaceholderElement(file);
          }
  
          // **Only cache thumbnail containers** (never actual <video> nodes)
          if (
            mediaElement &&
            mediaElement.classList.contains('video-thumbnail-container')
          ) {
            addToCache(file.url, mediaElement);
          }
        }
  
        // Final setup & insertion
        if (mediaElement) {
          if (!mediaElement.classList.contains('tiktok-media')) {
            mediaElement.classList.add('tiktok-media');
          }
          mediaElement.setAttribute('data-index', i);
  
          if (i === index) {
            mediaElement.classList.add('active');
            mediaElement.style.transform = 'translateY(0)';
  
            if (mediaElement.tagName === 'VIDEO') {
              // Immediately pause any unintended autoplay
              setTimeout(() => {
                if (mediaElement.parentNode) {
                  mediaElement.pause();
                  console.log(`Paused initial video at index ${i}`);
                }
              }, 0);
            }
          }
  
          tiktokContainer.appendChild(mediaElement);
        }
      }
  
      // Post-render chores
      preloadNextMedia();
      setupControls();
      updateSwipeIndicators(index, app.state.fullMediaList.length);
      setTimeout(() => {
        if (window.appModules?.fullscreenManager) {
          window.appModules.fullscreenManager.ensureFullscreenButtons();
        }
      }, 100);
  
      // Emit final state
      emitMyStateUpdate(app.state.currentCategoryId, app.state.currentMediaIndex);
  
    } catch (err) {
      console.error("Error in renderMediaWindow:", err);
      if (spinnerContainer) spinnerContainer.style.display = 'none';
      throw err;
    }
  }
  
  


/**
 * Emits the current user's state to the server.
 * @param {string} categoryId - The current category ID.
 * @param {number} index - The current media index.
 */
function emitMyStateUpdate(categoryId, index) {
    // Check if socket exists and is connected
    if (!socket) {
        console.warn('emitMyStateUpdate: Socket instance is not available.');
        return;
    }
    if (!socket.connected) {
        console.warn(`emitMyStateUpdate: Socket not connected. Cannot send state update for Cat=${categoryId}, Idx=${index}`);
        return;
    }
    
    // Validate categoryId and index
    if (!categoryId || typeof categoryId !== 'string' || !categoryId.trim()) {
        console.warn(`emitMyStateUpdate: Invalid or missing categoryId: ${categoryId}. Skipping update.`);
        return;
    }
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
        console.warn(`emitMyStateUpdate: Invalid or missing index: ${index}. Skipping update.`);
        return;
    }
    

    // If validation passes, emit the event
    const currentOrder = app.state.fullMediaList.map(item => item ? item.url : null).filter(url => url); // Send only URLs
    console.log(`Emitting state update: Cat=${categoryId}, Idx=${index}, Order URLs: ${currentOrder.length}`);
    try {
        socket.emit('update_my_state', {
            category_id: categoryId,
            index: index,
            media_order: currentOrder // Send the current order URLs
            
        });
        
    } catch (error) {
        console.error(`emitMyStateUpdate: Error emitting 'update_my_state' event:`, error);
    }
}


/**
 * Create a video thumbnail container (with overlay) for the given file.
 * Always returns a <div class="video-thumbnail-container"> wrapper,
 * using eager loading for the active item so its thumbnail always appears.
 *
 * @param {Object}  file     – The file object (must have file.url, file.name, file.thumbnailUrl)
 * @param {boolean} isActive – Whether this is the active media (i.e. i === index)
 * @returns {HTMLElement}     – The thumbnail container with overlay
 */
function createVideoElement(file, isActive) {
    const container = document.createElement('div');
    container.className = `tiktok-media video-thumbnail-container${isActive ? ' active' : ''}`;
    container.setAttribute('data-video-src', file.url);
    container.setAttribute('data-file-info', JSON.stringify(file));
  
    // thumbnail image
    const thumbnailImage = document.createElement('img');
    thumbnailImage.className = 'video-thumbnail-image';
    thumbnailImage.alt = file.name;
    // eager load if this is the active index, fallback to lazy for others
    thumbnailImage.loading = isActive ? 'eager' : 'lazy';
    thumbnailImage.src     = file.thumbnailUrl;
  
    // force decode on active so it paints ASAP
    if (isActive && thumbnailImage.decode) {
      thumbnailImage.decode().catch(() => {/* ignore decode errors */});
    }
  
    // play-button overlay
    const playOverlay = document.createElement('div');
    playOverlay.className = 'play-icon-overlay';
  
    container.appendChild(thumbnailImage);
    container.appendChild(playOverlay);
    return container;
  }
  
  
/**
 * Create the actual video element (used directly or via thumbnail click)
 * @param {Object} file - The file object
 * @param {boolean} isActive - Whether this is the active media (determines preload and muted state)
 * @returns {HTMLVideoElement} - The created video element
 */
function createActualVideoElement(file, isActive) {
    console.log(`Creating actual video element for ${file.name}, isActive: ${isActive}`);
    const mediaElement = document.createElement('video');

    // Set essential attributes
    mediaElement.loop = true; // Always loop videos
    mediaElement.setAttribute('loop', 'true');
    // ALWAYS create muted initially. Playback is handled by click or navigation.
    mediaElement.muted = true;

    // Set preload to 'none' initially for ALL videos. It will be set to 'auto' in the click handler.
    mediaElement.preload = 'none';

    // Explicitly remove autoplay attribute - playback is controlled manually
    mediaElement.removeAttribute('autoplay');
    // if (isActive) { // Old logic removed
    //     mediaElement.autoplay = true; // Removed
    //     mediaElement.setAttribute('autoplay', 'true');
    // }
    
    // Show controls on desktop, hide on mobile
    mediaElement.controls = !MOBILE_DEVICE; // Show controls on desktop only
    mediaElement.setAttribute('controlsList', 'nodownload'); // Remove download button
    
    // Set playsinline for all platforms
    mediaElement.playsInline = true;
    mediaElement.setAttribute('playsinline', 'true');
    mediaElement.setAttribute('webkit-playsinline', 'true');
    
    // Add performance attributes
    mediaElement.setAttribute('disableRemotePlayback', 'true');
    mediaElement.disablePictureInPicture = true;
    
    // Use thumbnail as poster if available, otherwise use a data URL
    if (file.thumbnailUrl) {
        mediaElement.poster = file.thumbnailUrl;
    } else {
        mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
    }
    
    // Add fetchpriority for active videos
    if (isActive) {
        mediaElement.setAttribute('fetchpriority', 'high');
    }
    
    // Create a placeholder element that will be shown if loading fails
    const placeholder = createPlaceholderElement(file, 'video');
    
    // Add error handling with simplified retry logic
    mediaElement.onerror = function() {
        console.error(`Error loading video: ${file.url}`, this.error);
        
        let retries = parseInt(this.getAttribute('data-retries') || '0');
        const maxRetries = 2; // Reduced from 3 to 2
        
        if (retries < maxRetries) {
            retries++;
            this.setAttribute('data-retries', retries);
            
            // Simplified retry - just set src directly instead of manipulating source elements
            this.src = `${file.url}${file.url.includes('?') ? '&' : '?'}retry=${retries}&_t=${Date.now()}`;
            this.load();
        } else {
            // Replace with placeholder after max retries
            if (this.parentNode) {
                this.parentNode.replaceChild(placeholder, this);
            }
        }
    };
    
    // Add minimal performance monitoring - only log canplay for active videos
    if (isActive) {
        mediaElement.addEventListener('canplay', () => console.log(`Video canplay: ${file.name}`));
    }
    
    // Add fullscreen button only for active videos
    if (isActive) {
        mediaElement.addEventListener('loadeddata', () => {
            setTimeout(() => {
                if (window.appModules && window.appModules.fullscreenManager) {
                    window.appModules.fullscreenManager.addFullscreenButton(mediaElement);
                }
            }, 100);
        });
    }
    
    // Set source directly instead of using source element
    mediaElement.src = file.url;
    
    // Force load
    mediaElement.load();
    
    return mediaElement;
}

/**
 * Create an image element for the given file
 * @param {Object} file - The file object
 * @returns {HTMLImageElement} - The created image element
 */
function createImageElement(file) {
    const mediaElement = document.createElement('img');
    mediaElement.alt = file.name;
    mediaElement.loading = 'lazy';
    
    // Create a placeholder element that will be shown if loading fails
    const placeholder = createPlaceholderElement(file, 'image');
    
    // Add error handling for images
    mediaElement.onerror = function() {
        console.error(`Error loading image: ${file.url}`);
        this.onerror = null; // Prevent infinite loop
        
        // Replace the image element with the placeholder
        if (this.parentNode) {
            this.parentNode.replaceChild(placeholder, this);
        } else {
            console.warn("Cannot replace image element - no parent node");
            return placeholder;
        }
    };
    
    // Set source after adding error handler
    mediaElement.src = file.url;
    
    return mediaElement;
}

/**
 * Create a placeholder element for unknown or failed media
 * @param {Object} file - The file object
 * @param {string} type - The type of placeholder ('video', 'image', or undefined for unknown)
 * @returns {HTMLDivElement} - The created placeholder element
 */
function createPlaceholderElement(file, type) {
    const mediaElement = document.createElement('div');
    mediaElement.className = 'unknown-file-placeholder';
    mediaElement.style.backgroundColor = '#333';
    mediaElement.style.display = 'flex';
    mediaElement.style.flexDirection = 'column';
    mediaElement.style.alignItems = 'center';
    mediaElement.style.justifyContent = 'center';
    mediaElement.style.color = 'white';
    mediaElement.style.height = '100%';
    mediaElement.style.width = '100%';
    
    // Add file icon based on type
    const iconDiv = document.createElement('div');
    if (type === 'video') {
        iconDiv.innerHTML = '🎬';
        iconDiv.style.fontSize = '64px';
        iconDiv.style.marginBottom = '10px';
    } else if (type === 'image') {
        iconDiv.innerHTML = '🖼️';
        iconDiv.style.fontSize = '64px';
        iconDiv.style.marginBottom = '10px';
    } else {
        iconDiv.innerHTML = '📄';
        iconDiv.style.fontSize = '64px';
        iconDiv.style.marginBottom = '10px';
    }
    
    // Add file name
    const nameDiv = document.createElement('div');
    nameDiv.textContent = file.name;
    nameDiv.style.fontSize = '16px';
    nameDiv.style.maxWidth = '80%';
    nameDiv.style.overflow = 'hidden';
    nameDiv.style.textOverflow = 'ellipsis';
    nameDiv.style.whiteSpace = 'nowrap';
    
    // Add file type or error message
    const typeDiv = document.createElement('div');
    if (type === 'video') {
        typeDiv.textContent = 'Video failed to load';
    } else if (type === 'image') {
        typeDiv.textContent = 'Image failed to load';
    } else {
        typeDiv.textContent = `Unsupported file type: ${file.type || 'unknown'}`;
    }
    typeDiv.style.fontSize = '14px';
    typeDiv.style.color = '#aaa';
    typeDiv.style.marginTop = '5px';
    
    mediaElement.appendChild(iconDiv);
    mediaElement.appendChild(nameDiv);
    mediaElement.appendChild(typeDiv);
    
    return mediaElement;
}

/**
 * Update the media info overlay with current file information
 * @param {Object} file - The current media file object
 */
function updateMediaInfoOverlay(file) {
    if (!file) return;
    
    const overlay = document.querySelector('.media-info-overlay');
    if (!overlay) return;
    
    const filename = overlay.querySelector('.filename');
    const metadata = overlay.querySelector('.metadata');
    
    if (filename && metadata) {
        // Set filename
        filename.textContent = file.name || 'Unknown file';
        
        // Format file size
        let sizeText = '';
        if (file.size) {
            const sizeInMB = file.size / (1024 * 1024);
            sizeText = sizeInMB < 1 ? 
                `${Math.round(sizeInMB * 1000) / 10} KB` : 
                `${Math.round(sizeInMB * 10) / 10} MB`;
        }
        
        // Format dimensions
        let dimensionsText = '';
        if (file.width && file.height) {
            dimensionsText = `${file.width} × ${file.height}`;
        }
        
        // Format date
        let dateText = '';
        if (file.date) {
            const date = new Date(file.date);
            dateText = date.toLocaleDateString();
        }
        
        // Update metadata spans
        const dimensionsSpan = metadata.querySelector('.dimensions');
        const sizeSpan = metadata.querySelector('.size');
        const dateSpan = metadata.querySelector('.date');
        
        if (dimensionsSpan) dimensionsSpan.textContent = dimensionsText || 'Unknown dimensions';
        if (sizeSpan) sizeSpan.textContent = sizeText || 'Unknown size';
        if (dateSpan) dateSpan.textContent = dateText || 'Unknown date';
    }
}

export {
    navigateMedia,
    renderMediaWindow,
    createVideoElement, // Keep this export
    createActualVideoElement, // Add export for the new function if needed elsewhere, otherwise remove
    createImageElement,
    createPlaceholderElement,
    updateMediaInfoOverlay,
    initMediaNavigation // Export init function
};

/**
 * Initialize the media navigation module.
 * @param {Object} socketInstance - The shared Socket.IO instance.
 */
function initMediaNavigation(socketInstance) {
    socket = socketInstance;
    console.log('Media navigation initialized with socket.');
    // Setup the delegated listener during initialization as well
    setupThumbnailClickListener();
    // Any other initialization logic for this module can go here
}
