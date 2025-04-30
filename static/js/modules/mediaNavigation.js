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
                        el.src = ''; // Explicitly clear src before removing attribute
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
        // Save the spinner container before clearing
        const savedSpinner = spinnerContainer ? spinnerContainer.cloneNode(true) : null;
        
        // Instead of removing all media elements, we'll keep track of which ones we're using
        // and only remove those that are no longer needed at the end
        const existingElements = new Map();
        tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => {
            const dataIndex = parseInt(el.getAttribute('data-index'), 10);
            existingElements.set(dataIndex, el);
        });
        
        // Remove fullscreen buttons - we'll add them back as needed
        tiktokContainer.querySelectorAll('.fullscreen-btn').forEach(el => el.remove());
        
        // Track the render time to prevent fullscreen issues during rapid rendering
        app.state.lastRenderTime = Date.now();
        
        // Remove any loading message if it exists
        if (app.state.loadingMessage && document.body.contains(app.state.loadingMessage)) {
            app.state.loadingMessage.remove();
            app.state.loadingMessage = null;
        }
        
        // Re-add the spinner if it was removed
        if (savedSpinner && !tiktokContainer.querySelector('.spinner-container')) {
            tiktokContainer.appendChild(savedSpinner);
        }
        
        // Store the previous index for sync update check
        const previousIndex = app.state.currentMediaIndex;
        app.state.currentMediaIndex = index;
        
        // Update media info overlay with current file information if available
        if (app.state.fullMediaList && app.state.fullMediaList.length > index && app.state.fullMediaList[index]) {
            updateMediaInfoOverlay(app.state.fullMediaList[index]);
        }

        // Adjust render window size based on network conditions
        let effectiveRenderWindowSize = renderWindowSize;
        
        // Check for network conditions if the API is available
        if (navigator.connection) {
            const isLowBandwidth = navigator.connection.saveData || 
                                  navigator.connection.effectiveType === 'slow-2g' ||
                                  navigator.connection.effectiveType === '2g' ||
                                  (navigator.connection.downlink && navigator.connection.downlink < 0.5);
            
            // Reduce window size on low bandwidth connections
            if (isLowBandwidth) {
                effectiveRenderWindowSize = 1; // Only render immediate neighbors on low bandwidth
                console.log('Low bandwidth detected, using reduced render window size');
            }
        }
        
        // Use smaller render window on mobile devices
        if (MOBILE_DEVICE && effectiveRenderWindowSize > 2) {
            effectiveRenderWindowSize = 2; // Smaller window on mobile
        }
        
        const startIndex = Math.max(0, index - effectiveRenderWindowSize);
        const endIndex = Math.min(app.state.fullMediaList.length - 1, index + effectiveRenderWindowSize);
        
        // Always keep preload window small to reduce bandwidth
        const preloadStartIndex = Math.max(0, index - 1);
        const preloadEndIndex = Math.min(app.state.fullMediaList.length - 1, index + 1);

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
            
            // Check if we already have this element in the DOM
            if (existingElements.has(i)) {
                mediaElement = existingElements.get(i);
                existingElements.delete(i); // Remove from map to mark as used
                
                // Update element properties as needed
                if (i === index) {
                    mediaElement.classList.add('active');
                    mediaElement.style.transform = 'translateY(0)';
                    
                    // Ensure video is ready to play if it's the active element
                    if (mediaElement.tagName === 'VIDEO') {
                        // Store the current time and playing state before updating properties
                        const wasPlaying = !mediaElement.paused;
                        const currentTime = mediaElement.currentTime;
                        
                        // Update properties without resetting playback
                        mediaElement.muted = false;
                        mediaElement.loop = true;
                        mediaElement.setAttribute('loop', 'true');
                        
                        // Only set autoplay if it wasn't already playing
                        if (!wasPlaying) {
                            mediaElement.autoplay = true;
                            mediaElement.setAttribute('autoplay', 'true');
                        }
                        
                        // Add a flag to prevent unnecessary reloads
                        if (!mediaElement.hasAttribute('data-initialized')) {
                            mediaElement.setAttribute('data-initialized', 'true');
                            
                            // Add event listeners to detect and prevent unexpected resets
                            mediaElement.addEventListener('emptied', (e) => {
                                console.warn('Video emptied event detected - preventing reset', e);
                                // Try to restore playback if emptied unexpectedly
                                if (currentTime > 0) {
                                    mediaElement.currentTime = currentTime;
                                    if (wasPlaying) mediaElement.play();
                                }
                            });
                            
                            // Prevent seeking issues
                            mediaElement.addEventListener('seeking', () => {
                                console.log(`Video seeking: ${mediaElement.currentTime}`);
                            });
                            
                            mediaElement.addEventListener('seeked', () => {
                                console.log(`Video seeked to: ${mediaElement.currentTime}`);
                            });
                        }
                        
                        // Restore playback state
                        if (currentTime > 0) {
                            mediaElement.currentTime = currentTime;
                        }
                        
                        // Only attempt to play if it was playing before or is new
                        if (wasPlaying || !mediaElement.hasAttribute('data-played-once')) {
                            mediaElement.setAttribute('data-played-once', 'true');
                            
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
                } else {
                    mediaElement.classList.remove('active');
                    // Position non-active elements appropriately
                    if (i < index) {
                        mediaElement.style.transform = 'translateY(-100%)';
                    } else if (i > index) {
                        mediaElement.style.transform = 'translateY(100%)';
                    }
                }
            } else {
                // Element doesn't exist in DOM, create it
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
                    } else if (i < index) {
                        mediaElement.style.transform = 'translateY(-100%)';
                    } else if (i > index) {
                        mediaElement.style.transform = 'translateY(100%)';
                    }
                    
                    // Autoplay current video
                    if (i === index && mediaElement.tagName === 'VIDEO') {
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
                    
                    tiktokContainer.appendChild(mediaElement);
                }
            }
        }
        
        // Now remove any elements that weren't used in this render, EXCEPT the active video
        existingElements.forEach((element, dataIndex) => {
            if (dataIndex !== index) { // Only remove if it's not the active element
                // Release resources for videos
                if (element.tagName === 'VIDEO') {
                    try {
                        element.pause();
                        element.src = ''; // Explicitly clear src
                        element.removeAttribute('src');
                        element.load(); // Force release of video resources
                    } catch (e) {
                        console.warn('Error cleaning up non-active video:', e);
                    }
                }
                element.remove();
            } else {
                console.log(`Keeping active video element (index ${index}) in DOM`);
            }
        });
        
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
        
        // Ensure fullscreen buttons are added to all active videos
        // Use a small delay to ensure videos are fully rendered
        setTimeout(() => {
            if (window.appModules && window.appModules.fullscreenManager) {
                window.appModules.fullscreenManager.ensureFullscreenButtons();
            }
        }, 100);

        // Spinner is hidden by loadMoreMedia's finally block
        
        // Emit state update after successful render
        emitMyStateUpdate(app.state.currentCategoryId, app.state.currentMediaIndex);
        
    } catch (renderError) {
        console.error("!!! Error inside renderMediaWindow:", renderError);
        // Ensure spinner is hidden on render error if loadMoreMedia didn't catch it
        if (spinnerContainer) spinnerContainer.style.display = 'none';
        throw renderError;
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
    
    // Check if we need to send the full order
    // We'll only send the full order in specific cases to reduce bandwidth:
    // 1. First update for this category (lastEmittedCategory doesn't match)
    // 2. Order has changed (e.g., after a shuffle)
    // 3. Every 10th update as a sync check
    
    // Track last emitted values in app state if not already present
    if (!app.state.lastEmittedCategory) {
        app.state.lastEmittedCategory = null;
        app.state.lastEmittedIndex = -1;
        app.state.emitCount = 0;
        app.state.lastEmittedOrderHash = null;
    }
    
    // Increment emit count
    app.state.emitCount++;
    
    // Determine if we need to send the full order
    const categoryChanged = app.state.lastEmittedCategory !== categoryId;
    const periodicFullSync = app.state.emitCount % 10 === 0; // Every 10th update
    
    // Simple hash function for the order to detect changes
    const getOrderHash = (list) => {
        if (!list || list.length === 0) return '0';
        // Just use the first, middle and last few items as a fingerprint
        // This is not a cryptographic hash, just a quick way to detect changes
        const items = [
            list[0],
            list[Math.floor(list.length / 2)],
            list[list.length - 1]
        ].filter(Boolean);
        return items.join('|').slice(0, 100); // Limit length
    };
    
    // Get current order hash
    const currentOrder = app.state.fullMediaList.map(item => item ? item.url : null).filter(url => url);
    const currentOrderHash = getOrderHash(currentOrder);
    const orderChanged = currentOrderHash !== app.state.lastEmittedOrderHash;
    
    // Determine if we need to send the full order
    const sendFullOrder = categoryChanged || orderChanged || periodicFullSync;
    
    // Prepare the update payload - always include media_order as the server expects it
    const updateData = {
        category_id: categoryId,
        index: index,
        media_order: currentOrder // Always include media_order as the server expects it
    };
    
    // Log appropriate message based on whether this is a full update or not
    if (sendFullOrder) {
        console.log(`Emitting FULL state update: Cat=${categoryId}, Idx=${index}, Order URLs: ${currentOrder.length}`);
        
        // Update tracking variables
        app.state.lastEmittedOrderHash = currentOrderHash;
    } else {
        console.log(`Emitting state update: Cat=${categoryId}, Idx=${index}`);
    }
    
    // Update tracking variables
    app.state.lastEmittedCategory = categoryId;
    app.state.lastEmittedIndex = index;
    
    // Emit the event
    try {
        socket.emit('update_my_state', updateData);
    } catch (error) {
        console.error(`emitMyStateUpdate: Error emitting 'update_my_state' event:`, error);
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
    
    // Set essential attributes only
    mediaElement.loop = true;
    mediaElement.setAttribute('loop', 'true');
    mediaElement.muted = isActive ? false : true; // Only unmute if active
    
    // Set preload based on whether this is the active video
    mediaElement.preload = isActive ? 'auto' : 'metadata';
    
    // Only set autoplay for active videos
    if (isActive) {
        mediaElement.autoplay = true;
        mediaElement.setAttribute('autoplay', 'true');
    }
    
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
    
    // Use a data URL for the poster to avoid an extra network request
    mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';
    
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
    
    // Add stability improvements to prevent unexpected resets
    mediaElement.addEventListener('abort', (e) => {
        console.warn(`Video playback aborted: ${file.name}`, e);
    });
    
    mediaElement.addEventListener('stalled', (e) => {
        console.warn(`Video playback stalled: ${file.name}`, e);
        // Don't try to auto-recover from stalled state, as this can cause resets
    });
    
    // Prevent seeking issues that can cause resets
    mediaElement.addEventListener('seeking', () => {
        console.log(`Video seeking: ${file.name}`);
    });
    
    mediaElement.addEventListener('seeked', () => {
        console.log(`Video seeked: ${file.name}`);
    });
    
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
        this.onerror = null; // Prevent infinite loopS
        
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
    // Any other initialization logic for this module can go here
}
