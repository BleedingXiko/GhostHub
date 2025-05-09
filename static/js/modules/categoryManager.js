/**
 * Category Manager Module
 * Handles category loading, deletion, and thumbnail handling
 */

import { categoryList } from '../core/app.js';
// getConfigValue is not directly used in this file after refactor, but ensureFeatureAccess will use it.
// import { getConfigValue } from '../utils/configManager.js'; 
import { ensureFeatureAccess } from '../utils/authManager.js'; // Import the new auth utility

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
            // Add admin-feature class to the delete button
            buttonGroup.innerHTML = `
                <button class="delete-btn admin-feature" data-id="${category.id}" title="Delete">🗑️</button>
            `;

            // Append in the correct order for the new card layout
            categoryElement.appendChild(thumbnail);
            categoryElement.appendChild(badge);
            categoryElement.appendChild(typeIcon); // Add the type icon
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

let originalViewCategoryFunction = (categoryId, mediaOrder, index) => { // Added mediaOrder and index to signature
    console.warn('Original viewCategory function not yet initialized or called before password check.');
};

// This is our new function that will be called when a category is clicked
async function protectedViewCategory(categoryId, mediaOrder, index) { // Added mediaOrder and index
    const accessGranted = await ensureFeatureAccess();
    if (accessGranted) {
        originalViewCategoryFunction(categoryId, mediaOrder, index); // Call the original function
    } else {
        console.log('Access to category view denied by password protection.');
        // Optionally, provide user feedback here if not already handled by ensureFeatureAccess (e.g. alert was cancelled)
    }
}

// The 'viewCategory' that gets called by the event listener in loadCategories
// will now be our protected version.
let viewCategory = protectedViewCategory;

/**
 * Set the viewCategory function from outside.
 * We will store the original function and our viewCategory will call it after password check.
 * @param {Function} func - The original viewCategory function from mediaLoader.js (via main.js)
 */
function setViewCategoryFunction(func) {
    if (typeof func === 'function') {
        originalViewCategoryFunction = func;
        // viewCategory is already set to protectedViewCategory, which calls originalViewCategoryFunction.
        console.log('Original viewCategory function has been set and wrapped for password protection.');
    } else {
        console.error('setViewCategoryFunction: provided argument is not a function.');
    }
}

export {
    loadCategories,
    deleteCategory,
    createPlaceholder,
    initLazyLoading,
    setViewCategoryFunction,
    refreshCategoryDeleteButtonVisibility // Export the new function
    // viewCategory (which is protectedViewCategory) is used internally by the click listener
};

// Function to be called by adminController to update delete button visibility
// This is necessary because categories (and their delete buttons) might be loaded
// after the initial admin status check.
function refreshCategoryDeleteButtonVisibility(isAdmin) {
    const deleteButtons = document.querySelectorAll('.delete-btn.admin-feature');
    deleteButtons.forEach(btn => {
        if (isAdmin) {
            // Buttons are typically inline-block or block by default.
            // Check if .delete-btn has specific display CSS, otherwise '' or 'inline-block'
            btn.style.display = 'inline-block'; 
        } else {
            btn.style.display = 'none';
        }
    });
}
