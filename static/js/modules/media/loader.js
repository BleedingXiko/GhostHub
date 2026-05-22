/**
 * Media Loader Module
 * Manages media loading, caching, and resource cleanup
 */


import { getShowHiddenHeaders } from '../../utils/showHiddenManager.js';

import {
    addToCache,
    getFromCache,
    hasInCache,
    performCacheCleanup
} from '../../utils/cacheManager.js';

import { renderMediaWindow } from './navigation.js';
import { isPlaybackProgressAllowed } from './progressSync.js';
import { toggleAutoPlay } from '../playback/autoPlay.js';
import {
    getLocalProgress,
    getAllVideoLocalProgress,
    getCategoryVideoLocalProgress,
    initProgressDB,
    isProgressDBReady,
} from '../../utils/progressDB.js';
import { hasActiveProfile } from '../../utils/profileUtils.js';
import { fileIcon } from '../../utils/icons.js';
import { createElement, css, attr, $, $$ } from '../../libs/ragot.esm.min.js';
import {
    setupControls,
    toggleSpinner
} from '../ui/controller.js';
import { showIndexingStatus, hideIndexingStatus } from '../../utils/indexingStatusLane.js';
import { selectRecordAt, selectRecordsForView, selectView, selectIndexOf } from './selectors.js';
import { clearViewerSession, getViewerSession, setViewerSession } from './viewerState.js';

// Local state for the current subfolder being viewed
let activeSubfolder = null;

function normalizeVideoProgressMap(progressMap) {
    if (!progressMap || typeof progressMap !== 'object') return {};
    const normalized = {};
    Object.entries(progressMap).forEach(([url, value]) => {
        if (!value || typeof value !== 'object') return;
        const videoTimestamp = Number(value.video_timestamp ?? value.timestamp ?? 0) || 0;
        const videoDuration = Number(value.video_duration ?? value.duration ?? 0) || 0;
        if (videoTimestamp > 0) {
            normalized[url] = {
                ...value,
                video_timestamp: videoTimestamp,
                video_duration: videoDuration
            };
        }
    });
    return normalized;
}

function resolveVideoProgressForUrl(progressMap, url) {
    if (!progressMap || !url) return null;
    if (progressMap[url]) return progressMap[url];
    try {
        const encoded = encodeURI(url);
        if (progressMap[encoded]) return progressMap[encoded];
    } catch (e) { /* ignore */ }
    try {
        const decoded = decodeURIComponent(url);
        if (progressMap[decoded]) return progressMap[decoded];
    } catch (e) { /* ignore */ }
    return null;
}


function findMediaIndexByUrl(viewKey, targetUrl) {
    if (!viewKey || !targetUrl) return -1;
    return selectRecordsForView(viewKey)
        .findIndex((item) => urlsMatch(item?.url, targetUrl) || urlsMatch(targetUrl, item?.url));
}

// Stable id resolution. The record id is `<category_id>::<rel_path>` and
// lives in the orderedIds array of every view — so a direct indexOf gives
// the correct row regardless of URL encoding, rename races, or category
// shuffles. Callers pass the id from the card's dataset (set at render).
function findMediaIndexById(viewKey, recordId) {
    if (!viewKey || !recordId) return -1;
    return selectIndexOf(viewKey, recordId);
}

async function fetchServerCategoryProgress(categoryId, limit = 500) {
    try {
        const response = await fetch(`/api/progress/videos?limit=${limit}`, {
            headers: getShowHiddenHeaders(),
            cache: 'no-store'
        });
        if (!response.ok) {
            return { progressMap: {}, latest: null };
        }
        const payload = await response.json();
        const videos = Array.isArray(payload?.videos) ? payload.videos : [];
        const categoryVideos = videos.filter((entry) => entry?.category_id === categoryId);
        const progressMap = {};

        categoryVideos.forEach((entry) => {
            const videoUrl = entry.video_path || entry.video_url;
            const videoTimestamp = Number(entry.video_timestamp || 0);
            if (!videoUrl || videoTimestamp <= 0) return;
            progressMap[videoUrl] = {
                video_timestamp: videoTimestamp,
                video_duration: Number(entry.video_duration || 0),
                thumbnail_url: entry.thumbnail_url || null,
                last_watched: entry.last_watched || 0
            };
        });

        const latestEntry = categoryVideos.find((entry) => Number(entry?.video_timestamp || 0) > 0) || null;
        const latest = latestEntry ? {
            video_url: latestEntry.video_path || latestEntry.video_url,
            video_timestamp: Number(latestEntry.video_timestamp || 0),
            video_duration: Number(latestEntry.video_duration || 0)
        } : null;

        return { progressMap, latest };
    } catch (e) {
        console.warn('[ContinueWatching] Failed to fetch server category progress:', e);
        return { progressMap: {}, latest: null };
    }
}

/**
 * Processes a raw file object from the API to ensure it has necessary properties for the app.
 * @param {Object} file - The raw file object.
 * @returns {Object} The processed file object with 'type' and 'originalPath'.
 */
function processApiFile(file) {
    let type = file.type;
    if (!type) {
        if (file.url && /\.(jpe?g|png|gif|webp)$/i.test(file.url)) {
            type = 'image';
        } else if (file.url && /\.(mp4|webm|mov|mkv|avi)$/i.test(file.url)) {
            type = 'video';
        } else {
            type = 'unknown';
        }
    }
    return {
        ...file, // Spread existing file properties
        type: type,
        originalPath: file.path || file.url // Prefer 'path' if available, fallback to 'url'
    };
}

import { setupLayoutNavigation, onLayoutMediaRendered, onLayoutViewerClosed, urlsMatch } from '../../utils/layoutUtils.js';
import { processMediaWithSubfolders, getSubfoldersFromResponse } from '../../utils/subfolderUtils.js';
import { setAppState, batchAppState } from '../../utils/appStateUtils.js';
import { toast } from '../../utils/notificationManager.js';

function getManifestModule() {
    const manifest = window.ragotModules?.mediaManifest;
    if (!manifest) throw new Error('Media manifest module is not initialized');
    return manifest;
}

function getOrderingModule() {
    const ordering = window.ragotModules?.mediaOrdering;
    if (!ordering) throw new Error('Media ordering module is not initialized');
    return ordering;
}

function viewerViewKeyForCategory(categoryId, subfolder = null, mediaFilter = 'all') {
    const sortBy = window.ragotModules?.appState?.sortBy || 'name';
    const sortOrder = window.ragotModules?.appState?.sortOrder || 'ASC';
    return `viewer_category::${categoryId}::${subfolder || ''}::${mediaFilter}::${sortBy}::${sortOrder}`;
}

function cleanCanonicalParams(params) {
    const clean = { ...(params || {}) };
    Object.keys(clean).forEach((key) => {
        if (clean[key] === undefined || clean[key] === null || clean[key] === '') {
            delete clean[key];
        }
    });
    return clean;
}

function makeLocalRecordId(record, categoryId) {
    if (record?.id) return record.id;
    const scopedCategory = record?.categoryId || record?.category_id || categoryId || 'media';
    const relPath = record?.relPath || record?.rel_path || record?.path || record?.url || record?.name;
    return `${scopedCategory}::${relPath || crypto.randomUUID?.() || Date.now()}`;
}

function buildRecordFromUrl(categoryId, mediaUrl) {
    const url = String(mediaUrl || '');
    const name = decodeURIComponent(url.split('/').pop() || 'unknown');
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(url);
    const isVideo = /\.(mp4|webm|mov|mkv|avi)$/i.test(url);
    let thumbnailUrl = isImage ? url : '/static/icons/Ghosthub192.png';
    if (isVideo) {
        const urlParts = url.split('/');
        const thumbCategoryId = urlParts[2] || categoryId;
        const baseName = name
            .replace(/[/\\]/g, '_')
            .replace(/\.[^.]+$/, '')
            .replace(/[?&%#'!$"()\[\]{}+=, ;]/g, '_');
        thumbnailUrl = `/thumbnails/${thumbCategoryId}/${encodeURIComponent(baseName)}.jpeg`;
    }
    return processApiFile({
        id: `${categoryId || 'media'}::${url}`,
        categoryId,
        url,
        name,
        displayName: name,
        type: isImage ? 'image' : isVideo ? 'video' : 'unknown',
        thumbnailUrl,
    });
}

function ingestLocalViewerRecords(viewKey, records, { categoryId = null, viewMeta = {}, params = {} } = {}) {
    const manifest = getManifestModule();
    const ordering = getOrderingModule();
    const normalizedRecords = {};
    const orderedIds = [];

    (records || []).forEach((record) => {
        if (!record) return;
        const processed = typeof record === 'string'
            ? buildRecordFromUrl(categoryId, record)
            : processApiFile(record);
        const id = makeLocalRecordId(processed, categoryId);
        const withId = { ...processed, id };
        normalizedRecords[id] = withId;
        orderedIds.push(id);
    });

    manifest.ingest(normalizedRecords, []);
    manifest.pin(viewKey, orderedIds);
    ordering.ingestView(viewKey, {
        viewKey,
        viewType: 'viewer_local',
        orderedIds,
        hasMore: false,
        pageToken: null,
        status: 'ready',
        viewMeta: { ...viewMeta },
        params: cleanCanonicalParams({
            ...params,
            category_id: categoryId,
            page: 1,
            limit: orderedIds.length,
            include_total: 'false',
        }),
    });
    return selectView(viewKey);
}

function mergeViewerOrder(viewKey, order) {
    const manifest = getManifestModule();
    manifest.pin(viewKey, order?.orderedIds || []);
    return selectView(viewKey);
}

async function requestViewerPage(viewKey, { page, limit, forceRefresh = false, signal = null } = {}) {
    const ordering = getOrderingModule();
    const manifest = getManifestModule();
    const current = selectView(viewKey);
    const currentParams = current?.params || {};
    const categoryId = currentParams.category_id || window.ragotModules.appState.currentCategoryId;
    if (!categoryId) throw new Error('categoryId is required for viewer media loading');

    const currentPage = Math.max(1, Number(currentParams.page) || 1);
    const derivedNextPage = current?.hasMore ? currentPage + 1 : null;
    const resolvedPage = Math.max(1, Number(page || derivedNextPage || 1));
    const resolvedLimit = Math.max(1, Number(limit || currentParams.limit || window.ragotModules.appRuntime.getMediaPerPage()));
    const mediaFilter = currentParams.media_filter || 'all';
    const subfolder = currentParams.subfolder || null;
    const viewType = current?.viewType || (subfolder ? 'subfolder_grid' : 'streaming_grid');
    const params = {
        category_id: categoryId,
        page: resolvedPage,
        limit: resolvedLimit,
        include_total: currentParams.include_total === 'true' ? 'true' : 'false',
        media_filter: mediaFilter,
        force_refresh: forceRefresh ? 'true' : 'false',
        hydrate: 'true',
        sort_by: currentParams.sort_by || window.ragotModules.appState.sortBy || 'name',
        sort_order: currentParams.sort_order || window.ragotModules.appState.sortOrder || 'ASC',
        shuffle: window.ragotModules.appState.syncModeEnabled ? 'false' : undefined,
    };
    if (subfolder) params.subfolder = subfolder;

    const order = await ordering.requestOrder(viewKey, viewType, params, {
        bypassClientCache: forceRefresh,
        append: resolvedPage > 1,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const view = mergeViewerOrder(viewKey, order);
    await manifest.hydrate(view.orderedIds || []);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return view;
}

async function resolveResumeIndex(categoryId, viewKey, explicitIndex = null) {
    if (explicitIndex !== null && explicitIndex !== undefined) {
        const parsed = parseInt(explicitIndex, 10);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }

    if (!isPlaybackProgressAllowed(window.ragotModules?.appState)) return 0;

    const activeProfile = hasActiveProfile();
    const saveVideoProgressEnabled = window.ragotModules?.appStore?.get?.('config', {})?.python_config?.SAVE_VIDEO_PROGRESS !== false;
    if (!saveVideoProgressEnabled) return 0;

    if (!activeProfile && !isProgressDBReady()) {
        await initProgressDB();
    }

    const isSyncGuest = window.ragotModules.appState.syncModeEnabled && !window.ragotModules.appState.isHost;
    if (isSyncGuest && typeof window.ragotModules.appState.savedVideoTimestamp === 'number') {
        return Number.isInteger(window.ragotModules.appState.savedVideoIndex)
            ? window.ragotModules.appState.savedVideoIndex
            : 0;
    }

    if (activeProfile) {
        const serverCategoryProgress = await fetchServerCategoryProgress(categoryId);
        if (serverCategoryProgress?.latest?.video_timestamp > 0) {
            const index = findMediaIndexByUrl(viewKey, serverCategoryProgress.latest.video_url);
            if (index >= 0) {
                setAppState('videoProgressMap', normalizeVideoProgressMap(serverCategoryProgress.progressMap || {}));
                setAppState('savedVideoTimestamp', serverCategoryProgress.latest.video_timestamp);
                setAppState('savedVideoDuration', serverCategoryProgress.latest.video_duration || 0);
                return index;
            }
        }
        setAppState('videoProgressMap', normalizeVideoProgressMap(serverCategoryProgress?.progressMap || {}));
        return 0;
    }

    const localProgress = getLocalProgress(categoryId);
    if (localProgress?.index !== undefined) {
        const index = parseInt(localProgress.index, 10);
        if (Number.isInteger(index) && index >= 0) {
            setAppState('savedVideoTimestamp', localProgress.video_timestamp || null);
            setAppState('savedVideoDuration', localProgress.video_duration || 0);
            return index;
        }
    }

    const latestCategoryVideo = getAllVideoLocalProgress()
        .filter((entry) => entry?.category_id === categoryId && Number(entry?.video_timestamp || 0) > 0)
        .sort((a, b) => Number(b?.last_updated || 0) - Number(a?.last_updated || 0))[0];
    if (latestCategoryVideo) {
        const index = findMediaIndexByUrl(viewKey, latestCategoryVideo.video_url);
        if (index >= 0) {
            setAppState('videoProgressMap', normalizeVideoProgressMap(getCategoryVideoLocalProgress(categoryId)));
            setAppState('savedVideoTimestamp', Number(latestCategoryVideo.video_timestamp || 0));
            setAppState('savedVideoDuration', Number(latestCategoryVideo.video_duration || 0));
            return index;
        }
    }

    return 0;
}

async function ensureViewerIndexLoaded(viewKey, index, limit, signal) {
    let view = selectView(viewKey);
    let attempts = 0;
    while (index >= (view?.orderedIds?.length || 0) && view?.hasMore && attempts < 20) {
        await requestViewerPage(viewKey, { limit, signal });
        view = selectView(viewKey);
        attempts += 1;
    }
    return index < (view?.orderedIds?.length || 0) ? index : 0;
}

function showViewerShell() {
    toggleSpinner(true);
    if (window.ragotModules.appDom.mediaViewer) {
        window.ragotModules.appDom.mediaViewer.classList.remove('hidden');
    }
    const mobileBackOverlay = $('#mobile-back-overlay');
    if (mobileBackOverlay) mobileBackOverlay.style.display = 'block';
    toggleAutoPlay('stop');
}

function resetViewerRuntime(categoryId, viewKey, startIndex, { subfolder = null, sortBy = null, sortOrder = null } = {}) {
    setAppState('currentCategoryId', categoryId);
    setAppState('isLoading', false);
    setAppState('knownSubfolders', new Set());
    setAppState('preloadQueue', []);
    setAppState('isPreloading', false);
    setAppState('sortBy', sortBy || 'name');
    setAppState('sortOrder', sortOrder || 'ASC');
    activeSubfolder = subfolder || null;
    setViewerSession(viewKey, startIndex || 0, { categoryId });

    window.ragotModules.appCache.clear();
    if (window.ragotModules.appState.currentFetchController) {
        window.ragotModules.appState.currentFetchController.abort();
    }
    setAppState('currentFetchController', new AbortController());
    clearResources(true);
    if (window.ragotModules.appDom.mediaViewer) {
        $$('.viewer-media', window.ragotModules.appDom.mediaViewer).forEach(el => el.remove());
    }
    setupLayoutNavigation();
}

/**
 * Open the active media viewer around a category-backed canonical view.
 */
async function openCategoryViewer({
    categoryId,
    startIndex = null,
    startMediaId = null,
    startRecordId = null,
    subfolder = null,
    sortBy = null,
    sortOrder = null,
    mediaFilter = 'all',
    viewKey = null,
    viewType = null,
    forceRefresh = null,
} = {}) {
    if (!categoryId) throw new Error('categoryId is required');
    showViewerShell();

    const resolvedSortBy = sortBy || window.ragotModules.appState.sortBy || 'name';
    const resolvedSortOrder = sortOrder || window.ragotModules.appState.sortOrder || 'ASC';
    const viewerViewKey = viewKey || viewerViewKeyForCategory(categoryId, subfolder, mediaFilter);
    const needsRefresh = window.ragotModules.appState.needsMediaRefresh || false;
    const shouldForceRefresh = forceRefresh === true || window.ragotModules.appState.forceMediaRefresh === true;
    if (needsRefresh) {
        setAppState('needsMediaRefresh', false);
        setAppState('forceMediaRefresh', false);
    }

    resetViewerRuntime(categoryId, viewerViewKey, startIndex || 0, {
        subfolder,
        sortBy: resolvedSortBy,
        sortOrder: resolvedSortOrder,
    });
    const limit = window.ragotModules.appRuntime.getMediaPerPage();
    getOrderingModule().ingestView(viewerViewKey, {
        viewKey: viewerViewKey,
        viewType: viewType || (subfolder ? 'subfolder_grid' : 'streaming_grid'),
        orderedIds: [],
        hasMore: true,
        status: 'ready',
        pageToken: '1',
        viewMeta: {},
        params: cleanCanonicalParams({
            category_id: categoryId,
            subfolder,
            media_filter: mediaFilter,
            sort_by: resolvedSortBy,
            sort_order: resolvedSortOrder,
            page: 1,
            limit,
            include_total: 'false',
        }),
    });

    const signal = window.ragotModules.appState.currentFetchController.signal;

    try {
        await requestViewerPage(viewerViewKey, { page: 1, limit, forceRefresh: shouldForceRefresh, signal });
        // Stable id wins over URL. Same view + same record id is unambiguous;
        // URL matching is a last-resort fallback for callers that genuinely
        // don't have the id (search-by-share-link, deep-link).
        let resolvedIndex = -1;
        if (startRecordId) resolvedIndex = findMediaIndexById(viewerViewKey, startRecordId);
        if (resolvedIndex < 0 && startMediaId) resolvedIndex = findMediaIndexByUrl(viewerViewKey, startMediaId);

        // If target record is not on page 1, hydrate it instantly and append to orderedIds
        if (resolvedIndex < 0 && startRecordId) {
            const manifest = getManifestModule();
            await manifest.hydrate([startRecordId], 15000, signal);
            const record = manifest.get(startRecordId);
            if (record) {
                const view = selectView(viewerViewKey);
                if (view && !view.orderedIds.includes(startRecordId)) {
                    const nextOrderedIds = [...(view.orderedIds || []), startRecordId];
                    getOrderingModule().ingestView(viewerViewKey, {
                        ...view,
                        orderedIds: nextOrderedIds,
                    });
                    resolvedIndex = nextOrderedIds.length - 1;
                }
            }
        }

        if (resolvedIndex < 0 && !startRecordId && !startMediaId) {
            resolvedIndex = await resolveResumeIndex(categoryId, viewerViewKey, startIndex);
        }
        if (resolvedIndex < 0) resolvedIndex = 0;
        resolvedIndex = await ensureViewerIndexLoaded(viewerViewKey, resolvedIndex, limit, signal);
        setViewerSession(viewerViewKey, resolvedIndex, { categoryId });
        if (isPlaybackProgressAllowed(window.ragotModules?.appState)) {
            setAppState('savedVideoIndex', resolvedIndex);
            setAppState('savedVideoCategoryId', categoryId);
        }
        renderMediaWindow(resolvedIndex);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('openCategoryViewer error:', err);
            toast.error('Error loading media');
            toggleSpinner(false);
        }
        if (window.ragotModules.appDom.mediaViewer) window.ragotModules.appDom.mediaViewer.classList.add('hidden');
    }
}

/**
 * Open a viewer from an already materialized view without passing media arrays.
 */
async function openViewerFromView({ sourceViewKey, categoryId, startIndex = 0, startRecordId = null, mediaUrl = null } = {}) {
    const sourceView = selectView(sourceViewKey);
    if (!sourceView?.orderedIds?.length) {
        return openCategoryViewer({ categoryId, startIndex, startRecordId, startMediaId: mediaUrl });
    }

    const viewerViewKey = `viewer::${sourceViewKey}`;
    const manifest = getManifestModule();
    const ordering = getOrderingModule();
    const records = selectRecordsForView(sourceViewKey);
    const recordMap = {};
    records.forEach((record) => {
        if (record?.id) recordMap[record.id] = record;
    });
    manifest.ingest(recordMap, []);
    manifest.pin(viewerViewKey, sourceView.orderedIds);
    ordering.ingestView(viewerViewKey, {
        ...sourceView,
        viewKey: viewerViewKey,
        viewType: sourceView.viewType,
        viewMeta: { ...sourceView.viewMeta },
        params: cleanCanonicalParams({
            ...(sourceView.params || {}),
            category_id: categoryId,
        }),
    });

    showViewerShell();
    const sourceParams = sourceView.params || {};
    resetViewerRuntime(categoryId, viewerViewKey, startIndex, {
        subfolder: sourceParams.subfolder || null,
        sortBy: sourceParams.sort_by,
        sortOrder: sourceParams.sort_order,
    });

    // Resolve by stable id first — the source view's orderedIds is the
    // canonical ordering, so indexOf is exact. mediaUrl is the last-resort
    // fallback for call sites that only have a URL.
    let resolvedIndex = -1;
    if (startRecordId) resolvedIndex = findMediaIndexById(viewerViewKey, startRecordId);
    if (resolvedIndex < 0 && mediaUrl) resolvedIndex = findMediaIndexByUrl(viewerViewKey, mediaUrl);
    if (resolvedIndex < 0) resolvedIndex = Math.max(0, Number(startIndex) || 0);

    setViewerSession(viewerViewKey, resolvedIndex, { categoryId });
    renderMediaWindow(resolvedIndex);
}

/**
 * Open a one-record local viewer for shared/search links that do not have a source view.
 */
async function openSingleMediaViewer({ categoryId, mediaUrl, record = null } = {}) {
    if (!mediaUrl && !record?.url) return openCategoryViewer({ categoryId, startIndex: 0 });
    const viewerViewKey = `viewer_single::${categoryId || 'media'}::${record?.id || mediaUrl || record?.url}`;
    const mediaRecord = record || buildRecordFromUrl(categoryId, mediaUrl);
    ingestLocalViewerRecords(viewerViewKey, [mediaRecord], { categoryId });
    showViewerShell();
    resetViewerRuntime(categoryId || mediaRecord.categoryId || null, viewerViewKey, 0);
    setViewerSession(viewerViewKey, 0, { categoryId: categoryId || mediaRecord.categoryId || null });
    renderMediaWindow(0);
}

/**
 * Load additional media into the active viewer view.
 */
async function loadMoreMedia(customLimit = null, signal = null, forceRefresh = false, targetPage = null) {
    const session = getViewerSession();
    if (!session?.viewKey) return null;
    const view = selectView(session.viewKey);
    const effectiveSignal = signal || window.ragotModules.appState.currentFetchController?.signal || null;
    if (effectiveSignal?.aborted) return null;
    if (!view?.hasMore || window.ragotModules.appState.isLoading) return null;

    setAppState('isLoading', true);
    toggleSpinner(true);
    try {
        const currentPage = Math.max(1, Number(view.params?.page) || 1);
        const nextPage = view.hasMore ? currentPage + 1 : null;
        const nextView = await requestViewerPage(session.viewKey, {
            page: targetPage || nextPage || 1,
            limit: customLimit || view.params?.limit || window.ragotModules.appRuntime.getMediaPerPage(),
            forceRefresh,
            signal: effectiveSignal,
        });
        const loadedCount = nextView?.orderedIds?.length || 0;
        const meta = nextView?.viewMeta || {};
        if (meta.asyncIndexing === true) {
            setAppState('asyncIndexingActive', true);
            showIndexingStatus(meta.indexingProgress || 0, {
                title: loadedCount > 0 ? 'Indexing media. More pages are loading...' : 'Preparing media library. First items are loading...',
                meta: loadedCount > 0 ? `${meta.indexingProgress || 0}% complete - ${loadedCount} items ready` : `${meta.indexingProgress || 0}% complete`,
            });
            if ((meta.indexingProgress || 0) < 100) {
                setTimeout(() => {
                    if (getViewerSession()?.viewKey === session.viewKey) {
                        loadMoreMedia(customLimit, effectiveSignal, false, targetPage);
                    }
                }, 2000);
            }
        } else {
            setAppState('asyncIndexingActive', false);
            hideIndexingStatus();
        }
        if (window.ragotModules.appDom.mediaViewer && !window.ragotModules.appDom.mediaViewer.classList.contains('hidden')) {
            onLayoutMediaRendered(session.activeIndex, loadedCount);
        }
        return nextView;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error loading more media:', error);
            toast.error('Failed to load more media. Please try again later.');
            toggleSpinner(false);
        }
        return null;
    } finally {
        setAppState('isLoading', false);
    }
}

/**
 * Clean up media resources
 * @param {boolean} aggressive - Deep cleanup if true
 */
function clearResources(aggressive = false) {
    console.log(`Clearing resources (aggressive: ${aggressive})`);
    setAppState('asyncIndexingActive', false);
    hideIndexingStatus();

    // Ensure video-controls UI state is fully reset before removing media nodes.
    window.ragotModules?.videoControls?.detachControls?.();

    // Clear media elements
    $$('.viewer-media', window.ragotModules.appDom.mediaViewer).forEach(el => {
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
    const existingControls = $('.controls-wrapper', window.ragotModules.appDom.mediaViewer);
    if (existingControls) {
        existingControls.remove();
    }

    // Clear indicators
    // Swipe indicators removed from semantic UI

    // Clear preload queue
    setAppState('preloadQueue', []);
    setAppState('isPreloading', false);

    // More aggressive cleanup on mobile or when explicitly requested
    if (aggressive || window.innerWidth <= 768) {
        console.log('Performing aggressive cleanup');
        // Clear the entire cache on aggressive cleanup
        window.ragotModules.appCache.clear();

        // Remove any detached video elements from the DOM
        $$('video').forEach(video => {
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

        // Use the performCacheCleanup function from cacheManager.js
        performCacheCleanup(true);
    } else {
        // Regular cleanup - limit cache size
        performCacheCleanup();
    }
}

/**
 * Preload next media items in background
 */
function preloadNextMedia() {
    if (window.ragotModules.appState.isPreloading || window.ragotModules.appState.preloadQueue.length === 0) return;

    // Get device memory if available, default to 4GB if not
    const deviceMemory = navigator.deviceMemory || 4;

    // Low-memory client optimization: use conservative cache size
    const adjustedMaxCacheSize = window.ragotModules.appRuntime.LOW_MEMORY_DEVICE ? Math.min(window.ragotModules.appRuntime.MAX_CACHE_SIZE, 10) : window.ragotModules.appRuntime.MAX_CACHE_SIZE;

    // Skip preloading if cache is getting too large
    if (window.ragotModules.appCache.size >= adjustedMaxCacheSize) {
        console.log(`Cache size (${window.ragotModules.appCache.size}) >= adjusted window.ragotModules.appRuntime.MAX_CACHE_SIZE (${adjustedMaxCacheSize}), skipping preload.`);
        // Force cache cleanup when we're at the limit
        performCacheCleanup(true);
        setAppState('isPreloading', false);
        return;
    }

    // Check if client browser is likely to be under memory pressure
    const isLowMemory = window.ragotModules.appRuntime.LOW_MEMORY_DEVICE || deviceMemory <= 2 ||
        (typeof navigator.deviceMemory === 'undefined' && window.ragotModules.appRuntime.MOBILE_DEVICE);

    // Limit concurrent preloads based on client device capabilities
    const maxConcurrentPreloads = isLowMemory ? 1 : 2;

    // Count active preloads (elements with preload attribute)
    const activePreloads = $$('video[preload="metadata"], img[fetchpriority="high"]').length;

    if (activePreloads >= maxConcurrentPreloads) {
        console.log(`Too many active preloads (${activePreloads}), deferring preload.`);
        // Try again later with a longer delay
        setTimeout(preloadNextMedia, 1000); // Increased from 500ms to 1000ms
        return;
    }

    setAppState('isPreloading', true);

    // Prioritize next item for immediate viewing
    const nextItems = window.ragotModules.appState.preloadQueue.slice(0, 1); // Only preload 1 at a time
    // Get the next file to preload
    let file = null;
    batchAppState((state) => {
        file = state.preloadQueue.shift();
    }, { source: 'mediaLoader.preloadNextMedia.dequeue' });

    if (!file || hasInCache(file.url)) {
        setAppState('isPreloading', false);
        // Continue preloading next items immediately
        setTimeout(preloadNextMedia, 0);
        return;
    }

    console.log(`Preloading ${file.type}: ${file.name}`);
    let mediaElement;

    if (file.type === 'video') {
        // If the file has a thumbnailUrl, preload the thumbnail image instead of the video metadata
        if (file.thumbnailUrl) {
            console.log(`Preloading video thumbnail for: ${file.name}`);
            mediaElement = new Image();
            mediaElement.style.display = 'none'; // Keep it hidden

            // Add fetch priority hint for next items
            if (nextItems.includes(file)) {
                mediaElement.setAttribute('fetchpriority', 'high');
            }

            // Use a single onload handler with timeout clearing
            // Shorter timeout for low-memory clients to recover faster from stalled loads
            const timeoutMs = window.ragotModules.appRuntime.LOW_MEMORY_DEVICE ? 3000 : 5000;
            const loadTimeout = setTimeout(() => {
                console.warn(`Video thumbnail load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                setAppState('isPreloading', false);
                setTimeout(preloadNextMedia, 0); // Continue preloading
            }, timeoutMs);

            attr(mediaElement, {
                onLoad: () => {
                    clearTimeout(loadTimeout); // Clear timeout on successful load
                    console.log(`Video thumbnail loaded: ${file.name}`);
                    // Store the thumbnail IMAGE in the cache using the VIDEO'S URL as the key
                    addToCache(file.url, mediaElement);
                    // No need to remove from body here, it's already display:none
                    // if (document.body.contains(mediaElement)) {
                    //     document.body.removeChild(mediaElement);
                    // }
                    setAppState('isPreloading', false);
                    setTimeout(preloadNextMedia, 0); // Continue preloading
                },
                onError: () => {
                    clearTimeout(loadTimeout); // Clear timeout on error
                    console.error(`Error preloading video thumbnail: ${file.thumbnailUrl}`);
                    if (document.body.contains(mediaElement)) {
                        document.body.removeChild(mediaElement);
                    }
                    setAppState('isPreloading', false);
                    setTimeout(preloadNextMedia, 0); // Continue preloading
                }
            });

            document.body.appendChild(mediaElement); // Append to trigger load
            mediaElement.src = file.thumbnailUrl; // Set src to start loading
        } else {
            // If no thumbnail URL, create a minimal video element that only loads metadata
            console.log(`Preloading video metadata for: ${file.name} (no thumbnail)`);
            mediaElement = createElement('video', {
                preload: 'metadata',
                playsInline: true,
                muted: true,
                style: { display: 'none' }
            });
            mediaElement.setAttribute('playsinline', 'true');
            mediaElement.setAttribute('webkit-playsinline', 'true');
            mediaElement.setAttribute('controlsList', 'nodownload nofullscreen');
            mediaElement.disablePictureInPicture = true;

            // Add fetch priority hint for next items
            if (nextItems.includes(file)) {
                mediaElement.setAttribute('fetchpriority', 'high');
            }

            // Add error handling for videos
            attr(mediaElement, {
                onError: function () {
                    console.error(`Error preloading video: ${file.url}`);
                    if (document.body.contains(mediaElement)) {
                        document.body.removeChild(mediaElement);
                    }
                    setAppState('isPreloading', false);
                    // Continue preloading immediately
                    setTimeout(preloadNextMedia, 0);
                }
            });

            // Set a shorter timeout for faster recovery from stalled loading
            const metaTimeoutMs = window.ragotModules.appRuntime.LOW_MEMORY_DEVICE ? 2000 : 3000;
            const loadTimeout = setTimeout(() => {
                console.warn(`Video metadata load timeout: ${file.name}`);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                setAppState('isPreloading', false);
                // Continue preloading immediately
                setTimeout(preloadNextMedia, 0);
            }, metaTimeoutMs);

            // For videos, only preload metadata
            attr(mediaElement, {
                onLoadedMetadata: () => {
                    clearTimeout(loadTimeout);
                    console.log(`Video metadata loaded: ${file.name}`);
                    addToCache(file.url, mediaElement);
                    if (document.body.contains(mediaElement)) {
                        document.body.removeChild(mediaElement);
                    }
                    setAppState('isPreloading', false);
                    // Continue preloading immediately
                    setTimeout(preloadNextMedia, 0);
                }
            });

            // Use a data URL for the poster to avoid an extra network request
            mediaElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';

            document.body.appendChild(mediaElement);

            // Add source with type for better loading
            mediaElement.appendChild(createElement('source', { src: file.url, type: 'video/mp4' }));

            // Force load metadata only
            mediaElement.load();
        }
    } else if (file.type === 'image') {
        mediaElement = new Image();
        mediaElement.style.display = 'none';

        // Add fetch priority hint for next items
        if (nextItems.includes(file)) {
            mediaElement.setAttribute('fetchpriority', 'high');
        }

        // Set a shorter timeout for faster recovery on low-memory clients
        const imgTimeoutMs = window.ragotModules.appRuntime.LOW_MEMORY_DEVICE ? 3000 : 5000;
        const loadTimeout = setTimeout(() => {
            if (document.body.contains(mediaElement)) {
                document.body.removeChild(mediaElement);
            }
            setAppState('isPreloading', false);
            setTimeout(preloadNextMedia, 0);
        }, imgTimeoutMs);

        attr(mediaElement, {
            onLoad: () => {
                clearTimeout(loadTimeout);
                addToCache(file.url, mediaElement);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                setAppState('isPreloading', false);
                setTimeout(preloadNextMedia, 0);
            },
            onError: () => {
                clearTimeout(loadTimeout);
                if (document.body.contains(mediaElement)) {
                    document.body.removeChild(mediaElement);
                }
                setAppState('isPreloading', false);
                setTimeout(preloadNextMedia, 0);
            }
        });

        document.body.appendChild(mediaElement);

        // Use URL directly - browser caching improves performance on Pi
        // Only add cache-buster if image previously failed
        mediaElement.src = file.url;
    } else {
        // For unknown file types, create a placeholder element and cache it

        // Create placeholder element (simplified for performance)
        mediaElement = createElement('div', {
            className: 'unknown-file-placeholder',
            innerHTML: `
                <div class="unknown-file-placeholder__content">
                    <div class="unknown-file-placeholder__icon">${fileIcon(64)}</div>
                    <div class="unknown-file-placeholder__name">${file.displayName || file.name}</div>
                </div>
            `
        });

        // Cache the placeholder
        addToCache(file.url, mediaElement);
        setAppState('isPreloading', false);
        // Continue preloading immediately
        setTimeout(preloadNextMedia, 0);
    }
}

/**
 * Apply performance optimizations to video element
 * @param {HTMLVideoElement} videoElement - Video to optimize
 */
function optimizeVideoElement(videoElement) {
    // Set video attributes for faster loading
    videoElement.preload = 'metadata';
    videoElement.playsInline = true;
    videoElement.setAttribute('playsinline', 'true');
    videoElement.setAttribute('webkit-playsinline', 'true');

    // Add performance attributes
    videoElement.setAttribute('disableRemotePlayback', 'true');
    videoElement.disablePictureInPicture = true;

    // Set initial muted state for faster loading
    videoElement.muted = true;

    // Use a data URL for the poster to avoid an extra network request
    videoElement.poster = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMxYTFhM2EiLz48L3N2Zz4=';

    // iOS specific optimizations
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        // These attributes are needed for proper iOS video behavior
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('webkit-playsinline', 'true');
        videoElement.setAttribute('x-webkit-airplay', 'allow');

        // For iOS fullscreen support
        videoElement.setAttribute('webkit-allows-inline-media-playback', 'true');

    }


    return videoElement;
}

export {
    openCategoryViewer,
    openViewerFromView,
    openSingleMediaViewer,
    loadMoreMedia,
    clearResources,
    clearResources as clearMediaCache,
    preloadNextMedia,
    optimizeVideoElement
};
