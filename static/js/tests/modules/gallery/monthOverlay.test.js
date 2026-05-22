/**
 * GalleryMonthOverlayComponent – loading detection & subscribeView tests.
 * Issue B regression coverage.
 *
 * Uses the real selectors.js, mediaOrdering, and mediaManifest.
 * Seeds ordering and manifest directly to test realistic behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Real module imports for seeding state ───────────────────────────────────
import { mediaOrdering } from '../../../modules/media/ordering.js';
import { mediaManifest } from '../../../modules/media/manifest.js';
import { selectRecordsForView, subscribeView } from '../../../modules/media/selectors.js';

// ── Mocks for transitive dependencies of renderer.js ──────────────────────
vi.mock('../../../modules/layouts/gallery/state.js', () => ({
  isActive: vi.fn(() => true),
  getContainer: vi.fn(),
  setContainer: vi.fn(),
  getMediaByDate: vi.fn(() => ({})),
  getCategoriesData: vi.fn(() => []),
  getMediaFilter: vi.fn(() => 'all'),
  setMediaFilter: vi.fn(),
  getHasMoreDates: vi.fn(() => false),
  setIsLoading: vi.fn(),
  getIsLoading: vi.fn(() => false),
  getSortedDateKeys: vi.fn(() => []),
  getDateTotal: vi.fn(() => 0),
  getMonthTotal: vi.fn(() => 0),
  isMediaSelected: vi.fn(() => false),
  toggleMediaSelection: vi.fn(),
  clearSelection: vi.fn(),
  getSelectedMediaItems: vi.fn(() => []),
  getAllYearsData: vi.fn(() => []),
  getSelectedMobileYear: vi.fn(() => null),
  setSelectedMobileYear: vi.fn(),
  setCategoryIdFilter: vi.fn(),
  getCategoryIdFilter: vi.fn(() => null),
  getCategoryNameFilter: vi.fn(() => null),
  setCategoryNameFilter: vi.fn(),
  getParentNameFilter: vi.fn(() => null),
  setParentNameFilter: vi.fn(),
  setCategoryIdsFilter: vi.fn(),
  getCategoryIdsFilter: vi.fn(() => null),
  getGalleryTimelineViewKey: vi.fn(() => null),
}));

vi.mock('../../../modules/layouts/gallery/lazyLoad.js', () => ({
  initLazyLoading: vi.fn(),
  cleanupLazyLoading: vi.fn(),
  observeLazyImage: vi.fn(),
  refreshLazyLoader: vi.fn(),
}));

vi.mock('../../../modules/layouts/gallery/mediaDataSource.js', () => ({
  loadInitialMedia: vi.fn(),
  loadMoreForDate: vi.fn(),
  loadMoreDates: vi.fn(),
}));

vi.mock('../../../modules/layouts/gallery/navigation.js', () => ({
  openViewer: vi.fn(),
}));

vi.mock('../../../utils/authManager.js', () => ({
  ensureFeatureAccess: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../../modules/admin/files.js', () => ({
  openFileManager: vi.fn(),
}));

vi.mock('../../../modules/layouts/gallery/components/index.js', () => ({
  setupGalleryDragDrop: vi.fn(),
  setupAutoCollapseObserver: vi.fn(),
  cleanupAutoCollapseObserver: vi.fn(),
  clearDateGroupState: vi.fn(),
  getDateGroupState: vi.fn(() => ({})),
  setIsZooming: vi.fn(),
}));

vi.mock('../../../modules/shared/thumbnailProgress.js', () => ({
  default: {
    isProcessing: vi.fn(() => false),
  },
}));

vi.mock('../../../modules/ui/categoryFilterPill.js', () => ({
  updateCategoryFilterPill: vi.fn(),
  handlePillClear: vi.fn(),
  getLeafName: vi.fn((n) => n),
}));

vi.mock('../../../utils/layoutUtils.js', () => ({
  formatDateDisplay: vi.fn((d) => d),
}));

vi.mock('../../../utils/notificationManager.js', () => ({
  toast: vi.fn(),
}));

vi.mock('../../../utils/icons.js', () => ({
  cameraIcon: '',
  warningIcon: '',
}));

vi.mock('../../../utils/showHiddenManager.js', () => ({
  appendShowHiddenParam: vi.fn((url) => url),
}));

vi.mock('../../../utils/mediaUtils.js', () => ({
  buildThumbnailImageAttrs: vi.fn(() => ({})),
  createThumbnailShell: vi.fn(() => document.createElement('div')),
}));

// ── Import the Component under test ────────────────────────────────────────
import { GalleryMonthOverlayComponent } from '../../../modules/layouts/gallery/renderer.js';

function clearState() {
  mediaOrdering.orders.clear();
  mediaOrdering.setState({ version: 0 });
  mediaManifest.clear();
  mediaManifest._pins.clear();
  mediaManifest.failed.clear();
}

function seedView(viewKey, { ids = [], status = 'ready' } = {}) {
  mediaOrdering.ingestView(viewKey, {
    viewType: 'gallery_month',
    orderedIds: ids,
    status,
  });
}

function seedRecords(recordsArray) {
  const records = {};
  recordsArray.forEach(r => {
    records[r.id] = r;
  });
  mediaManifest.ingest(records);
}

describe('GalleryMonthOverlayComponent', () => {
  let host;

  beforeEach(() => {
    clearState();
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    clearState();
  });

  // ── Loading detection ─────────────────────────────────────────────────

  it('shows loading spinner when view status is fetching (initial fetch)', () => {
    seedView('vk-fetching', { ids: [], status: 'fetching' });
    const comp = new GalleryMonthOverlayComponent();
    comp.mount(host);
    comp.setStateSync({ open: true, year: 2025, month: 6, mediaIds: null, viewKey: 'vk-fetching' });

    expect(comp.element.querySelector('.gallery-month-loading')).not.toBeNull();
    expect(comp.element.querySelector('.gallery-grid')).toBeNull();
    comp.unmount();
  });

  it('renders available cards when mediaIds is set even if some records are missing from manifest', () => {
    const viewKey = 'gallery_month::c1::::all::2025-06';
    
    // Seed 3 IDs in ordering
    seedView(viewKey, { ids: ['id-a', 'id-b', 'id-c'] });
    // Hydrate only 1 record in manifest (missing 'id-b' and 'id-c')
    seedRecords([{ id: 'id-a', url: '/a.jpg', name: 'a', type: 'image', categoryId: 'c1' }]);

    const comp = new GalleryMonthOverlayComponent();
    comp.mount(host);
    comp.setStateSync({
      open: true, year: 2025, month: 6,
      viewKey,
      mediaIds: ['id-a', 'id-b', 'id-c'],
    });

    // Should NOT show loading — mediaIds is not null
    expect(comp.element.querySelector('.gallery-month-loading')).toBeNull();
    // Grid should be rendered with the one available record card
    const grid = comp.element.querySelector('.gallery-grid');
    expect(grid).not.toBeNull();
    expect(grid.querySelectorAll('.gallery-item')).toHaveLength(1);
    comp.unmount();
  });

  it('shows empty state when mediaIds is empty and no records', () => {
    const viewKey = 'gallery_month::::::all::2025-01';
    seedView(viewKey, { ids: [] });

    const comp = new GalleryMonthOverlayComponent();
    comp.mount(host);
    comp.setStateSync({
      open: true, year: 2025, month: 1,
      viewKey,
      mediaIds: [],
    });

    expect(comp.element.querySelector('.gallery-month-loading')).toBeNull();
    expect(comp.element.querySelector('.gallery-month-empty')).not.toBeNull();
    comp.unmount();
  });

  // ── subscribeView lifecycle ──────────────────────────────────────────

  it('wires subscribeView on mount when viewKey is present in state', () => {
    const viewKey = 'vk-init';
    const comp = new GalleryMonthOverlayComponent();
    comp.setStateSync({ viewKey });
    
    // Spy on the ordering module's subscribe method
    const orderingSpy = vi.spyOn(mediaOrdering, 'subscribe');

    comp.mount(host);

    expect(orderingSpy).toHaveBeenCalled();
    
    comp.unmount();
    orderingSpy.mockRestore();
  });

  it('tears down old subscription and creates new one when viewKey rotates via setStateSync', () => {
    const comp = new GalleryMonthOverlayComponent();
    comp.mount(host);

    const orderingSpy = vi.spyOn(mediaOrdering, 'subscribe');

    // First viewKey via setStateSync after mount
    comp.setStateSync({ viewKey: 'vk-1' });
    expect(orderingSpy).toHaveBeenCalledTimes(1);

    // Rotate viewKey — should trigger another subscribe call (and unsubscribe old)
    comp.setStateSync({ viewKey: 'vk-2' });
    expect(orderingSpy).toHaveBeenCalledTimes(2);

    comp.unmount();
    orderingSpy.mockRestore();
  });
});
