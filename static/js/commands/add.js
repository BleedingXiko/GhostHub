/**
 * /add command
 * Adds the currently playing media item to the shared session playlist.
 */
import { refreshAllLayouts } from '../utils/liveVisibility.js';
import { getCurrentViewerRecord, getViewerSession } from '../modules/media/viewerState.js';

export const add = {
    description: '• Adds the current media item to the shared session playlist.',
    getHelpText: () => '• /add Add current item to Shared Playlist.',
    execute: async (socket, displayLocalMessage, args) => {
        const appState = window.ragotModules?.appState;
        if (!appState) {
            displayLocalMessage('App not ready.', { icon: 'x' });
            return;
        }

        // Check if we are viewing media using app state (like /myview)
        const categoryId = appState.currentCategoryId;
        const viewer = getViewerSession(appState);

        // Check if category is loaded and index is valid (not null/undefined)
        if (!categoryId || !viewer) {
            displayLocalMessage('No media item open.', { icon: 'x' });
            return;
        }

        const currentItem = getCurrentViewerRecord(appState);
        if (!currentItem) {
            displayLocalMessage('No media item open.', { icon: 'x' });
            return;
        }

        try {
            const response = await fetch('/api/session/playlist/add', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(currentItem)
            });

            const data = await response.json();

            if (response.ok && data.success) {
                displayLocalMessage(`Added "${currentItem.name}" to playlist.`, { icon: 'checkCircle' });

                // Refresh the active layout to show the new "Shared Session Playlist"
                refreshAllLayouts(true).catch(err => {
                    console.error('Failed to refresh layout after /add:', err);
                });
            } else {
                displayLocalMessage(data.message || 'Failed to add.', { icon: 'x' });
            }
        } catch (error) {
            console.error('/add command error:', error);
            displayLocalMessage('Failed to add.', { icon: 'x' });
        }
    }
};
