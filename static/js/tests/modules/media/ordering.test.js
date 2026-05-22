import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MediaOrderingModule } from '../../../modules/media/ordering.js';

vi.mock('../../../utils/showHiddenManager.js', () => ({
  getShowHiddenHeaders: vi.fn(() => ({}))
}));

vi.mock('../../../utils/requestCache.js', () => ({
  cachedFetch: vi.fn()
}));

import { cachedFetch } from '../../../utils/requestCache.js';

describe('MediaOrderingModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cachedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        orderedIds: ['cat::a.mp4'],
        hasMore: false,
        pageToken: null,
        viewMeta: {}
      })
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns a ready cached order without publishing a fetching state', async () => {
    const ordering = new MediaOrderingModule().start();
    const first = await ordering.requestOrder('view::cat', 'streaming_row', {
      category_id: 'cat',
      page: 1
    });
    const versionAfterFirst = ordering.state.version;

    const second = await ordering.requestOrder('view::cat', 'streaming_row', {
      page: 1,
      category_id: 'cat'
    });

    expect(second).toBe(first);
    expect(ordering.state.version).toBe(versionAfterFirst);
    expect(cachedFetch).toHaveBeenCalledTimes(1);

    ordering.stop();
  });
});
