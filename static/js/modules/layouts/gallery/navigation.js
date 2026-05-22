/**
 * Gallery Layout - Navigation
 * Handles opening media viewer from gallery
 */

import { ensureFeatureAccess } from '../../../utils/authManager.js';
import { toggleSpinner } from '../../ui/controller.js';
import { selectView } from '../../media/selectors.js';

/**
 * Open the media viewer for a specific media item.
 *
 * Prefers opening from the source view (timeline / month overlay) so the
 * viewer inherits the already-hydrated orderedIds — this is critical for
 * the gallery timeline, which is a global view that doesn't match a single
 * category's page-1 fetch. URL-only matching against a fresh category fetch
 * is the root cause of the "first click opens wrong media" bug: if the
 * record isn't on page 1 of the category, the URL find returns -1 and the
 * viewer falls back to index 0.
 *
 * @param {string} categoryId - Category ID
 * @param {string} mediaUrl - URL of the media to view (used as fallback)
 * @param {Object} options
 * @param {string} [options.recordId] - Stable record id from the card
 * @param {string} [options.sourceViewKey] - View the card was rendered from
 * @param {number} [options.index] - Fallback index when nothing else resolves
 */
export async function openViewer(categoryId, mediaUrl, options = {}) {
    toggleSpinner(true);
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        toggleSpinner(false);
        return;
    }

    if (!categoryId) {
        console.error('[GalleryLayout] No category ID provided');
        return;
    }

    const loader = window.ragotModules?.mediaLoader;
    if (!loader) {
        console.error('[GalleryLayout] mediaLoader not available');
        return;
    }

    const { recordId = null, sourceViewKey = null, index = 0 } = options;

    if (sourceViewKey && loader.openViewerFromView) {
        const sourceView = selectView(sourceViewKey);
        if (sourceView?.orderedIds?.length) {
            await loader.openViewerFromView({
                sourceViewKey,
                categoryId,
                startIndex: index,
                startRecordId: recordId,
                mediaUrl,
            });
            return;
        }
    }

    if (mediaUrl || recordId) {
        await loader.openCategoryViewer({
            categoryId,
            startIndex: 0,
            startRecordId: recordId,
            startMediaId: mediaUrl,
        });
    } else {
        await loader.openCategoryViewer({ categoryId, startIndex: index });
    }
}

/**
 * Open viewer at a specific index in a category
 * @param {string} categoryId 
 * @param {number} index 
 */
export async function openViewerAtIndex(categoryId, index) {
    toggleSpinner(true);
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        toggleSpinner(false);
        return;
    }

    if (window.ragotModules?.mediaLoader?.openCategoryViewer) {
        window.ragotModules.mediaLoader.openCategoryViewer({ categoryId, startIndex: index });
    }
}

/**
 * Convenience wrapper used by the gallery timeline / month overlay click
 * handlers. Reads stable id + source viewKey from the click site and routes
 * through openViewerFromView so the viewer inherits the hydrated ordering.
 */
export function openViewerFromGalleryCard(item, sourceViewKey) {
    if (!item) return;
    const categoryId = item.dataset?.categoryId || '';
    const mediaUrl = item.dataset?.mediaUrl || '';
    const recordId = item.dataset?.recordId || '';
    return openViewer(categoryId, mediaUrl, {
        recordId: recordId || null,
        sourceViewKey: sourceViewKey || null,
    });
}
