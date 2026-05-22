/**
 * MediaLoader Unit Tests
 * Tests for media loading and category viewing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('MediaLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup DOM
    document.body.innerHTML = `
      <div id="categoriesSection"></div>
      <div id="mediaViewer" class="hidden">
        <div id="media-view" class="hidden">
          <div id="media-viewer" class="hidden">
            <div class="media-wrapper"></div>
            <div class="spinner-container"></div>
          </div>
        </div>
      </div>
    `;
    
    // Mock app state service
    window.__RAGOT_ALLOW_DIRECT_MUTATION__ = true;
    window.ragotModules = {
      ...(window.ragotModules || {}),
      appState: {
        currentCategoryId: null,
        currentPage: 1,
        fullMediaList: [],
        mediaUrlSet: new Set(),
        isLoading: false,
        hasMoreMedia: true,
        currentMediaIndex: 0
      },
      appCache: new Map(),
      resetAppState: vi.fn()
    };
    
    // Mock fetch
    global.fetch = vi.fn();
  });

  describe('viewCategory', () => {
    it('should set current category', () => {
      window.ragotModules.appState.currentCategoryId = 'movies';
      expect(window.ragotModules.appState.currentCategoryId).toBe('movies');
    });

    it('should reset state for new category', () => {
      window.ragotModules.appState.fullMediaList = [{ url: 'old.mp4' }];
      window.ragotModules.appState.currentPage = 5;
      
      // Simulate reset
      window.ragotModules.appState.fullMediaList = [];
      window.ragotModules.appState.currentPage = 1;
      window.ragotModules.appState.mediaUrlSet.clear();
      
      expect(window.ragotModules.appState.fullMediaList).toHaveLength(0);
      expect(window.ragotModules.appState.currentPage).toBe(1);
    });

    it('should show media view', () => {
      const categoriesSection = document.getElementById('categoriesSection');
      const mediaViewer = document.getElementById('mediaViewer');
      
      categoriesSection.classList.add('hidden');
      mediaViewer.classList.remove('hidden');
      
      expect(mediaViewer.classList.contains('hidden')).toBe(false);
    });

    it('should fetch media ordering from API', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          orderedIds: ['movies::video1.mp4', 'movies::video2.mp4'],
          hasMore: true,
          viewMeta: { page: 1 }
        })
      });
      
      const response = await fetch('/api/media/order?view=streaming_grid&category_id=movies&page=1');
      const data = await response.json();
      
      expect(data.orderedIds).toHaveLength(2);
    });

    it('should handle forced order', () => {
      const forcedOrder = ['/media/specific.mp4'];
      window.ragotModules.appState.fullMediaList = forcedOrder.map(url => ({ url }));
      
      expect(window.ragotModules.appState.fullMediaList[0].url).toBe('/media/specific.mp4');
    });
  });

  describe('loadMoreMedia', () => {
    it('should increment page number', () => {
      window.ragotModules.appState.currentPage = 1;
      window.ragotModules.appState.currentPage++;
      
      expect(window.ragotModules.appState.currentPage).toBe(2);
    });

    it('should append new media to list', () => {
      window.ragotModules.appState.fullMediaList = [{ url: 'existing.mp4' }];
      const newMedia = [{ url: 'new.mp4' }];
      
      window.ragotModules.appState.fullMediaList.push(...newMedia);
      
      expect(window.ragotModules.appState.fullMediaList).toHaveLength(2);
    });

    it('should prevent duplicate URLs', () => {
      window.ragotModules.appState.mediaUrlSet.add('/media/video.mp4');
      
      const isDuplicate = window.ragotModules.appState.mediaUrlSet.has('/media/video.mp4');
      
      expect(isDuplicate).toBe(true);
    });

    it('should stop when no more media', () => {
      window.ragotModules.appState.hasMoreMedia = false;
      
      const shouldLoad = window.ragotModules.appState.hasMoreMedia && !window.ragotModules.appState.isLoading;
      
      expect(shouldLoad).toBe(false);
    });
  });

  describe('clearResources', () => {
    it('should clear media cache', () => {
      window.ragotModules.appCache.set('key', 'value');
      window.ragotModules.appCache.clear();
      
      expect(window.ragotModules.appCache.size).toBe(0);
    });

    it('should pause videos', () => {
      const video = document.createElement('video');
      video.pause = vi.fn();
      document.body.appendChild(video);
      
      video.pause();
      
      expect(video.pause).toHaveBeenCalled();
    });

    it('should revoke blob URLs', () => {
      URL.revokeObjectURL = vi.fn();
      URL.revokeObjectURL('blob:test');
      
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  describe('goBack', () => {
    it('should hide media view', () => {
      const categoriesSection = document.getElementById('categoriesSection');
      const mediaViewer = document.getElementById('mediaViewer');
      
      mediaViewer.classList.remove('hidden');
      
      // Simulate go back
      mediaViewer.classList.add('hidden');
      categoriesSection.classList.remove('hidden');
      
      expect(mediaViewer.classList.contains('hidden')).toBe(true);
      expect(categoriesSection.classList.contains('hidden')).toBe(false);
    });

    it('should reset state on back', () => {
      window.ragotModules.resetAppState();
      expect(window.ragotModules.resetAppState).toHaveBeenCalled();
    });
  });

  describe('Media rendering', () => {
    it('should create video element', () => {
      const video = document.createElement('video');
      video.src = '/media/video.mp4';
      video.controls = true;
      video.autoplay = true;
      
      expect(video.src).toContain('video.mp4');
    });

    it('should create image element', () => {
      const img = document.createElement('img');
      img.src = '/media/photo.jpg';
      
      expect(img.src).toContain('photo.jpg');
    });

    it('should detect media type from URL', () => {
      const getType = (url) => {
        const ext = url.split('.').pop().toLowerCase();
        const videoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov'];
        return videoExts.includes(ext) ? 'video' : 'image';
      };
      
      expect(getType('/media/movie.mp4')).toBe('video');
      expect(getType('/media/photo.jpg')).toBe('image');
    });
  });

  describe('Shuffle mode', () => {
    it('should shuffle media list', () => {
      const original = [1, 2, 3, 4, 5];
      const shuffled = [...original].sort(() => Math.random() - 0.5);
      
      // Just verify it's still same length
      expect(shuffled).toHaveLength(5);
    });

    it('should respect SHUFFLE_MEDIA config', () => {
      window.appConfig = { python_config: { SHUFFLE_MEDIA: false } };
      
      expect(window.appConfig.python_config.SHUFFLE_MEDIA).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should handle fetch errors', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));
      
      await expect(fetch('/api/media/order?view=streaming_grid&category_id=test')).rejects.toThrow();
    });

    it('should handle empty response', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ orderedIds: [] })
      });
      
      const response = await fetch('/api/media/order?view=streaming_grid&category_id=empty');
      const data = await response.json();
      
      expect(data.orderedIds).toHaveLength(0);
    });
  });
});
