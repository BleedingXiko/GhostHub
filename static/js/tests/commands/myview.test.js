/**
 * MyView Command Unit Tests
 * Tests for /myview command - share current view
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/authManager.js', () => ({
  ensureFeatureAccess: vi.fn(() => Promise.resolve(true))
}));

import { myview } from '../../commands/myview.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';
import { mediaManifest } from '../../modules/media/manifest.js';
import { mediaOrdering } from '../../modules/media/ordering.js';

describe('MyView Command', () => {
  let mockSocket;
  let mockDisplayMessage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = {
      emit: vi.fn(),
      id: 'test-socket-id'
    };
    mockDisplayMessage = vi.fn();

    mediaManifest.clear();
    mediaOrdering.orders.clear();
    mediaManifest.ingest({
      'movies::movie5.mp4': { id: 'movies::movie5.mp4', url: '/media/movie5.mp4', name: 'Movie 5' }
    }, []);
    mediaOrdering.ingestView('movies-view', {
      viewKey: 'movies-view',
      viewType: 'streaming_grid',
      orderedIds: ['movies::movie5.mp4'],
      params: { category_id: 'movies', media_filter: 'all' }
    });

    window.ragotModules = {
      mediaManifest,
      mediaOrdering,
      appState: {
        currentCategoryId: 'movies',
        viewer: { viewKey: 'movies-view', activeIndex: 0 }
      }
    };
  });

  describe('exports', () => {
    it('should export myview command object', () => {
      expect(myview).toBeDefined();
    });

    it('should have execute function', () => {
      expect(myview.execute).toBeInstanceOf(Function);
    });

    it('should have getHelpText function', () => {
      expect(myview.getHelpText).toBeInstanceOf(Function);
    });

    it('should have description', () => {
      expect(myview.description).toBeDefined();
    });
  });

  describe('getHelpText', () => {
    it('should return help text', () => {
      const helpText = myview.getHelpText();
      expect(helpText).toContain('/myview');
    });
  });

  describe('execute', () => {
    it('should check password protection', async () => {
      await myview.execute(mockSocket, mockDisplayMessage, '');
      expect(ensureFeatureAccess).toHaveBeenCalled();
    });

    it('should deny access if password not validated', async () => {
      vi.mocked(ensureFeatureAccess).mockResolvedValueOnce(false);

      await myview.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('Password required.'),
        expect.objectContaining({ icon: 'stop' })
      );
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should show error if no category loaded', async () => {
      window.ragotModules.appState.currentCategoryId = null;

      await myview.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('No media open'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should show error if no media index', async () => {
      window.ragotModules.appState.viewer = null;

      await myview.execute(mockSocket, mockDisplayMessage, '');

      expect(mockDisplayMessage).toHaveBeenCalledWith(
        expect.stringContaining('No media open'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should emit command event with view info', async () => {
      await myview.execute(mockSocket, mockDisplayMessage, '');

      expect(mockSocket.emit).toHaveBeenCalledWith('command', {
        cmd: 'myview',
        arg: {
          category_id: 'movies',
          viewKey: 'movies-view',
          viewType: 'streaming_grid',
          viewParams: { category_id: 'movies', media_filter: 'all' },
          mediaId: 'movies::movie5.mp4'
        },
        from: 'test-socket-id'
      });
    });
  });
});
