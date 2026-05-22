/**
 * Tests for Auto-Play Manager Module
 * Tests automatic media advancement and slideshow functionality.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    initAutoPlayManager,
    toggleAutoPlay,
    handleAutoPlay,
    isAutoPlayActive,
    getAutoPlayInterval,
    updateAutoPlayIndicator
} from '../../../modules/playback/autoPlay.js';
import { mediaManifest } from '../../../modules/media/manifest.js';
import { mediaOrdering } from '../../../modules/media/ordering.js';

describe('Auto-Play Manager Module', () => {
    let mockNavigate;

    beforeEach(() => {
        // Reset DOM
        document.body.innerHTML = '';
        document.head.innerHTML = '';

        // Create media viewer
        const container = document.createElement('div');
        container.id = 'media-viewer';
        document.body.appendChild(container);

        // Mock appState service in registry
        window.__RAGOT_ALLOW_DIRECT_MUTATION__ = true;
        mediaManifest.clear();
        mediaOrdering.orders.clear();
        mediaManifest.ingest({
            'media::image1.jpg': { id: 'media::image1.jpg', type: 'image', name: 'image1.jpg', url: '/media/image1.jpg' },
            'media::video1.mp4': { id: 'media::video1.mp4', type: 'video', name: 'video1.mp4', url: '/media/video1.mp4' },
            'media::image2.jpg': { id: 'media::image2.jpg', type: 'image', name: 'image2.jpg', url: '/media/image2.jpg' }
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
                mediaViewer: container
            },
            mediaNavigation: {
                activateVideoThumbnail: vi.fn(() => true)
            }
        };

        mockNavigate = vi.fn();
        initAutoPlayManager(mockNavigate);

        // Use fake timers
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        toggleAutoPlay(false); // Stop auto-play
    });

    describe('initAutoPlayManager', () => {
        it('should initialize with navigate function', () => {
            expect(() => initAutoPlayManager(mockNavigate)).not.toThrow();
        });

        it('should set up fullscreen event listeners', () => {
            const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

            initAutoPlayManager(mockNavigate);

            expect(addEventListenerSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function), undefined);
            expect(addEventListenerSpy).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function), undefined);
            expect(addEventListenerSpy).toHaveBeenCalledWith('mozfullscreenchange', expect.any(Function), undefined);
        });
    });

    describe('toggleAutoPlay', () => {
        it('should start auto-play with default interval', () => {
            const result = toggleAutoPlay(true);

            expect(result).toBe('started');
            expect(isAutoPlayActive()).toBe(true);
        });

        it('should start auto-play with custom interval', () => {
            toggleAutoPlay(5); // 5 seconds

            expect(isAutoPlayActive()).toBe(true);
            expect(getAutoPlayInterval()).toBe(5000); // 5000ms
        });

        it('should stop auto-play', () => {
            toggleAutoPlay(true);
            expect(isAutoPlayActive()).toBe(true);

            const result = toggleAutoPlay(false);

            expect(result).toBe('stopped');
            expect(isAutoPlayActive()).toBe(false);
        });

        it('should stop auto-play with "stop" string', () => {
            toggleAutoPlay(true);

            toggleAutoPlay('stop');

            expect(isAutoPlayActive()).toBe(false);
        });

        it('should show indicator when started', () => {
            toggleAutoPlay(true);

            const indicator = document.getElementById('autoplay-indicator');
            expect(indicator).not.toBeNull();
            expect(indicator.style.display).toBe('flex');
        });

        it('should hide indicator when stopped', () => {
            toggleAutoPlay(true);
            const indicator = document.getElementById('autoplay-indicator');

            toggleAutoPlay(false);

            expect(indicator.style.display).toBe('none');
        });

        it('should create indicator element if not exists', () => {
            expect(document.getElementById('autoplay-indicator')).toBeNull();

            toggleAutoPlay(true);

            const indicator = document.getElementById('autoplay-indicator');
            expect(indicator).not.toBeNull();
            expect(indicator.innerHTML).toBe('▶');
        });

        it('should add animation styles', () => {
            toggleAutoPlay(true);

            const styles = document.getElementById('autoplay-styles');
            expect(styles).not.toBeNull();
            expect(styles.textContent).toContain('autoplay-pulse');
        });
    });

    describe('handleAutoPlay - Images', () => {
        it('should set timer for image auto-advance', () => {
            toggleAutoPlay(10); // 10 seconds
            window.ragotModules.appState.viewer.activeIndex = 0; // First item is image

            handleAutoPlay(0);

            // Timer should be set
            expect(mockNavigate).not.toHaveBeenCalled();

            // Fast-forward time
            vi.advanceTimersByTime(10000);

            expect(mockNavigate).toHaveBeenCalledWith('next');
        });

        it('should not advance if auto-play stopped before timer', () => {
            toggleAutoPlay(10);
            handleAutoPlay(0);

            toggleAutoPlay(false); // Stop auto-play

            vi.advanceTimersByTime(10000);

            expect(mockNavigate).not.toHaveBeenCalled();
        });

        it('should clear previous timer when handling new item', () => {
            toggleAutoPlay(10);

            handleAutoPlay(0);
            vi.advanceTimersByTime(5000); // Halfway through

            handleAutoPlay(2); // Navigate to another image
            vi.advanceTimersByTime(5000); // Should NOT fire old timer

            expect(mockNavigate).not.toHaveBeenCalled();

            vi.advanceTimersByTime(5000); // Complete new timer

            expect(mockNavigate).toHaveBeenCalledWith('next');
            expect(mockNavigate).toHaveBeenCalledTimes(1);
        });
    });

    describe('handleAutoPlay - Videos', () => {
        it('should disable video loop when auto-play active', () => {
            const video = document.createElement('video');
            video.className = 'viewer-media active';
            video.setAttribute('data-index', '1');
            video.loop = true;

            // Mock paused property and play method
            Object.defineProperty(video, 'paused', {
                get: () => false,
                configurable: true
            });
            video.play = vi.fn(() => Promise.resolve());

            document.getElementById('media-viewer').appendChild(video);

            window.ragotModules.appState.viewer.activeIndex = 1; // Video item
            toggleAutoPlay(true);

            handleAutoPlay(1);

            expect(video.loop).toBe(false);
            expect(video.hasAttribute('loop')).toBe(false);
        });

        it('should set onended handler to advance to next', () => {
            const video = document.createElement('video');
            video.className = 'viewer-media active';
            video.setAttribute('data-index', '1');

            // Mock paused property and play method
            Object.defineProperty(video, 'paused', {
                get: () => false,
                configurable: true
            });
            video.play = vi.fn(() => Promise.resolve());

            document.getElementById('media-viewer').appendChild(video);

            window.ragotModules.appState.viewer.activeIndex = 1;
            toggleAutoPlay(true);

            handleAutoPlay(1);

            expect(video._ragotHandlers?.ended).toBeTruthy();

            // Trigger ended event
            video.dispatchEvent(new Event('ended'));

            expect(mockNavigate).toHaveBeenCalledWith('next');
        });

        it('should try to play paused video', () => {
            const video = document.createElement('video');
            video.className = 'viewer-media active';
            video.setAttribute('data-index', '1');

            // Mock paused property and play method
            Object.defineProperty(video, 'paused', {
                get: () => true,
                configurable: true
            });
            video.play = vi.fn(() => Promise.resolve());

            document.getElementById('media-viewer').appendChild(video);

            window.ragotModules.appState.viewer.activeIndex = 1;
            toggleAutoPlay(true);

            handleAutoPlay(1);

            expect(video.play).toHaveBeenCalled();
        });

        it('should convert thumbnail container via mediaNavigation activation path', () => {
            const thumbnail = document.createElement('div');
            thumbnail.className = 'viewer-media active video-thumbnail-container';
            thumbnail.setAttribute('data-index', '1');
            document.getElementById('media-viewer').appendChild(thumbnail);

            window.ragotModules.appState.viewer.activeIndex = 1;
            toggleAutoPlay(true);

            handleAutoPlay(1);

            expect(window.ragotModules.mediaNavigation.activateVideoThumbnail).toHaveBeenCalledWith(thumbnail);
        });
    });

    describe('isAutoPlayActive', () => {
        it('should return false when auto-play inactive', () => {
            expect(isAutoPlayActive()).toBe(false);
        });

        it('should return true when auto-play active', () => {
            toggleAutoPlay(true);

            expect(isAutoPlayActive()).toBe(true);
        });
    });

    describe('getAutoPlayInterval', () => {
        it('should return default interval', () => {
            expect(getAutoPlayInterval()).toBe(10000); // Default 10s
        });

        it('should return custom interval', () => {
            toggleAutoPlay(15);

            expect(getAutoPlayInterval()).toBe(15000);
        });
    });

    describe('updateAutoPlayIndicator', () => {
        it('should show indicator when called with true', () => {
            updateAutoPlayIndicator(true);

            const indicator = document.getElementById('autoplay-indicator');
            expect(indicator).not.toBeNull();
            expect(indicator.style.display).toBe('flex');
        });

        it('should hide indicator when called with false', () => {
            updateAutoPlayIndicator(true);
            const indicator = document.getElementById('autoplay-indicator');

            updateAutoPlayIndicator(false);

            expect(indicator.style.display).toBe('none');
        });

        it('should not throw if indicator does not exist', () => {
            expect(() => updateAutoPlayIndicator(false)).not.toThrow();
        });
    });

    describe('Edge Cases', () => {
        it('should handle missing fullMediaList gracefully', () => {
            window.ragotModules.appState.viewer = null;
            toggleAutoPlay(true);

            expect(() => handleAutoPlay(0)).not.toThrow();
        });

        it('should handle missing viewer session', () => {
            window.ragotModules.appState.viewer = null;

            expect(() => toggleAutoPlay(true)).not.toThrow();
        });

        it('should handle missing media-viewer', () => {
            document.getElementById('media-viewer').remove();
            toggleAutoPlay(true);

            expect(() => handleAutoPlay(1)).not.toThrow();
        });

        it('should not advance if navigateMediaFn not set', () => {
            // Reinitialize without navigate function
            initAutoPlayManager(null);
            toggleAutoPlay(10);

            handleAutoPlay(0);
            vi.advanceTimersByTime(10000);

            // Should not crash, just not call anything
            expect(true).toBe(true);
        });
    });

    describe('Fullscreen Integration', () => {
        it('should set up fullscreen event listeners', () => {
            const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

            initAutoPlayManager(mockNavigate);

            const fullscreenListeners = addEventListenerSpy.mock.calls.filter(call =>
                call[0].includes('fullscreenchange')
            );

            expect(fullscreenListeners.length).toBeGreaterThan(0);
        });
    });
});
