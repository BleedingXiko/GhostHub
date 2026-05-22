/**
 * Media Module Index
 * Re-exports all media-related functionality.
 * 
 * @module media
 */

// Element Factory
export {
    UNPLAYABLE_FORMATS,
    requiresTranscoding,
    createCannotPlayElement,
    createVideoThumbnailElement,
    createImageElement,
    createPlaceholderElement,
    updateMediaInfoOverlay
} from './elementFactory.js';

// Video Player
export { createActualVideoElement } from './videoPlayer.js';

// Transcoding Player
export {
    initTranscodingPlayer,
    createTranscodingVideoElement,
    playWithTranscoding
} from './transcodingPlayer.js';

// Progress Sync
export {
    initProgressSync,
    getCurrentVideoProgress,
    emitMyStateUpdate,
    createVideoProgressSaver,
    updateMediaSession
} from './progressSync.js';

// Thumbnail Handler
export {
    initThumbnailHandler,
    setupThumbnailClickListener,
    activateThumbnailContainer
} from './thumbnailHandler.js';
