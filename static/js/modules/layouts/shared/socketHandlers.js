import { Module, $ } from '../../../libs/ragot.esm.min.js';
import { isUploadInProgress } from '../../../utils/uploadManager.js';
import { SOCKET_EVENTS } from '../../../core/socketEvents.js';

/**
 * Shared socket handler manager for layout modules.
 * Handles debounced refresh scheduling and common socket events.
 *
 * @param {Object} options
 * @param {Function} options.isActive
 * @param {Function} options.refresh
 * @param {Function} options.handleProgressUpdate
 * @param {Function} options.syncShowHiddenFromEvent
 * @param {boolean} [options.forceRefreshOnShowHiddenToggle=false]
 * @returns {{register: Function, cleanup: Function}}
 */
export function createLayoutSocketHandlerManager({
    isActive,
    refresh,
    handleProgressUpdate = null,
    syncShowHiddenFromEvent,
    forceRefreshOnShowHiddenToggle = false,
    shouldScheduleCategoryRefresh = null
}) {
    let socketLifecycle = null;
    let pendingForceRefresh = false;
    let pendingRefreshCategoryList = false;
    let refreshTimer = null;

    function cleanup() {
        if (socketLifecycle) {
            socketLifecycle.stop();
            socketLifecycle = null;
        }
        pendingForceRefresh = false;
        pendingRefreshCategoryList = false;
        refreshTimer = null;
    }

    /**
     * Cancel any pending debounced refresh without running it.
     * Call this when the user explicitly triggers a load (e.g. filter click, pagination)
     * so the socket-driven debounce does not fire afterwards and clobber the user action.
     */
    function cancelPendingRefresh() {
        if (refreshTimer && socketLifecycle) {
            socketLifecycle.clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        pendingForceRefresh = false;
        pendingRefreshCategoryList = false;
    }

    function scheduleRefresh(forceRefresh, delayMs, refreshCategoryList = false) {
        pendingForceRefresh = pendingForceRefresh || forceRefresh;
        pendingRefreshCategoryList = pendingRefreshCategoryList || refreshCategoryList;
        if (refreshTimer) socketLifecycle.clearTimeout(refreshTimer);
        refreshTimer = socketLifecycle.timeout(() => {
            const force = pendingForceRefresh;
            const refreshCatList = pendingRefreshCategoryList;
            pendingForceRefresh = false;
            pendingRefreshCategoryList = false;
            refreshTimer = null;
            if (!isActive()) return;
            window.ragotModules?.mediaLoader?.clearMediaCache?.();
            window.ragotModules?.cacheManager?.clearCache?.();
            refresh(force, false, refreshCatList);
        }, Math.max(0, delayMs));
    }

    function shouldRefreshLayoutForCategoryEvent(data) {
        const reason = data?.reason;
        return data?.refreshCategoryList === true ||
            data?.invalidateAll === true ||
            reason === 'category_hidden' ||
            reason === 'category_unhidden' ||
            reason === 'file_hidden' ||
            reason === 'file_unhidden' ||
            reason === 'files_hidden' ||
            reason === 'files_unhidden' ||
            reason === 'files_deleted' ||
            reason === 'show_hidden_enabled' ||
            reason === 'show_hidden_disabled' ||
            reason === 'folder_deleted' ||
            reason === 'file_uploaded' ||
            reason === 'upload_complete' ||
            reason === 'chunked_upload';
    }

    // Defer a refresh until the upload manager flips isUploadInProgress() false.
    // Without this, a CATEGORY_UPDATED that arrives mid-upload gets dropped by
    // the early-return below and the new file never shows up in the layout.
    let deferredRefreshPending = false;
    function deferRefreshUntilUploadIdle(forceRefresh, refreshCategoryList) {
        if (deferredRefreshPending) return;
        deferredRefreshPending = true;
        const start = Date.now();
        const tick = () => {
            if (!socketLifecycle) {
                deferredRefreshPending = false;
                return;
            }
            // 30s safety cap — if upload state never settles, refresh anyway
            // rather than leave the UI permanently stale.
            if (!isUploadInProgress() || (Date.now() - start) > 30_000) {
                deferredRefreshPending = false;
                scheduleRefresh(forceRefresh, 800, refreshCategoryList);
                return;
            }
            socketLifecycle.timeout(tick, 500);
        };
        socketLifecycle.timeout(tick, 500);
    }

    function register(socket) {
        cleanup();
        socketLifecycle = new Module();
        socketLifecycle.start();

        socketLifecycle.onSocket(socket, SOCKET_EVENTS.CATEGORY_UPDATED, async (data) => {
            if (!isActive()) return;
            try {
                const isVisibilityReason = data.reason === 'show_hidden_enabled' ||
                    data.reason === 'show_hidden_disabled' ||
                    data.reason === 'category_hidden' ||
                    data.reason === 'category_unhidden';

                if (isVisibilityReason) {
                    await syncShowHiddenFromEvent(data);
                }

                const isVisibilityToggle = isVisibilityReason ||
                    data.reason === 'file_hidden' ||
                    data.reason === 'file_unhidden' ||
                    data.reason === 'files_hidden' ||
                    data.reason === 'files_unhidden';

                const isDbChange = data.reason === 'category_hidden' ||
                    data.reason === 'category_unhidden' ||
                    data.reason === 'file_hidden' ||
                    data.reason === 'file_unhidden' ||
                    data.reason === 'files_hidden' ||
                    data.reason === 'files_unhidden' ||
                    data.reason === 'files_deleted';

                const isUploadOrIndexChange = data.reason === 'upload_complete' ||
                    data.reason === 'chunked_upload' ||
                    data.reason === 'file_uploaded' ||
                    data.reason === 'index_updated';
                if (isUploadOrIndexChange && isUploadInProgress()) {
                    // Don't drop the refresh — defer it until the upload
                    // manager reports idle so the new file actually appears.
                    deferRefreshUntilUploadIdle(true, data?.invalidateAll === true);
                    return;
                }

                const isShowHiddenToggle = data.reason === 'show_hidden_enabled' ||
                    data.reason === 'show_hidden_disabled';

                const forceRefresh = (data?.force_refresh === true) ||
                    isDbChange ||
                    isUploadOrIndexChange ||
                    (forceRefreshOnShowHiddenToggle && isShowHiddenToggle);

                const mediaViewerEl = $('#media-viewer');
                if (mediaViewerEl && !mediaViewerEl.classList.contains('hidden')) return;

                if (!data.session_only || isVisibilityToggle) {
                    const shouldRefresh = shouldRefreshLayoutForCategoryEvent(data) &&
                        (
                            typeof shouldScheduleCategoryRefresh !== 'function' ||
                            shouldScheduleCategoryRefresh(data) !== false
                        );
                    if (shouldRefresh) {
                        const delay = data.reason === 'index_updated' ? 2500 : 800;
                        scheduleRefresh(forceRefresh, delay, isShowHiddenToggle);
                    }
                }
            } catch (e) {
                console.error('[LayoutSocketHandlers] Error handling category_updated:', e);
            }
        });

        if (typeof handleProgressUpdate === 'function') {
            socketLifecycle.onSocket(socket, SOCKET_EVENTS.PROGRESS_UPDATE, (data) => {
                if (isActive()) handleProgressUpdate(data);
            });
        }

        socketLifecycle.onSocket(socket, SOCKET_EVENTS.USB_MOUNTS_CHANGED, (data) => {
            if (!isActive()) return;
            cancelPendingRefresh();
            window.ragotModules?.mediaLoader?.clearMediaCache?.();
            window.ragotModules?.cacheManager?.clearCache?.();
            refresh(data?.force_refresh === true, false, true);
        });
    }

    return {
        register,
        cleanup,
        cancelPendingRefresh
    };
}
