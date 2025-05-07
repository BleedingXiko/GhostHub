/**
 * Category Manager Module
 * Handles category loading, deletion, and thumbnail handling
 */

import { categoryList } from '../core/app.js';

let categoryStatusPollers = {}; // To store setInterval IDs for polling

/**
 * Clears all active category status pollers.
 * Call this when navigating away or reloading the category list.
 */
function clearAllCategoryPollers() {
    for (const categoryId in categoryStatusPollers) {
        if (categoryStatusPollers.hasOwnProperty(categoryId)) {
            clearInterval(categoryStatusPollers[categoryId]);
            delete categoryStatusPollers[categoryId];
        }
    }
    console.log("Cleared all category status pollers.");
}


/**
 * Updates the display of a category item with its indexing/transcoding status.
 * @param {HTMLElement} categoryElement - The DOM element for the category.
 * @param {string} categoryId - The ID of the category.
 */
async function updateCategoryStatusDisplay(categoryElement, categoryId) {
    try {
        const response = await fetch(`/api/categories/${categoryId}/index_status`);
        if (!response.ok) {
            console.error(`Error fetching status for category ${categoryId}: ${response.status}`);
            // Optionally stop polling on certain errors or show error in UI
            if (response.status === 404 && categoryStatusPollers[categoryId]) { // Category might have been deleted
                clearInterval(categoryStatusPollers[categoryId]);
                delete categoryStatusPollers[categoryId];
            }
            return;
        }
        const statusData = await response.json();

        let progressIndicator = categoryElement.querySelector('.category-progress-indicator');
        if (!progressIndicator) {
            progressIndicator = document.createElement('div');
            progressIndicator.className = 'category-progress-indicator';
            // Insert it before the button group or at a suitable place
            const buttonGroup = categoryElement.querySelector('.button-group');
            if (buttonGroup) {
                categoryElement.insertBefore(progressIndicator, buttonGroup);
            } else {
                categoryElement.appendChild(progressIndicator);
            }
        }

        if (statusData && statusData.status === 'running') {
            let statusText = `Indexing: ${statusData.progress || 0}%`;
            if (statusData.is_transcoding_enabled_for_category && statusData.videos_total_for_transcoding > 0) {
                statusText += `<br>Transcoding: ${statusData.videos_processed_for_transcoding || 0}/${statusData.videos_total_for_transcoding || 0} videos.`;
                if (statusData.current_transcoding_filename) {
                    statusText += `<br>Current: ${statusData.current_transcoding_filename}`;
                }
            }
            progressIndicator.innerHTML = statusText;
            progressIndicator.style.display = 'block'; // Make sure it's visible
            categoryElement.classList.add('category-item--processing'); // Add processing class

            // Ensure polling continues
            if (!categoryStatusPollers[categoryId]) {
                categoryStatusPollers[categoryId] = setInterval(() => {
                    updateCategoryStatusDisplay(categoryElement, categoryId);
                }, 5000); // Poll every 5 seconds
            }
        } else if (statusData && (statusData.status === 'complete' || statusData.status === 'error')) {
            progressIndicator.innerHTML = ''; // Clear content first
            progressIndicator.style.display = 'none'; // Hide progress
            categoryElement.classList.remove('category-item--processing'); // Remove processing class

            if (categoryStatusPollers[categoryId]) {
                clearInterval(categoryStatusPollers[categoryId]);
                delete categoryStatusPollers[categoryId];
                console.log(`Stopped polling for category ${categoryId} (status: ${statusData.status})`);
            }
            if (statusData.status === 'error') {
                progressIndicator.innerHTML = `Error: ${statusData.error || 'Indexing failed'}`;
                progressIndicator.style.display = 'block'; // Show error
                progressIndicator.style.color = 'red'; // Style error
                // Keep category as 'processing' visually if error state should also lock it,
                // or remove 'category-item--processing' if errors should unlock it.
                // For now, errors will unlock it as per current class removal logic above.
            }
        } else {
            // No status or unknown status, hide indicator and stop polling if any
            progressIndicator.style.display = 'none';
            categoryElement.classList.remove('category-item--processing');
            if (categoryStatusPollers[categoryId]) {
                clearInterval(categoryStatusPollers[categoryId]);
                delete categoryStatusPollers[categoryId];
            }
        }

    } catch (error) {
        console.error(`Error in updateCategoryStatusDisplay for ${categoryId}:`, error);
        // Stop polling on unexpected error to prevent loops
        if (categoryStatusPollers[categoryId]) {
            clearInterval(categoryStatusPollers[categoryId]);
            delete categoryStatusPollers[categoryId];
        }
    }
}


/**
 * Main function to load categories
 */
async function loadCategories() {
    clearAllCategoryPollers(); // Clear existing pollers before loading new list
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
            categoryElement.dataset.categoryId = category.id; // Add categoryId for easy selection

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

            // Media Type Icon (Updated Logic)
            const typeIcon = document.createElement('span');
            typeIcon.className = 'media-type-icon';
            // Use the containsVideo flag primarily
            if (category.containsVideo) {
                typeIcon.textContent = '🎬'; // Film reel if category contains any video
                typeIcon.title = 'Contains videos';
            } else if (category.mediaCount > 0) { // If no videos, but has media, assume images
                typeIcon.textContent = '🖼️'; // Picture frame for image-only (or mixed without video)
                typeIcon.title = 'Contains images';
            } else { // If mediaCount is 0 or category data is incomplete
                 typeIcon.textContent = '❓'; // Question mark if empty or error
                 typeIcon.title = 'Category empty or type unknown';
            }

            // Button Group - only contains delete button now
            const buttonGroup = document.createElement('div');
            buttonGroup.className = 'button-group';
            buttonGroup.innerHTML = `
                <button class="delete-btn" data-id="${category.id}" title="Delete">🗑️</button>
            `;

            // Append in the correct order for the new card layout
            categoryElement.appendChild(thumbnail);
            categoryElement.appendChild(badge);
            categoryElement.appendChild(typeIcon); // Add the type icon
            categoryElement.appendChild(buttonGroup);

            // Make the entire card clickable
            categoryElement.addEventListener('click', (e) => {
                if (categoryElement.classList.contains('category-item--processing')) {
                    e.preventDefault();
                    e.stopPropagation(); // Prevent further actions
                    // Optionally, provide feedback like an alert or a temporary message
                    // alert("This category is currently being processed. Please wait.");
                    console.log(`Category ${category.id} is processing. Click prevented.`);
                    return;
                }
                // Only trigger if not clicking on the delete button
                if (!e.target.closest('.delete-btn')) {
                    viewCategory(category.id);
                }
            });
            
            categoryList.appendChild(categoryElement);
            
            // Fetch and display initial status, start polling if needed
            updateCategoryStatusDisplay(categoryElement, category.id);
        });

        // Add event listeners to delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering the card click
                const categoryId = e.target.dataset.id;
                deleteCategory(categoryId).then(() => {
                    // Stop polling for the deleted category
                    if (categoryStatusPollers[categoryId]) {
                        clearInterval(categoryStatusPollers[categoryId]);
                        delete categoryStatusPollers[categoryId];
                    }
                });
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
 * Delete a category
 * @param {string} categoryId - The ID of the category to delete
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

/**
 * Create a placeholder for thumbnails
 * @param {HTMLImageElement} img - The image element to create a placeholder for
 * @param {Object} category - The category object
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

// This function is imported from mediaLoader, but we need to declare it here
// to avoid circular dependencies. It will be properly set by main.js
let viewCategory = (categoryId) => {
    console.warn('viewCategory not yet initialized');
};

/**
 * Set the viewCategory function from outside
 * @param {Function} func - The viewCategory function
 */
function setViewCategoryFunction(func) {
    if (typeof func === 'function') {
        viewCategory = func;
    }
}

export {
    loadCategories,
    deleteCategory,
    createPlaceholder,
    initLazyLoading,
    setViewCategoryFunction
};
