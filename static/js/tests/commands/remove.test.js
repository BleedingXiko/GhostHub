/**
 * Remove Command Unit Tests
 * Tests for /remove command - removes from shared playlist
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { remove } from '../../commands/remove.js';
import { mediaManifest } from '../../modules/media/manifest.js';
import { mediaOrdering } from '../../modules/media/ordering.js';

describe('Remove Command', () => {
  let mockSocket;
  let mockDisplayMessage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = { emit: vi.fn() };
    mockDisplayMessage = vi.fn();
    global.fetch = vi.fn();

    const mockAppState = {
      currentCategoryId: 'session-playlist',
      viewer: { viewKey: 'playlist-view', activeIndex: 0 }
    };
    mediaManifest.clear();
    mediaOrdering.orders.clear();
    mediaManifest.ingest({
      'session-playlist::movie1.mp4': { id: 'session-playlist::movie1.mp4', url: '/media/movie1.mp4', name: 'Movie 1' },
      'session-playlist::movie2.mp4': { id: 'session-playlist::movie2.mp4', url: '/media/movie2.mp4', name: 'Movie 2' }
    }, []);
    mediaOrdering.ingestView('playlist-view', {
      viewKey: 'playlist-view',
      viewType: 'streaming_grid',
      orderedIds: ['session-playlist::movie1.mp4', 'session-playlist::movie2.mp4'],
      params: { category_id: 'session-playlist', media_filter: 'all' }
    });

    window.ragotModules = {
      mediaManifest,
      mediaOrdering,
      appState: mockAppState,
      appStore: {
        getState: vi.fn(() => mockAppState),
        get: vi.fn((key, fallback) => mockAppState[key] ?? fallback),
        actions: {
          setField: vi.fn((key, value) => { mockAppState[key] = value; }),
          patchState: vi.fn(),
          batchState: vi.fn(),
        }
      },
      mediaNavigation: {
        renderMediaWindow: vi.fn(),
        goBackToCategories: vi.fn()
      }
    };
  });

  describe('exports', () => {
    it('should export remove command object', () => {
      expect(remove).toBeDefined();
    });

    it('should have execute function', () => {
      expect(remove.execute).toBeInstanceOf(Function);
    });

    it('should have getHelpText function', () => {
      expect(remove.getHelpText).toBeInstanceOf(Function);
    });

    it('should have description', () => {
      expect(remove.description).toBeDefined();
    });
  });

  describe('getHelpText', () => {
    it('should return help text', () => {
      const helpText = remove.getHelpText();
      expect(helpText).toContain('/remove');
    });
  });

  describe('execute', () => {
    it('should show error if not in session playlist', async () => {
      window.ragotModules.appState.currentCategoryId = 'movies';

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('Only works in the Shared Playlist.'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should show error if no media selected', async () => {
      window.ragotModules.appState.viewer = null;

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('No item selected.'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should show error if index out of range', async () => {
      window.ragotModules.appState.viewer.activeIndex = 100;

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('No item selected.'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should call API to remove from playlist', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(fetch).toHaveBeenCalledWith(
        '/api/session/playlist/remove',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });

    it('should show success message on success', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('Removed'),
        expect.objectContaining({ icon: 'checkCircle' })
      );
    });

    it('should go back to categories if last item removed', async () => {
      mediaOrdering.ingestView('playlist-view', {
        ...mediaOrdering.selectView('playlist-view'),
        orderedIds: ['session-playlist::movie1.mp4']
      });

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(window.ragotModules.mediaNavigation.goBackToCategories).toHaveBeenCalled();
    });

    it('should render next item after remove', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(window.ragotModules.mediaNavigation.renderMediaWindow).toHaveBeenCalled();
    });

    it('should update ordering without mutating original list', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mediaOrdering.selectView('playlist-view').orderedIds).toEqual(['session-playlist::movie2.mp4']);
    });

    it('should show error message on failure', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ success: false, message: 'Failed' })
      });

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should handle fetch errors', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      await remove.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove.'),
        expect.objectContaining({ icon: 'x' })
      );
    });
  });
});
