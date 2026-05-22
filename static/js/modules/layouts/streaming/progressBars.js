/**
 * Streaming Layout - Card Progress Bar Updates
 *
 * Throttled RAF-scheduled sweep that updates `.streaming-card-progress` fills
 * for every visible video card using the current videoProgressMap. Used after
 * the viewer closes to refresh card progress without remounting any rows.
 */

import { calculateProgress } from '../../../utils/layoutUtils.js';
import { updateCardProgress } from './cards.js';
import { getVideoProgressMap } from './state.js';

const _state = (() => {
    let rafId = null;
    return {
        schedule() {
            if (rafId) return;
            rafId = requestAnimationFrame(() => { rafId = null; _flush(); });
        },
        cancel() {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        }
    };
})();

export function updateMediaCardProgressBars() { _state.schedule(); }
export function cancelMediaCardProgressBars() { _state.cancel(); }

function _flush() {
    const container = document.getElementById('streaming-container');
    if (!container) return;
    const vpm = getVideoProgressMap() || {};
    container.querySelectorAll('.streaming-card[data-media-url], .streaming-card[data-video-url]').forEach((card) => {
        const url = card.dataset.mediaUrl || card.dataset.videoUrl;
        if (!url) return;
        let p = vpm[url];
        if (!p) { try { p = vpm[encodeURI(url)]; } catch (_) { /* ignore */ } }
        if (!p) { try { p = vpm[decodeURIComponent(url)]; } catch (_) { /* ignore */ } }
        if (p && p.video_timestamp > 0 && p.video_duration > 0) {
            updateCardProgress(card, calculateProgress(p.video_timestamp, p.video_duration));
        }
    });
}
