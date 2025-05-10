/**
 * /random command
 * Navigates to a random media item.
 * If already viewing a category, picks a random item from the current category's loaded media.
 * Otherwise, picks a random category and then a random item from its first page.
 */

import { app } from '../core/app.js';

export const random = {
    description: 'Navigates to a random media item. Stays in current category if active (random from loaded items), otherwise picks a new random category (random from its first page).',
    getHelpText: () => '/random [new] - Random item. Use "new" to force new category.',
    execute: async (socket, displayLocalMessage, args) => {
        displayLocalMessage('Fetching random item...');

        try {
            if (!window.appModules || !window.appModules.mediaLoader || !window.appModules.mediaNavigation ||
                typeof window.appModules.mediaNavigation.renderMediaWindow !== 'function' ||
                typeof window.appModules.mediaLoader.viewCategory !== 'function') {
                displayLocalMessage('Error: Core media modules or functions are not available.');
                console.error('/random: Essential media modules or functions missing.');
                return;
            }

            const { mediaLoader, mediaNavigation } = window.appModules;
            const forceNewCategory = args && args.trim().toLowerCase() === 'new';
            let currentCategoryId = app.state.currentCategoryId;
            let inMediaView = false;

            if (currentCategoryId) {
                const tiktokContainer = document.getElementById('tiktok-container');
                const mediaViewElement = document.getElementById('media-view');
                if (tiktokContainer && mediaViewElement &&
                    !mediaViewElement.classList.contains('hidden') &&
                    !tiktokContainer.classList.contains('hidden')) {
                    inMediaView = true;
                }
            }

            if (inMediaView && currentCategoryId && !forceNewCategory) {
                // Scenario A: Already in media view, not forcing new. Pick from currently loaded media.
                const currentMediaList = app.state.fullMediaList || [];
                const mediaCountInCurrentList = currentMediaList.length;

                if (mediaCountInCurrentList > 0) {
                    const randomIndex = Math.floor(Math.random() * mediaCountInCurrentList);
                    displayLocalMessage(`Staying in current category (ID: ${currentCategoryId}). Navigating to random loaded item (index ${randomIndex} of ${mediaCountInCurrentList}).`);
                    try {
                        mediaNavigation.renderMediaWindow(randomIndex);
                        return; // Success
                    } catch (renderError) {
                        console.error('Error in renderMediaWindow (Scenario A):', renderError);
                        displayLocalMessage(`Error displaying random item in current category: ${renderError.message}. Falling back to new category selection.`);
                        // Fall through to Scenario B if renderMediaWindow fails
                    }
                } else {
                    displayLocalMessage(`Current category (ID: ${currentCategoryId}) has no media in fullMediaList. Picking a new random category.`);
                    // Fall through to Scenario B
                }
            }

            // Scenario B: Not in media view, or forcing new, or current category's fullMediaList was empty/failed.
            if (forceNewCategory) {
                displayLocalMessage('Forcing selection of a new random category...');
            } else {
                displayLocalMessage('Selecting a new random category...');
            }

            try {
                const timestamp = Date.now(); // Cache buster
                const categoriesResponse = await fetch(`/api/categories?_=${timestamp}`);
                if (!categoriesResponse.ok) {
                    throw new Error(`API Error: Failed to fetch categories (${categoriesResponse.status})`);
                }
                const categories = await categoriesResponse.json();

                if (!categories || !Array.isArray(categories) || categories.length === 0) {
                    displayLocalMessage('No categories available from API.');
                    return;
                }

                let availableCategories = categories.filter(cat => cat && cat.id && cat.mediaCount > 0);
                
                if (forceNewCategory && currentCategoryId && availableCategories.length > 1) {
                    // If forcing new and other categories exist, filter out the current one
                    const otherCategories = availableCategories.filter(cat => cat.id !== currentCategoryId);
                    if (otherCategories.length > 0) {
                        availableCategories = otherCategories;
                        displayLocalMessage('Filtered out current category for new selection.');
                    } else {
                        displayLocalMessage('Only one non-empty category available, or current category is the only option. Using it.');
                    }
                }

                if (availableCategories.length === 0) {
                    displayLocalMessage('No non-empty categories available to choose from.');
                    return;
                }

                const randomCategory = availableCategories[Math.floor(Math.random() * availableCategories.length)];
                const randomCategoryIdToLoad = randomCategory.id;
                displayLocalMessage(`Selected new category: "${randomCategory.name || randomCategoryIdToLoad}" (API mediaCount: ${randomCategory.mediaCount}). Loading its first page...`);

                // Load the new category, displaying its first item (index 0)
                // This populates app.state.fullMediaList with the first page of this category.
                await mediaLoader.viewCategory(randomCategoryIdToLoad, null, 0);

                // Now, fullMediaList should contain items from the first page of the new category.
                const firstPageMediaList = app.state.fullMediaList || [];
                const countOnFirstPage = firstPageMediaList.length;

                if (countOnFirstPage > 0) {
                    const randomIndexOnFirstPage = Math.floor(Math.random() * countOnFirstPage);
                    displayLocalMessage(`Displaying random item (index ${randomIndexOnFirstPage} of ${countOnFirstPage} from first page) in "${randomCategory.name || randomCategoryIdToLoad}".`);
                    mediaNavigation.renderMediaWindow(randomIndexOnFirstPage);
                } else {
                    displayLocalMessage(`Category "${randomCategory.name || randomCategoryIdToLoad}" loaded, but its first page (fullMediaList) is empty. Item 0 should be displayed by viewCategory.`);
                    // viewCategory(..., 0) should have handled showing something, or an empty state.
                }
            } catch (categoryError) {
                console.error('Error in Scenario B (new category selection/loading):', categoryError);
                displayLocalMessage(`Error selecting/loading new category: ${categoryError.message}`);
            }

        } catch (error) {
            console.error('Overall error in /random command:', error);
            displayLocalMessage(`Error: ${error.message || 'An unknown error occurred.'}`);
        }
    }
}; 