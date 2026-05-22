/**
 * Random Command Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/authManager.js', () => ({
  ensureFeatureAccess: vi.fn(() => Promise.resolve(true))
}));

import { random } from '../../commands/random.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';

describe('Random Command', () => {
  let mockSocket;
  let displayLocalMessage;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = {};
    displayLocalMessage = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ categories: [] })
    });

    document.body.innerHTML = `
      <div id="media-viewer" class="hidden"></div>
      <div id="media-view" class="hidden"></div>
    `;

    window.ragotModules = {
      appState: {
        currentCategoryId: null,
        viewer: null
      },
      mediaLoader: {
        openCategoryViewer: vi.fn().mockResolvedValue(undefined)
      },
      mediaNavigation: {
        renderMediaWindow: vi.fn()
      },
      mediaOrdering: {
        selectView: vi.fn(() => ({ orderedIds: [], hasMore: false, viewMeta: {} })),
        getOrder: vi.fn(() => ({ orderedIds: [], hasMore: false, viewMeta: {} })),
      },
      mediaManifest: {
        getMany: vi.fn(() => []),
        get: vi.fn(() => null),
        recordsVersion: 1,
      }
    };
  });

  describe('random object', () => {
    it('should have required properties', () => {
      expect(random.description).toBeDefined();
      expect(random.getHelpText).toBeInstanceOf(Function);
      expect(random.execute).toBeInstanceOf(Function);
    });

    it('should return help text', () => {
      const helpText = random.getHelpText();
      expect(helpText).toContain('/random');
    });
  });

  describe('execute', () => {
    it('should check password protection', async () => {
      await random.execute(mockSocket, displayLocalMessage, '');
      expect(ensureFeatureAccess).toHaveBeenCalled();
    });

    it('should reject access when password validation fails', async () => {
      vi.mocked(ensureFeatureAccess).mockResolvedValueOnce(false);
      await random.execute(mockSocket, displayLocalMessage, '');

      expect(displayLocalMessage).toHaveBeenCalledWith(
        expect.stringContaining('Password required.'),
        expect.objectContaining({ icon: 'stop' })
      );
    });

    it('should handle missing app modules gracefully', async () => {
      window.ragotModules = null;
      await random.execute(mockSocket, displayLocalMessage, '');

      expect(displayLocalMessage).toHaveBeenCalledWith(
        expect.stringContaining('App not ready.'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    it('should handle missing mediaLoader', async () => {
      window.ragotModules = {
        appState: { currentCategoryId: null, viewer: null },
        mediaNavigation: {}
      };
      await random.execute(mockSocket, displayLocalMessage, '');

      expect(displayLocalMessage).toHaveBeenCalledWith(
        expect.stringContaining('Media modules not available.'),
        expect.objectContaining({ icon: 'x' })
      );
    });

    describe('when in media view with loaded media', () => {
      beforeEach(() => {
        window.ragotModules.appState.currentCategoryId = 'cat1';
        window.ragotModules.appState.viewer = { viewKey: 'viewer::cat1', activeIndex: 0 };
        window.ragotModules.mediaOrdering.selectView.mockReturnValue({ orderedIds: ['1', '2', '3'], hasMore: false, viewMeta: {} });
        window.ragotModules.mediaManifest.getMany.mockReturnValue([
          { id: '1', url: '/media/1.mp4' },
          { id: '2', url: '/media/2.mp4' },
          { id: '3', url: '/media/3.mp4' }
        ]);
        document.getElementById('media-viewer').classList.remove('hidden');
        document.getElementById('media-view').classList.remove('hidden');
      });

      it('should pick random from current category', async () => {
        await random.execute(mockSocket, displayLocalMessage, '');

        expect(window.ragotModules.mediaNavigation.renderMediaWindow).toHaveBeenCalled();
        expect(displayLocalMessage).toHaveBeenCalledWith(
          'Jumped to a random item.',
          expect.objectContaining({ icon: 'checkCircle' })
        );
      });

      it('should force new category with "new" argument', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              categories: [{ id: 'cat2', name: 'Other Category', mediaCount: 5 }]
            })
        });

        await random.execute(mockSocket, displayLocalMessage, 'new');

        expect(displayLocalMessage).toHaveBeenCalledWith(
          'Jumped to a random item.',
          expect.objectContaining({ icon: 'checkCircle' })
        );
        expect(window.ragotModules.mediaLoader.openCategoryViewer).toHaveBeenCalledWith({ categoryId: 'cat2', startIndex: 0 });
      });
    });

    describe('when selecting new category', () => {
      it('should fetch categories from API', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              categories: [{ id: 'cat1', name: 'Category 1', mediaCount: 10 }]
            })
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(fetch).toHaveBeenCalled();
        const fetchCall = fetch.mock.calls[0][0];
        expect(fetchCall).toMatch(/\/api\/categories/);
      });

      it('should handle empty categories', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ categories: [] })
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(displayLocalMessage).toHaveBeenCalledWith(
          expect.stringContaining('No categories available'),
          expect.objectContaining({ icon: 'x' })
        );
      });

      it('should filter categories with no media', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              categories: [
                { id: 'empty', name: 'Empty', mediaCount: 0 },
                { id: 'hasMedia', name: 'Has Media', mediaCount: 5 }
              ]
            })
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(window.ragotModules.mediaLoader.openCategoryViewer).toHaveBeenCalledWith({ categoryId: 'hasMedia', startIndex: 0 });
      });

      it('should handle API errors', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(displayLocalMessage).toHaveBeenCalledWith(
          expect.stringContaining('Error'),
          expect.objectContaining({ icon: 'x' })
        );
      });

      it('should handle legacy array response format', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve([{ id: 'cat1', name: 'Category 1', mediaCount: 10 }])
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(window.ragotModules.mediaLoader.openCategoryViewer).toHaveBeenCalled();
      });

      it('should call openCategoryViewer with selected category', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              categories: [{ id: 'testCat', name: 'Test Category', mediaCount: 5 }]
            })
        });

        await random.execute(mockSocket, displayLocalMessage, '');

        expect(window.ragotModules.mediaLoader.openCategoryViewer).toHaveBeenCalledWith({ categoryId: 'testCat', startIndex: 0 });
      });
    });
  });
});
