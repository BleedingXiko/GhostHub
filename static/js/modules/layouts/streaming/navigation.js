/**
 * Streaming Layout - Navigation
 * Handles opening media viewer and resume functionality
 */

import { ensureFeatureAccess } from '../../../utils/authManager.js';
import { getVideoProgress, getSubfolderFilter, getCategoryView, getMediaFilter } from './state.js';
import { toggleSpinner } from '../../ui/controller.js';
import { selectRecordsForView } from '../../media/selectors.js';

/**
 * Open the media viewer at a specific index
 * Includes password protection check
 * @param {string} categoryId - Category ID
 * @param {number} startIndex - Starting index
 */
export async function openViewer(categoryId, startIndex = 0) {
    toggleSpinner(true);
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        toggleSpinner(false);
        return;
    }

    if (window.ragotModules?.mediaLoader?.openCategoryViewer) {
        window.ragotModules.mediaLoader.openCategoryViewer({
            categoryId,
            startIndex,
            subfolder: getSubfolderFilter(),
        });
    } else {
        console.error('mediaLoader not available');
    }
}

/**
 * Open the media viewer for a specific media URL
 * Uses the cached media from the row if available to enable navigation
 * @param {string} categoryId - Category ID
 * @param {string} mediaUrl - URL of the media to view
 */
export async function openViewerByUrl(categoryId, mediaUrl, recordId = null) {
    toggleSpinner(true);
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        toggleSpinner(false);
        return;
    }

    if (!mediaUrl && !recordId) {
        if (window.ragotModules?.mediaLoader?.openCategoryViewer) {
            window.ragotModules.mediaLoader.openCategoryViewer({ categoryId, startIndex: 0 });
        }
        return;
    }

    // Set video progress in app.state BEFORE loading so mediaNavigation can resume
    if (mediaUrl) {
        const progressInfo = getVideoProgress(mediaUrl);
        if (progressInfo && progressInfo.video_timestamp > 0) {
            const appState = window.ragotModules?.appState;
            if (appState) {
                if (!appState.videoProgressMap) appState.videoProgressMap = {};
                appState.videoProgressMap[mediaUrl] = {
                    video_timestamp: progressInfo.video_timestamp,
                    video_duration: progressInfo.video_duration || 0
                };
                appState.trackingMode = 'video';
                appState.savedVideoTimestamp = progressInfo.video_timestamp;
                appState.savedVideoIndex = 0;
            }
        }
    }

    if (window.ragotModules?.mediaLoader?.openCategoryViewer) {
        // Try to find the full row list from cache to enable navigation
        const subfolder = getSubfolderFilter();
        const mediaFilter = getMediaFilter();
        const categoryCache = getCategoryView(categoryId, subfolder, mediaFilter);

        const cachedRecords = selectRecordsForView(categoryCache?.viewKey);
        if (cachedRecords.length > 0) {
            // Stable id wins. URL fallback covers cards that haven't been
            // re-rendered with the new id yet (e.g. brief window after a
            // rename before the row VS rebuild lands).
            let index = -1;
            if (recordId) index = cachedRecords.findIndex(m => m.id === recordId);
            if (index === -1 && mediaUrl) index = cachedRecords.findIndex(m => m.url === mediaUrl);
            if (index !== -1) {
                window.ragotModules.mediaLoader.openViewerFromView({
                    sourceViewKey: categoryCache.viewKey,
                    categoryId,
                    startIndex: index,
                    startRecordId: cachedRecords[index]?.id || recordId || null,
                    mediaUrl,
                });
                return;
            }
        }

        window.ragotModules.mediaLoader.openCategoryViewer({
            categoryId,
            startIndex: 0,
            startRecordId: recordId,
            startMediaId: mediaUrl,
            subfolder,
        });
    } else {
        console.error('mediaLoader not available');
    }
}
