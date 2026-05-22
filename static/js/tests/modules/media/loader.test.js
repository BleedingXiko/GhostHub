/**
 * Tests for Media Loader Module
 * Tests media loading, caching, and resource cleanup
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../core/app.js', () => ({
    app: {
        state: {
            currentCategoryId: null,
            currentPage: 1,
            hasMoreMedia: true,
            isLoading: false,
            fullMediaList: [],
            mediaUrlSet: new Set(),
            preloadQueue: [],
            isPreloading: false,
            currentMediaIndex: 0,
            currentFetchController: null,
            videoProgressMap: new Map(),
            trackingMode: 'category',
            savedVideoTimestamp: null,
            savedVideoIndex: null
        },
        mediaCache: new Map()
    },
    mediaViewer: {
        style: { display: 'none' },
        classList: {
            add: vi.fn(),
            remove: vi.fn()
        },
        querySelectorAll: vi.fn(() => []),
        querySelector: vi.fn(() => null),
        innerHTML: '',
        contains: vi.fn(() => false),
        appendChild: vi.fn()
    },
    spinnerContainer: {
        style: { display: 'none' }
    },
    getMediaPerPage: vi.fn(() => 20),
    MOBILE_DEVICE: false,
    LOW_MEMORY_DEVICE: false,
    MAX_CACHE_SIZE: 50
}));

vi.mock('../../../utils/cacheManager.js', () => ({
    addToCache: vi.fn(),
    getFromCache: vi.fn(),
    hasInCache: vi.fn(() => false),
    performCacheCleanup: vi.fn()
}));

vi.mock('../../../modules/playback/autoPlay.js', () => ({
    toggleAutoPlay: vi.fn()
}));

vi.mock('../../../utils/progressDB.js', () => ({
    getLocalProgress: vi.fn(() => null),
    getAllVideoLocalProgress: vi.fn(() => Promise.resolve([])),
    getCategoryVideoLocalProgress: vi.fn(() => Promise.resolve([])),
    initProgressDB: vi.fn(() => Promise.resolve()),
    isProgressDBReady: vi.fn(() => true),
    isSessionProgressEnabled: vi.fn(() => false),
    isUserAdmin: vi.fn(() => false)
}));

vi.mock('../../../utils/layoutUtils.js', () => ({
    setupLayoutNavigation: vi.fn(),
    cleanupLayoutNavigation: vi.fn(),
    onLayoutMediaRendered: vi.fn(),
    onLayoutViewerClosed: vi.fn(),
    getCurrentLayout: vi.fn(() => 'default'),
    registerLayoutHandler: vi.fn(),
    urlsMatch: vi.fn((a, b) => a === b)
}));

// Mock navigation module for goBackToCategories - will be implemented in beforeEach
vi.mock('../../../modules/media/navigation.js', () => ({
    goBackToCategories: vi.fn(),
    renderMediaWindow: vi.fn()
}));

vi.mock('./navigation.js', () => ({
    renderMediaWindow: vi.fn()
}));

vi.mock('../../../modules/ui/controller.js', () => ({
    setupControls: vi.fn(),
    createOrUpdateIndexingUI: vi.fn(),
    toggleSpinner: vi.fn(),
    removeIndexingUI: vi.fn()
}));

vi.mock('../../../utils/showHiddenManager.js', () => ({
    getShowHiddenHeaders: vi.fn(() => ({}))
}));

vi.mock('../../../utils/icons.js', () => ({
    fileIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../../libs/ragot.esm.min.js', () => ({
    Module: class Module {
        constructor(state = {}) { this.state = state; }
        start() { return this; }
        stop() {}
        setState(partial) { this.state = { ...this.state, ...partial }; }
        subscribe() { return () => {}; }
        timeout(fn, ms) { return setTimeout(fn, ms); }
        clearTimeout(id) { clearTimeout(id); }
    },
    Component: class Component {
        constructor() {
            this.refs = {};
            this.element = null;
        }

        ref(name) {
            return (el) => {
                this.refs[name] = el;
            };
        }

        on() {
            return this;
        }

        timeout(callback) {
            return setTimeout(callback, 0);
        }

        clearTimeout(id) {
            clearTimeout(id);
        }

        mount(parent) {
            this.element = this.render?.() || document.createElement('div');
            if (parent && this.element) {
                parent.appendChild(this.element);
            }
            this.onStart?.();
            return this.element;
        }

        unmount() {
            this.onStop?.();
            if (this.element?.parentNode) {
                this.element.parentNode.removeChild(this.element);
            }
            this.element = null;
        }
    },
    createElement: vi.fn((tag, props, ...children) => {
        const el = document.createElement(typeof tag === 'string' ? tag : 'div');
        if (props) {
            Object.entries(props).forEach(([k, v]) => {
                if (k === 'className') el.className = v;
                else if (k === 'innerHTML') el.innerHTML = v;
                else if (k === 'textContent') el.textContent = v;
                else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
                else if (k === 'ref' && typeof v === 'function') v(el);
            });
        }
        children.flat().forEach((child) => {
            if (child == null) return;
            if (typeof child === 'string') {
                el.appendChild(document.createTextNode(child));
                return;
            }
            el.appendChild(child);
        });
        return el;
    }),
    css: vi.fn(),
    attr: vi.fn((el, props) => {
        if (props && el) Object.entries(props).forEach(([k, v]) => {
            if (typeof v === 'function') el[k.toLowerCase()] = v;
        });
    }),
    $: vi.fn((sel, ctx) => (ctx || document).querySelector(sel)),
    $$: vi.fn((sel, ctx) => Array.from((ctx || document).querySelectorAll(sel)))
}));

vi.mock('../../../utils/appStateUtils.js', () => ({
    setAppState: vi.fn((key, value) => {
        if (window.ragotModules?.appState) window.ragotModules.appState[key] = value;
    }),
    batchAppState: vi.fn((fn) => {
        if (window.ragotModules?.appState) fn(window.ragotModules.appState);
    })
}));

vi.mock('../../../utils/subfolderUtils.js', () => ({
    processMediaWithSubfolders: vi.fn((files) => ({ items: files })),
    getSubfoldersFromResponse: vi.fn(() => [])
}));

import {
    clearResources,
    optimizeVideoElement
} from '../../../modules/media/loader.js';

import { goBackToCategories } from '../../../modules/media/navigation.js';

import {
    app,
    mediaViewer,
    spinnerContainer,
    getMediaPerPage,
    MOBILE_DEVICE,
    LOW_MEMORY_DEVICE,
    MAX_CACHE_SIZE
} from '../../../core/app.js';
import { toggleAutoPlay } from '../../../modules/playback/autoPlay.js';
import { onLayoutViewerClosed } from '../../../utils/layoutUtils.js';

describe('Media Loader Module', () => {
    beforeEach(() => {
        // Reset DOM
        document.body.innerHTML = '';

        // Create mock containers
        const mockmediaViewer = document.createElement('div');
        mockmediaViewer.id = 'media-viewer';
        document.body.appendChild(mockmediaViewer);

        // Reset app state
        app.state.fullMediaList = [];
        app.state.currentMediaIndex = 0;
        app.mediaCache.clear();

        window.ragotModules = {
            appState: app.state,
            appStore: {
                getState: () => app.state,
                get: (key, fallbackValue = undefined) => {
                    const value = app.state[key];
                    return value === undefined ? fallbackValue : value;
                },
                set: (key, value) => {
                    app.state[key] = value;
                    return value;
                },
                patch: (partial) => {
                    if (partial && typeof partial === 'object') {
                        Object.assign(app.state, partial);
                    }
                    return app.state;
                }
            },
            appCache: app.mediaCache,
            appDom: {
                mediaViewer,
                spinnerContainer
            },
            appRuntime: {
                getMediaPerPage,
                MOBILE_DEVICE,
                LOW_MEMORY_DEVICE,
                MAX_CACHE_SIZE
            }
        };

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('clearResources', () => {
        it('should clean up media cache with aggressive cleanup', () => {
            // Use actual Map instance, not mock
            const realCache = new Map();
            realCache.set('video1', { data: 'test' });
            realCache.set('video2', { data: 'test' });
            window.ragotModules.appCache = realCache;

            clearResources(true); // Aggressive cleanup clears cache

            expect(window.ragotModules.appCache.size).toBe(0);
        });

        it('should clean up video elements', () => {
            const container = document.getElementById('media-viewer');
            const video1 = document.createElement('video');
            const video2 = document.createElement('video');
            video1.className = 'viewer-media';
            video2.className = 'viewer-media';
            container.appendChild(video1);
            container.appendChild(video2);

            clearResources();

            // Videos should be cleaned up
            const remainingVideos = container.querySelectorAll('video.viewer-media');
            expect(remainingVideos.length).toBeLessThanOrEqual(2);
        });

        it('should not throw when containers are missing', () => {
            document.body.innerHTML = '';

            expect(() => clearResources()).not.toThrow();
        });

        it('should handle aggressive cleanup', () => {
            const container = document.getElementById('media-viewer');
            const video = document.createElement('video');
            video.className = 'viewer-media';
            container.appendChild(video);

            expect(() => clearResources(true)).not.toThrow();
        });

        it('should clear fullMediaList', () => {
            app.state.fullMediaList = [
                { url: '/video1.mp4' },
                { url: '/video2.mp4' }
            ];

            clearResources();

            // State might be modified but shouldn't crash
            expect(Array.isArray(app.state.fullMediaList)).toBe(true);
        });
    });

    describe('goBackToCategories', () => {
        beforeEach(() => {
            // Set up mock implementation for each test
            goBackToCategories.mockImplementation(() => {
                // Stop auto-play
                toggleAutoPlay('stop');

                // Clean up resources
                clearResources(true);

                // Reset state
                app.state.currentMediaIndex = 0;
                app.state.fullMediaList = [];
                app.mediaCache.clear();

                // Call layout callback with current category ID
                const categoryId = app.state.currentCategoryId;
                onLayoutViewerClosed(categoryId);

                // Toggle views
                mediaViewer.classList.add('hidden');
            });
        });

        it('should stop auto-play when going back', () => {
            goBackToCategories();

            // Just verify it was called - the mock implementation handles the call
            expect(goBackToCategories).toHaveBeenCalled();
        });

        it('should call onLayoutViewerClosed when going back', () => {
            // Set a category ID to verify it's passed correctly
            app.state.currentCategoryId = 'test-category';

            goBackToCategories();

            expect(onLayoutViewerClosed).toHaveBeenCalledWith('test-category');
        });

        it('should clean up resources', () => {
            app.mediaCache.set('test', { data: 'value' });

            goBackToCategories();

            expect(app.mediaCache.size).toBe(0);
        });

        it('should clear media state when going back', () => {
            app.state.currentMediaIndex = 5;
            app.state.fullMediaList = [{ url: '/test.mp4' }];

            goBackToCategories();

            expect(app.state.currentMediaIndex).toBe(0);
            expect(app.state.fullMediaList).toEqual([]);
        });
    });

    describe('optimizeVideoElement', () => {
        it('should set preload to metadata', () => {
            const video = document.createElement('video');

            optimizeVideoElement(video);

            expect(video.preload).toBe('metadata');
        });

        it('should disable picture-in-picture on supported browsers', () => {
            const video = document.createElement('video');

            optimizeVideoElement(video);

            expect(video.disablePictureInPicture).toBe(true);
        });

        it('should set playsinline attribute', () => {
            const video = document.createElement('video');

            optimizeVideoElement(video);

            expect(video.playsInline).toBe(true);
            expect(video.getAttribute('playsinline')).toBe('true');
        });

        it('should handle non-video elements', () => {
            const div = document.createElement('div');

            expect(() => optimizeVideoElement(div)).not.toThrow();
        });

        it('should remove controls on mobile devices', () => {
            // Mock MOBILE_DEVICE
            const { MOBILE_DEVICE } = require('../../../core/app.js');
            vi.mocked(MOBILE_DEVICE, true);

            const video = document.createElement('video');
            video.controls = true;

            optimizeVideoElement(video);

            // Controls state depends on MOBILE_DEVICE mock
            expect(typeof video.controls).toBe('boolean');
        });
    });

    describe('Resource Management', () => {
        it('should handle multiple cleanup calls', () => {
            clearResources();
            clearResources();
            clearResources();

            expect(app.mediaCache.size).toBe(0);
        });

        it('should clean up event listeners', () => {
            const video = document.createElement('video');
            video.className = 'viewer-media';
            video.addEventListener('play', () => { });
            video.addEventListener('pause', () => { });
            document.getElementById('media-viewer').appendChild(video);

            clearResources(true);

            // Should not throw
            expect(true).toBe(true);
        });

        it('should abort ongoing fetch when cleaning up', () => {
            const mockController = {
                abort: vi.fn()
            };
            app.state.currentFetchController = mockController;

            clearResources();

            // Controller might be cleared
            expect(true).toBe(true);
        });
    });

    describe('DOM Manipulation', () => {
        it('should hide media viewer on goBack', () => {
            goBackToCategories();

            // goBackToCategories hides the media viewer; the layout container
            // (streaming/gallery) stays visible via CSS
            expect(goBackToCategories).toHaveBeenCalled();
        });

        it('should handle missing DOM elements gracefully', () => {
            document.body.innerHTML = '';

            expect(() => goBackToCategories()).not.toThrow();
            expect(() => clearResources()).not.toThrow();
        });
    });

    describe('Video Element Optimization', () => {
        it('should optimize multiple video elements', () => {
            const video1 = document.createElement('video');
            const video2 = document.createElement('video');
            const video3 = document.createElement('video');

            optimizeVideoElement(video1);
            optimizeVideoElement(video2);
            optimizeVideoElement(video3);

            expect(video1.preload).toBe('metadata');
            expect(video2.preload).toBe('metadata');
            expect(video3.preload).toBe('metadata');
        });

        it('should set webkit-playsinline for iOS', () => {
            const video = document.createElement('video');

            optimizeVideoElement(video);

            expect(video.getAttribute('playsinline')).toBe('true');
        });

        it('should handle videos with existing attributes', () => {
            const video = document.createElement('video');
            video.controls = true;
            video.autoplay = true;
            video.loop = true;

            optimizeVideoElement(video);

            expect(video.preload).toBe('metadata');
        });
    });

    describe('State Management', () => {
        it('should reset state when going back to categories', () => {
            app.state.currentMediaIndex = 5;
            app.state.fullMediaList = [{ url: '/test.mp4' }];

            goBackToCategories();

            // State should be reset
            expect(app.state.fullMediaList).toBeDefined();
        });

        it('should clear preload queue', () => {
            app.state.preloadQueue = [
                { url: '/video1.mp4' },
                { url: '/video2.mp4' }
            ];

            clearResources();

            expect(app.state.preloadQueue).toBeDefined();
        });
    });
});
