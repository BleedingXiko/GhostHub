/**
 * CategoryRowsContainerComponent Unit Tests
 *
 * Verifies the rows container:
 *   - shows loading shape when empty + isLoading
 *   - shows empty shape when empty + !isLoading
 *   - mounts a CategoryRowComponent per category on initial reconcile
 *   - mounts/unmounts only the child rows whose fingerprint changed
 *     (categoryId | activeSubfolder | viewKey) when categoriesData mutates
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mountCalls, unmountCalls } = vi.hoisted(() => ({
  mountCalls: [],
  unmountCalls: []
}));

vi.mock('../../../modules/layouts/streaming/CategoryRowComponent.js', () => {
  class StubChildComponent {
    constructor(props = {}) {
      this.props = props;
      this.element = null;
      this._mounted = false;
    }
    mount(parent) {
      this.element = document.createElement('div');
      this.element.className = 'streaming-row stub-child';
      this.element.dataset.categoryId = this.props.category?.id || '';
      this.element.dataset.viewKey = this.props.viewKey || '';
      parent.appendChild(this.element);
      this._mounted = true;
      mountCalls.push({ kind: 'category', props: this.props });
    }
    unmount() {
      if (this.element?.parentNode) this.element.parentNode.removeChild(this.element);
      this._mounted = false;
      unmountCalls.push({ kind: 'category', props: this.props });
    }
  }
  return { CategoryRowComponent: StubChildComponent };
});

vi.mock('../../../modules/layouts/streaming/ContinueWatchingRowComponent.js', () => {
  class StubCwComponent {
    constructor() { this.element = null; }
    mount(parent) {
      this.element = document.createElement('div');
      this.element.id = 'row-continue-watching-stub';
      parent.appendChild(this.element);
      mountCalls.push({ kind: 'cw' });
    }
    unmount() {
      if (this.element?.parentNode) this.element.parentNode.removeChild(this.element);
      unmountCalls.push({ kind: 'cw' });
    }
  }
  return { ContinueWatchingRowComponent: StubCwComponent };
});

vi.mock('../../../modules/layouts/streaming/WhatsNewRowComponent.js', () => {
  class StubWnComponent {
    constructor() { this.element = null; this._fn = null; }
    setShowLoadingFn(fn) { this._fn = fn; }
    mount(parent) {
      this.element = document.createElement('div');
      this.element.id = 'row-whats-new-stub';
      parent.appendChild(this.element);
      mountCalls.push({ kind: 'wn' });
    }
    unmount() {
      if (this.element?.parentNode) this.element.parentNode.removeChild(this.element);
      unmountCalls.push({ kind: 'wn' });
    }
  }
  return { WhatsNewRowComponent: StubWnComponent };
});

import { CategoryRowsContainerComponent } from '../../../modules/layouts/streaming/CategoryRowsContainer.js';
import { streamingState } from '../../../modules/layouts/streaming/state.js';

function resetState() {
  streamingState.setState({
    categoriesData: [],
    isLoading: false,
    mediaFilter: 'all',
    categoryIdFilter: null,
    subfolderFilter: null
  });
}

describe('CategoryRowsContainerComponent', () => {
  let host;

  beforeEach(() => {
    mountCalls.length = 0;
    unmountCalls.length = 0;
    resetState();
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    resetState();
  });

  it('renders the loading shape when categoriesData is empty and isLoading is true', () => {
    streamingState.setState({ categoriesData: [], isLoading: true });
    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);

    const wrap = host.querySelector('[data-rows-shape="rows-loading"]');
    expect(wrap).not.toBeNull();
    expect(wrap.querySelectorAll('.streaming-row').length).toBeGreaterThan(0);

    comp.unmount();
  });

  it('renders the empty shape when categoriesData is empty and not loading', () => {
    streamingState.setState({ categoriesData: [], isLoading: false });
    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);

    expect(host.querySelector('[data-rows-shape="rows-empty"]')).not.toBeNull();
    expect(host.querySelector('.streaming-no-media')).not.toBeNull();

    comp.unmount();
  });

  it('mounts one CategoryRowComponent per category, plus CW + WN, on initial reconcile', () => {
    streamingState.setState({
      categoriesData: [
        { id: 'cat-a', name: 'A', viewKey: 'vk-a' },
        { id: 'cat-b', name: 'B', viewKey: 'vk-b' }
      ],
      isLoading: false
    });

    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);

    const categoryMounts = mountCalls.filter((c) => c.kind === 'category');
    expect(categoryMounts).toHaveLength(2);
    expect(categoryMounts[0].props.category.id).toBe('cat-a');
    expect(categoryMounts[1].props.category.id).toBe('cat-b');
    expect(mountCalls.filter((c) => c.kind === 'cw')).toHaveLength(1);
    expect(mountCalls.filter((c) => c.kind === 'wn')).toHaveLength(1);

    comp.unmount();
  });

  it('mounts only the new row when categoriesData appends a category', async () => {
    streamingState.setState({
      categoriesData: [{ id: 'cat-a', name: 'A', viewKey: 'vk-a' }],
      isLoading: false
    });

    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);
    expect(mountCalls.filter((c) => c.kind === 'category')).toHaveLength(1);

    mountCalls.length = 0;
    unmountCalls.length = 0;

    streamingState.setState({
      categoriesData: [
        { id: 'cat-a', name: 'A', viewKey: 'vk-a' },
        { id: 'cat-b', name: 'B', viewKey: 'vk-b' }
      ]
    });
    await Promise.resolve();

    expect(mountCalls.filter((c) => c.kind === 'category')).toHaveLength(1);
    expect(mountCalls[0].props.category.id).toBe('cat-b');
    expect(unmountCalls.filter((c) => c.kind === 'category')).toHaveLength(0);

    comp.unmount();
  });

  it('unmounts only the row whose fingerprint disappeared when one category is removed', async () => {
    streamingState.setState({
      categoriesData: [
        { id: 'cat-a', name: 'A', viewKey: 'vk-a' },
        { id: 'cat-b', name: 'B', viewKey: 'vk-b' }
      ],
      isLoading: false
    });

    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);

    mountCalls.length = 0;
    unmountCalls.length = 0;

    streamingState.setState({
      categoriesData: [{ id: 'cat-a', name: 'A', viewKey: 'vk-a' }]
    });
    await Promise.resolve();

    expect(unmountCalls.filter((c) => c.kind === 'category')).toHaveLength(1);
    expect(unmountCalls[0].props.category.id).toBe('cat-b');
    expect(mountCalls.filter((c) => c.kind === 'category')).toHaveLength(0);

    comp.unmount();
  });

  it('remounts a row when its viewKey rotates (treated as new identity)', async () => {
    streamingState.setState({
      categoriesData: [{ id: 'cat-a', name: 'A', viewKey: 'vk-old' }],
      isLoading: false
    });

    const comp = new CategoryRowsContainerComponent();
    comp.mount(host);

    mountCalls.length = 0;
    unmountCalls.length = 0;

    streamingState.setState({
      categoriesData: [{ id: 'cat-a', name: 'A', viewKey: 'vk-new' }]
    });
    await Promise.resolve();

    expect(unmountCalls.filter((c) => c.kind === 'category' && c.props.viewKey === 'vk-old')).toHaveLength(1);
    expect(mountCalls.filter((c) => c.kind === 'category' && c.props.viewKey === 'vk-new')).toHaveLength(1);

    comp.unmount();
  });
});
