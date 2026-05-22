/**
 * Shared Thumbnail Progress Lifecycle
 *
 * Encapsulates the global "generating thumbnails" notification banner that
 * both the streaming and gallery layouts display while thumbnails are being
 * produced server-side.
 *
 * Usage:
 *   const tracker = createThumbnailProgressTracker({
 *       label: 'StreamingLayout',
 *       getProcessingCategories,   // () => Array of category objects to seed polling
 *       onThumbnailReady,          // optional: (statusData) => void — called when a thumb is done
 *       notificationClass,         // CSS class for the notification element (default provided)
 *       createNotificationEl,      // optional: () => HTMLElement — custom factory
 *   });
 *
 *   tracker.init();       // call after layout is rendered
 *   tracker.cleanup();    // call in layout cleanup
 *
 * Lifecycle ownership:
 *   - The Module owns the ThumbnailProgress global callback registration (via addCleanup).
 *   - Polling is stopped in cleanup via addCleanup.
 *   - The notification DOM element is removed in cleanup via addCleanup.
 *   - Module.stop() fires all of the above automatically.
 */

import ThumbnailProgress from '../../shared/thumbnailProgress.js';
import { Module } from '../../../libs/ragot.esm.min.js';
import { showStatusLane, hideStatusLane } from '../../../utils/statusLane.js';

const THUMBNAIL_STATUS_KEY = 'thumbnail-generation';
const RATE_WINDOW_MS = 12000;

/**
 * Create a self-contained thumbnail progress tracker for a layout.
 *
 * @param {Object} opts
 * @param {string} opts.label - Name used in console logs (e.g. 'StreamingLayout')
 * @param {Function} opts.getProcessingCategories - Returns array of category objects with `.id` to seed polling
 * @param {Function} [opts.onThumbnailReady] - Called with statusData when a category finishes
 * @returns {{ init: Function, cleanup: Function }}
 */
export function createThumbnailProgressTracker({
    label,
    getProcessingCategories,
    onThumbnailReady = null,
}) {
    // Module instance that owns all resources for this tracker.
    // Created fresh each time init() is called, destroyed in cleanup().
    let trackerModule = null;

    // Progress state — lives inside the closure, reset on each init
    // categoryId -> { status, processed, total, committedTotal, progress }
    let activeCategories = new Map();
    let inProgressCount = 0;
    let throughputSamples = [];

    // ── Progress display ──────────────────────────────────────────────────────

    function recordThroughputSample(previousStatus, nextStatus) {
        if (!previousStatus || !nextStatus) return;

        const nextProcessed = Number(nextStatus.processed || 0);
        const prevProcessed = Number(previousStatus.processed || 0);
        const nextTimestamp = Number(nextStatus.timestamp || Date.now());
        const prevTimestamp = Number(previousStatus.timestamp || 0);
        const processedDelta = nextProcessed - prevProcessed;
        const elapsedMs = nextTimestamp - prevTimestamp;

        if (processedDelta <= 0 || elapsedMs <= 0) return;

        throughputSamples.push({
            timestamp: nextTimestamp,
            processedDelta,
            elapsedMs
        });
    }

    function getCurrentRate() {
        const cutoff = Date.now() - RATE_WINDOW_MS;
        throughputSamples = throughputSamples.filter((sample) => sample.timestamp >= cutoff);
        if (throughputSamples.length === 0) return 0;

        const totalProcessed = throughputSamples.reduce((sum, sample) => sum + sample.processedDelta, 0);
        const totalElapsedMs = throughputSamples.reduce((sum, sample) => sum + sample.elapsedMs, 0);

        if (totalProcessed <= 0 || totalElapsedMs <= 0) return 0;
        return totalProcessed / (totalElapsedMs / 1000);
    }

    function formatRate(rate) {
        if (!Number.isFinite(rate) || rate <= 0) return null;
        const decimals = rate >= 10 ? 0 : 1;
        return `${rate.toFixed(decimals)} thumbnails/sec`;
    }

    function updateDisplay() {
        if (activeCategories.size === 0) {
            hideStatusLane(THUMBNAIL_STATUS_KEY);
            return;
        }

        let totalProcessed = 0;
        activeCategories.forEach(s => {
            totalProcessed += s.processed || 0;
        });

        const rate = formatRate(getCurrentRate());
        const metaParts = [];
        if (rate) metaParts.push(rate);
        metaParts.push(`${totalProcessed} generated`);

        showStatusLane(THUMBNAIL_STATUS_KEY, {
            group: 'library-processing',
            title: 'Generating thumbnails',
            meta: metaParts.join(' • '),
            tone: 'info',
            busy: true,
            priority: 20
        });
    }

    // ── Global callback ───────────────────────────────────────────────────────

    function handleGlobalCallback({ categoryId, statusData }) {
        if (!categoryId || !statusData) return;

        const existing = activeCategories.get(categoryId);
        const isGenerating = statusData.status === 'generating' || statusData.status === 'pending';
        const isDone = statusData.status === 'complete' || statusData.status === 'idle' || statusData.status === 'error';

        if (isGenerating) {
            recordThroughputSample(existing, statusData);

            if (!existing || (existing.status !== 'generating' && existing.status !== 'pending')) {
                inProgressCount++;
                activeCategories.set(categoryId, {
                    ...statusData,
                    // Only commit total when > 0; keep existing committedTotal if we already have one
                    committedTotal: statusData.total > 0 ? statusData.total : (existing?.committedTotal || 0)
                });
            } else {
                // Update numbers, preserve committed total so denominator never shrinks
                const newCommittedTotal = statusData.total > existing.committedTotal
                    ? statusData.total
                    : existing.committedTotal;
                activeCategories.set(categoryId, {
                    ...statusData,
                    committedTotal: newCommittedTotal
                });
            }
        } else if (isDone) {
            if (existing) {
                if (existing.status === 'generating' || existing.status === 'pending') {
                    inProgressCount = Math.max(0, inProgressCount - 1);
                }
                // Pin processed at committedTotal so the overall % reaches exactly 100
                activeCategories.set(categoryId, {
                    ...statusData,
                    processed: existing.committedTotal,
                    total: existing.committedTotal,
                    committedTotal: existing.committedTotal,
                    progress: 100
                });
            }

            // Use inProgressCount as the sole authority — ThumbnailProgress state may
            // still show the category for up to 5 seconds after completion.
            if (inProgressCount === 0) {
                activeCategories.clear();
                throughputSamples = [];
                hideStatusLane(THUMBNAIL_STATUS_KEY);
                if (typeof onThumbnailReady === 'function' && statusData.thumbnailUrl && statusData.mediaUrl) {
                    onThumbnailReady(statusData);
                }
                return;
            }
        }

        if (typeof onThumbnailReady === 'function' && isDone && statusData.thumbnailUrl && statusData.mediaUrl) {
            onThumbnailReady(statusData);
        }

        updateDisplay();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function init() {
        // Tear down any previous run (e.g. refresh() calling init() again)
        cleanup();

        // Create a fresh Module to own all resources
        trackerModule = new Module();
        trackerModule.start();

        // Initialize ThumbnailProgress utility with socket if available
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
        if (socket && !ThumbnailProgress.initialized) {
            ThumbnailProgress.init(socket);
        }

        // Register global callback — cleanup registered via Module.addCleanup
        const unregister = ThumbnailProgress.registerGlobalCallback(handleGlobalCallback);
        trackerModule.addCleanup(unregister);

        // Poll for categories the server reports as actively generating
        const processing = getProcessingCategories();
        processing.forEach(cat => {
            if (cat?.id) ThumbnailProgress.startPolling(cat.id);
        });

        // Stop all polling and remove notification when the module is stopped
        trackerModule.addCleanup(() => {
            ThumbnailProgress.stopAllPolling();
            activeCategories.clear();
            inProgressCount = 0;
            throughputSamples = [];
            hideStatusLane(THUMBNAIL_STATUS_KEY);
        });

        updateDisplay();
        console.log(`[${label}] Thumbnail progress tracking initialized`);
    }

    function cleanup() {
        if (trackerModule) {
            trackerModule.stop();
            trackerModule = null;
        }
        console.log(`[${label}] Thumbnail progress tracking cleaned up`);
    }

    return { init, cleanup };
}
