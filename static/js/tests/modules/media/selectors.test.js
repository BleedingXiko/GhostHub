import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../utils/showHiddenManager.js', () => ({
  getShowHiddenHeaders: vi.fn(() => ({}))
}));

vi.mock('../../../utils/requestCache.js', () => ({
  cachedFetch: vi.fn()
}));

import { mediaManifest } from '../../../modules/media/manifest.js';
import { mediaOrdering } from '../../../modules/media/ordering.js';
import {
  selectChunkRecords,
  selectIdAt,
  selectIndexOf,
  selectUnhydratedIdsInWindow,
  selectRecordAt,
  selectRecordsForView,
  selectView,
  subscribeView
} from '../../../modules/media/selectors.js';

describe('media selectors', () => {
  beforeEach(() => {
    mediaManifest.clear();
    mediaManifest._pins.clear();
    mediaManifest.failed.clear();
    mediaOrdering.orders.clear();
    mediaOrdering.setState({ version: 0 });
  });

  it('returns the canonical idle MediaView shape for unknown views', () => {
    expect(selectView('streaming_row::cat')).toMatchObject({
      viewKey: 'streaming_row::cat',
      viewType: null,
      orderedIds: [],
      status: 'idle',
      hasMore: false,
      pageToken: null,
      viewMeta: {},
      error: null
    });
  });

  it('projects records from ordering through one manifest-backed selector', () => {
    const viewKey = 'streaming_row::cat';
    mediaOrdering.orders.set(viewKey, {
      viewKey,
      viewType: 'streaming_row',
      orderedIds: ['cat::a.mp4', 'cat::b.jpg'],
      status: 'ready',
      hasMore: false,
      pageToken: null,
      viewMeta: {},
      error: null
    });
    mediaManifest.ingest({
      'cat::a.mp4': { id: 'cat::a.mp4', type: 'video', url: '/media/cat/a.mp4' },
      'cat::b.jpg': { id: 'cat::b.jpg', type: 'image', url: '/media/cat/b.jpg' }
    });

    expect(selectRecordsForView(viewKey).map((record) => record.id)).toEqual(['cat::a.mp4', 'cat::b.jpg']);
    expect(selectRecordAt(viewKey, 1)?.id).toBe('cat::b.jpg');
    expect(selectIdAt(viewKey, 0)).toBe('cat::a.mp4');
    expect(selectIndexOf(viewKey, 'cat::b.jpg')).toBe(1);
    expect(selectChunkRecords(viewKey, 0, 2, 'video').map((record) => record.id)).toEqual(['cat::a.mp4']);
  });

  it('reports unhydrated ids inside a requested window', () => {
    const viewKey = 'gallery_timeline::all';
    mediaOrdering.orders.set(viewKey, {
      viewKey,
      viewType: 'gallery_timeline',
      orderedIds: ['cat::a.mp4', 'cat::b.jpg', 'cat::c.jpg'],
      status: 'ready',
      hasMore: true,
      pageToken: '2',
      viewMeta: {},
      error: null
    });
    mediaManifest.ingest({
      'cat::a.mp4': { id: 'cat::a.mp4', url: '/media/cat/a.mp4' }
    }, ['cat::c.jpg']);

    expect(selectUnhydratedIdsInWindow(viewKey, 0, 3)).toEqual(['cat::b.jpg']);
  });

  it('notifies subscribers when subscribed ordering or hydrated records change', async () => {
    const callback = vi.fn();
    const viewKey = 'streaming_row::cat';
    const unsubscribe = subscribeView(viewKey, callback);

    mediaOrdering.ingestView(viewKey, {
      viewType: 'streaming_row',
      orderedIds: ['cat::a.mp4'],
      status: 'ready'
    });
    mediaManifest.ingest({
      'cat::a.mp4': { id: 'cat::a.mp4', url: '/media/cat/a.mp4' }
    });
    await Promise.resolve();

    expect(callback).toHaveBeenCalled();
    unsubscribe();
  });

  it('registers owner cleanup for view subscriptions', async () => {
    const cleanupFns = [];
    const owner = {
      addCleanup(fn) {
        cleanupFns.push(fn);
      }
    };
    const callback = vi.fn();
    const viewKey = 'streaming_row::owned';

    subscribeView(viewKey, callback, { owner });

    expect(cleanupFns).toHaveLength(1);
    cleanupFns[0]();

    mediaOrdering.ingestView(viewKey, {
      viewType: 'streaming_row',
      orderedIds: ['cat::owned.mp4'],
      status: 'ready'
    });
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
  });
});
