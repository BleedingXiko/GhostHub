/**
 * DownloadManager Unit Tests
 * Tests for file and category download functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('DownloadManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup DOM
    document.body.innerHTML = `
      <div id="media-viewer"></div>
    `;
    
    // Mock app state
    window.appConfig = {
      is_admin: true,
      python_config: {
        ENABLE_SESSION_PROGRESS: true
      }
    };
    window.ragotModules = {
      mediaOrdering: {
        getOrder: vi.fn(() => ({
          orderedIds: ['cat::file1.mp4', 'cat::file2.mp4', 'cat::file3.mp4'],
          status: 'ready',
          hasMore: false,
          pageToken: null,
          viewMeta: {}
        })),
        state: { version: 1 },
        subscribe: vi.fn(() => () => {})
      },
      mediaManifest: {
        get: vi.fn((id) => ({
          'cat::file1.mp4': { url: '/media/file1.mp4', name: 'File 1' },
          'cat::file2.mp4': { url: '/media/file2.mp4', name: 'File 2' },
          'cat::file3.mp4': { url: '/media/file3.mp4', name: 'File 3' }
        }[id] || null)),
        getMany: vi.fn((ids) => ids.map((id) => window.ragotModules.mediaManifest.get(id)).filter(Boolean)),
        has: vi.fn(() => false),
        isMissing: vi.fn(() => false),
        recordsVersion: 1,
        subscribe: vi.fn(() => () => {})
      }
    };
    
    // Mock fetch
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCurrentMediaItem', () => {
    it('should return current media item when state is valid', async () => {
      const mockState = {
        viewer: { viewKey: 'download-test-view', activeIndex: 1 }
      };
      
      const { initDownloadManager, getCurrentMediaItem } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      const item = getCurrentMediaItem();
      expect(item).toEqual({ url: '/media/file2.mp4', name: 'File 2' });
    });

    it('should return null when index is out of bounds', async () => {
      const mockState = {
        currentMediaIndex: 10,
        fullMediaList: [
          { url: '/media/file1.mp4', name: 'File 1' }
        ]
      };
      
      const { initDownloadManager, getCurrentMediaItem } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      const item = getCurrentMediaItem();
      expect(item).toBeNull();
    });

    it('should return null when media list is empty', async () => {
      const mockState = {
        currentMediaIndex: 0,
        fullMediaList: []
      };
      
      const { initDownloadManager, getCurrentMediaItem } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      const item = getCurrentMediaItem();
      expect(item).toBeNull();
    });

    it('should return null when index is negative', async () => {
      const mockState = {
        currentMediaIndex: -1,
        fullMediaList: [
          { url: '/media/file1.mp4', name: 'File 1' }
        ]
      };
      
      const { initDownloadManager, getCurrentMediaItem } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      const item = getCurrentMediaItem();
      expect(item).toBeNull();
    });
  });

  describe('ensureDownloadButton', () => {
    it('should create download button container', async () => {
      const mockState = {
        viewer: { viewKey: 'download-test-view', activeIndex: 0 }
      };
      
      const { initDownloadManager, ensureDownloadButton } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      ensureDownloadButton();
      
      const container = document.getElementById('download-btn-container');
      expect(container).toBeDefined();
    });

    it('should show container when media is available', async () => {
      const mockState = {
        viewer: { viewKey: 'download-test-view', activeIndex: 0 }
      };
      
      const { initDownloadManager, ensureDownloadButton } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      ensureDownloadButton();
      
      const container = document.getElementById('download-btn-container');
      expect(container.style.display).toBe('block');
    });

    it('should hide container when no media is available', async () => {
      const mockState = {
        currentMediaIndex: 0,
        fullMediaList: []
      };
      
      const { initDownloadManager, ensureDownloadButton } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      ensureDownloadButton();
      
      const container = document.getElementById('download-btn-container');
      expect(container.style.display).toBe('none');
    });
  });

  describe('removeDownloadButton', () => {
    it('should remove download button container', async () => {
      const mockState = {
        currentMediaIndex: 0,
        fullMediaList: [
          { url: '/media/file1.mp4', name: 'File 1' }
        ]
      };
      
      const { initDownloadManager, ensureDownloadButton, removeDownloadButton } = await import('../../modules/media/download.js');
      initDownloadManager(mockState, document.getElementById('media-viewer'));
      
      ensureDownloadButton();
      expect(document.getElementById('download-btn-container')).toBeDefined();
      
      removeDownloadButton();
      expect(document.getElementById('download-btn-container')).toBeNull();
    });
  });

  describe('showDownloadNotification', () => {
    it('should create notification element', async () => {
      const { showDownloadNotification } = await import('../../modules/media/download.js');
      
      showDownloadNotification('Test message', 'info', 1000);
      
      const notification = document.querySelector('.download-notification');
      expect(notification).toBeDefined();
      expect(notification.textContent).toContain('Test message');
    });

    it('should remove existing notification before creating new one', async () => {
      const { showDownloadNotification } = await import('../../modules/media/download.js');
      
      showDownloadNotification('First message', 'info', 5000);
      showDownloadNotification('Second message', 'success', 5000);
      
      const notifications = document.querySelectorAll('.download-notification');
      expect(notifications.length).toBe(1);
      expect(notifications[0].textContent).toContain('Second message');
    });

    it('should apply correct styling for error type', async () => {
      const { showDownloadNotification } = await import('../../modules/media/download.js');
      
      showDownloadNotification('Error message', 'error', 5000);
      
      const notification = document.querySelector('.download-notification');
      expect(notification.classList.contains('download-notification--error')).toBe(true);
    });

    it('should apply correct styling for success type', async () => {
      const { showDownloadNotification } = await import('../../modules/media/download.js');
      
      showDownloadNotification('Success message', 'success', 5000);
      
      const notification = document.querySelector('.download-notification');
      expect(notification.classList.contains('download-notification--success')).toBe(true);
    });
  });

  describe('hideDownloadDropdown', () => {
    it('should hide dropdown when it exists', async () => {
      // Create dropdown element
      const dropdown = document.createElement('div');
      dropdown.id = 'download-dropdown';
      dropdown.style.display = 'flex';
      document.body.appendChild(dropdown);
      
      const { hideDownloadDropdown } = await import('../../modules/media/download.js');
      hideDownloadDropdown();
      
      expect(dropdown.style.display).toBe('none');
    });

    it('should not throw when dropdown does not exist', async () => {
      const { hideDownloadDropdown } = await import('../../modules/media/download.js');
      
      expect(() => hideDownloadDropdown()).not.toThrow();
    });
  });
});
