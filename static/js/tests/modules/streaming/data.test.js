import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildContinueWatchingData,
  fetchCategories,
  fetchAllCategoryMedia,
  fetchCategoryMedia,
  fetchCategoryMediaBatch,
  fetchNewestMedia,
  primeCategoryLoadingShells,
  getCategoryProgress
} from '../../../modules/layouts/streaming/mediaDataSource.js';
import { selectRecordsForView } from '../../../modules/media/selectors.js';

import { getCategoryView, streamingState } from '../../../modules/layouts/streaming/state.js';
import * as layoutUtils from '../../../utils/layoutUtils.js';
import * as progressDB from '../../../utils/progressDB.js';
import * as profileUtils from '../../../utils/profileUtils.js';
import * as requestCache from '../../../utils/requestCache.js';
import * as progressPersistence from '../../../modules/media/progressPersistence.js';

// Mock dependencies
vi.mock('../../../utils/layoutUtils.js', () => ({
  fetchVideoProgressData: vi.fn(),
  ensureProgressDBReady: vi.fn()
}));

vi.mock('../../../utils/progressDB.js', () => ({
  getLocalProgress: vi.fn()
}));

vi.mock('../../../utils/profileUtils.js', () => ({
  hasActiveProfile: vi.fn(() => false)
}));

vi.mock('../../../utils/showHiddenManager.js', () => ({
  getShowHiddenHeaders: vi.fn(() => ({})),
  appendShowHiddenParam: vi.fn(url => url)
}));

vi.mock('../../../utils/requestCache.js', () => ({
  cachedFetch: vi.fn()
}));

vi.mock('../../../modules/media/progressPersistence.js', () => ({
  isPendingDeletion: vi.fn()
}));

describe('Streaming Layout Data Fetching & Processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton state
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
      whatsNewViewKey: null
    });
    const orderPayload = {
      orderedIds: ['cat-123::one.mp4', 'cat-123::two.jpg'],
      records: {
        'cat-123::one.mp4': { id: 'cat-123::one.mp4', categoryId: 'cat-123', relPath: 'one.mp4', name: 'one.mp4', type: 'video', url: '/media/cat-123/one.mp4' },
        'cat-123::two.jpg': { id: 'cat-123::two.jpg', categoryId: 'cat-123', relPath: 'two.jpg', name: 'two.jpg', type: 'image', url: '/media/cat-123/two.jpg' }
      },
      missing: [],
      hasMore: true,
      viewMeta: {
        total: 100,
        subfolders: ['folder1'],
        asyncIndexing: false,
        indexingProgress: 100
      }
    };
    window.ragotModules = {
      mediaOrdering: {
        requestOrder: vi.fn().mockResolvedValue(orderPayload),
        ingestView: vi.fn(),
        getOrder: vi.fn(() => orderPayload),
        state: { version: 1 },
        subscribe: vi.fn(() => () => {})
      },
      mediaManifest: {
        pin: vi.fn(),
        ingest: vi.fn(),
        hydrate: vi.fn().mockResolvedValue([]),
        get: vi.fn((id) => ({
          id,
          url: `/media/${id}`,
          name: id.split('::').pop(),
          categoryId: id.split('::')[0],
          type: id.endsWith('.jpg') ? 'image' : 'video'
        })),
        getMany: vi.fn((ids) => ids.map((id) => window.ragotModules.mediaManifest.get(id)).filter(Boolean)),
        has: vi.fn(() => false),
        isMissing: vi.fn(() => false),
        subscribe: vi.fn(() => () => {}),
        recordsVersion: 1
      }
    };
  });

  describe('buildContinueWatchingData', () => {
    it('should correctly parse and sort continue watching data, avoiding duplicates', async () => {
      // Setup base categories
      streamingState.setState({
        categoriesData: [{ id: 'cat1', name: 'Movies' }, { id: 'cat2', name: 'TV Shows' }]
      });

      // Mock fetched DB videos
      layoutUtils.fetchVideoProgressData.mockResolvedValue([
        { video_url: 'movieA.mp4', category_id: 'cat1', video_timestamp: 100, last_watched: 50 },
        { video_url: 'movieA.mp4', category_id: 'cat1', video_timestamp: 200, last_watched: 100 }, // Duplicate URL, newer last_watched
        { video_url: 'tvshowB.mp4', category_id: 'cat2', video_timestamp: 300, last_watched: 75 }
      ]);

      progressPersistence.isPendingDeletion.mockReturnValue(false);

      await buildContinueWatchingData(false);

      const cwData = streamingState.state.continueWatchingData;

      // Should have 2 items (movieA merged, tvshowB)
      expect(cwData.length).toBe(2);

      // Should be sorted descending by last_watched
      expect(cwData[0].videoUrl).toBe('movieA.mp4'); // last_watched: 100
      expect(cwData[0].videoTimestamp).toBe(200); // the newer one was adopted
      expect(cwData[0].categoryName).toBe('Movies');

      expect(cwData[1].videoUrl).toBe('tvshowB.mp4'); // last_watched: 75
      expect(cwData[1].categoryName).toBe('TV Shows');

      // videoProgressMap should be populated
      const progressMap = streamingState.state.videoProgressMap;
      expect(progressMap['movieA.mp4'].video_timestamp).toBe(200);
      expect(progressMap['tvshowB.mp4'].video_timestamp).toBe(300);
    });

    it('should skip videos marked for pending deletion', async () => {
      layoutUtils.fetchVideoProgressData.mockResolvedValue([
        { video_url: 'movieC.mp4', category_id: 'cat1', video_timestamp: 100, last_watched: 50 }
      ]);

      // This mock makes it so the video is considered "completed/deleting"
      progressPersistence.isPendingDeletion.mockReturnValue(true);

      await buildContinueWatchingData(false);

      // CW list should be empty because it skipped movieC
      expect(streamingState.state.continueWatchingData.length).toBe(0);
    });

    it('keeps the previous CW snapshot visible while an async refresh is still running', async () => {
      let resolveFetch;
      const existingItem = {
        videoUrl: 'existing.mp4',
        categoryId: 'cat1',
        categoryName: 'Movies',
        thumbnailUrl: 'existing.jpg',
        videoTimestamp: 25,
        videoDuration: 100,
        lastWatched: 10
      };

      streamingState.setState({
        categoriesData: [{ id: 'cat1', name: 'Movies' }],
        continueWatchingData: [existingItem],
        videoProgressMap: {
          'existing.mp4': { video_timestamp: 25, video_duration: 100 }
        }
      });

      layoutUtils.fetchVideoProgressData.mockReturnValue(new Promise((resolve) => {
        resolveFetch = resolve;
      }));
      progressPersistence.isPendingDeletion.mockReturnValue(false);

      const refreshPromise = buildContinueWatchingData(true);

      expect(streamingState.state.continueWatchingLoading).toBe(true);
      expect(streamingState.state.continueWatchingData).toEqual([existingItem]);
      expect(streamingState.state.videoProgressMap).toEqual({
        'existing.mp4': { video_timestamp: 25, video_duration: 100 }
      });

      resolveFetch([
        { video_url: 'fresh.mp4', category_id: 'cat1', video_timestamp: 40, video_duration: 120, last_watched: 20 }
      ]);
      await refreshPromise;

      expect(streamingState.state.continueWatchingLoading).toBe(false);
      expect(streamingState.state.continueWatchingData[0].videoUrl).toBe('fresh.mp4');
      expect(streamingState.state.videoProgressMap).toEqual({
        'fresh.mp4': { video_timestamp: 40, video_duration: 120 }
      });
    });
  });

  describe('getCategoryProgress', () => {
    it('should return server data when an active profile exists', () => {
      profileUtils.hasActiveProfile.mockReturnValue(true);

      const categoryItem = {
        id: 'item1',
        saved_index: 5,
        video_timestamp: 120,
        video_duration: 600,
        thumbnailUrl: 'thumb.jpg'
      };

      const result = getCategoryProgress(categoryItem);
      expect(result.savedIndex).toBe(5);
      expect(result.videoTimestamp).toBe(120);
    });

    it('should override with local progress when no active profile exists', () => {
      profileUtils.hasActiveProfile.mockReturnValue(false);
      progressDB.getLocalProgress.mockReturnValue({
        index: 8,
        video_timestamp: 300,
        video_duration: 600,
        thumbnail_url: 'local_thumb.jpg'
      });

      const categoryItem = {
        id: 'item2',
        saved_index: 2,
        video_timestamp: 50,
        video_duration: 600
      };

      const result = getCategoryProgress(categoryItem);

      // Should take the values from localProgress instead of categoryItem
      expect(result.savedIndex).toBe(8);
      expect(result.videoTimestamp).toBe(300);
      expect(result.thumbnailUrl).toBe('local_thumb.jpg');
    });
  });

  describe('fetchCategoryMedia', () => {
    it('should request ordering and hydrate records for subfolders and pagination', async () => {
      const result = await fetchCategoryMedia('cat-123', 2, false, 'Movies/Action', { includeTotal: true });

      expect(result.orderedIds.length).toBe(2);
      expect(result.hasMore).toBe(true);
      expect(result.subfolders).toContain('folder1');
      expect(result.total).toBe(100);

      expect(window.ragotModules.mediaOrdering.requestOrder).toHaveBeenCalledWith(
        expect.stringContaining('subfolder_grid::cat-123::Movies/Action'),
        'subfolder_grid',
        expect.objectContaining({
          category_id: 'cat-123',
          page: 2,
          subfolder: 'Movies/Action',
          media_filter: 'all',
          hydrate: 'true'
        }),
        expect.any(Object)
      );
      expect(window.ragotModules.mediaManifest.hydrate).toHaveBeenCalledWith([
        'cat-123::one.mp4',
        'cat-123::two.jpg'
      ]);
    });

    it('projects ordered ids through shared selectors', () => {
      const viewKey = 'streaming_row::cat-123::::all::20';
      window.ragotModules.mediaManifest.recordsVersion = 1;

      const records = selectRecordsForView(viewKey);

      expect(records).toHaveLength(2);
      expect(window.ragotModules.mediaManifest.getMany).toHaveBeenCalledWith([
        'cat-123::one.mp4',
        'cat-123::two.jpg'
      ]);
    });

    it('should fall back gracefully if the API fails', async () => {
      window.ragotModules.mediaOrdering.requestOrder.mockRejectedValue(new Error('boom'));

      const result = await fetchCategoryMedia('cat-404', 1);

      expect(result.orderedIds).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.total).toBeNull();
    });

    it('bypasses client request dedupe on visibility refresh without adding force_refresh', async () => {
      const result = await fetchCategoryMedia('cat-123', 1, false, null, { bypassClientCache: true });

      expect(result.orderedIds).toHaveLength(2);
      expect(requestCache.cachedFetch).not.toHaveBeenCalled();
      expect(window.ragotModules.mediaOrdering.requestOrder.mock.calls[0][3]).toEqual(
        expect.objectContaining({ bypassClientCache: true })
      );
      expect(window.ragotModules.mediaOrdering.requestOrder.mock.calls[0][2].force_refresh).toBe('false');
    });
  });

  describe('fetchCategoryMediaBatch', () => {
    it('posts one batch request and ingests each returned view', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{
            viewKey: 'streaming_row::cat-123::::all::20',
            orderedIds: ['cat-123::one.mp4'],
            records: {
              'cat-123::one.mp4': { id: 'cat-123::one.mp4', categoryId: 'cat-123', relPath: 'one.mp4' }
            },
            missing: [],
            hasMore: false,
            viewMeta: { subfolders: [] },
            status: 'ready'
          }]
        })
      });

      const result = await fetchCategoryMediaBatch([{
        viewType: 'streaming_row',
        viewKey: 'streaming_row::cat-123::::all::20',
        params: { view: 'streaming_row', category_id: 'cat-123', hydrate: 'true' }
      }]);

      expect(global.fetch).toHaveBeenCalledWith('/api/media/orders', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requests: [{ view: 'streaming_row', category_id: 'cat-123', hydrate: 'true' }] })
      }));
      expect(window.ragotModules.mediaManifest.ingest).toHaveBeenCalledWith(
        { 'cat-123::one.mp4': { id: 'cat-123::one.mp4', categoryId: 'cat-123', relPath: 'one.mp4' } },
        []
      );
      expect(window.ragotModules.mediaOrdering.ingestView).toHaveBeenCalledWith(
        'streaming_row::cat-123::::all::20',
        expect.objectContaining({ orderedIds: ['cat-123::one.mp4'], status: 'ready' })
      );
      expect(result[0].orderedIds).toEqual(['cat-123::one.mp4']);
    });

    it('does not ingest or pin failed batch items', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{
            viewKey: 'streaming_row::cat-123::::all::20',
            orderedIds: [],
            records: { stale: { id: 'stale' } },
            missing: [],
            status: 'error',
            error: 'bad request'
          }]
        })
      });

      const result = await fetchCategoryMediaBatch([{
        viewType: 'streaming_row',
        viewKey: 'streaming_row::cat-123::::all::20',
        params: { view: 'streaming_row', category_id: 'cat-123', hydrate: 'true' }
      }]);

      expect(window.ragotModules.mediaManifest.ingest).not.toHaveBeenCalled();
      expect(window.ragotModules.mediaManifest.pin).not.toHaveBeenCalled();
      expect(window.ragotModules.mediaOrdering.ingestView).not.toHaveBeenCalled();
      expect(result[0].status).toBe('error');
      expect(result[0].viewKey).toBe('streaming_row::cat-123::::all::20');
    });
  });

  describe('fetchCategories', () => {
    it('drops stale category view metadata during category-list refreshes', async () => {
      streamingState.setState({
        categoriesData: [
          { id: 'cat-live', name: 'Live USB', viewKey: 'view-a', viewPage: 1, viewHasMore: false, viewStatus: 'ready', viewSubfolder: '', viewMediaFilter: 'all', subfolders: [] },
          { id: 'cat-stale', name: 'Removed USB', viewKey: 'view-b', viewPage: 1, viewHasMore: false, viewStatus: 'ready', viewSubfolder: '', viewMediaFilter: 'all', subfolders: [] }
        ]
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          categories: [{ id: 'cat-live', name: 'Live USB' }],
          pagination: { total: 1, totalPages: 1, hasMore: false }
        })
      });

      const categories = await fetchCategories(true, {
        bypassClientCache: true,
        pruneMissingCategories: true
      });

      expect(categories).toEqual([{ id: 'cat-live', name: 'Live USB' }]);
      expect(streamingState.state.categoriesData).toEqual([
        {
          id: 'cat-live',
          name: 'Live USB',
          viewKey: 'streaming_row::cat-live::::all::20',
          viewPage: 1,
          viewHasMore: false,
          viewStatus: 'ready',
          viewSubfolder: '',
          viewMediaFilter: 'all',
          subfolders: []
        }
      ]);
      expect(getCategoryView('cat-stale', null, 'all')).toBeNull();
    });
  });

  describe('fetchAllCategoryMedia', () => {
    it('leaves an uncached single-category subfolder view untouched when the batch load fails', async () => {
      streamingState.setState({
        categoriesData: [{ id: 'cat-123', name: 'Movies' }],
        categoryIdFilter: 'cat-123',
        subfolderFilter: 'Movies/Action',
        mediaFilter: 'all'
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('boom'));

      await fetchAllCategoryMedia(false);

      expect(getCategoryView('cat-123', 'Movies/Action', 'all')).toBeNull();
    });
  });

  describe('primeCategoryLoadingShells', () => {
    it('creates fetching cache entries for categories that do not have a row cache yet', () => {
      streamingState.setState({
        categoriesData: [{ id: 'cat-1', name: 'Movies' }, { id: 'cat-2', name: 'Shows' }],
        mediaFilter: 'all'
      });

      primeCategoryLoadingShells();

      expect(getCategoryView('cat-1', null, 'all')).toEqual({
        orderedIds: [],
        viewKey: null,
        page: 1,
        hasMore: false,
        status: 'fetching',
        subfolders: [],
        asyncIndexing: false,
        indexingProgress: 0
      });
      expect(getCategoryView('cat-2', null, 'all')).toEqual({
        orderedIds: [],
        viewKey: null,
        page: 1,
        hasMore: false,
        status: 'fetching',
        subfolders: [],
        asyncIndexing: false,
        indexingProgress: 0
      });
    });
  });

  describe('fetchNewestMedia', () => {
    it('preserves the previous row snapshot while the latest media refresh is pending', async () => {
      let resolveOrder;
      const previousMedia = [{ id: 'old-1', name: 'Old upload' }];
      streamingState.setState({ whatsNewData: previousMedia });

      window.ragotModules.mediaOrdering.requestOrder.mockReturnValue(new Promise((resolve) => {
        resolveOrder = resolve;
      }));

      const refreshPromise = fetchNewestMedia(10, true);

      expect(streamingState.state.whatsNewLoading).toBe(true);
      expect(streamingState.state.whatsNewData).toEqual(previousMedia);

      const newestOrder = {
        orderedIds: ['cat-123::new-1.mp4'],
        records: {},
        missing: [],
        hasMore: false,
        viewMeta: {}
      };
      window.ragotModules.mediaOrdering.getOrder.mockReturnValue(newestOrder);
      resolveOrder(newestOrder);

      await refreshPromise;

      expect(window.ragotModules.mediaOrdering.requestOrder).toHaveBeenCalledWith(
        'whats_new::all::10',
        'whats_new',
        { limit: 10, media_filter: 'all', hydrate: 'true' },
        { bypassClientCache: true }
      );
      expect(window.ragotModules.mediaManifest.pin).toHaveBeenCalledWith(
        'whats_new::all::10',
        ['cat-123::new-1.mp4']
      );
      expect(window.ragotModules.mediaManifest.hydrate).toHaveBeenCalledWith(['cat-123::new-1.mp4']);
      expect(streamingState.state.whatsNewLoading).toBe(false);
      expect(streamingState.state.whatsNewViewKey).toBe('whats_new::all::10');
      expect(streamingState.state.whatsNewData).toEqual([expect.objectContaining({ id: 'cat-123::new-1.mp4' })]);
    });
  });
});
