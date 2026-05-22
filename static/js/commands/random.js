/**
 * /random command
 * Navigates to a random media item.
 * If already viewing a category, picks a random item from the current category's loaded media.
 * Otherwise, picks a random category and then a random item from its first page.
 */

import { getShowHiddenHeaders } from '../utils/showHiddenManager.js';
import { ensureFeatureAccess } from '../utils/authManager.js';
import { $ } from '../libs/ragot.esm.min.js';
import { getKnownViewerCount } from '../modules/media/viewerState.js';

export const random = {
    description: '• Navigates to a random media item. Stays in current category if active (random from loaded items), otherwise picks a new random category (random from its first page).',
    getHelpText: () => '• /random Switch to a random media item.',
    execute: async (socket, displayLocalMessage, args) => {
        const appState = window.ragotModules?.appState;
        if (!appState) {
            displayLocalMessage('App not ready.', { icon: 'x' });
            return;
        }

        // Add password protection like other sensitive commands
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            displayLocalMessage('Password required.', { icon: 'stop' });
            return;
        }

        try {
            if (!window.ragotModules || !window.ragotModules.mediaLoader || !window.ragotModules.mediaNavigation ||
                typeof window.ragotModules.mediaNavigation.renderMediaWindow !== 'function' ||
                typeof window.ragotModules.mediaLoader.openCategoryViewer !== 'function') {
                displayLocalMessage('Media modules not available.', { icon: 'x' });
                return;
            }

            const { mediaLoader, mediaNavigation } = window.ragotModules;
            const forceNewCategory = args && args.trim().toLowerCase() === 'new';
            let currentCategoryId = appState.currentCategoryId;
            let inMediaView = false;

            if (currentCategoryId) {
                const mediaViewer = $('#media-viewer');
                if (mediaViewer && !mediaViewer.classList.contains('hidden')) {
                    inMediaView = true;
                }
            }

            if (inMediaView && currentCategoryId && !forceNewCategory) {
                const mediaCountInCurrentList = getKnownViewerCount(appState);

                if (mediaCountInCurrentList > 0) {
                    const randomIndex = Math.floor(Math.random() * mediaCountInCurrentList);
                    try {
                        mediaNavigation.renderMediaWindow(randomIndex);
                        displayLocalMessage('Jumped to a random item.', { icon: 'checkCircle' });
                        return;
                    } catch (renderError) {
                        displayLocalMessage(`Error displaying item: ${renderError.message}`, { icon: 'x' });
                    }
                }
            }

            try {
                const timestamp = Date.now();
                const categoriesResponse = await fetch(`/api/categories?_=${timestamp}`, {
                    headers: getShowHiddenHeaders()
                });
                if (!categoriesResponse.ok) {
                    throw new Error(`API Error: ${categoriesResponse.status}`);
                }
                const responseData = await categoriesResponse.json();
                const categories = Array.isArray(responseData) ? responseData : (responseData.categories || []);

                if (!categories || categories.length === 0) {
                    displayLocalMessage('No categories available.', { icon: 'x' });
                    return;
                }

                let availableCategories = categories.filter(cat => cat && cat.id && cat.mediaCount > 0);

                if (forceNewCategory && currentCategoryId && availableCategories.length > 1) {
                    const otherCategories = availableCategories.filter(cat => cat.id !== currentCategoryId);
                    if (otherCategories.length > 0) {
                        availableCategories = otherCategories;
                    }
                }

                if (availableCategories.length === 0) {
                    displayLocalMessage('No non-empty categories available.', { icon: 'x' });
                    return;
                }

                const randomCategory = availableCategories[Math.floor(Math.random() * availableCategories.length)];
                await mediaLoader.openCategoryViewer({ categoryId: randomCategory.id, startIndex: 0 });

                const countOnFirstPage = getKnownViewerCount(appState);

                if (countOnFirstPage > 0) {
                    const randomIndexOnFirstPage = Math.floor(Math.random() * countOnFirstPage);
                    mediaNavigation.renderMediaWindow(randomIndexOnFirstPage);
                    displayLocalMessage('Jumped to a random item.', { icon: 'checkCircle' });
                } else {
                    displayLocalMessage(`Opened "${randomCategory.name || randomCategory.id}".`, { icon: 'checkCircle' });
                }
            } catch (categoryError) {
                displayLocalMessage(`Error: ${categoryError.message}`, { icon: 'x' });
            }

        } catch (error) {
            displayLocalMessage(`Error: ${error.message}`, { icon: 'x' });
        }
    }
}; 
