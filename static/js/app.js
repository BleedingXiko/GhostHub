/**
 * Mobile Media Browser Application
 * Main JavaScript file with optimized media loading (Mute button removed, sound on by default)
 */

document.addEventListener('DOMContentLoaded', () => {
    // Create app instance to expose to window for back button handler
    const app = {};
    
    // DOM Elements
    const categoryView = document.getElementById('categoryView');
    const mediaView = document.getElementById('mediaView');
    const categoryList = document.getElementById('categoryList');
    const tiktokContainer = document.getElementById('tiktok-container');
    const spinnerContainer = document.querySelector('#tiktok-container .spinner-container');
    const syncToggleBtn = document.getElementById('sync-toggle-btn');

    // Global variables
    let currentCategoryId = null;
    let currentPage = 1;
    let isLoading = false;
    let hasMoreMedia = true;
    let fullMediaList = [];
    let currentMediaIndex = 0;
    let controlsContainer = null;
    // Removed muteBtn and isMuted variables
    const MEDIA_PER_PAGE = 5; // Reduced: Load 5 items per page for faster initial load
    const LOAD_MORE_THRESHOLD = 3; // Reduced: Load more when 3 items away from the end
    const renderWindowSize = 0; // Reduced: Only render the current item to save memory
    const MOBILE_DEVICE = window.innerWidth <= 768; // Detect if we're on a mobile device
    
    // Sync mode variables
    let syncModeEnabled = false;
    let isHost = false;
    let syncPollingInterval = null;

    // Media loading optimization variables
    const mediaCache = new Map(); // Cache for loaded media (with size limit)
    const MAX_CACHE_SIZE = MOBILE_DEVICE ? 20 : 50; // Smaller cache on mobile
    let mediaObserver = null; // Intersection observer for lazy loading
    let preloadQueue = []; // Queue for preloading media
    let isPreloading = false; // Flag to prevent multiple preloads
    let lastCleanupTime = Date.now(); // Track last cleanup time
    let currentFetchController = null; // AbortController for fetch requests

    // Expose app instance to window for back button handler
    app.mediaCache = mediaCache;
    
    // Function to reset state when going back to category view
    app.resetState = function() {
        console.log("Resetting app state");
        // Reset all state variables
        currentCategoryId = null;
        currentPage = 1;
        hasMoreMedia = true;
        isLoading = false;
        fullMediaList = [];
        preloadQueue = [];
        isPreloading = false;
        currentMediaIndex = 0;
        
        // Clear media cache
        mediaCache.clear();
        
        // Abort any ongoing fetch requests
        if (currentFetchController) {
            console.log("Aborting fetch requests during reset");
            currentFetchController.abort();
            currentFetchController = null;
        }
        
        // Perform aggressive cleanup
        clearResources(true);
        
        console.log("App state reset complete");
    };
    
    // Expose app instance to window
    window.appInstance = app;

    // Initialize sync toggle button
    if (syncToggleBtn) {
        syncToggleBtn.addEventListener('click', toggleSyncMode);
    }

    // Check sync mode status on page load
    checkSyncMode();
    
    // Load categories on page load
    loadCategories();
    
    /**
     * Check if sync mode is enabled
     */
    async function checkSyncMode() {
        try {
            const response = await fetch('/api/sync/status');
            const data = await response.json();
            
            syncModeEnabled = data.active;
            isHost = data.is_host;
            
            // Update toggle button
            updateSyncToggleButton();
            
            if (syncModeEnabled) {
                // Removed call to showSyncModeIndicator(isHost);
                
                if (!isHost) {
                    // Start polling for updates if guest
                    startSyncPolling();
                    // Disable navigation controls for guests
                    disableNavigationControls();
                }
            }
        } catch (error) {
            console.error('Error checking sync mode:', error);
        }
    }
    
    /**
     * Toggle sync mode on/off
     */
    async function toggleSyncMode() {
        try {
            // Get current media info if we're viewing media
            let mediaInfo = null;
            if (currentCategoryId && fullMediaList.length > 0 && currentMediaIndex >= 0) {
                const currentFile = fullMediaList[currentMediaIndex];
                mediaInfo = {
                    category_id: currentCategoryId,
                    file_url: currentFile.url,
                    index: currentMediaIndex
                };
            }
            
            // Toggle the current state
            const newState = !syncModeEnabled;
            
            const response = await fetch('/api/sync/toggle', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    enabled: newState,
                    media: mediaInfo
                })
            });
            
            const data = await response.json();
            
            // Update UI based on response
            syncModeEnabled = data.active;
            isHost = data.is_host;
            
            // Update toggle button
            updateSyncToggleButton();
            
            // Show/hide sync mode indicator (Removed)
            if (syncModeEnabled) {
                // Removed call to showSyncModeIndicator(isHost);
                
                if (!isHost) {
                    // Start polling for updates if guest
                    startSyncPolling();
                    // Disable navigation controls for guests
                    disableNavigationControls();
                }
            } else {
                // Hide sync mode indicator (Removed)
                // Removed call to hideSyncModeIndicator();
                // Stop polling
                if (syncPollingInterval) {
                    clearInterval(syncPollingInterval);
                    syncPollingInterval = null;
                }
                // Re-enable navigation controls
                enableNavigationControls();
            }
            
        } catch (error) {
            console.error('Error toggling sync mode:', error);
        }
    }
    
    /**
     * Update sync toggle button appearance
     */
    function updateSyncToggleButton() {
        if (!syncToggleBtn) return;
        
        if (syncModeEnabled) {
            syncToggleBtn.textContent = isHost ? 'Sync Mode: HOST' : 'Sync Mode: ON';
            syncToggleBtn.classList.add('active');
        } else {
            syncToggleBtn.textContent = 'Sync Mode: OFF';
            syncToggleBtn.classList.remove('active');
        }
    }
    
    // Removed showSyncModeIndicator and hideSyncModeIndicator functions
    
    /**
     * Start polling for sync updates
     */
    function startSyncPolling() {
        // Clear any existing interval
        if (syncPollingInterval) {
            clearInterval(syncPollingInterval);
        }
        
        console.log('Starting sync polling');
        
        // Poll every second
        syncPollingInterval = setInterval(async () => {
            try {
                console.log('Polling for sync updates...');
                const response = await fetch('/api/sync/current');
                
                if (!response.ok) {
                    console.error(`Error polling for sync updates: ${response.status} ${response.statusText}`);
                    return;
                }
                
                const data = await response.json();
                console.log('Received sync data:', data);
                
                // Only process if we have valid data
                if (!data || data.error) {
                    console.error('Invalid sync data received:', data);
                    return;
                }
                
                // Check if we need to update the view
                if (data.category_id && data.category_id !== currentCategoryId) {
                    // Different category, need to load it
                    console.log(`Switching to category ${data.category_id} based on sync update`);
                    // Ensure viewCategory is called correctly and then render the specific index
                    viewCategory(data.category_id).then(() => {
                        // Wait for category to load, then render the correct index
                        if (data.index !== undefined) {
                            console.log(`Rendering index ${data.index} after category switch`);
                            renderMediaWindow(data.index);
                        }
                    });
                } else if (data.category_id === currentCategoryId && data.index !== undefined && currentMediaIndex !== data.index) {
                    // Same category but different index
                    console.log(`Updating to index ${data.index} based on sync update`);
                    renderMediaWindow(data.index);
                } else {
                    console.log('No sync update needed or data is the same');
                }
            } catch (error) {
                console.error('Error polling for sync updates:', error);
            }
        }, 1000);
    }
    
    /**
     * Disable navigation controls for guests in sync mode
     */
    function disableNavigationControls() {
        // Remove swipe and keyboard event listeners for guests
        document.body.removeEventListener('touchstart', handleTouchStart);
        document.body.removeEventListener('touchmove', handleTouchMove);
        document.body.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('keydown', handleKeyDown);
        
        // Add a message or visual indicator that controls are disabled
        // Gets in the way of chat
        /*
        const message = document.createElement('div');
        message.id = 'guest-message';
        message.style.position = 'fixed';
        message.style.bottom = '20px';
        message.style.left = '0';
        message.style.width = '100%';
        message.style.textAlign = 'center';
        message.style.color = 'rgba(255,255,255,0.7)';
        message.style.fontSize = '14px';
        message.style.padding = '10px';
        message.style.zIndex = '1000';
        message.textContent = 'Navigation controlled by host';
      */
        
        document.body.appendChild(message);
    }
    
    /**
     * Re-enable navigation controls when sync mode is disabled
     */
    function enableNavigationControls() {
        // Re-add event listeners
        setupMediaNavigation();
        
        // Remove the guest message
        const message = document.getElementById('guest-message');
        if (message) {
            message.remove();
        }
    }

    /**
     * Main function to load categories
     */
    async function loadCategories() {
        try {
            const response = await fetch('/api/categories');
            const categories = await response.json();
            
            categoryList.innerHTML = '';
            if (categories.length === 0) {
                categoryList.innerHTML = '<div class="category-item">No categories yet. Add one above.</div>';
                return;
            }
            
            categories.forEach(category => {
                const categoryElement = document.createElement('div');
                categoryElement.className = 'category-item';

                // Thumbnail with lazy loading
                const thumbnail = document.createElement('img');
                thumbnail.className = 'thumbnail lazy-load';
                thumbnail.alt = category.name;
                
                // Create a placeholder with the first letter of the category name
                if (!category.thumbnailUrl) {
                    console.log(`No thumbnail URL for ${category.name}, using placeholder`);
                    createPlaceholder(thumbnail, category);
                } else {
                    // Use data-src for lazy loading instead of src
                    thumbnail.dataset.src = category.thumbnailUrl;
                    console.log(`Setting thumbnail data-src for ${category.name}: ${category.thumbnailUrl}`);
                    
                    // Enhanced error handling for thumbnail loading
                    thumbnail.onerror = function() {
                        console.log(`Error loading thumbnail for ${category.name}`);
                        this.onerror = null; // Prevent infinite loop
                        this.src = ''; // Clear the src
                        createPlaceholder(this, category);
                    };
                }

                // Media Count Badge
                const badge = document.createElement('span');
                badge.className = 'media-count-badge';
                badge.textContent = category.mediaCount;

                // Button Group - only contains delete button now
                const buttonGroup = document.createElement('div');
                buttonGroup.className = 'button-group';
                buttonGroup.innerHTML = `
                    <button class="delete-btn" data-id="${category.id}" title="Delete">🗑️</button>
                `;

                // Append in the correct order for the new card layout
                categoryElement.appendChild(thumbnail);
                categoryElement.appendChild(badge);
                categoryElement.appendChild(buttonGroup);
                
                // Make the entire card clickable
                categoryElement.addEventListener('click', (e) => {
                    // Only trigger if not clicking on the delete button
                    if (!e.target.closest('.delete-btn')) {
                        viewCategory(category.id);
                    }
                });
                
                categoryList.appendChild(categoryElement);
            });

            // Add event listeners to delete buttons
            document.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent triggering the card click
                    deleteCategory(e.target.dataset.id);
                });
            });

            // Initialize lazy loading for thumbnails
            initLazyLoading();
        } catch (error) {
            console.error('Error loading categories:', error);
            categoryList.innerHTML = '<div class="category-item">Error loading categories</div>';
        }
    }

    /**
     * Initialize lazy loading for images
     */
    function initLazyLoading() {
        // Use Intersection Observer API for lazy loading
        if ('IntersectionObserver' in window) {
            const lazyImageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const lazyImage = entry.target;
                        if (lazyImage.dataset.src) {
                            lazyImage.src = lazyImage.dataset.src;
                            lazyImage.onload = () => {
                                lazyImage.classList.add('loaded');
                            };
                            lazyImageObserver.unobserve(lazyImage);
                        }
                    }
                });
            });

            const lazyImages = document.querySelectorAll('.lazy-load');
            lazyImages.forEach(image => {
                lazyImageObserver.observe(image);
            });
        } else {
            // Fallback for browsers that don't support Intersection Observer
            const lazyImages = document.querySelectorAll('.lazy-load');
            lazyImages.forEach(image => {
                if (image.dataset.src) {
                    image.src = image.dataset.src;
                }
            });
        }
    }

    /**
     * Create a placeholder for thumbnails
     */
    function createPlaceholder(img, category) {
        img.style.backgroundColor = '#333';
        img.style.display = 'flex';
        img.style.alignItems = 'center';
        img.style.justifyContent = 'center';
        
        // Clear any existing content
        while (img.firstChild) {
            img.removeChild(img.firstChild);
        }
        
        // Create a folder icon placeholder
        const folderDiv = document.createElement('div');
        folderDiv.innerHTML = '📁';
        folderDiv.style.fontSize = '64px';
        folderDiv.style.color = 'rgba(255,255,255,0.7)';
        folderDiv.style.textShadow = '0 0 10px rgba(254, 44, 85, 0.5)';
        img.appendChild(folderDiv);
    }
    
    /**
     * Clear resources to prevent memory leaks - optimized version
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
        preloadQueue = [];
        isPreloading = false;
        
        // More aggressive cleanup on mobile or when explicitly requested
        if (aggressive || MOBILE_DEVICE) {
            console.log('Performing aggressive cleanup');
            // Clear the entire cache on aggressive cleanup
            mediaCache.clear();
            
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
            if (mediaCache.size > MAX_CACHE_SIZE) {
                console.log(`Cache size (${mediaCache.size}) exceeds limit, pruning...`);
                const keysToDelete = Array.from(mediaCache.keys()).slice(0, mediaCache.size - MAX_CACHE_SIZE);
                keysToDelete.forEach(key => mediaCache.delete(key));
                console.log(`Pruned cache to ${mediaCache.size} items`);
            }
        }
        
        // Perform periodic aggressive cleanup
        const now = Date.now();
        if (now - lastCleanupTime > 60000) { // Every minute
            console.log('Performing periodic aggressive cleanup');
            setTimeout(() => {
                mediaCache.clear();
                if (window.gc) window.gc();
                lastCleanupTime = now;
            }, 100);
        }
    }

    /**
     * View a category and its media - optimized version
     * Returns a Promise that resolves when the category is loaded and initial media is rendered.
     */
    function viewCategory(categoryId) { // Make it non-async to return a Promise explicitly
        return new Promise(async (resolve, reject) => { // Wrap in a Promise
            console.log(`Starting viewCategory for categoryId: ${categoryId}`);
            
            // IMPORTANT: First check if we're already viewing this category
            if (currentCategoryId === categoryId) {
                console.log("Already viewing this category, resolving immediately");
                resolve(); // Resolve immediately if already viewing
                return;
            }
        
        // STEP 1: Reset all state variables FIRST before any other operations
        currentCategoryId = categoryId;
        currentPage = 1; 
        hasMoreMedia = true; 
        isLoading = false; 
        fullMediaList = []; 
        preloadQueue = []; 
        isPreloading = false;
        currentMediaIndex = 0;
        
        // STEP 2: Explicitly clear the media cache to prevent stale data
        mediaCache.clear();
        console.log("Media cache completely cleared for new category");
        
        // STEP 3: Abort any ongoing fetch requests from the previous category
        if (currentFetchController) {
            console.log("Aborting previous fetch request...");
            currentFetchController.abort();
        }
        // Create a new AbortController for this category's requests
        currentFetchController = new AbortController();

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
        const pageSize = MOBILE_DEVICE ? 5 : 10;
        
        // STEP 7: Introduce a small delay to allow the browser to process cleanup before loading
        setTimeout(async () => {
            console.log(`Starting load for category ${categoryId} after delay.`);
            try {
                // Show spinner before fetching
                if (spinnerContainer) spinnerContainer.style.display = 'flex';

                // STEP 8: Always force refresh when loading a new category
                console.log("Forcing refresh for new category load");
                
                // Fetch the first page of media, passing the specific signal for this view
                await loadMoreMedia(pageSize, currentFetchController.signal, true); // Added true for forceRefresh

            // Check if the fetch was aborted (e.g., user switched category again quickly)
            if (currentFetchController.signal.aborted) {
                 console.log("Fetch aborted during initial load, stopping viewCategory.");
                 if (spinnerContainer) spinnerContainer.style.display = 'none'; // Hide spinner if aborted
                 return; 
            }

            // --- REVISED LOGIC: Only proceed if media was successfully loaded ---
            if (fullMediaList && fullMediaList.length > 0) {
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
      }); // End of Promise wrapper
    }

    /**
     * Setup swipe and keyboard navigation for media
     */
    function setupMediaNavigation() {
        // Swipe Logic (Vertical Only)
        let startY = 0;
        let isSwiping = false;
        const swipeThreshold = 50;

        // Remove existing event listeners if any
        document.body.removeEventListener('touchstart', handleTouchStart);
        document.body.removeEventListener('touchmove', handleTouchMove);
        document.body.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('keydown', handleKeyDown);

        // Add new event listeners
        document.body.addEventListener('touchstart', handleTouchStart, { passive: true });
        document.body.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.body.addEventListener('touchend', handleTouchEnd);
        document.addEventListener('keydown', handleKeyDown);

        function handleTouchStart(e) {
            if (tiktokContainer.classList.contains('hidden')) return;
            console.log('touchstart event fired on body');
            if (e.target.closest('.media-controls, .back-button')) {
                console.log('touchstart ignored: target is controls/back button');
                return;
            }
            startY = e.touches[0].clientY;
            isSwiping = true;
            console.log(`touchstart: startY = ${startY}`);
            
            // Pause current video during swipe interaction
            const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
            if (activeElement && activeElement.tagName === 'VIDEO') {
                activeElement.pause();
            }
        }

        function handleTouchMove(e) {
            if (tiktokContainer.classList.contains('hidden') || !isSwiping) return;
            // Only prevent default if we're actually swiping
            if (Math.abs(e.touches[0].clientY - startY) > 10) {
                 e.preventDefault();
             }
        }

        function handleTouchEnd(e) {
            if (tiktokContainer.classList.contains('hidden')) return;
            console.log('touchend event fired on body');
            if (!isSwiping) {
                console.log('touchend ignored: isSwiping is false');
                return;
            }
            isSwiping = false;
            const endY = e.changedTouches[0].clientY;
            const diffY = startY - endY;
            console.log(`touchend: endY = ${endY}, diffY = ${diffY}`);

            // Vertical Swipe - Navigate Media
            if (diffY > swipeThreshold) {
                console.log('Swipe Up detected');
                navigateMedia('next');
            } else if (diffY < -swipeThreshold) {
                console.log('Swipe Down detected');
                navigateMedia('prev');
            } else {
                console.log('Swipe threshold not met, resuming video');
                // No vertical threshold met, resume video
                const activeElement = tiktokContainer.querySelector('.tiktok-media.active');
                if (activeElement && activeElement.tagName === 'VIDEO') {
                    activeElement.play().catch(e => console.error("Resume play failed:", e));
                }
            }
        }

        function handleKeyDown(e) {
            if (tiktokContainer.classList.contains('hidden')) {
                return;
            }

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateMedia('next');
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateMedia('prev');
            }
        }
    }

    /**
     * Setup controls for media viewing - with mobile-specific handling
     */
    function setupControls() {
        try {
            // Create a wrapper for easier removal
            controlsContainer = document.createElement('div');
            controlsContainer.className = 'controls-wrapper';
            controlsContainer.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                pointer-events: none; z-index: 100;
            `;
            
            // Make sure the permanent back button is visible
            const backButton = document.getElementById('permanent-back-button');
            if (backButton) {
                // Make sure it's visible
                backButton.style.display = 'flex';
                
                // Remove any existing event listeners
                const newBackButton = backButton.cloneNode(true);
                if (backButton.parentNode) {
                    backButton.parentNode.replaceChild(newBackButton, backButton);
                }
                
                // Add a special mobile-specific touch handler
                if (MOBILE_DEVICE) {
                    // Create a transparent overlay just for the back button area
                    const backButtonOverlay = document.createElement('div');
                    backButtonOverlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 120px;
                        height: 120px;
                        z-index: 10000000;
                        background-color: transparent;
                        pointer-events: auto;
                    `;
                    
                    // Add a direct click handler to the overlay
                    backButtonOverlay.addEventListener('touchstart', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log("Back button overlay touched");
                        
                        // Show spinner
                        const spinner = document.getElementById('back-button-spinner');
                        if (spinner) spinner.style.display = 'inline-block';
                        
                        // Force reload
                        window.location.reload(true);
                    }, {passive: false});
                    
                    // Add the overlay to the document
                    document.body.appendChild(backButtonOverlay);
                    console.log("Added special mobile back button overlay");
                }
                
                // Also add regular click handler for non-mobile
                newBackButton.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log("Back button clicked");
                    
                    // Show spinner
                    const spinner = document.getElementById('back-button-spinner');
                    if (spinner) spinner.style.display = 'inline-block';
                    
                    // Force reload
                    window.location.reload(true);
                });
                
                console.log("Back button configured with event handlers");
            } else {
                console.error("Back button element not found!");
            }
            
            tiktokContainer.appendChild(controlsContainer);
        } catch (controlsError) {
            console.error("!!! Error inside setupControls:", controlsError);
        }
    }

    /**
     * Render media window with optimized loading
     */
    function renderMediaWindow(index) {
        try {
            // Save the spinner container before clearing
            const savedSpinner = spinnerContainer ? spinnerContainer.cloneNode(true) : null;
            
            // Remove all media elements but keep other elements like controls
            tiktokContainer.querySelectorAll('.tiktok-media').forEach(el => el.remove());
            
            // Re-add the spinner if it was removed
            if (savedSpinner && !tiktokContainer.querySelector('.spinner-container')) {
                tiktokContainer.appendChild(savedSpinner);
            }
            
            currentMediaIndex = index;

            const startIndex = Math.max(0, index - renderWindowSize);
            const endIndex = Math.min(fullMediaList.length - 1, index + renderWindowSize);
            const preloadStartIndex = Math.max(0, index - 2);
            const preloadEndIndex = Math.min(fullMediaList.length - 1, index + 2);

            console.log(`Rendering window: ${startIndex} to ${endIndex} (current: ${index})`);

            // First render the visible media
            for (let i = startIndex; i <= endIndex; i++) {
                const file = fullMediaList[i];
                if (!file || file.type === 'error') continue;

                let mediaElement;
                
                // Check if media is already in cache
                if (mediaCache.has(file.url)) {
                    mediaElement = mediaCache.get(file.url).cloneNode(true);
                    // Ensure cached videos respect the unmuted state
                    if (mediaElement.tagName === 'VIDEO') {
                        mediaElement.muted = false;
                    }
                } else {
                    if (file.type === 'video') {
                        mediaElement = document.createElement('video');
                        mediaElement.playsInline = true;
                        mediaElement.setAttribute('playsinline', 'true'); // For iOS
                        mediaElement.setAttribute('webkit-playsinline', 'true'); // For older iOS
                        mediaElement.setAttribute('controlsList', 'nodownload nofullscreen'); // Prevent fullscreen
                        mediaElement.disablePictureInPicture = true;
                        mediaElement.loop = true;
                        mediaElement.muted = false; // Videos play with sound by default
                        mediaElement.preload = i === index ? 'auto' : 'metadata';
                        
                        // Create a placeholder element that will be shown if loading fails
                        const placeholder = document.createElement('div');
                        placeholder.className = 'unknown-file-placeholder';
                        placeholder.style.backgroundColor = '#333';
                        placeholder.style.display = 'flex';
                        placeholder.style.flexDirection = 'column';
                        placeholder.style.alignItems = 'center';
                        placeholder.style.justifyContent = 'center';
                        placeholder.style.color = 'white';
                        placeholder.style.height = '100%';
                        placeholder.style.width = '100%';
                        placeholder.innerHTML = `
                            <div style="font-size: 64px; margin-bottom: 10px;">🎬</div>
                            <div style="font-size: 16px; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${file.name}</div>
                            <div style="font-size: 14px; color: #aaa; margin-top: 5px;">Video failed to load</div>
                        `;
                        
                        // Add error handling for videos
                        mediaElement.onerror = function() {
                            console.error(`Error loading video: ${file.url}`);
                            this.onerror = null; // Prevent infinite loop
                            
                            // Replace the video element with the placeholder
                            if (this.parentNode) {
                                this.parentNode.replaceChild(placeholder, this);
                            } else {
                                console.warn("Cannot replace video element - no parent node");
                                // Return the placeholder to be used instead
                                mediaElement = placeholder;
                            }
                        };
                        
                        // Set source after adding error handler
                        mediaElement.src = file.url;
                    } else if (file.type === 'image') {
                        mediaElement = document.createElement('img');
                        mediaElement.alt = file.name;
                        mediaElement.loading = 'lazy';
                        
                        // Create a placeholder element that will be shown if loading fails
                        const placeholder = document.createElement('div');
                        placeholder.className = 'unknown-file-placeholder';
                        placeholder.style.backgroundColor = '#333';
                        placeholder.style.display = 'flex';
                        placeholder.style.flexDirection = 'column';
                        placeholder.style.alignItems = 'center';
                        placeholder.style.justifyContent = 'center';
                        placeholder.style.color = 'white';
                        placeholder.style.height = '100%';
                        placeholder.style.width = '100%';
                        placeholder.innerHTML = `
                            <div style="font-size: 64px; margin-bottom: 10px;">🖼️</div>
                            <div style="font-size: 16px; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${file.name}</div>
                            <div style="font-size: 14px; color: #aaa; margin-top: 5px;">Image failed to load</div>
                        `;
                        
                        // Add error handling for images
                        mediaElement.onerror = function() {
                            console.error(`Error loading image: ${file.url}`);
                            this.onerror = null; // Prevent infinite loop
                            
                            // Replace the image element with the placeholder
                            if (this.parentNode) {
                                this.parentNode.replaceChild(placeholder, this);
                            } else {
                                console.warn("Cannot replace image element - no parent node");
                                // Return the placeholder to be used instead
                                mediaElement = placeholder;
                            }
                        };
                        
                        // Set source after adding error handler
                        mediaElement.src = file.url;
                    } else {
                        // Handle unknown file types with a placeholder
                        console.log(`Unknown file type for ${file.name}: ${file.type}`);
                        mediaElement = document.createElement('div');
                        mediaElement.className = 'unknown-file-placeholder';
                        mediaElement.style.backgroundColor = '#333';
                        mediaElement.style.display = 'flex';
                        mediaElement.style.flexDirection = 'column';
                        mediaElement.style.alignItems = 'center';
                        mediaElement.style.justifyContent = 'center';
                        mediaElement.style.color = 'white';
                        mediaElement.style.height = '100%';
                        mediaElement.style.width = '100%';
                        
                        // Add file icon
                        const iconDiv = document.createElement('div');
                        iconDiv.innerHTML = '📄';
                        iconDiv.style.fontSize = '64px';
                        iconDiv.style.marginBottom = '10px';
                        
                        // Add file name
                        const nameDiv = document.createElement('div');
                        nameDiv.textContent = file.name;
                        nameDiv.style.fontSize = '16px';
                        nameDiv.style.maxWidth = '80%';
                        nameDiv.style.overflow = 'hidden';
                        nameDiv.style.textOverflow = 'ellipsis';
                        nameDiv.style.whiteSpace = 'nowrap';
                        
                        // Add file type
                        const typeDiv = document.createElement('div');
                        typeDiv.textContent = `Unsupported file type: ${file.type || 'unknown'}`;
                        typeDiv.style.fontSize = '14px';
                        typeDiv.style.color = '#aaa';
                        typeDiv.style.marginTop = '5px';
                        
                        mediaElement.appendChild(iconDiv);
                        mediaElement.appendChild(nameDiv);
                        mediaElement.appendChild(typeDiv);
                    }
                    
                    // Store in cache
                    mediaCache.set(file.url, mediaElement.cloneNode(true));
                }

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
            
            // Queue preloading of nearby media
            preloadQueue = [];
            for (let i = preloadStartIndex; i <= preloadEndIndex; i++) {
                if (i < startIndex || i > endIndex) { // Only preload items not already rendered
                    const file = fullMediaList[i];
                    if (file && file.type !== 'error' && !mediaCache.has(file.url)) {
                        preloadQueue.push(file);
                    }
                }
            }
            
            // Start preloading process
            preloadNextMedia();
            
            setupControls(); // Setup controls (now just the back button wrapper)
            updateSwipeIndicators(index, fullMediaList.length);

            // Spinner is hidden by loadMoreMedia's finally block
        } catch (renderError) {
            console.error("!!! Error inside renderMediaWindow:", renderError);
            // Ensure spinner is hidden on render error if loadMoreMedia didn't catch it
            if (spinnerContainer) spinnerContainer.style.display = 'none';
            throw renderError;
        }
    }

    /**
     * Preload media in the background
     */
    function preloadNextMedia() {
        if (isPreloading || preloadQueue.length === 0) return;
        
        // Skip preloading if cache is getting too large
        if (mediaCache.size >= MAX_CACHE_SIZE) {
            console.log("Cache size limit reached, skipping preload");
            isPreloading = false;
            return;
        }
        
        isPreloading = true;
        const file = preloadQueue.shift();
        
        if (!file || mediaCache.has(file.url)) {
            isPreloading = false;
            preloadNextMedia();
            return;
        }
        
        console.log(`Preloading ${file.type}: ${file.name}`);
        let mediaElement;
        
        if (file.type === 'video') {
            mediaElement = document.createElement('video');
            mediaElement.preload = 'metadata';
            mediaElement.playsInline = true;
            mediaElement.setAttribute('playsinline', 'true'); // For iOS
            mediaElement.setAttribute('webkit-playsinline', 'true'); // For older iOS
            mediaElement.setAttribute('controlsList', 'nodownload nofullscreen'); // Prevent fullscreen
            mediaElement.disablePictureInPicture = true;
            mediaElement.muted = false; // Preload unmuted
            mediaElement.style.display = 'none';
            
            // Add error handling for videos
            mediaElement.onerror = function() {
                console.error(`Error preloading video: ${file.url}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            };
            
            // For videos, just preload metadata
            mediaElement.addEventListener('loadedmetadata', () => {
                console.log(`Video metadata loaded: ${file.name}`);
                mediaCache.set(file.url, mediaElement.cloneNode(true));
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            });
            
            // Set timeout to handle stalled loading
            const loadTimeout = setTimeout(() => {
                console.warn(`Video load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            }, 10000); // 10 second timeout
            
            mediaElement.addEventListener('loadedmetadata', () => {
                clearTimeout(loadTimeout);
            });
            
            document.body.appendChild(mediaElement);
            mediaElement.src = file.url;
        } else if (file.type === 'image') {
            mediaElement = new Image();
            mediaElement.style.display = 'none';
            
            mediaElement.onload = () => {
                console.log(`Image loaded: ${file.name}`);
                mediaCache.set(file.url, mediaElement.cloneNode(true));
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            };
            
            mediaElement.onerror = () => {
                console.error(`Error preloading image: ${file.url}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            };
            
            // Set timeout to handle stalled loading
            const loadTimeout = setTimeout(() => {
                console.warn(`Image load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            }, 10000); // 10 second timeout
            
            mediaElement.onload = () => {
                clearTimeout(loadTimeout);
                console.log(`Image loaded: ${file.name}`);
                mediaCache.set(file.url, mediaElement.cloneNode(true));
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                isPreloading = false;
                preloadNextMedia();
            };
            
            document.body.appendChild(mediaElement);
            mediaElement.src = file.url;
        } else {
            // For unknown file types, create a placeholder element and cache it
            console.log(`Preloading unknown file type for ${file.name}: ${file.type}`);
            
            // Create placeholder element
            mediaElement = document.createElement('div');
            mediaElement.className = 'unknown-file-placeholder';
            mediaElement.style.backgroundColor = '#333';
            mediaElement.style.display = 'flex';
            mediaElement.style.flexDirection = 'column';
            mediaElement.style.alignItems = 'center';
            mediaElement.style.justifyContent = 'center';
            mediaElement.style.color = 'white';
            mediaElement.style.height = '100%';
            mediaElement.style.width = '100%';
            
            // Add file icon
            const iconDiv = document.createElement('div');
            iconDiv.innerHTML = '📄';
            iconDiv.style.fontSize = '64px';
            iconDiv.style.marginBottom = '10px';
            
            // Add file name
            const nameDiv = document.createElement('div');
            nameDiv.textContent = file.name;
            nameDiv.style.fontSize = '16px';
            nameDiv.style.maxWidth = '80%';
            nameDiv.style.overflow = 'hidden';
            nameDiv.style.textOverflow = 'ellipsis';
            nameDiv.style.whiteSpace = 'nowrap';
            
            // Add file type
            const typeDiv = document.createElement('div');
            typeDiv.textContent = `Unsupported file type: ${file.type || 'unknown'}`;
            typeDiv.style.fontSize = '14px';
            typeDiv.style.color = '#aaa';
            typeDiv.style.marginTop = '5px';
            
            mediaElement.appendChild(iconDiv);
            mediaElement.appendChild(nameDiv);
            mediaElement.appendChild(typeDiv);
            
            // Cache the placeholder
            mediaCache.set(file.url, mediaElement.cloneNode(true));
            isPreloading = false;
            preloadNextMedia();
        }
    }

    /**
     * Navigate between media items with performance optimizations
     */
    function navigateMedia(direction) {
        let nextIndex = currentMediaIndex;
        const listLength = fullMediaList.length;
        const currentMediaElement = tiktokContainer.querySelector('.tiktok-media.active');

        // Performance optimization: Clean up old media elements
        // Keep only the currently visible and a few nearby elements
        const visibleIndices = new Set([currentMediaIndex]);
        if (currentMediaIndex > 0) visibleIndices.add(currentMediaIndex - 1);
        if (currentMediaIndex < listLength - 1) visibleIndices.add(currentMediaIndex + 1);
        
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
            if (hasMoreMedia && !isLoading && currentMediaIndex >= listLength - LOAD_MORE_THRESHOLD) {
                console.log("Approaching end, loading more media...");
                loadMoreMedia(); // Load more in the background
            }
            
            if (currentMediaIndex < listLength - 1) {
                nextIndex = currentMediaIndex + 1;
            } else {
                console.log("Reached end of loaded media.");
                if (!hasMoreMedia) return; // Stop if no more media to load
            }
        } else if (direction === 'prev') {
            if (currentMediaIndex > 0) {
                nextIndex = currentMediaIndex - 1;
            } else {
                console.log("Already at the beginning.");
                return; // Stay at the first item
            }
        } else {
            // Handle tap/click to play/pause
            if (currentMediaElement && currentMediaElement.tagName === 'VIDEO') {
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
        if (nextIndex !== currentMediaIndex) {
            renderMediaWindow(nextIndex);
            
            // If sync mode is enabled and we're the host, send update to server
            if (syncModeEnabled && isHost) {
                const currentFile = fullMediaList[nextIndex];
                
                fetch('/api/sync/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        category_id: currentCategoryId,
                        file_url: currentFile.url,
                        index: nextIndex
                    })
                }).catch(error => {
                    console.error('Error updating sync state:', error);
                });
            }
        }
    }

    /**
     * Load more media items when scrolling near the end - optimized version
     * @param {number|null} customLimit - Optional limit for the number of items to load.
     * @param {AbortSignal|null} signal - Optional AbortSignal to use for the fetch.
     * @param {boolean} forceRefresh - Whether to force a refresh from the server.
     */
    async function loadMoreMedia(customLimit = null, signal = null, forceRefresh = false) {
        const effectiveSignal = signal || (currentFetchController ? currentFetchController.signal : null);
        
        console.log(`loadMoreMedia called: currentPage=${currentPage}, hasMoreMedia=${hasMoreMedia}, isLoading=${isLoading}, currentMediaIndex=${currentMediaIndex}, fullMediaList.length=${fullMediaList.length}`);
        
        // Check if the signal has been aborted
        if (effectiveSignal && effectiveSignal.aborted) {
            console.log("loadMoreMedia skipped: signal was aborted.");
            return;
        }
        
        if (!hasMoreMedia || isLoading) {
            console.log(`Load more skipped: hasMoreMedia=${hasMoreMedia}, isLoading=${isLoading}`);
            return; // Don't load if no more items or already loading
        }

        isLoading = true;
        const limit = customLimit || MEDIA_PER_PAGE;
        console.log(`Loading page ${currentPage} with limit ${limit}...`);
        
        // Show loading indicator
        if (spinnerContainer) spinnerContainer.style.display = 'flex';

        try {
            // Add cache-busting parameter, force_refresh parameter, and the effective AbortSignal
            const cacheBuster = Date.now();
            // Use the forceRefresh parameter or default to first page
            const forceRefreshParam = forceRefresh || currentPage === 1 ? '&force_refresh=true' : '';
            const fetchOptions = {
                signal: effectiveSignal // Use the determined signal
            };
            console.log(`Fetching media with forceRefresh: ${forceRefresh}, syncModeEnabled: ${syncModeEnabled}`);
            // Explicitly set shuffle=false if sync mode is enabled
            const shuffleParam = syncModeEnabled ? '&shuffle=false' : ''; 
            const response = await fetch(`/api/categories/${currentCategoryId}/media?page=${currentPage}&limit=${limit}${forceRefreshParam}${shuffleParam}&_=${cacheBuster}`, fetchOptions);
            
            if (!response.ok) {
                // Don't throw error if fetch was aborted, just return
                if (effectiveSignal && effectiveSignal.aborted) {
                    console.log("Fetch aborted during loadMoreMedia response check.");
                    isLoading = false; // Reset loading flag
                    return;
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            if (data.error) {
                 console.error("Server error fetching more media:", data.error);
                 alert(`Error loading more media: ${data.error}`);
                 hasMoreMedia = false; // Stop trying if server reports error
            } else if (data.files && data.files.length > 0) {
                console.log(`Received ${data.files.length} new media items.`);
                // Modify the array in-place instead of creating a new one
                fullMediaList.push(...data.files); 
                hasMoreMedia = data.pagination.hasMore;
                currentPage++; // Increment page number for the next request
                console.log(`Total media now: ${fullMediaList.length}, hasMore: ${hasMoreMedia}`);
                
                // Update swipe indicators if the view is active
                if (!tiktokContainer.classList.contains('hidden')) {
                    updateSwipeIndicators(currentMediaIndex, fullMediaList.length);
                }
            } else {
                console.log("No more media files received from server.");
                hasMoreMedia = false; // No more files returned
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
            isLoading = false;
            console.log("Loading finished.");
            // Hide loading indicator here reliably
            if (spinnerContainer) spinnerContainer.style.display = 'none';
        }
    }

    /**
     * Update swipe indicators
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
        downIndicator.classList.toggle('visible', currentIndex < totalItems - 1 || hasMoreMedia);
    }

    /**
     * Delete a category
     */
    async function deleteCategory(categoryId) {
        if (!confirm('Are you sure you want to delete this category?')) return;
        
        try {
            const response = await fetch(`/api/categories/${categoryId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                loadCategories();
            } else {
                alert('Error deleting category');
            }
        } catch (error) {
            console.error('Error deleting category:', error);
            alert('Error deleting category');
        }
    }

    // Function to handle keydown events (already defined in setupMediaNavigation)
    // function handleKeyDown(e) { ... }
});
