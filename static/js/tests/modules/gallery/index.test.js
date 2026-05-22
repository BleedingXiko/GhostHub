/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchMonthMediaMock,
  galleryStateMock
} = vi.hoisted(() => ({
  fetchMonthMediaMock: vi.fn(),
  galleryStateMock: {
    state: {
      allYearsData: []
    },
    timeout: vi.fn((fn) => fn()),
    subscribe: vi.fn()
  }
}));

vi.mock('../../../modules/layouts/gallery/state.js', () => ({
  isActive: vi.fn(() => true),
  getContainer: vi.fn(() => null),
  setContainer: vi.fn(),
  setIsGalleryLayout: vi.fn(),
  clearAllMedia: vi.fn(),
  getCategoriesData: vi.fn(() => []),
  getCategoryIdFilter: vi.fn(() => null),
  getCategoryIdsFilter: vi.fn(() => []),
  setCategoryIdFilter: vi.fn(),
  setCategoryNameFilter: vi.fn(),
  setParentNameFilter: vi.fn(),
  setCategoryIdsFilter: vi.fn(),
  setMediaFilter: vi.fn(),
  setDatesPage: vi.fn(),
  getSortedDateKeys: vi.fn(() => []),
  getMediaByDate: vi.fn(() => ({})),
  getHasMoreDates: vi.fn(() => false),
  galleryState: galleryStateMock
}));

vi.mock('../../../modules/layouts/gallery/renderer.js', () => {
  class DummyComponent {
    constructor(initialState = {}) {
      this.state = initialState;
      this.element = null;
    }
    setState(nextState) {
      this.state = { ...this.state, ...nextState };
    }
    mount() {}
    unmount() {}
    setCloseHandler() {}
    setNavigateHandler() {}
    setTimelineClickHandler() {}
    setRetryHandler() {}
  }

  return {
    loadAndRender: vi.fn(),
    render: vi.fn(),
    mountTimeline: vi.fn(),
    unmountTimeline: vi.fn(),
    getTimelineComponent: vi.fn(() => null),
    setToolbarComponent: vi.fn(),
    setDateHeaderClickHandler: vi.fn(),
    clearDateGroupState: vi.fn(),
    handleDownloadSelected: vi.fn(),
    GallerySidebarComponent: DummyComponent,
    GalleryMobileTimelineComponent: DummyComponent,
    GallerySelectionToolbarComponent: DummyComponent,
    GalleryToolbarComponent: DummyComponent,
    GalleryContainerComponent: DummyComponent,
    GalleryMonthOverlayComponent: DummyComponent
  };
});

vi.mock('../../../modules/layouts/gallery/mediaDataSource.js', () => ({
  jumpToYear: vi.fn(),
  jumpToDate: vi.fn(),
  fetchMonthMedia: fetchMonthMediaMock
}));

vi.mock('../../../modules/layouts/gallery/navigation.js', () => ({
  openViewer: vi.fn()
}));

vi.mock('../../../modules/ui/categoryFilterPill.js', () => ({
  resolveCategoryName: vi.fn()
}));

vi.mock('../../../modules/layouts/shared/layoutLifecycle.js', () => ({
  createLayoutChangeLifecycle: vi.fn(() => vi.fn())
}));

vi.mock('../../../modules/layouts/shared/thumbnailProgressLifecycle.js', () => ({
  createThumbnailProgressTracker: vi.fn(() => ({
    init: vi.fn(),
    cleanup: vi.fn()
  }))
}));

vi.mock('../../../modules/layouts/shared/socketHandlers.js', () => ({
  createLayoutSocketHandlerManager: vi.fn(() => ({}))
}));

vi.mock('../../../modules/layouts/shared/filterActions.js', () => ({
  createLayoutFilterActions: vi.fn(() => ({}))
}));

vi.mock('../../../utils/layoutUtils.js', () => ({
  registerLayoutHandler: vi.fn(),
  urlsMatch: vi.fn(() => true)
}));

vi.mock('../../../utils/mediaUtils.js', () => ({
  buildThumbnailImageAttrs: vi.fn(() => ({})),
  setThumbnailImageState: vi.fn(),
  createThumbnailLazyLoader: vi.fn(() => ({
    observe: vi.fn(),
    destroy: vi.fn()
  })),
  getAdaptiveRootMargin: vi.fn(() => '0px'),
  isGeneratedThumbnailSrc: vi.fn(() => true),
  withThumbnailRetryParam: vi.fn((src) => src)
}));

vi.mock('../../../utils/showHiddenManager.js', () => ({
  appendShowHiddenParam: vi.fn((value) => value),
  syncShowHiddenFromEvent: vi.fn()
}));

vi.mock('../../../libs/ragot.esm.min.js', () => ({
  Module: class {
    constructor(initialState = {}) {
      this.state = initialState;
      this.running = true;
    }
    adopt() {}
    adoptComponent() {}
    addCleanup() {}
    start() {}
    stop() {}
  },
  createElement: vi.fn(() => document.createElement('div')),
  append: vi.fn(),
  $: vi.fn(() => null),
  $$: vi.fn(() => []),
  attr: vi.fn()
}));

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createOverlayStub() {
  return {
    state: {
      open: false,
      year: null,
	      month: null,
	      mediaIds: [],
	      error: null,
      hasPrev: false,
      hasNext: false,
      allMonths: []
    },
    element: null,
    setState(nextState) {
      this.state = { ...this.state, ...nextState };
    }
  };
}

describe('GalleryLayoutModule month overlay', () => {
  let GalleryLayoutModule;

  beforeEach(async () => {
    vi.resetModules();
    fetchMonthMediaMock.mockReset();
    galleryStateMock.state.allYearsData = [
      {
        year: 2024,
        months: [
          { month: 5, dateKey: '2024-05-01' },
          { month: 4, dateKey: '2024-04-01' }
        ]
      }
    ];
    global.requestAnimationFrame = vi.fn((cb) => cb());

    ({ GalleryLayoutModule } = await import('../../../modules/layouts/gallery/index.js'));
  });

  it('shows an explicit error state when month fetch fails', async () => {
	    fetchMonthMediaMock.mockResolvedValue({
	      orderedIds: [],
	      dateTotals: {},
      error: "Couldn't load 2024-05. Please try again."
    });

    const module = new GalleryLayoutModule();
    module._overlayComp = createOverlayStub();

    await module.openMonthOverlay(2024, 5);

    expect(module._overlayComp.state.open).toBe(true);
	    expect(module._overlayComp.state.error).toContain("Couldn't load 2024-05");
	    expect(module._overlayComp.state.mediaIds).toEqual([]);
  });

  it('ignores stale responses after the overlay closes during load', async () => {
    const deferred = createDeferred();
    fetchMonthMediaMock.mockReturnValue(deferred.promise);

    const module = new GalleryLayoutModule();
    module._overlayComp = createOverlayStub();

    const pendingOpen = module.openMonthOverlay(2024, 5);
    module.closeOverlay();
	    deferred.resolve({
	      orderedIds: ['photos::late.mp4'],
	      dateTotals: {},
      error: null
    });
    await pendingOpen;

    expect(module._overlayComp.state.open).toBe(false);
	    expect(module._overlayComp.state.error).toBeNull();
	    expect(module._overlayComp.state.mediaIds).toEqual([]);
  });

  it('keeps only the newest month-navigation response when requests race', async () => {
    const first = createDeferred();
    const second = createDeferred();

    fetchMonthMediaMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const module = new GalleryLayoutModule();
    module._overlayComp = createOverlayStub();

    const mayOpen = module.openMonthOverlay(2024, 5);
    const aprilOpen = module.openMonthOverlay(2024, 4);

	    second.resolve({
	      orderedIds: ['photos::april.mp4'],
	      dateTotals: {},
	      error: null
	    });
	    first.resolve({
	      orderedIds: ['photos::may.mp4'],
	      dateTotals: {},
	      error: null
    });

    await Promise.all([mayOpen, aprilOpen]);

    expect(module._overlayComp.state.year).toBe(2024);
    expect(module._overlayComp.state.month).toBe(4);
	    expect(module._overlayComp.state.error).toBeNull();
	    expect(module._overlayComp.state.mediaIds).toEqual(['photos::april.mp4']);
  });
});
