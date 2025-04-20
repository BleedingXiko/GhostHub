/**
 * Media Navigation Module
 * Handles navigation between media items and rendering the media window
 */

import { 
    app, 
    tiktokContainer, 
    spinnerContainer, 
    LOAD_MORE_THRESHOLD, 
    renderWindowSize 
} from '../core/app.js';

import { 
    getFromCache, 
    hasInCache, 
    addToCache 
} from '../utils/cacheManager.js';

import { loadMoreMedia, preloadNextMedia, updateSwipeIndicators } from './mediaLoader.js';
import { setupControls } from './uiController.js';

/**
 * Navigate between media items with performance optimizations
 * @param {string} direction - The direction to navigate ('next', 'prev', or undefined for play/pause)
 */
function navigateMedia(direction) {
    let nextIndex = app.state.currentMediaIndex;
    const listLength = app.state.fullMediaList.length;
    const currentMediaElement = tiktokContainer.querySelector('.tiktok-media.active');

    // Performance optimization: Clean up old media elements
    // Keep only the currently visible and a few nearby elements
    const visibleIndices = new Set([app.state.currentMediaIndex]);
    if (app.state.currentMediaIndex > 0) visibleIndices.add(app.state.currentMediaIndex - 1);
    if (app.state.currentMediaIndex < listLength - 1) visibleIndices.add(app.state.currentMediaIndex + 1);
    
    tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => {
        const index = parseInt(el.getAttribute('data-index'), 10);
        if (!visibleIndices.has(index) && el !== currentMediaElement) {
            // Remove elements that are far from current view to save memory
            if (el.tagName === 'VIDEO') {
                el.pause();
                el.src = '';
                el.load(); // Force release of video resources
            }
            el.remove();
        }
    });

    if (direction === 'next') {
        // Check if we need to load more before calculating next index
        if (app.state.hasMoreMedia && !app.state.isLoading && app.state.currentMediaIndex >= listLength - LOAD_MORE_THRESHOLD) {
            console.log("Approaching end, loading more media...");
            loadMoreMedia(); // Load more in the background
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
        currentMediaElement.pause();
    }

    // Render the new window centered on nextIndex, only if index changed
    if (nextIndex !== app.state.currentMediaIndex) {
        renderMediaWindow(nextIndex);
        
        // Update media info overlay
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
}

/**
 * Render media window with optimized loading
 * @param {number} index - The index of the media to render
 */
function renderMediaWindow(index) {
    try {
        // Save the spinner container before clearing
        const savedSpinner = spinnerContainer ? spinnerContainer.cloneNode(true) : null;
        
        // Remove all media elements and fullscreen buttons
        tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => el.remove());
        tiktokContainer.querySelectorAll('.fullscreen-btn').forEach(el => el.remove());
        
        // Re-add the spinner if it was removed
        if (savedSpinner && !tiktokContainer.querySelector('.spinner-container')) {
            tiktokContainer.appendChild(savedSpinner);
        }
        
        // Store the previous index for sync update check
        const previousIndex = app.state.currentMediaIndex;
        app.state.currentMediaIndex = index;
        
        // Update media info overlay with current file information
        updateMediaInfoOverlay(app.state.fullMediaList[index]);

        const startIndex = Math.max(0, index - renderWindowSize);
        const endIndex = Math.min(app.state.fullMediaList.length - 1, index + renderWindowSize);
        const preloadStartIndex = Math.max(0, index - 2);
        const preloadEndIndex = Math.min(app.state.fullMediaList.length - 1, index + 2);

        console.log(`Rendering window: ${startIndex} to ${endIndex} (current: ${index})`);
        
        // If sync mode is enabled, we're the host, and the index has changed, send update to server
        // This handles direct calls to renderMediaWindow (not through navigateMedia)
        if (app.state.syncModeEnabled && app.state.isHost && previousIndex !== index) {
            const currentFile = app.state.fullMediaList[index];
            console.log('Host directly changing media index, sending sync update');
            
            // Use the improved sendSyncUpdate function
            window.appModules.syncManager.sendSyncUpdate({
                category_id: app.state.currentCategoryId,
                file_url: currentFile.url,
                index: index
            }).then(success => {
                if (!success) {
                    console.warn('Sync update for direct index change was not successful');
                }
            });
        }

        // First render the visible media
        for (let i = startIndex; i <= endIndex; i++) {
            const file = app.state.fullMediaList[i];
            if (!file || file.type === 'error') continue;

            let mediaElement;
            
            // Check if media is already in cache
            if (hasInCache(file.url)) {
                mediaElement = getFromCache(file.url);
                // Ensure cached videos respect the unmuted state and have loop set
                if (mediaElement && mediaElement.tagName === 'VIDEO') {
                    mediaElement.muted = false;
                    mediaElement.loop = true;
                    mediaElement.setAttribute('loop', 'true');
                    // Set autoplay for active videos
                    if (i === index) {
                        mediaElement.autoplay = true;
                        mediaElement.setAttribute('autoplay', 'true');
                    }
                }
            } else {
                if (file.type === 'video') {
                    mediaElement = createVideoElement(file, i === index);
                } else if (file.type === 'image') {
                    mediaElement = createImageElement(file);
                } else {
                    // Handle unknown file types with a placeholder
                    mediaElement = createPlaceholderElement(file);
                }
                
                // Store in cache
                if (mediaElement) {
                    addToCache(file.url, mediaElement);
                }
            }

            if (mediaElement) {
                mediaElement.className = 'tiktok-media';
                mediaElement.setAttribute('data-index', i);

                // Position elements correctly
                if (i === index) {
                    mediaElement.classList.add('active');
                    mediaElement.style.transform = 'translateY(0)';
                    
                    // Autoplay current video
                    if (mediaElement.tagName === 'VIDEO') {
                        setTimeout(() => {
                            // Attempt to play unmuted
                            mediaElement.play().catch(e => {
                                console.warn("Autoplay failed, possibly due to browser restrictions. Trying muted autoplay...", e);
                                // Fallback: try playing muted if unmuted autoplay fails
                                mediaElement.muted = true;
                                mediaElement.play().catch(e2 => console.error("Muted autoplay also failed:", e2));
                            });
                        }, 50);
                    }
                }
                
                tiktokContainer.appendChild(mediaElement);
            }
        }
        
        // Queue preloading of nearby media
        app.state.preloadQueue = [];
        for (let i = preloadStartIndex; i <= preloadEndIndex; i++) {
            if (i < startIndex || i > endIndex) { // Only preload items not already rendered
                const file = app.state.fullMediaList[i];
                if (file && file.type !== 'error' && !hasInCache(file.url)) {
                    app.state.preloadQueue.push(file);
                }
            }
        }
        
        // Start preloading process
        preloadNextMedia();
        
        setupControls(); // Setup controls (now just the back button wrapper)
        updateSwipeIndicators(index, app.state.fullMediaList.length);

        // Spinner is hidden by loadMoreMedia's finally block
    } catch (renderError) {
        console.error("!!! Error inside renderMediaWindow:", renderError);
        // Ensure spinner is hidden on render error if loadMoreMedia didn't catch it
        if (spinnerContainer) spinnerContainer.style.display = 'none';
        throw renderError;
    }
}

/**
 * Create a video element for the given file with optimized loading
 * @param {Object} file - The file object
 * @param {boolean} isActive - Whether this is the active media
 * @returns {HTMLVideoElement} - The created video element
 */
function createVideoElement(file, isActive) {
    const mediaElement = document.createElement('video');
    
    // Use the optimizeVideoElement function from mediaLoader.js
    window.appModules.mediaLoader.optimizeVideoElement(mediaElement);
    
    // Set additional attributes specific to this context
    mediaElement.loop = true;
    mediaElement.setAttribute('loop', 'true');
    mediaElement.muted = isActive ? false : true; // Only unmute if active
    mediaElement.preload = isActive ? 'auto' : 'metadata';
    mediaElement.autoplay = isActive;
    mediaElement.setAttribute('autoplay', isActive ? 'true' : 'false');
    
    // Add controls attribute for native video controls
    mediaElement.controls = true;
    mediaElement.setAttribute('controlsList', 'nodownload'); // Remove download button
    
    // iOS specific attributes for better fullscreen support
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        // These attributes are needed for proper iOS video behavior
        mediaElement.setAttribute('playsinline', 'true');
        mediaElement.setAttribute('webkit-playsinline', 'true');
        mediaElement.setAttribute('x-webkit-airplay', 'allow');
        
        // For iOS 10+ fullscreen support
        if (typeof mediaElement.webkitEnterFullscreen === 'function') {
            mediaElement.setAttribute('webkit-playsinline', 'true');
        }
    }
    
    // Add fetchpriority for active videos
    if (isActive) {
        mediaElement.setAttribute('fetchpriority', 'high');
    }
    
    // Create a placeholder element that will be shown if loading fails
    const placeholder = createPlaceholderElement(file, 'video');
    
    // Add error handling with retry logic for videos
    mediaElement.onerror = function() {
        console.error(`Error loading video: ${file.url}`, this.error);
        
        let retries = parseInt(this.getAttribute('data-retries') || '0');
        const maxRetries = 3; // Try reloading up to 3 times
        const retryDelay = 500; // Wait 500ms before retrying

        if (retries < maxRetries) {
            retries++;
            this.setAttribute('data-retries', retries);
            console.log(`Attempting retry ${retries}/${maxRetries} for video: ${file.name}`);
            
            // Remove existing source elements before reloading
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
            
            // Re-add source and attempt load after a delay
            setTimeout(() => {
                const source = document.createElement('source');
                // Add cache buster to retry URL
                source.src = `${file.url}${file.url.includes('?') ? '&' : '?'}retry=${retries}&_t=${Date.now()}`; 
                source.type = 'video/mp4'; // Assume MP4
                this.appendChild(source);
                this.load(); // Attempt to reload
            }, retryDelay);

        } else {
            console.error(`Max retries reached for video: ${file.name}. Replacing with placeholder.`);
            this.onerror = null; // Prevent further error loops
            // Replace the video element with the placeholder only after max retries
            if (this.parentNode) {
                this.parentNode.replaceChild(placeholder, this);
            } else {
                console.warn("Cannot replace video element - no parent node");
                // If no parent, just return the placeholder (though this shouldn't happen in normal flow)
                return placeholder; 
            }
        }
    };
    
    // Add performance monitoring
    mediaElement.addEventListener('loadstart', () => console.log(`Video loadstart: ${file.name}`));
    mediaElement.addEventListener('loadedmetadata', () => console.log(`Video loadedmetadata: ${file.name}`));
    mediaElement.addEventListener('loadeddata', () => console.log(`Video loadeddata: ${file.name}`));
    mediaElement.addEventListener('canplay', () => console.log(`Video canplay: ${file.name}`));
    
    // Use source element with type for better loading
    const source = document.createElement('source');
    source.src = file.url;
    source.type = 'video/mp4'; // Assume MP4 for better browser compatibility
    mediaElement.appendChild(source);
    
    // Force load
    mediaElement.load();
    
    // Add fullscreen button after the video is loaded
    mediaElement.addEventListener('loadeddata', () => {
        window.appModules.fullscreenManager.addFullscreenButton(mediaElement);
    });
    
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
    createVideoElement,
    createImageElement,
    createPlaceholderElement,
    updateMediaInfoOverlay
};
