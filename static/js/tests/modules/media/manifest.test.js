import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getManifestRecordBudget, MediaManifestModule } from '../../../modules/media/manifest.js';

vi.mock('../../../utils/showHiddenManager.js', () => ({
  getShowHiddenHeaders: vi.fn(() => ({}))
}));

describe('MediaManifestModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses deterministic monotonic LRU touches', () => {
    const manifest = new MediaManifestModule();

    manifest._touch('cat::a.mp4');
    manifest._touch('cat::b.mp4');

    expect(manifest._lru.get('cat::b.mp4')).toBeGreaterThan(manifest._lru.get('cat::a.mp4'));
  });

  it('does not publish state updates for unchanged pins', () => {
    const manifest = new MediaManifestModule();
    const spy = vi.spyOn(manifest, 'setState');

    manifest.pin('view::cat', ['cat::a.mp4']);
    manifest.pin('view::cat', ['cat::a.mp4']);

    expect(spy).not.toHaveBeenCalled();
  });

  it('increments recordsVersion only when records or missing ids change', () => {
    const manifest = new MediaManifestModule();

    manifest.pin('view::cat', ['cat::a.mp4']);
    expect(manifest.recordsVersion).toBe(0);

    manifest.ingest({
      'cat::a.mp4': { id: 'cat::a.mp4', categoryId: 'cat', relPath: 'a.mp4' }
    });

    expect(manifest.recordsVersion).toBe(1);
  });

  it('exposes coalesced dirty ids for subscribers, then clears them', async () => {
    const manifest = new MediaManifestModule();
    const dirtySnapshots = [];

    manifest.subscribe(() => {
      dirtySnapshots.push(Array.from(manifest.dirtyIds).sort());
    });

    manifest.ingest({
      'cat::a.mp4': { id: 'cat::a.mp4', categoryId: 'cat', relPath: 'a.mp4' }
    });
    manifest.ingest({
      'cat::b.mp4': { id: 'cat::b.mp4', categoryId: 'cat', relPath: 'b.mp4' }
    });

    await Promise.resolve();

    expect(dirtySnapshots).toEqual([['cat::a.mp4', 'cat::b.mp4']]);
    expect(manifest.dirtyIds.size).toBe(0);
  });

  it('tracks transient hydration failures separately from permanent missing and retries pinned ids', async () => {
    const manifest = new MediaManifestModule().start();
    const id = 'cat::a.mp4';

    global.fetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: {
            [id]: { id, categoryId: 'cat', relPath: 'a.mp4', url: '/media/cat/a.mp4' }
          },
          missing: []
        })
      });

    manifest.pin('streaming_row::cat', [id]);
    const firstHydrate = manifest.hydrate([id]);
    await vi.advanceTimersByTimeAsync(16);
    await firstHydrate;

    expect(manifest.isMissing(id)).toBe(false);
    expect(manifest.isFailed(id)).toBe(true);
    expect(manifest.has(id)).toBe(false);

    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(16);

    expect(manifest.has(id)).toBe(true);
    expect(manifest.isFailed(id)).toBe(false);

    manifest.stop();
  });

  it('uses a sliding-window sized retention budget instead of a whole-library cap', () => {
    expect(getManifestRecordBudget({ LOW_MEMORY_DEVICE: true }, { deviceMemory: 8 })).toBe(500);
    expect(getManifestRecordBudget({}, { deviceMemory: 2 })).toBe(500);
    expect(getManifestRecordBudget({}, { deviceMemory: 4 })).toBe(1200);
    expect(getManifestRecordBudget({}, { deviceMemory: 8 })).toBe(2500);
  });

  it('evicts least-recently-used unpinned records beyond the runtime budget', () => {
    const manifest = new MediaManifestModule();
    window.ragotModules = {
      ...(window.ragotModules || {}),
      appRuntime: { LOW_MEMORY_DEVICE: true }
    };
    const records = {};
    for (let i = 0; i < 510; i++) {
      records[`cat::${i}.mp4`] = { id: `cat::${i}.mp4`, categoryId: 'cat', relPath: `${i}.mp4` };
    }

    manifest.pin('visible-window', ['cat::0.mp4']);
    manifest.ingest(records);

    expect(manifest.has('cat::0.mp4')).toBe(true);
    expect(manifest.records.size).toBeLessThanOrEqual(500);
  });
});
