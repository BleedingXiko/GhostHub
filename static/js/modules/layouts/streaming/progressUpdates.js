/**
 * Progress Updates — handles real-time video progress events
 *
 * Updates continue-watching data, video progress map, and DOM progress bars
 * when a progress_update or local progress event fires.
 */

import {
    getContinueWatchingData,
    setContinueWatchingData,
    getVideoProgress,
    setVideoProgress,
    deleteVideoProgress,
    getCategoriesData
} from './state.js';
import { getActiveProfileId, hasActiveProfile } from '../../../utils/profileUtils.js';
import { createElement, append, $ } from '../../../libs/ragot.esm.min.js';
import { updateMediaCardProgressBars } from './progressBars.js';

export function handleProgressUpdate(data) {
    if (!data) return;
    const isLocalProgress = data.__localProgress === true;
    if (!isLocalProgress && !hasActiveProfile()) return;
    if (!isLocalProgress && data.profile_id && data.profile_id !== getActiveProfileId()) return;

    const { video_url: videoUrl, video_timestamp: timestamp, video_duration: duration, category_id: categoryId, thumbnail_url: thumbnailUrl } = data;
    if (!videoUrl) return;

    const urlsMatch = (a, b) => {
        if (!a || !b) return false;
        if (a === b) return true;
        try { if (decodeURIComponent(a) === decodeURIComponent(b)) return true; } catch (_) { /* ignore */ }
        try { if (a === encodeURI(b)) return true; } catch (_) { /* ignore */ }
        try { if (encodeURI(a) === b) return true; } catch (_) { /* ignore */ }
        return false;
    };

    if (data.video_progress_deleted) {
        deleteVideoProgress(videoUrl);
        const next = getContinueWatchingData().filter((item) => !item.videoUrl || !urlsMatch(item.videoUrl, videoUrl));
        setContinueWatchingData(next);
        const container = document.getElementById('streaming-container');
        if (container) {
            container.querySelectorAll('.streaming-card[data-media-url], .streaming-card[data-video-url]').forEach((card) => {
                const cardUrl = card.dataset.mediaUrl || card.dataset.videoUrl;
                if (cardUrl && urlsMatch(cardUrl, videoUrl)) {
                    const progressBar = $('.streaming-card-progress', card);
                    if (progressBar) progressBar.remove();
                }
            });
        }
        return;
    }

    if (!timestamp || timestamp <= 0) return;
    const continueWatching = [...getContinueWatchingData()];
    const existingIndex = continueWatching.findIndex((item) => item.videoUrl && urlsMatch(item.videoUrl, videoUrl));
    const existingItem = existingIndex >= 0 ? continueWatching[existingIndex] : null;
    const existingProgress = getVideoProgress(videoUrl);
    const effectiveDuration = duration > 0
        ? duration
        : existingProgress?.video_duration || existingItem?.videoDuration || 0;
    const effectiveThumbnail = thumbnailUrl || existingItem?.thumbnailUrl || videoUrl;

    setVideoProgress(videoUrl, {
        video_timestamp: timestamp,
        video_duration: effectiveDuration
    });
    updateMediaCardProgressBars();

    const categories = getCategoriesData();
    const category = categories.find((c) => c.id === categoryId);
    if (existingIndex >= 0) continueWatching.splice(existingIndex, 1);
    continueWatching.unshift({
        videoUrl, categoryId,
        categoryName: category?.name || existingItem?.categoryName || 'Unknown',
        thumbnailUrl: effectiveThumbnail,
        videoTimestamp: timestamp,
        videoDuration: effectiveDuration,
        lastWatched: Date.now() / 1000
    });
    if (continueWatching.length > 15) continueWatching.pop();
    setContinueWatchingData(continueWatching);

    const container = document.getElementById('streaming-container');
    if (!container || !effectiveDuration) return;
    container.querySelectorAll('.streaming-card[data-media-url], .streaming-card[data-video-url]').forEach((card) => {
        const cardUrl = card.dataset.mediaUrl || card.dataset.videoUrl;
        if (!cardUrl) return;
        const matches = cardUrl === videoUrl ||
            (() => { try { return decodeURIComponent(cardUrl) === videoUrl; } catch (_) { return false; } })() ||
            (() => { try { return cardUrl === decodeURIComponent(videoUrl); } catch (_) { return false; } })();
        if (matches && effectiveDuration > 0) {
            const progressPercent = Math.min((timestamp / effectiveDuration) * 100, 100);
            if (progressPercent > 0 && progressPercent < 100) {
                let progressBar = $('.streaming-card-progress', card);
                if (!progressBar) {
                    progressBar = createElement('div', { className: 'streaming-card-progress' });
                    const infoSection = $('.streaming-card-info', card);
                    if (infoSection) infoSection.parentNode.insertBefore(progressBar, infoSection);
                    else append(card, progressBar);
                }
                let fill = progressBar.firstElementChild;
                if (!fill) {
                    fill = createElement('div', { className: 'streaming-card-progress-fill' });
                    append(progressBar, fill);
                }
                fill.style.width = `${progressPercent}%`;
            }
        }
    });
}
