/**
 * Layout Utilities - Shared utilities for gallery and streaming layouts
 * Reduces code duplication between layout modules
 */

import {
    getAllVideoLocalProgress,
    isProgressDBReady,
    initProgressDB
} from './progressDB.js';
import { getShowHiddenHeaders } from './showHiddenManager.js';
import { hasActiveProfile } from './profileUtils.js';
import { $ } from '../libs/ragot.esm.min.js';
import { getCurrentViewerRecord, getViewerSession } from '../modules/media/viewerState.js';

// ==================== HTML UTILITIES ====================

/**
 * Escape HTML to prevent XSS
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ==================== TIME/DATE UTILITIES ====================

/**
 * Format time in seconds to mm:ss or hh:mm:ss
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get a date key string from a timestamp
 * @param {number|string|null} timestamp - Unix timestamp or date string
 * @returns {string} Date key like "2024-12-11" or "Unknown"
 */
export function getDateKey(timestamp) {
    if (!timestamp) return 'Unknown';

    try {
        const date = new Date(timestamp * 1000); // Assume Unix timestamp
        if (isNaN(date.getTime())) {
            // Try parsing as string
            const parsed = new Date(timestamp);
            if (isNaN(parsed.getTime())) return 'Unknown';
            return parsed.toISOString().split('T')[0];
        }
        return date.toISOString().split('T')[0];
    } catch (e) {
        return 'Unknown';
    }
}

/**
 * Format a date key for display
 * @param {string} dateKey 
 * @returns {string} Formatted date like "December 11, 2024" or "Today"
 */
export function formatDateDisplay(dateKey) {
    if (dateKey === 'Unknown') return 'Unknown Date';

    try {
        // Parse dateKey as local date (not UTC) by adding time component
        const [year, month, day] = dateKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const dateOnly = new Date(date);
        dateOnly.setHours(0, 0, 0, 0);

        if (dateOnly.getTime() === today.getTime()) {
            return 'Today';
        }

        if (dateOnly.getTime() === yesterday.getTime()) {
            return 'Yesterday';
        }

        if (date.getFullYear() === today.getFullYear()) {
            return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        }

        return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return dateKey;
    }
}

// ==================== MEDIA UTILITIES ====================

/**
 * Extract display title from URL or filename
 * @param {string} urlOrFilename
 * @returns {string}
 */
export function extractTitle(urlOrFilename) {
    if (!urlOrFilename) return 'Untitled';
    const filename = decodeURIComponent(urlOrFilename.split('/').pop());
    return filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
}

/**
 * Calculate progress percentage
 * @param {number} current - Current position (timestamp)
 * @param {number} total - Total duration
 * @returns {number} Percentage 0-100
 */
export function calculateProgress(current, total) {
    if (!total || total <= 0) return 0;
    return Math.min((current / total) * 100, 100);
}

/**
 * Check if media is a video based on type or extension
 * @param {string} type - MIME type or file extension
 * @param {string} url - Media URL
 * @returns {boolean}
 */
export function isVideo(type, url) {
    if (type && type.startsWith('video/')) return true;
    if (type === 'video') return true;
    if (url) {
        const ext = url.split('.').pop().toLowerCase();
        return ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v'].includes(ext);
    }
    return false;
}

/**
 * Check if media is an image based on type or extension
 * @param {string} type - MIME type or file extension
 * @param {string} url - Media URL
 * @returns {boolean}
 */
export function isImage(type, url) {
    if (type && type.startsWith('image/')) return true;
    if (type === 'image') return true;
    if (url) {
        const ext = url.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
    }
    return false;
}

// ==================== PROGRESS DATA ====================

/**
 * Fetch video progress data following admin/guest/session pattern
 * Used by both gallery and streaming layouts
 * 
 * @param {number} limit - Max number of videos to fetch
 * @returns {Promise<Array>} Array of video progress objects
 * 
 * Data Flow:
 * - Active profile: server profile progress via /api/progress/videos
 * - No profile: IndexedDB via getAllVideoLocalProgress()
 */
export async function fetchVideoProgressData(limit = 500) {
    let videos = [];

    if (hasActiveProfile()) {
        try {
            const response = await fetch(`/api/progress/videos?limit=${limit}`, {
                headers: getShowHiddenHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                videos = data.videos || [];
            }
        } catch (e) {
            console.error('[LayoutUtils] Error fetching video progress:', e);
        }
    } else {
        if (!isProgressDBReady()) {
            try {
                await initProgressDB();
            } catch (e) {
                console.warn('[LayoutUtils] IndexedDB init failed:', e);
            }
        }
        videos = getAllVideoLocalProgress();
    }

    return videos;
}

/**
 * Ensure IndexedDB is ready for Guest mode.
 */
export async function ensureProgressDBReady() {
    if (!hasActiveProfile() && !isProgressDBReady()) {
        try {
            await initProgressDB();
        } catch (e) {
            console.warn('[LayoutUtils] IndexedDB init failed:', e);
        }
    }
}

/**
 * Build a video progress map from video progress data
 * @param {Array} videos - Array of video progress objects from fetchVideoProgressData
 * @returns {Object} Map of videoUrl -> {video_timestamp, video_duration}
 */
export function buildProgressMap(videos) {
    const progressMap = {};

    for (const v of videos) {
        const videoUrl = v.video_url || v.video_path;
        const timestamp = v.video_timestamp;

        if (!videoUrl || !timestamp || timestamp <= 0) continue;

        progressMap[videoUrl] = {
            video_timestamp: timestamp,
            video_duration: v.video_duration || 0
        };
    }

    return progressMap;
}

// ==================== LAYOUT SYNC WRAPPER ====================
// Provides a unified interface for sync across all layouts

/**
 * Registry of layout handlers for sync and navigation functionality
 * Each layout can register its own handlers
 */
const layoutHandlers = {
    streaming: {
        viewMedia: null,
        getCurrentState: null,
        setupNavigation: null,
        cleanupNavigation: null,
        onMediaRendered: null,
        onViewerClosed: null
    },
    gallery: {
        viewMedia: null,
        getCurrentState: null,
        setupNavigation: null,
        cleanupNavigation: null,
        onMediaRendered: null,
        onViewerClosed: null
    }
};

/**
 * Register a layout's handler set
 * @param {string} layoutId - 'streaming' or 'gallery'
 * @param {Object} handlers - Handler functions
 */
export function registerLayoutHandler(layoutId, handlers) {
    if (layoutHandlers.hasOwnProperty(layoutId)) {
        layoutHandlers[layoutId] = { ...layoutHandlers[layoutId], ...handlers };
        console.log(`[LayoutUtils] Registered/Updated handlers for layout: ${layoutId}`);
    }
}

/**
 * Get current active layout
 * @returns {string} 'streaming' or 'gallery'
 */
export function getCurrentLayout() {
    return document.documentElement.getAttribute('data-layout') || 'streaming';
}

/**
 * Call layout-specific navigation setup
 * @param {Object} socket - Socket instance
 * @param {Function} navigateFn - Navigation function (usually navigateMedia)
 */
export function setupLayoutNavigation(socket, navigateFn) {
    const layout = getCurrentLayout();
    const handler = layoutHandlers[layout];
    if (handler?.setupNavigation) {
        handler.setupNavigation(socket, navigateFn);
    }
}

/**
 * Call layout-specific navigation cleanup
 */
export function cleanupLayoutNavigation() {
    const layout = getCurrentLayout();
    const handler = layoutHandlers[layout];
    if (handler?.cleanupNavigation) {
        handler.cleanupNavigation();
    }
}

/**
 * Call layout-specific hook after media is rendered
 * @param {number} index - Current media index
 * @param {number} total - Total media items
 */
export function onLayoutMediaRendered(index, total) {
    const layout = getCurrentLayout();
    const handler = layoutHandlers[layout];
    if (handler?.onMediaRendered) {
        handler.onMediaRendered(index, total);
    }
}

/**
 * Call layout-specific hook when media viewer is closed
 */
export function onLayoutViewerClosed(categoryId = null) {
    const layout = getCurrentLayout();
    const handler = layoutHandlers[layout];
    if (handler?.onViewerClosed) {
        handler.onViewerClosed(categoryId);
    }
}

/**
 * Check if the media viewer (#media-viewer) is currently open/visible
 * The media viewer is shared across all layouts
 * @returns {boolean}
 */
export function isMediaViewerOpen() {
    const mediaViewer = $('#media-viewer');
    return mediaViewer && !mediaViewer.classList.contains('hidden');
}

/**
 * Navigate to specific media across any layout
 * This is the unified entry point for sync, slash commands, etc.
 * @param {string} categoryId - Category to navigate to
 * @param {string} mediaUrl - Optional specific media URL
 * @param {number} index - Optional media index
 * @returns {Promise<boolean>} Success status
 */
export async function navigateToMedia(categoryId, mediaUrl = null, index = 0) {
    const currentLayout = getCurrentLayout();
    const handler = layoutHandlers[currentLayout];

    // If current layout has a handler, use it
    if (handler?.viewMedia) {
        try {
            await handler.viewMedia(categoryId, mediaUrl, index);
            return true;
        } catch (err) {
            console.error(`[LayoutUtils] Layout ${currentLayout} viewMedia error:`, err);
        }
    }

    // Fallback to default mediaLoader (shared by grid layouts when opening viewer)
    if (window.ragotModules?.mediaLoader?.openCategoryViewer) {
        try {
            await window.ragotModules.mediaLoader.openCategoryViewer({
                categoryId,
                startIndex: index,
                startMediaId: mediaUrl,
            });
            return true;
        } catch (err) {
            console.error('[LayoutUtils] Default openCategoryViewer error:', err);
        }
    }

    return false;
}

/**
 * Get current sync state from the active layout
 * @returns {Object|null} { categoryId, mediaUrl, index } or null
 */
export function getCurrentMediaState() {
    const currentLayout = getCurrentLayout();
    const handler = layoutHandlers[currentLayout];

    if (handler?.getCurrentState) {
        return handler.getCurrentState();
    }

    // Fallback to shared app state service
    const appState = window.ragotModules?.appState;
    if (appState) {
        const viewer = getViewerSession(appState);
        const currentMedia = getCurrentViewerRecord(appState);
        return {
            categoryId: appState.currentCategoryId,
            mediaUrl: currentMedia?.url,
            index: viewer?.activeIndex ?? -1
        };
    }

    return null;
}

/**
 * Normalize a media URL for comparison: decode percent-encoding, strip query/hash,
 * and reduce absolute URLs to their pathname.
 * @param {string} value
 * @returns {string}
 */
function normalizeMediaUrl(value) {
    if (!value || typeof value !== 'string') return '';
    let normalized = value;
    try { normalized = decodeURIComponent(normalized); } catch (e) { /* ignore */ }
    normalized = normalized.split('#')[0].split('?')[0];
    try {
        if (/^https?:\/\//i.test(normalized)) {
            normalized = new URL(normalized).pathname;
        }
    } catch (e) { /* ignore */ }
    return normalized;
}

/**
 * Compare two media URLs for equivalence, tolerating URL-encoding differences,
 * query/hash suffixes, and absolute vs. relative forms.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function urlsMatch(a, b) {
    if (!a || !b) return false;
    const na = normalizeMediaUrl(a);
    const nb = normalizeMediaUrl(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    try { if (na === normalizeMediaUrl(encodeURI(b))) return true; } catch (e) { /* ignore */ }
    try { if (nb === normalizeMediaUrl(encodeURI(a))) return true; } catch (e) { /* ignore */ }
    return false;
}
