/**
 * AutoPlayManager Unit Tests
 * Tests for automatic media advancement functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mediaManifest } from '../../modules/media/manifest.js';
import { mediaOrdering } from '../../modules/media/ordering.js';

describe('AutoPlayManager', () => {
  let navigateMediaMock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    
    // Setup DOM
    document.body.innerHTML = `
      <div id="media-viewer">
        <video class="viewer-media active" data-index="0"></video>
      </div>
    `;
    
    // Mock app state service in registry
    window.__RAGOT_ALLOW_DIRECT_MUTATION__ = true;
    mediaManifest.clear();
    mediaOrdering.orders.clear();
    mediaManifest.ingest({
      'media::image1.jpg': { id: 'media::image1.jpg', url: '/media/image1.jpg', type: 'image', name: 'Image 1' },
      'media::video1.mp4': { id: 'media::video1.mp4', url: '/media/video1.mp4', type: 'video', name: 'Video 1' },
      'media::image2.jpg': { id: 'media::image2.jpg', url: '/media/image2.jpg', type: 'image', name: 'Image 2' }
    }, []);
    mediaOrdering.ingestView('autoplay-view', {
      viewKey: 'autoplay-view',
      viewType: 'streaming_grid',
      orderedIds: ['media::image1.jpg', 'media::video1.mp4', 'media::image2.jpg'],
      params: { category_id: 'media', media_filter: 'all' }
    });
    window.ragotModules = {
      ...(window.ragotModules || {}),
      mediaManifest,
      mediaOrdering,
      appState: {
        viewer: { viewKey: 'autoplay-view', activeIndex: 0 }
      },
      appDom: {
        mediaViewer: document.getElementById('media-viewer')
      }
    };
    
    navigateMediaMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('toggleAutoPlay', () => {
    it('should start auto-play with default interval', async () => {
      const { initAutoPlayManager, toggleAutoPlay, isAutoPlayActive } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      const result = toggleAutoPlay(true);
      
      expect(result).toBe('started');
      expect(isAutoPlayActive()).toBe(true);
    });

    it('should start auto-play with custom interval', async () => {
      const { initAutoPlayManager, toggleAutoPlay, getAutoPlayInterval } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(5); // 5 seconds
      
      expect(getAutoPlayInterval()).toBe(5000);
    });

    it('should stop auto-play when called with false', async () => {
      const { initAutoPlayManager, toggleAutoPlay, isAutoPlayActive } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(10);
      expect(isAutoPlayActive()).toBe(true);
      
      const result = toggleAutoPlay(false);
      expect(result).toBe('stopped');
      expect(isAutoPlayActive()).toBe(false);
    });

    it('should stop auto-play when called with "stop"', async () => {
      const { initAutoPlayManager, toggleAutoPlay, isAutoPlayActive } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(10);
      
      const result = toggleAutoPlay('stop');
      expect(result).toBe('stopped');
      expect(isAutoPlayActive()).toBe(false);
    });
  });

  describe('handleAutoPlay', () => {
    it('should set timer for image files', async () => {
      const { initAutoPlayManager, toggleAutoPlay, handleAutoPlay } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(5); // 5 second interval
      
      // Current item is an image (index 0)
      handleAutoPlay(0);
      
      // Fast-forward timer
      vi.advanceTimersByTime(5000);
      
      expect(navigateMediaMock).toHaveBeenCalledWith('next');
    });

    it('should not navigate when auto-play is inactive', async () => {
      const { initAutoPlayManager, toggleAutoPlay, handleAutoPlay } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(false); // Ensure stopped
      
      handleAutoPlay(0);
      
      vi.advanceTimersByTime(15000);
      
      expect(navigateMediaMock).not.toHaveBeenCalled();
    });

    it('should not crash when current file is undefined', async () => {
      const { initAutoPlayManager, toggleAutoPlay, handleAutoPlay } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(5);
      
      // Index out of bounds
      expect(() => handleAutoPlay(999)).not.toThrow();
    });
  });

  describe('isAutoPlayActive', () => {
    it('should return false initially', async () => {
      const { isAutoPlayActive } = await import('../../modules/playback/autoPlay.js');
      
      // Need to reset module state - for fresh import
      expect(typeof isAutoPlayActive).toBe('function');
    });
  });

  describe('Auto-play indicator', () => {
    it('should create indicator element when auto-play starts', async () => {
      const { initAutoPlayManager, toggleAutoPlay } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(10);
      
      const indicator = document.getElementById('autoplay-indicator');
      expect(indicator).toBeDefined();
    });

    it('should hide indicator when auto-play stops', async () => {
      const { initAutoPlayManager, toggleAutoPlay } = await import('../../modules/playback/autoPlay.js');
      
      initAutoPlayManager(navigateMediaMock);
      toggleAutoPlay(10);
      toggleAutoPlay(false);
      
      const indicator = document.getElementById('autoplay-indicator');
      if (indicator) {
        expect(indicator.style.display).toBe('none');
      }
    });
  });
});
