/**
 * CategoryRowComponent Unit Tests
 *
 * Verifies the per-category row Component:
 *   - subscribes to its viewKey via subscribeView with itself as owner
 *   - renders the row shell with title + count derived from selectors
 *   - reacts to mediaOrdering/mediaManifest changes (e.g. ingest fires
 *     subscribeView, which in turn drives the row update path)
 *   - tears the subscription down on unmount
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/showHiddenManager.js', () => ({
  getShowHiddenHeaders: vi.fn(() => ({}))
}));

vi.mock('../../../utils/requestCache.js', () => ({
  cachedFetch: vi.fn()
}));

vi.mock('../../../modules/layouts/streaming/cards.js', () => ({
  createMediaItemCard: vi.fn(() => {
    const card = document.createElement('div');
    card.className = 'streaming-card';
    return card;
  }),
  createSubfolderCard: vi.fn((sf) => {
    const card = document.createElement('div');
    card.className = 'streaming-card streaming-subfolder-card subfolder';
    card.dataset.subfolderName = sf.name;
    return card;
  }),
  createContinueWatchingCard: vi.fn(() => document.createElement('div')),
  updateCardProgress: vi.fn(),
  updateContinueWatchingCard: vi.fn()
}));

vi.mock('../../../modules/layouts/streaming/lazyLoad.js', () => ({
  observeLazyImage: vi.fn(),
  primeLazyImage: vi.fn()
}));

vi.mock('../../../modules/layouts/streaming/mediaDataSource.js', () => ({
  loadMoreMedia: vi.fn(async () => [])
}));

vi.mock('../../../modules/layouts/shared/subfolderNavigation.js', () => ({
  handleSubfolderClick: vi.fn()
}));

import { CategoryRowComponent } from '../../../modules/layouts/streaming/CategoryRowComponent.js';
import { mediaOrdering } from '../../../modules/media/ordering.js';
import { mediaManifest } from '../../../modules/media/manifest.js';

function freshOrdering() {
  mediaOrdering.orders.clear();
  mediaOrdering.setState({ version: 0 });
  mediaManifest.clear();
  mediaManifest._pins.clear();
  mediaManifest.failed.clear();
}

function seedView(viewKey, { ids = [], hasMore = false, subfolders = [], status = 'ready' } = {}) {
  mediaOrdering.ingestView(viewKey, {
    viewType: 'streaming_row',
    orderedIds: ids,
    hasMore,
    status,
    viewMeta: { subfolders }
  });
  const records = {};
  ids.forEach((id) => {
    records[id] = {
      id,
      url: `/media/${id.replace('::', '/')}`,
      name: id.split('::').pop(),
      type: 'image',
      categoryId: id.split('::')[0]
    };
  });
  if (ids.length) mediaManifest.ingest(records);
}

describe('CategoryRowComponent', () => {
  let host;

  beforeEach(() => {
    freshOrdering();
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    freshOrdering();
  });

  it('renders the row shell with title and count derived from the populated view', () => {
    const viewKey = 'streaming_row::cat-1::::all::20';
    seedView(viewKey, { ids: ['cat-1::a.jpg', 'cat-1::b.jpg'] });

    const comp = new CategoryRowComponent({
      category: { id: 'cat-1', name: 'Movies' },
      viewKey,
      rowOrder: 0,
      mediaFilter: 'all'
    });

    comp.mount(host);

    const row = host.querySelector('#row-category-cat-1');
    expect(row).not.toBeNull();
    expect(row.querySelector('.streaming-row-title-text')?.textContent).toContain('Movies');
    expect(row.querySelector('.streaming-row-count')?.textContent).toBe('(2 items)');

    comp.unmount();
  });

  it('shows the loading shell when the view is empty and still fetching', () => {
    const viewKey = 'streaming_row::cat-load::::all::20';
    mediaOrdering.ingestView(viewKey, {
      viewType: 'streaming_row',
      orderedIds: [],
      status: 'fetching'
    });

    const comp = new CategoryRowComponent({
      category: { id: 'cat-load', name: 'Loading Library', asyncIndexing: true },
      viewKey,
      rowOrder: 0,
      mediaFilter: 'all'
    });
    comp.mount(host);

    const row = host.querySelector('#row-category-cat-load');
    expect(row).not.toBeNull();
    expect(row.querySelectorAll('.streaming-card-skeleton').length).toBeGreaterThan(0);

    comp.unmount();
  });

  it('renders subfolder cards before the virtualized media strip when the view exposes subfolders', () => {
    const viewKey = 'streaming_row::cat-sf::::all::20';
    seedView(viewKey, {
      ids: ['cat-sf::a.jpg'],
      subfolders: [{ name: 'Season 1', count: 8, contains_video: true }]
    });

    const comp = new CategoryRowComponent({
      category: { id: 'cat-sf', name: 'Show' },
      viewKey,
      rowOrder: 0,
      mediaFilter: 'all'
    });
    comp.mount(host);

    const subfolderCard = host.querySelector('.streaming-card.subfolder[data-subfolder-name="Season 1"]');
    expect(subfolderCard).not.toBeNull();
    expect(subfolderCard.closest('.streaming-subfolder-strip')).not.toBeNull();
    const scrollContainer = subfolderCard.closest('.streaming-scroll-container');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.firstElementChild).toBe(subfolderCard.closest('.streaming-subfolder-strip'));
    expect(scrollContainer.lastElementChild.classList.contains('streaming-media-strip')).toBe(true);

    comp.unmount();
  });

  it('reacts to ordering changes for its viewKey while mounted (subscribeView wired)', async () => {
    const viewKey = 'streaming_row::cat-reactive::::all::20';
    seedView(viewKey, { ids: ['cat-reactive::a.jpg'] });

    const comp = new CategoryRowComponent({
      category: { id: 'cat-reactive', name: 'Reactive' },
      viewKey,
      rowOrder: 0,
      mediaFilter: 'all'
    });
    comp.mount(host);

    const initialVersion = mediaOrdering.state.version;

    mediaOrdering.ingestView(viewKey, {
      viewType: 'streaming_row',
      orderedIds: ['cat-reactive::a.jpg', 'cat-reactive::b.jpg'],
      status: 'ready'
    });
    await Promise.resolve();

    expect(mediaOrdering.state.version).toBeGreaterThan(initialVersion);
    // Component is still mounted; subscription path did not throw.
    expect(host.querySelector('#row-category-cat-reactive')).not.toBeNull();

    comp.unmount();
  });

  it('detaches its subscription on unmount so unrelated ingests no longer touch it', async () => {
    const viewKey = 'streaming_row::cat-detached::::all::20';
    seedView(viewKey, { ids: ['cat-detached::a.jpg'] });

    const comp = new CategoryRowComponent({
      category: { id: 'cat-detached', name: 'Detached' },
      viewKey,
      rowOrder: 0,
      mediaFilter: 'all'
    });
    comp.mount(host);
    comp.unmount();

    expect(host.querySelector('#row-category-cat-detached')).toBeNull();

    // Mutating ordering after unmount must not throw — subscription is gone.
    expect(() => {
      mediaOrdering.ingestView(viewKey, {
        viewType: 'streaming_row',
        orderedIds: ['cat-detached::a.jpg', 'cat-detached::b.jpg'],
        status: 'ready'
      });
    }).not.toThrow();
  });
});
