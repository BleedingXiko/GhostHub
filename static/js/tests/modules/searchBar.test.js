import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock ragot module that searchBar imports (Component, createElement, etc.)
vi.mock('../../libs/ragot.esm.min.js', () => {
  class Component {
    constructor(state) { this.state = state || {}; this._listeners = []; this._started = false; }
    setState(partial) { this.state = { ...this.state, ...partial }; this._performUpdate?.(); }
    on(target, type, handler, options) { target.addEventListener(type, handler, options); this._listeners.push({ target, type, handler, options }); }
    off(target, type, handler, options) { target.removeEventListener(type, handler, options); }
    addCleanup() { }
  }
  class Module extends Component {
    start() { this._isMounted = true; this.onStart?.(); return this; }
    stop() { this._isMounted = false; this.onStop?.(); return this; }
    timeout(cb, ms) { return setTimeout(cb, ms); }
    clearTimeout(id) { clearTimeout(id); }
    interval(cb, ms) { return setInterval(cb, ms); }
    clearInterval(id) { clearInterval(id); }
  }
  return {
    Component,
    Module,
    createElement: (tag, props, ...children) => {
      const el = document.createElement(typeof tag === 'string' ? tag : 'div');
      if (props) Object.entries(props).forEach(([k, v]) => {
        if (k === 'className') el.className = v;
        else if (k === 'innerHTML') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      });
      children.flat().forEach(c => { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
      return el;
    },
    renderList: vi.fn(),
    clear: (el) => { el.innerHTML = ''; },
    append: (parent, child) => { if (child) parent.appendChild(child); },
    show: (el) => { el.classList.remove('hidden'); },
    hide: (el) => { el.classList.add('hidden'); },
    $: (sel) => document.querySelector(sel)
  };
});

vi.mock('../../utils/authManager.js', () => ({
  ensureFeatureAccess: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../utils/icons.js', () => ({
  videoIcon: () => '<svg></svg>',
  imageIcon: () => '<svg></svg>',
  fileIcon: () => '<svg></svg>',
  folderIcon: () => '<svg></svg>'
}));

vi.mock('../ui/categoryFilterPill.js', () => ({
  getLeafName: (name) => name?.split('/').pop() || name
}));

describe('SearchBar', () => {
  let searchModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = `
      <button id="search-toggle-btn" class="gh-header__btn">Search</button>
      <div id="search-dropdown" class="hidden">
        <input id="global-search-input" />
        <div id="search-results-dropdown"></div>
      </div>
    `;

    window.requestAnimationFrame = (cb) => cb();
    window.getComputedStyle = vi.fn(() => ({ transitionDuration: '0s' }));
    searchModule = await import('../../modules/ui/searchBar.js');
  });

  afterEach(() => {
    searchModule?.destroySearchBar?.();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('opens and closes dropdown without destroying adopted DOM', () => {
    searchModule.initSearchBar();

    const toggle = document.getElementById('search-toggle-btn');
    const dropdown = document.getElementById('search-dropdown');
    const input = document.getElementById('global-search-input');

    toggle.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('global-search-input')).toBe(input);
    expect(dropdown.contains(input)).toBe(true);

    input.value = 'hello';
    toggle.click();
    expect(dropdown.classList.contains('hidden')).toBe(true);
    expect(input.value).toBe('');
    expect(dropdown.contains(input)).toBe(true);
  });

  it('cancels a pending close when reopened before the fade-out finishes', () => {
    window.getComputedStyle = vi.fn(() => ({ transitionDuration: '0.2s' }));
    searchModule.initSearchBar();

    const toggle = document.getElementById('search-toggle-btn');
    const dropdown = document.getElementById('search-dropdown');
    const input = document.getElementById('global-search-input');

    toggle.click();
    input.value = 'ca';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    toggle.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);

    toggle.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);

    input.value = 'cat';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);

    expect(dropdown.classList.contains('hidden')).toBe(false);
  });
});
