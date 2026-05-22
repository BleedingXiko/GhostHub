/**
 * Streaming State Module Unit Tests
 *
 * Covers the real exports from streaming/state.js, not local plain-object
 * scaffolds. Verifies setState behavior on the singleton StreamingStateModule,
 * the per-category view metadata helpers (getCategoryView/setCategoryView/
 * pruneCategoryViews), and the URL-rename helpers used after file moves.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  streamingState,
  setCategoryView,
  getCategoryView,
  updateCategoryView,
  clearCategoryViews,
  pruneCategoryViews,
  setVideoProgress,
  getVideoProgress,
  deleteVideoProgress,
  clearVideoProgressMap,
  updateContinueWatchingVideoUrl,
  updateVideoProgressMapUrl,
  MAX_CONTINUE_WATCHING,
  MEDIA_PER_PAGE
} from '../../../modules/layouts/streaming/state.js';

function resetState() {
  streamingState.setState({
    categoriesData: [],
    continueWatchingData: [],
    whatsNewData: [],
    videoProgressMap: {},
    continueWatchingLoading: false,
    whatsNewLoading: false,
    mediaFilter: 'all',
    categoryIdFilter: null,
    subfolderFilter: null,
    parentNameFilter: null,
    categoryIdsFilter: null,
    isLoading: false
  });
}

describe('Streaming State', () => {
  beforeEach(resetState);
  afterEach(resetState);

  describe('constants', () => {
    it('exports MEDIA_PER_PAGE and MAX_CONTINUE_WATCHING', () => {
      expect(typeof MEDIA_PER_PAGE).toBe('number');
      expect(typeof MAX_CONTINUE_WATCHING).toBe('number');
    });
  });

  describe('category view metadata', () => {
    beforeEach(() => {
      streamingState.setState({
        categoriesData: [
          { id: 'cat-a', name: 'A' },
          { id: 'cat-b', name: 'B' }
        ]
      });
    });

    it('stores and reads back per-category view metadata under the matching subfolder/filter pair', () => {
      setCategoryView('cat-a', {
        viewKey: 'streaming_row::cat-a',
        page: 1,
        hasMore: true,
        status: 'ready',
        subfolders: [{ name: 'Season 1' }],
        asyncIndexing: false,
        indexingProgress: 0
      }, null, 'all');

      const view = getCategoryView('cat-a', null, 'all');
      expect(view).toBeTruthy();
      expect(view.viewKey).toBe('streaming_row::cat-a');
      expect(view.page).toBe(1);
      expect(view.hasMore).toBe(true);
      expect(view.subfolders).toEqual([{ name: 'Season 1' }]);
    });

    it('returns null when the requested subfolder or media filter does not match the stored view', () => {
      setCategoryView('cat-a', { viewKey: 'vk', page: 1, hasMore: false, status: 'ready' }, 'Season 1', 'all');

      expect(getCategoryView('cat-a', null, 'all')).toBeNull();
      expect(getCategoryView('cat-a', 'Season 1', 'video')).toBeNull();
      expect(getCategoryView('cat-a', 'Season 1', 'all')).not.toBeNull();
    });

    it('merges patches into an existing view via updateCategoryView', () => {
      setCategoryView('cat-a', { viewKey: 'vk', page: 1, hasMore: true, status: 'ready' }, null, 'all');
      updateCategoryView('cat-a', { page: 2, hasMore: false }, null, 'all');

      const view = getCategoryView('cat-a', null, 'all');
      expect(view.page).toBe(2);
      expect(view.hasMore).toBe(false);
      expect(view.viewKey).toBe('vk');
    });

    it('clears per-row view UI hints while preserving viewKey identity', () => {
      setCategoryView('cat-a', { viewKey: 'vk-a', page: 2, hasMore: true, status: 'ready' }, null, 'all');
      setCategoryView('cat-b', { viewKey: 'vk-b', page: 3, hasMore: true, status: 'ready' }, null, 'all');

      clearCategoryViews();

      // viewKey-identity is preserved (so CategoryRowsContainer fingerprint stays
      // stable and rows don't unmount/remount), but page/hasMore/status reset.
      const viewA = getCategoryView('cat-a', null, 'all');
      const viewB = getCategoryView('cat-b', null, 'all');
      expect(viewA).not.toBeNull();
      expect(viewA.viewKey).toBe('vk-a');
      expect(viewA.page).toBe(1);
      expect(viewA.hasMore).toBe(false);
      expect(viewA.status).toBe('idle');
      expect(viewB).not.toBeNull();
      expect(viewB.viewKey).toBe('vk-b');
      expect(streamingState.state.categoriesData.map((c) => c.id)).toEqual(['cat-a', 'cat-b']);
    });

    it('pruneCategoryViews strips per-row UI hints for any category not in the keep list', () => {
      setCategoryView('cat-a', { viewKey: 'vk-a', page: 4, hasMore: true, status: 'ready' }, null, 'all');
      setCategoryView('cat-b', { viewKey: 'vk-b', page: 5, hasMore: true, status: 'ready' }, null, 'all');

      pruneCategoryViews(['cat-a']);

      // cat-a retains its hints; cat-b keeps viewKey identity but is reset.
      const viewA = getCategoryView('cat-a', null, 'all');
      const viewB = getCategoryView('cat-b', null, 'all');
      expect(viewA).not.toBeNull();
      expect(viewA.page).toBe(4);
      expect(viewA.status).toBe('ready');
      expect(viewB).not.toBeNull();
      expect(viewB.viewKey).toBe('vk-b');
      expect(viewB.page).toBe(1);
      expect(viewB.status).toBe('idle');
    });
  });

  describe('videoProgressMap helpers', () => {
    it('round-trips entries via setVideoProgress / getVideoProgress', () => {
      setVideoProgress('/media/cat/a.mp4', { video_timestamp: 30, video_duration: 120 });
      expect(getVideoProgress('/media/cat/a.mp4')).toEqual({ video_timestamp: 30, video_duration: 120 });
    });

    it('deletes the entry under its canonical url and any url-encoded sibling', () => {
      setVideoProgress('/media/cat/a%20b.mp4', { video_timestamp: 10, video_duration: 60 });
      deleteVideoProgress('/media/cat/a b.mp4');
      expect(streamingState.state.videoProgressMap['/media/cat/a%20b.mp4']).toBeUndefined();
    });

    it('clearVideoProgressMap empties the slice', () => {
      setVideoProgress('/x.mp4', { video_timestamp: 1, video_duration: 2 });
      clearVideoProgressMap();
      expect(streamingState.state.videoProgressMap).toEqual({});
    });
  });

  describe('rename helpers', () => {
    it('renames continue-watching entries when a file is moved', () => {
      streamingState.setState({
        continueWatchingData: [
          { videoUrl: '/media/cat/old.mp4', categoryId: 'cat' },
          { videoUrl: '/media/cat/other.mp4', categoryId: 'cat' }
        ]
      });

      updateContinueWatchingVideoUrl('/media/cat/old.mp4', '/media/cat/new.mp4');

      const urls = streamingState.state.continueWatchingData.map((item) => item.videoUrl);
      expect(urls).toEqual(['/media/cat/new.mp4', '/media/cat/other.mp4']);
    });

    it('moves a videoProgressMap entry under the new URL key', () => {
      setVideoProgress('/media/cat/old.mp4', { video_timestamp: 50 });
      updateVideoProgressMapUrl('/media/cat/old.mp4', '/media/cat/new.mp4');
      expect(streamingState.state.videoProgressMap['/media/cat/new.mp4']).toEqual({ video_timestamp: 50 });
      expect(streamingState.state.videoProgressMap['/media/cat/old.mp4']).toBeUndefined();
    });

    it('is a no-op when the old URL is not present', () => {
      setVideoProgress('/media/cat/x.mp4', { video_timestamp: 5 });
      const before = { ...streamingState.state.videoProgressMap };
      updateVideoProgressMapUrl('/media/cat/missing.mp4', '/media/cat/replaced.mp4');
      expect(streamingState.state.videoProgressMap).toEqual(before);
    });
  });
});
