/**
 * Tests for Progress Sync Module
 * Tests progress tracking, state updates, and sync emissions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock app module
vi.mock('../../../core/app.js', () => ({
    app: {
        state: {
            fullMediaList: [],
            currentMediaIndex: 0,
            trackingMode: 'category'
        }
    },
    mediaViewer: document.createElement('div')
}));

// Mock progressDB before importing module under test
vi.mock('../../../utils/progressDB.js', () => ({
    isUserAdmin: vi.fn(() => false),
    isSessionProgressEnabled: vi.fn(() => true),
    isTvAuthorityForCategory: vi.fn(() => false),
    deleteVideoLocalProgress: vi.fn(),
    saveLocalProgress: vi.fn(),
    saveVideoLocalProgress: vi.fn()
}));

// Import the module under test AFTER setting up mocks
import {
    initProgressSync,
    getCurrentVideoProgress,
    emitMyStateUpdate
} from '../../../modules/media/progressSync.js';

// Import mocked modules to use in tests
import * as progressDB from '../../../utils/progressDB.js';
import { app, mediaViewer } from '../../../core/app.js';

describe('Progress Sync Module', () => {
    let mockSocket;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Setup mock socket
        mockSocket = {
            connected: true,
            emit: vi.fn()
        };

        // Reset DOM
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('data-layout');
        mediaViewer.innerHTML = '';

        // Reset mock return values
        vi.mocked(progressDB.isUserAdmin).mockReturnValue(false);
        vi.mocked(progressDB.isSessionProgressEnabled).mockReturnValue(true);
        vi.mocked(progressDB.isTvAuthorityForCategory).mockReturnValue(false);

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
            appDom: { mediaViewer }
        };
    });

    describe('initProgressSync', () => {
        it('should initialize with socket instance', () => {
            expect(() => initProgressSync(mockSocket)).not.toThrow();
        });

        it('should allow null socket', () => {
            expect(() => initProgressSync(null)).not.toThrow();
        });
    });

    describe('getCurrentVideoProgress', () => {
        it('should be callable', () => {
            expect(() => getCurrentVideoProgress()).not.toThrow();
        });

        it('should accept requirePlaying parameter', () => {
            expect(() => getCurrentVideoProgress(true)).not.toThrow();
            expect(() => getCurrentVideoProgress(false)).not.toThrow();
        });

        it('should return null or object', () => {
            const result = getCurrentVideoProgress();
            expect(result === null || typeof result === 'object').toBe(true);
        });

        it('should read nested active viewer video without scanning stale document videos', () => {
            const staleVideo = document.createElement('video');
            Object.defineProperty(staleVideo, 'duration', { value: 800, configurable: true });
            Object.defineProperty(staleVideo, 'currentTime', { value: 790, configurable: true });
            Object.defineProperty(staleVideo, 'paused', { value: false, configurable: true });
            document.body.appendChild(staleVideo);

            mediaViewer.innerHTML = `
                <div class="viewer-media active ghoststream-transcode-container">
                    <video class="ghoststream-video"></video>
                </div>
            `;

            const nestedVideo = mediaViewer.querySelector('video');
            Object.defineProperty(nestedVideo, 'duration', { value: 1000, configurable: true });
            Object.defineProperty(nestedVideo, 'currentTime', { value: 760, configurable: true });
            Object.defineProperty(nestedVideo, 'paused', { value: false, configurable: true });
            nestedVideo.dataset.hlsTimeOffset = '0';
            nestedVideo.dataset.hlsSourceDuration = '1000';

            expect(getCurrentVideoProgress()).toEqual({
                video_timestamp: 760,
                video_duration: 1000
            });
        });
    });

    describe('emitMyStateUpdate', () => {
        beforeEach(() => {
            initProgressSync(mockSocket);
        });

        it('should warn and return early when socket is not initialized', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            initProgressSync(null);

            emitMyStateUpdate('category-1', 0);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Socket instance is not available'));
            consoleSpy.mockRestore();
        });

        it('should warn when socket is not connected', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            mockSocket.connected = false;

            emitMyStateUpdate('category-1', 0);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Socket not connected'));
            consoleSpy.mockRestore();
        });

        it('should validate categoryId', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            emitMyStateUpdate('', 0);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid categoryId'));

            consoleSpy.mockRestore();
        });

        it('should validate index', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            emitMyStateUpdate('category-1', -1);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid index'));

            consoleSpy.mockRestore();
        });
    });

});
