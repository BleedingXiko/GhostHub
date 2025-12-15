/**
 * GhostStream Manager Module
 * Handles integration with GhostStream transcoding server for video playback
 */

import { app } from '../core/app.js';

// GhostStream state
const ghoststreamState = {
    enabled: false,
    available: false,
    settings: null,
    activeJobs: new Map(), // Map of videoUrl -> jobInfo
    pollIntervals: new Map() // Map of jobId -> intervalId
};

/**
 * Initialize GhostStream manager
 * Fetches settings and checks availability
 */
async function initGhostStream() {
    try {
        // Fetch GhostStream settings
        const settingsResponse = await fetch('/api/ghoststream/settings');
        if (settingsResponse.ok) {
            ghoststreamState.settings = await settingsResponse.json();
            ghoststreamState.enabled = ghoststreamState.settings.enabled;
            
            if (ghoststreamState.enabled) {
                console.log('GhostStream enabled, checking availability...');
                await checkAvailability();
            } else {
                console.log('GhostStream is disabled in settings');
            }
        }
    } catch (error) {
        console.warn('Failed to initialize GhostStream:', error);
        ghoststreamState.enabled = false;
    }
    
    return ghoststreamState;
}

/**
 * Check if GhostStream server is available
 */
async function checkAvailability() {
    if (ghoststreamState.available) return true;
    
    try {
        const response = await fetch('/api/ghoststream/health');
        if (response.ok) {
            const data = await response.json();
            ghoststreamState.available = data.available;
            
            if (!data.available && ghoststreamState.settings?.server) {
                const connected = await tryAutoConnect();
                if (connected) {
                    ghoststreamState.available = true;
                    return true;
                }
            }
        }
    } catch (error) {
        ghoststreamState.available = false;
    }
    
    return ghoststreamState.available;
}

/**
 * Try to auto-connect to GhostStream using test-connection
 */
async function tryAutoConnect() {
    try {
        const serverUrl = ghoststreamState.settings?.server || '';
        if (!serverUrl) return false;
        
        const response = await fetch('/api/ghoststream/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server_url: serverUrl })
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                console.log('GhostStream auto-connect successful!');
                ghoststreamState.available = true;
                return true;
            }
        }
    } catch (error) {
        console.warn('GhostStream auto-connect failed:', error);
    }
    return false;
}

/**
 * Check if a video file needs transcoding based on its extension
 * @param {string} filename - The video filename
 * @returns {boolean} - True if transcoding is recommended
 */
function needsTranscoding(filename) {
    if (!filename) return false;
    
    const ext = filename.toLowerCase().split('.').pop();
    
    // Formats that typically need transcoding for browser playback
    const transcodingNeeded = [
        'mkv', 'avi', 'wmv', 'flv', 'm4v', 'mov',
        'ts', 'm2ts', 'vob', 'mpg', 'mpeg', 'mts',
        'divx', 'asf', 'rm', 'rmvb', '3gp'
    ];
    
    // HEVC/H.265 files often need transcoding even in MP4 container
    // This is a heuristic - ideally we'd check the actual codec
    const hevcIndicators = ['hevc', 'h265', 'x265'];
    const lowerFilename = filename.toLowerCase();
    const hasHevcIndicator = hevcIndicators.some(ind => lowerFilename.includes(ind));
    
    return transcodingNeeded.includes(ext) || hasHevcIndicator;
}

/**
 * Start transcoding a video
 * @param {string} categoryId - The category ID
 * @param {string} filename - The video filename
 * @param {Object} options - Optional transcoding options
 * @returns {Promise<Object|null>} - Job info or null on failure
 */
async function startTranscode(categoryId, filename, options = {}) {
    if (!ghoststreamState.available) {
        console.warn('GhostStream not available for transcoding');
        return null;
    }
    
    const videoKey = `${categoryId}/${filename}`;
    
    // Check if we already have an active job for this video
    if (ghoststreamState.activeJobs.has(videoKey)) {
        const existingJob = ghoststreamState.activeJobs.get(videoKey);
        console.log(`Using existing transcode job for ${filename}: ${existingJob.job_id}`);
        return existingJob;
    }
    
    try {
        const requestBody = {
            category_id: categoryId,
            filename: filename,
            mode: options.mode || 'stream',
            format: options.format || (options.mode === 'batch' ? 'mp4' : 'hls'),
            resolution: options.resolution || ghoststreamState.settings?.default_resolution || '1080p',
            video_codec: options.video_codec || ghoststreamState.settings?.default_codec || 'h264',
            audio_codec: options.audio_codec || 'aac',
            bitrate: options.bitrate || 'auto',
            hw_accel: options.hw_accel || 'auto',
            start_time: options.start_time || 0,
            tone_map: options.tone_map !== undefined ? options.tone_map : true,
            two_pass: options.two_pass || false,
            max_audio_channels: options.max_audio_channels || 2
        };
        
        console.log(`Starting GhostStream transcode for ${filename} (mode: ${requestBody.mode})...`);
        
        const response = await fetch('/api/ghoststream/transcode/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        if (response.ok) {
            const job = await response.json();
            ghoststreamState.activeJobs.set(videoKey, job);
            console.log(`Transcode job started: ${job.job_id}, mode: ${job.mode}, stream_url: ${job.stream_url}`);
            return job;
        } else {
            const error = await response.json();
            console.error('Failed to start transcode:', error);
            return null;
        }
    } catch (error) {
        console.error('Transcode request failed:', error);
        return null;
    }
}

/**
 * Start HLS streaming transcode (single quality, fast startup)
 * @param {string} categoryId - The category ID
 * @param {string} filename - The video filename
 * @param {Object} options - Optional settings
 * @returns {Promise<Object|null>} - Job info or null
 */
async function startHlsStream(categoryId, filename, options = {}) {
    return startTranscode(categoryId, filename, {
        ...options,
        mode: 'stream',
        format: 'hls'
    });
}

/**
 * Start ABR (Adaptive Bitrate) streaming transcode
 * Automatically generates multiple quality variants
 * @param {string} categoryId - The category ID
 * @param {string} filename - The video filename
 * @param {Object} options - Optional settings
 * @returns {Promise<Object|null>} - Job info or null
 */
async function startAbrStream(categoryId, filename, options = {}) {
    return startTranscode(categoryId, filename, {
        ...options,
        mode: 'abr',
        format: 'hls',
        resolution: 'original' // ABR handles resolution automatically
    });
}

/**
 * Start batch (file-to-file) transcoding
 * Best for pre-transcoding library files
 * @param {string} categoryId - The category ID
 * @param {string} filename - The video filename
 * @param {Object} options - Optional settings
 * @returns {Promise<Object|null>} - Job info or null
 */
async function startBatchTranscode(categoryId, filename, options = {}) {
    return startTranscode(categoryId, filename, {
        ...options,
        mode: 'batch',
        format: options.format || 'mp4'
    });
}

/**
 * Get the status of a transcode job
 * @param {string} jobId - The job ID
 * @returns {Promise<Object|null>} - Job status or null
 */
async function getJobStatus(jobId) {
    try {
        const response = await fetch(`/api/ghoststream/transcode/${jobId}/status`);
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.warn(`Failed to get job status for ${jobId}:`, error);
    }
    return null;
}

/**
 * Wait for a job to be ready (with UI feedback)
 * @param {string} jobId - The job ID
 * @param {Function} onProgress - Callback for progress updates
 * @param {number} timeout - Max wait time in seconds
 * @returns {Promise<Object|null>} - Final job status or null
 */
async function waitForReady(jobId, onProgress = null, timeout = 30) {
    return new Promise((resolve) => {
        let elapsed = 0;
        const pollInterval = 1000; // 1 second
        
        const intervalId = setInterval(async () => {
            elapsed += pollInterval / 1000;
            
            if (elapsed >= timeout) {
                clearInterval(intervalId);
                ghoststreamState.pollIntervals.delete(jobId);
                console.warn(`Transcode timeout for job ${jobId}`);
                resolve(null);
                return;
            }
            
            const status = await getJobStatus(jobId);
            
            if (!status) {
                clearInterval(intervalId);
                ghoststreamState.pollIntervals.delete(jobId);
                resolve(null);
                return;
            }
            
            // Call progress callback
            if (onProgress) {
                onProgress(status);
            }
            
            // Check if ready or failed
            if (status.status === 'ready' || status.status === 'processing') {
                // For streaming, we can start playing as soon as we have a stream URL
                if (status.stream_url) {
                    clearInterval(intervalId);
                    ghoststreamState.pollIntervals.delete(jobId);
                    resolve(status);
                    return;
                }
            }
            
            if (status.status === 'error' || status.status === 'cancelled') {
                clearInterval(intervalId);
                ghoststreamState.pollIntervals.delete(jobId);
                console.error(`Transcode failed: ${status.error_message}`);
                resolve(status);
                return;
            }
        }, pollInterval);
        
        ghoststreamState.pollIntervals.set(jobId, intervalId);
    });
}

/**
 * Cancel a transcode job
 * @param {string} jobId - The job ID
 */
async function cancelJob(jobId) {
    // Stop polling
    if (ghoststreamState.pollIntervals.has(jobId)) {
        clearInterval(ghoststreamState.pollIntervals.get(jobId));
        ghoststreamState.pollIntervals.delete(jobId);
    }
    
    try {
        await fetch(`/api/ghoststream/transcode/${jobId}/cancel`, { method: 'POST' });
    } catch (error) {
        console.warn(`Failed to cancel job ${jobId}:`, error);
    }
    
    // Remove from active jobs
    for (const [key, job] of ghoststreamState.activeJobs.entries()) {
        if (job.job_id === jobId) {
            ghoststreamState.activeJobs.delete(key);
            break;
        }
    }
}

/**
 * Delete a transcode job and clean up resources
 * @param {string} jobId - The job ID
 */
async function deleteJob(jobId) {
    await cancelJob(jobId); // Cancel first if running
    
    try {
        await fetch(`/api/ghoststream/transcode/${jobId}`, { method: 'DELETE' });
    } catch (error) {
        console.warn(`Failed to delete job ${jobId}:`, error);
    }
}

/**
 * Clean up all active jobs (call on page unload or category change)
 */
function cleanupAllJobs() {
    console.log(`Cleaning up ${ghoststreamState.activeJobs.size} GhostStream jobs...`);
    
    // Stop all polling
    for (const intervalId of ghoststreamState.pollIntervals.values()) {
        clearInterval(intervalId);
    }
    ghoststreamState.pollIntervals.clear();
    
    // Delete all active jobs
    for (const job of ghoststreamState.activeJobs.values()) {
        deleteJob(job.job_id).catch(() => {});
    }
    ghoststreamState.activeJobs.clear();
}

/**
 * Get a transcoded video URL for playback
 * This is the main entry point for video playback with GhostStream
 * 
 * @param {Object} file - The file object with url, name, etc.
 * @param {string} categoryId - The category ID
 * @param {Object} options - Optional settings
 * @returns {Promise<{url: string, transcoded: boolean}>} - URL to play and whether it's transcoded
 */
async function getPlaybackUrl(file, categoryId, options = {}) {
    // If GhostStream is not available or auto-transcode is disabled, use original URL
    if (!ghoststreamState.available || !ghoststreamState.settings?.auto_transcode) {
        return { url: file.url, transcoded: false };
    }
    
    // Check if this file needs transcoding
    if (!needsTranscoding(file.name) && !options.forceTranscode) {
        return { url: file.url, transcoded: false };
    }
    
    console.log(`Video ${file.name} may need transcoding, attempting GhostStream...`);
    
    // Start transcoding
    const job = await startTranscode(categoryId, file.name, options);
    
    if (!job) {
        console.warn('Transcode failed, falling back to original URL');
        return { url: file.url, transcoded: false };
    }
    
    // If we already have a stream URL, use it
    if (job.stream_url) {
        return { url: job.stream_url, transcoded: true, jobId: job.job_id };
    }
    
    // Wait for stream to be ready
    const status = await waitForReady(job.job_id, (progress) => {
        console.log(`Transcode progress: ${progress.progress}%`);
    });
    
    if (status && status.stream_url) {
        return { url: status.stream_url, transcoded: true, jobId: job.job_id };
    }
    
    // Fallback to original URL
    console.warn('Transcode did not produce stream URL, falling back to original');
    return { url: file.url, transcoded: false };
}

/**
 * Create a transcoding status overlay element
 * @returns {HTMLElement} - The status overlay element
 */
function createStatusOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ghoststream-status-overlay';
    overlay.innerHTML = `
        <div class="ghoststream-status-content">
            <div class="ghoststream-spinner"></div>
            <div class="ghoststream-status-text">Preparing video...</div>
            <div class="ghoststream-progress-bar">
                <div class="ghoststream-progress-fill" style="width: 0%"></div>
            </div>
        </div>
    `;
    return overlay;
}

/**
 * Update status overlay with progress
 * @param {HTMLElement} overlay - The overlay element
 * @param {Object} status - Job status object
 */
function updateStatusOverlay(overlay, status) {
    const textEl = overlay.querySelector('.ghoststream-status-text');
    const progressEl = overlay.querySelector('.ghoststream-progress-fill');
    
    if (textEl) {
        if (status.status === 'queued') {
            textEl.textContent = 'Waiting to transcode...';
        } else if (status.status === 'processing') {
            let text = `Transcoding: ${Math.round(status.progress)}%`;
            if (status.eta_seconds && status.eta_seconds > 0) {
                const eta = Math.round(status.eta_seconds);
                if (eta < 60) {
                    text += ` (${eta}s remaining)`;
                } else {
                    text += ` (${Math.round(eta / 60)}m remaining)`;
                }
            }
            textEl.textContent = text;
        } else if (status.status === 'ready') {
            textEl.textContent = 'Ready!';
        } else if (status.status === 'error') {
            textEl.textContent = `Error: ${status.error_message || 'Unknown error'}`;
        }
    }
    
    if (progressEl) {
        progressEl.style.width = `${status.progress || 0}%`;
    }
}

/**
 * Create an HLS video element for transcoded content
 * @param {string} hlsUrl - The HLS stream URL (m3u8)
 * @param {Object} options - Video element options
 * @returns {HTMLVideoElement} - Configured video element
 */
function createHlsVideoElement(hlsUrl, options = {}) {
    const video = document.createElement('video');
    video.controls = options.controls !== false;
    video.autoplay = options.autoplay !== false;
    video.loop = options.loop || false;
    video.muted = true; // Start muted to allow autoplay
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    
    // Basic video styles
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    
    // Add double-click/tap for fullscreen
    video.addEventListener('dblclick', () => {
        toggleFullscreen(video);
    });
    
    // Double tap detection for mobile
    let lastTap = 0;
    video.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - lastTap < 300) {
            e.preventDefault();
            toggleFullscreen(video);
        }
        lastTap = now;
    });
    
    // Click to unmute on first interaction
    let hasInteracted = false;
    video.addEventListener('click', () => {
        if (!hasInteracted) {
            video.muted = false;
            hasInteracted = true;
        }
    });
    
    // Prefer hls.js over native (more reliable cross-browser)
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        // Use hls.js for browsers without native HLS support
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90,
            startLevel: -1, // Auto quality
            capLevelToPlayerSize: true
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS manifest parsed, ready to play');
            // Remove poster once video is ready
            video.removeAttribute('poster');
            video.style.background = 'transparent';
            if (options.autoplay !== false) {
                video.play().catch(e => console.warn('Autoplay failed:', e));
            }
        });
        
        // Also remove poster when first frame is shown
        video.addEventListener('loadeddata', () => {
            video.removeAttribute('poster');
            video.style.background = 'transparent';
            console.log('HLS video loadeddata - poster removed');
        }, { once: true });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                console.error('Fatal HLS error:', data.type, data.details);
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.log('Attempting to recover from network error...');
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log('Attempting to recover from media error...');
                        hls.recoverMediaError();
                        break;
                    default:
                        hls.destroy();
                        break;
                }
            }
        });
        
        // Store hls instance for cleanup
        video._hlsInstance = hls;
        console.log('Using hls.js for HLS playback');
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari)
        video.src = hlsUrl;
        if (options.autoplay !== false) {
            video.play().catch(e => console.warn('Autoplay failed:', e));
        }
    } else {
        console.error('No HLS support - hls.js not loaded and no native support');
    }
    
    return video;
}

/**
 * Toggle fullscreen for a video element
 */
function toggleFullscreen(video) {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (video.requestFullscreen) {
            video.requestFullscreen();
        } else if (video.webkitRequestFullscreen) {
            video.webkitRequestFullscreen();
        } else if (video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen(); // iOS
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

/**
 * Destroy HLS instance associated with a video element
 * @param {HTMLVideoElement} video - The video element
 */
function destroyHlsInstance(video) {
    if (video._hlsInstance) {
        video._hlsInstance.destroy();
        delete video._hlsInstance;
        console.log('HLS instance destroyed');
    }
}

/**
 * Get current GhostStream status
 */
function getStatus() {
    return {
        enabled: ghoststreamState.enabled,
        available: ghoststreamState.available,
        settings: ghoststreamState.settings,
        activeJobCount: ghoststreamState.activeJobs.size
    };
}

/**
 * Check if GhostStream is ready for use
 */
function isReady() {
    // If enabled and server configured, consider ready - let actual calls fail if needed
    return ghoststreamState.enabled && (ghoststreamState.available || ghoststreamState.settings?.server);
}

/**
 * Force re-check availability (call this after settings change)
 */
async function recheckAvailability() {
    console.log('Rechecking GhostStream availability...');
    return await checkAvailability();
}

/**
 * Manually set availability state (for when test connection succeeds)
 */
function setAvailable(available) {
    ghoststreamState.available = available;
    console.log(`GhostStream availability set to: ${available}`);
}

// Clean up jobs when page unloads
window.addEventListener('beforeunload', cleanupAllJobs);

/**
 * Start batch transcoding for all videos in a category
 * @param {string} categoryId - The category ID
 * @param {Object} options - Optional settings (resolution, video_codec, format)
 * @returns {Promise<Object>} - Batch job result
 */
async function transcodeAllInCategory(categoryId, options = {}) {
    if (!ghoststreamState.available) {
        console.warn('GhostStream not available for batch transcoding');
        return null;
    }
    
    try {
        const response = await fetch('/api/ghoststream/batch/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category_id: categoryId,
                resolution: options.resolution || ghoststreamState.settings?.default_resolution || '1080p',
                video_codec: options.video_codec || ghoststreamState.settings?.default_codec || 'h264',
                format: options.format || 'mp4'
            })
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log(`Batch transcode started: ${result.queued} jobs queued`);
            return result;
        } else {
            const error = await response.json();
            console.error('Batch transcode failed:', error);
            return null;
        }
    } catch (error) {
        console.error('Batch transcode request failed:', error);
        return null;
    }
}

/**
 * Check if a pre-transcoded version exists for a video
 * @param {string} categoryId - The category ID
 * @param {string} filename - The original filename
 * @returns {Promise<Object|null>} - Transcoded info or null
 */
async function getTranscodedVersion(categoryId, filename) {
    try {
        const response = await fetch(`/api/ghoststream/transcoded/${categoryId}/${encodeURIComponent(filename)}`);
        if (response.ok) {
            const data = await response.json();
            if (data.exists) {
                return data;
            }
        }
    } catch (error) {
        console.warn('Failed to check for transcoded version:', error);
    }
    return null;
}

/**
 * Download a completed batch transcode to storage
 * @param {string} jobId - The job ID
 * @param {string} categoryId - The category ID  
 * @param {string} originalFilename - Original filename
 * @returns {Promise<Object|null>} - Download result or null
 */
async function downloadTranscoded(jobId, categoryId, originalFilename) {
    try {
        const response = await fetch(`/api/ghoststream/batch/download/${jobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category_id: categoryId,
                original_filename: originalFilename
            })
        });
        
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.error('Download transcoded failed:', error);
    }
    return null;
}

/**
 * Poll batch jobs and auto-download when complete
 * @param {Array} jobs - Array of job objects with job_id and filename
 * @param {string} categoryId - The category ID
 * @param {Function} onProgress - Progress callback
 */
async function monitorBatchJobs(jobs, categoryId, onProgress = null) {
    const pendingJobs = [...jobs];
    
    const poll = async () => {
        const stillPending = [];
        
        for (const job of pendingJobs) {
            const status = await getJobStatus(job.job_id);
            
            if (status) {
                if (onProgress) {
                    onProgress(job.filename, status);
                }
                
                if (status.status === 'ready' && status.download_url) {
                    // Auto-download when complete
                    console.log(`Job ${job.job_id} complete, downloading...`);
                    await downloadTranscoded(job.job_id, categoryId, job.filename);
                } else if (status.status === 'processing' || status.status === 'queued') {
                    stillPending.push(job);
                }
                // Skip failed jobs
            }
        }
        
        if (stillPending.length > 0) {
            pendingJobs.length = 0;
            pendingJobs.push(...stillPending);
            setTimeout(poll, 3000); // Poll every 3 seconds
        } else {
            console.log('All batch jobs complete');
            if (onProgress) {
                onProgress(null, { status: 'all_complete' });
            }
        }
    };
    
    poll();
}

export {
    initGhostStream,
    checkAvailability,
    tryAutoConnect,
    needsTranscoding,
    startTranscode,
    startHlsStream,
    startAbrStream,
    startBatchTranscode,
    getJobStatus,
    waitForReady,
    cancelJob,
    deleteJob,
    cleanupAllJobs,
    getPlaybackUrl,
    createStatusOverlay,
    updateStatusOverlay,
    createHlsVideoElement,
    destroyHlsInstance,
    getStatus,
    isReady,
    recheckAvailability,
    setAvailable,
    transcodeAllInCategory,
    getTranscodedVersion,
    downloadTranscoded,
    monitorBatchJobs
};
