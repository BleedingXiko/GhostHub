/**
 * Core App Module Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock configManager before importing app
vi.mock('../../utils/configManager.js', () => ({
  getConfigValue: vi.fn((path, defaultValue) => {
    const mockConfig = {
      'javascript_config.core_app.media_per_page_desktop': 5,
      'javascript_config.core_app.media_per_page_mobile': 3,
      'javascript_config.core_app.load_more_threshold_desktop': 3,
      'javascript_config.core_app.load_more_threshold_mobile': 2,
      'javascript_config.core_app.render_window_size': 0,
      'javascript_config.core_app.mobile_cleanup_interval': 60000,
      'javascript_config.core_app.mobile_fetch_timeout': 15000,
      'javascript_config.core_app.fullscreen_check_interval': 2000,
      'python_config.MAX_CACHE_SIZE': 50
    };
    return mockConfig[path] ?? defaultValue;
  })
}));

describe('Core App Module', () => {
  let appModule;

  beforeEach(async () => {
    vi.resetModules();

    // Setup DOM elements that app.js expects
    document.body.innerHTML = `
      <div id="categories-section"></div>
      <div id="media-viewer">
        <div class="spinner-container"></div>
      </div>
      <div id="grid-container"></div>
      <button id="sync-toggle-btn"></button>
    `;

    // Import fresh module
    appModule = await import('../../core/app.js');
  });

  describe('DOM references', () => {
    it('should export gridContainer reference', () => {
      expect(appModule.gridContainer).toBeDefined();
    });

    it('should export mediaViewer reference', () => {
      expect(appModule.mediaViewer).toBeDefined();
    });

    it('should export syncToggleBtn reference', () => {
      expect(appModule.syncToggleBtn).toBeDefined();
    });
  });

  describe('configuration constants', () => {
    it('should export MOBILE_DEVICE detection', () => {
      expect(typeof appModule.MOBILE_DEVICE).toBe('boolean');
    });

    it('should export getMediaPerPage function', () => {
      expect(typeof appModule.getMediaPerPage).toBe('function');
    });

    it('getMediaPerPage should return a number', () => {
      const perPage = appModule.getMediaPerPage();
      expect(typeof perPage).toBe('number');
      expect(perPage).toBeGreaterThan(0);
    });

    it('should export LOAD_MORE_THRESHOLD', () => {
      expect(typeof appModule.LOAD_MORE_THRESHOLD).toBe('number');
    });

    it('should export MAX_CACHE_SIZE', () => {
      expect(typeof appModule.MAX_CACHE_SIZE).toBe('number');
    });

    it('should export renderWindowSize', () => {
      expect(typeof appModule.renderWindowSize).toBe('number');
    });
  });

  describe('app object', () => {
    it('should export app object', () => {
      expect(appModule.app).toBeDefined();
      expect(typeof appModule.app).toBe('object');
    });

    it('should have state property', () => {
      expect(appModule.app.state).toBeDefined();
    });

    it('should have mediaCache property', () => {
      expect(appModule.app.mediaCache).toBeDefined();
      expect(appModule.app.mediaCache instanceof Map).toBe(true);
    });

    it('should have resetState method', () => {
      expect(typeof appModule.app.resetState).toBe('function');
    });

    describe('app.state', () => {
      it('should have currentCategoryId', () => {
        expect(appModule.app.state).toHaveProperty('currentCategoryId');
      });

      it('should have isLoading', () => {
        expect(appModule.app.state.isLoading).toBe(false);
      });

      it('should have viewer session state', () => {
        expect(appModule.app.state.viewer).toBeNull();
      });

      it('should have syncModeEnabled', () => {
        expect(appModule.app.state.syncModeEnabled).toBe(false);
      });

      it('should have isHost', () => {
        expect(appModule.app.state.isHost).toBe(false);
      });

      it('should have navigationDisabled', () => {
        expect(appModule.app.state.navigationDisabled).toBe(false);
      });

      it('should have preloadQueue', () => {
        expect(Array.isArray(appModule.app.state.preloadQueue)).toBe(true);
      });
    });

    describe('app.resetState', () => {
      it('should reset currentCategoryId to null', () => {
        appModule.app.state.currentCategoryId = 'test-category';

        appModule.app.resetState();

        expect(appModule.app.state.currentCategoryId).toBeNull();
      });

      it('should clear viewer session', () => {
        appModule.app.state.viewer = { viewKey: 'test-view', activeIndex: 2 };

        appModule.app.resetState();

        expect(appModule.app.state.viewer).toBeNull();
      });

      it('should clear mediaCache', () => {
        appModule.app.mediaCache.set('key', 'value');

        appModule.app.resetState();

        expect(appModule.app.mediaCache.size).toBe(0);
      });

      it('should reset isLoading to false', () => {
        appModule.app.state.isLoading = true;

        appModule.app.resetState();

        expect(appModule.app.state.isLoading).toBe(false);
      });

      it('should reset navigationDisabled to false', () => {
        appModule.app.state.navigationDisabled = true;

        appModule.app.resetState();

        expect(appModule.app.state.navigationDisabled).toBe(false);
      });

      it('should abort current fetch controller if exists', () => {
        const mockAbort = vi.fn();
        appModule.app.state.currentFetchController = { abort: mockAbort };

        appModule.app.resetState();

        expect(mockAbort).toHaveBeenCalled();
        expect(appModule.app.state.currentFetchController).toBeNull();
      });
    });
  });

  describe('state exports', () => {
    it('should export appState as the canonical state object', () => {
      expect(appModule.appState).toBe(appModule.app.state);
    });
  });
});
