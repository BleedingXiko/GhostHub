/**
 * GhostStream Manager
 * Handles integration with GhostStream transcoding service
 * 
 * Plex/Jellyfin-like features:
 * - Automatic format detection and transcoding decision
 * - Quality selection (Original, 1080p, 720p, 480p)
 * - Direct Play vs Transcode mode
 * - Proactive incompatibility detection
 * - Real-time transcoding status
 */

import { getConfigValue, saveConfig } from '../../utils/configManager.js';
import { gearIcon, lightningIcon, checkIcon, xIcon } from '../../utils/icons.js';
import { Module, createElement, attr, $, $$ } from '../../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../../core/appEvents.js';

// Module state
let ghoststreamAvailable = false;
let ghoststreamServers = [];
let preferredServer = null;
let capabilities = null;
let activeJobs = new Map(); // job_id -> job info
let progressWebSocket = null;
let statusCheckInterval = null;
let fastDiscoveryInterval = null;
let networkConnectionRef = null;
let networkChangeHandler = null;
let networkChangeCleanup = null;
let ghoststreamLifecycle = null;
const GHOSTSTREAM_STATUS_CACHE_TTL_MS = 5000;
let ghoststreamStatusCache = null;
let ghoststreamStatusCacheAt = 0;
let ghoststreamStatusInFlight = null;

function getRuntimeConfig() {
    return window.ragotModules?.appStore?.get?.('config', {}) || {};
}

function ensureGhoststreamLifecycle() {
    if (!ghoststreamLifecycle) {
        ghoststreamLifecycle = new Module();
    }
    ghoststreamLifecycle.start();
    return ghoststreamLifecycle;
}

// Resolution preset profiles (maps quality string to transcode parameters)
// NOTE: These are for REMOTE playback over limited bandwidth
// Kiosk/TV is LOCAL so it should always use 'original' (direct play)
const RESOLUTION_PRESETS = {
    'original': {
        resolution: 'original',
        bitrate: 'auto',
        video_codec: 'h264',
        audio_codec: 'aac',
        description: 'Original quality - Direct Play when possible',
        maxHeight: null // No limit
    },
    '1080p': {
        resolution: '1080p',
        bitrate: '8M',
        video_codec: 'h264',
        audio_codec: 'aac',
        description: 'Full HD - 8 Mbps',
        maxHeight: 1080
    },
    '720p': {
        resolution: '720p',
        bitrate: '5M',
        video_codec: 'h264',
        audio_codec: 'aac',
        description: 'HD - 5 Mbps',
        maxHeight: 720
    },
    '480p': {
        resolution: '480p',
        bitrate: '2.5M',
        video_codec: 'h264',
        audio_codec: 'aac',
        description: 'SD - 2.5 Mbps (slow connections)',
        maxHeight: 480
    }
};

// User preferences (Plex-like settings)
const userPrefs = {
    preferTranscode: false,     // false = Direct Play when possible (like Plex default)
    preferredQuality: 'original', // 'original', '1080p', '720p', '480p'
    autoTranscodeFormats: true,  // Auto-transcode known problematic formats
    maxBitrate: 'auto',         // 'auto' or specific like '20M'
    autoTranscodeHighBitrate: true, // Auto-transcode high bitrate (>25 Mbps) like Plex
    highBitrateThreshold: 25,   // Mbps threshold for auto-transcode
    enableABR: false,           // Adaptive Bitrate - DEFAULT OFF (single-quality more reliable for initial setup)
    autoSelectQuality: true     // Automatically select quality based on network conditions
};

// Formats that ALWAYS need transcoding (browser can't play)
const ALWAYS_TRANSCODE = ['mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg', 'vob'];

// Formats that MIGHT need transcoding (depends on codec inside)
const MAYBE_TRANSCODE = ['mp4', 'mov', 'webm'];

// Codecs that browsers struggle with
const PROBLEMATIC_CODECS = ['hevc', 'h265', 'av1', 'vp9', 'ac3', 'dts', 'truehd', 'eac3'];

// Network and device state
let networkBandwidth = null; // Estimated in Mbps
let connectionType = 'unknown'; // 'ethernet', 'wifi', 'cellular', 'unknown'
let isKioskMode = false; // Whether we're in kiosk/cast mode

// Event callbacks
const eventCallbacks = {
    statusChange: [],
    jobProgress: [],
    jobComplete: [],
    jobError: [],
    playbackModeChange: []  // When switching between direct/transcode
};

/**
 * Initialize GhostStream manager
 * Call this on app startup to begin discovery
 */
export async function initGhostStream() {
    console.log('[GhostStream] Initializing...');

    // Load saved preferences (may be empty if config not loaded yet)
    loadPreferences();

    // Reload preferences when config is loaded.
    ensureGhoststreamLifecycle().listen(APP_EVENTS.CONFIG_LOADED, () => {
        console.log('[GhostStream] Config loaded, reloading preferences');
        loadPreferences();
    });

    // Detect network bandwidth and connection type
    detectNetworkCapabilities();

    // Detect kiosk mode
    detectKioskMode();

    // Check initial status
    await checkStatus();

    // If not available, check more frequently initially (every 3 seconds for first 30 seconds)
    if (!ghoststreamAvailable) {
        let fastCheckCount = 0;
        if (fastDiscoveryInterval) {
            ensureGhoststreamLifecycle().clearInterval(fastDiscoveryInterval);
            fastDiscoveryInterval = null;
        }
        fastDiscoveryInterval = ensureGhoststreamLifecycle().interval(async () => {
            fastCheckCount++;
            await checkStatus();

            // Stop fast checking after 10 attempts or when we find a server
            if (ghoststreamAvailable || fastCheckCount >= 10) {
                ensureGhoststreamLifecycle().clearInterval(fastDiscoveryInterval);
                fastDiscoveryInterval = null;
                console.log(`[GhostStream] Fast discovery complete, available: ${ghoststreamAvailable}`);
            }
        }, 3000);
    }

    // Start periodic status checks (every 15 seconds for ongoing monitoring)
    if (statusCheckInterval) {
        ensureGhoststreamLifecycle().clearInterval(statusCheckInterval);
    }
    statusCheckInterval = ensureGhoststreamLifecycle().interval(checkStatus, 15000);

    console.log('[GhostStream] Initialized, available:', ghoststreamAvailable);
    console.log(`[GhostStream] Network: ${connectionType}, Bandwidth: ${networkBandwidth ? networkBandwidth + ' Mbps' : 'unknown'}, Kiosk: ${isKioskMode}`);
    return ghoststreamAvailable;
}

/**
 * Detect network capabilities (connection type and bandwidth)
 */
function detectNetworkCapabilities() {
    // Use Network Information API if available
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    if (connection) {
        // Get connection type
        const effectiveType = connection.effectiveType; // '4g', '3g', '2g', 'slow-2g'
        const downlink = connection.downlink; // Mbps (estimate)
        const type = connection.type; // 'wifi', 'cellular', 'ethernet', 'unknown'

        // Map to our connection types
        if (type === 'ethernet' || type === 'wifi') {
            connectionType = type;
        } else if (type === 'cellular') {
            connectionType = 'cellular';
        } else {
            // Infer from effective type
            if (effectiveType === '4g') {
                connectionType = 'wifi'; // Assume fast connection is wifi/ethernet
            } else if (effectiveType === '3g' || effectiveType === '2g') {
                connectionType = 'cellular';
            } else {
                connectionType = 'unknown';
            }
        }

        // Estimate bandwidth based on downlink or effective type
        if (downlink && downlink > 0) {
            networkBandwidth = downlink;
        } else {
            // Fallback estimates based on connection type
            const bandwidthEstimates = {
                '4g': 20,
                '3g': 3,
                '2g': 0.5,
                'slow-2g': 0.25
            };
            networkBandwidth = bandwidthEstimates[effectiveType] || null;
        }

        console.log(`[GhostStream] Detected network: type=${connectionType}, downlink=${downlink} Mbps, effectiveType=${effectiveType}`);

        // Listen for network changes (ensure single listener per connection object)
        if (networkConnectionRef !== connection || !networkChangeHandler) {
            if (networkChangeCleanup) {
                try { networkChangeCleanup(); } catch (e) { /* ignore */ }
                networkChangeCleanup = null;
            }
            networkConnectionRef = connection;
            networkChangeHandler = () => {
                console.log('[GhostStream] Network changed, re-detecting...');
                detectNetworkCapabilities();
            };
            ensureGhoststreamLifecycle().on(connection, 'change', networkChangeHandler);
            networkChangeCleanup = () => ensureGhoststreamLifecycle().off(connection, 'change', networkChangeHandler);
        }
    } else {
        // Fallback: assume decent connection
        connectionType = 'unknown';
        networkBandwidth = 20; // Conservative estimate (20 Mbps)
        console.log('[GhostStream] Network Information API not available, assuming 20 Mbps');
    }
}

/**
 * Detect if we're running in kiosk mode (TV casting)
 */
function detectKioskMode() {
    // Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('kiosk') || urlParams.has('tv')) {
        isKioskMode = true;
        console.log('[GhostStream] Kiosk mode detected from URL');
        return;
    }

    // Check if we're on the /tv route
    if (window.location.pathname.includes('/tv')) {
        isKioskMode = true;
        console.log('[GhostStream] Kiosk mode detected from /tv route');
        return;
    }

    // Check if cast mode is active
    if (window.ragotModules?.tvCastManager?.isCastingToTv?.()) {
        isKioskMode = true;
        console.log('[GhostStream] Kiosk mode detected from active cast');
        return;
    }

    // Check user agent for TV browsers
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('tv') || ua.includes('webos') || ua.includes('tizen') || ua.includes('smarttv')) {
        isKioskMode = true;
        console.log('[GhostStream] Kiosk mode detected from user agent');
        return;
    }

    isKioskMode = false;
}

/**
 * Get current network information
 * @returns {Object} Network info {type, bandwidth, isKiosk}
 */
export function getNetworkInfo() {
    return {
        type: connectionType,
        bandwidth: networkBandwidth,
        isKiosk: isKioskMode
    };
}

/**
 * Check if currently in kiosk mode
 * @returns {boolean} True if in kiosk mode
 */
export function isKiosk() {
    return isKioskMode;
}

/**
 * Get recommended quality preset based on network and device
 * @param {number} sourceHeight - Source video height
 * @returns {string} Recommended quality preset key
 */
export function getRecommendedQuality(sourceHeight = 1080) {
    // If user disabled auto-select, use their preference
    if (!userPrefs.autoSelectQuality) {
        return userPrefs.preferredQuality;
    }

    // Kiosk mode: ALWAYS original (local HDMI, no bandwidth constraint)
    // Only transcode if format/codec is incompatible (handled in analyzePlayback)
    if (isKioskMode) {
        return 'original';
    }

    // No bandwidth info: use user preference
    if (!networkBandwidth) {
        return userPrefs.preferredQuality;
    }

    // Bandwidth-aware quality selection (for remote clients only)
    if (networkBandwidth >= 15) {
        // High bandwidth: support up to 1080p
        return sourceHeight > 1080 ? '1080p' : 'original';
    } else if (networkBandwidth >= 8) {
        // Medium bandwidth: 720p max
        return sourceHeight > 720 ? '720p' : 'original';
    } else if (networkBandwidth >= 4) {
        // Low bandwidth: 480p max
        return sourceHeight > 480 ? '480p' : 'original';
    } else {
        // Very low bandwidth: always 480p
        return '480p';
    }
}

// Header indicator removed - transcoding settings are in the Settings modal only

/**
 * Create configuration popup for GhostStream (add servers, change quality)
 */
export function createConfigPopup(anchorElement) {
    // Remove existing popup
    $('.ghoststream-config-popup')?.remove();

    const popup = createElement('div', { className: 'ghoststream-config-popup', innerHTML: `
        <div class="gs-config-header">
            <span>⚡ GhostStream Transcoding</span>
            <button class="gs-close-btn">×</button>
        </div>
        
        <div class="gs-config-status">
            <div class="gs-status-dot ${ghoststreamAvailable ? 'online' : 'offline'}"></div>
            <span>${ghoststreamAvailable ? `Connected (${ghoststreamServers.length} server${ghoststreamServers.length !== 1 ? 's' : ''})` : 'Not Connected'}</span>
        </div>
        
        <div class="gs-config-section">
            <label class="gs-config-label">Add Server Manually</label>
            <div class="gs-add-server">
                <input type="text" id="gs-server-input" placeholder="192.168.1.100:8765" class="gs-input">
                <button id="gs-add-server-btn" class="gs-btn-primary">Add</button>
            </div>
            <div id="gs-add-result" class="gs-add-result"></div>
        </div>
        
        ${ghoststreamServers.length > 0 ? `
        <div class="gs-config-section">
            <label class="gs-config-label">Connected Servers</label>
            <div class="gs-server-list">
                ${ghoststreamServers.map(s => `
                    <div class="gs-server-item">
                        <span class="gs-server-name">${s.name || s.host}</span>
                        <span class="gs-server-addr">${s.host}:${s.port}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
        
        <div class="gs-config-section">
            <label class="gs-config-label">Playback Quality</label>
            <div class="gs-quality-buttons">
                ${['original', '1080p', '720p', '480p'].map(q => `
                    <button class="gs-quality-btn ${userPrefs.preferredQuality === q ? 'active' : ''}" data-quality="${q}">
                        ${q === 'original' ? 'Original' : q}
                    </button>
                `).join('')}
            </div>
        </div>
        
        <div class="gs-config-section">
            <label class="gs-auto-option">
                <input type="checkbox" id="gs-auto-transcode" ${userPrefs.autoTranscodeFormats ? 'checked' : ''}>
                <span>Auto-transcode incompatible formats (MKV, HEVC, AC3)</span>
            </label>
            <label class="gs-auto-option">
                <input type="checkbox" id="gs-auto-quality" ${userPrefs.autoSelectQuality ? 'checked' : ''}>
                <span>Auto-select quality based on network/device</span>
            </label>
            <label class="gs-auto-option">
                <input type="checkbox" id="gs-enable-abr" ${userPrefs.enableABR ? 'checked' : ''}>
                <span>Enable Adaptive Bitrate (ABR) streaming</span>
            </label>
        </div>
    ` });

    // Position near anchor
    const rect = anchorElement.getBoundingClientRect();
    popup.style.cssText = `
        position: fixed;
        top: ${rect.bottom + 8}px;
        right: ${window.innerWidth - rect.right}px;
        z-index: 10000;
    `;

    document.body.appendChild(popup);

    // Event handlers
    attr($('.gs-close-btn', popup), { onClick: () => popup.remove() });

    // Add server handler
    const addBtn = $('#gs-add-server-btn', popup);
    const input = $('#gs-server-input', popup);
    const resultDiv = $('#gs-add-result', popup);

    attr(addBtn, {
        onClick: async () => {
            const address = input.value.trim();
        if (!address) {
            resultDiv.textContent = 'Please enter a server address';
            resultDiv.className = 'gs-add-result error';
            return;
        }

        // Add port if missing
        const fullAddress = address.includes(':') ? address : `${address}:8765`;

        addBtn.disabled = true;
        addBtn.textContent = 'Adding...';
        resultDiv.textContent = '';

        try {
            const result = await addManualServer(fullAddress);
            if (result.success) {
                resultDiv.innerHTML = `${checkIcon(14)} Server added successfully!`;
                resultDiv.className = 'gs-add-result success';
                input.value = '';
                // Refresh status
                await checkStatus({ force: true });
                // Rebuild popup to show new server
                setTimeout(() => createConfigPopup(anchorElement), 1000);
            } else {
                resultDiv.innerHTML = `${xIcon(14)} ${result.error}`;
                resultDiv.className = 'gs-add-result error';
            }
        } catch (e) {
            resultDiv.innerHTML = `${xIcon(14)} Error: ${e.message}`;
            resultDiv.className = 'gs-add-result error';
        }

            addBtn.disabled = false;
            addBtn.textContent = 'Add';
        }
    });

    // Enter key to add
    attr(input, {
        onKeyPress: (e) => {
            if (e.key === 'Enter') addBtn.click();
        }
    });

    // Quality buttons
    $$('.gs-quality-btn', popup).forEach(btn => {
        attr(btn, {
            onClick: () => {
                setPreferences({ preferredQuality: btn.dataset.quality });
                $$('.gs-quality-btn', popup).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }
        });
    });

    // Auto-transcode checkbox
    attr($('#gs-auto-transcode', popup), {
        onChange: (e) => {
            setPreferences({ autoTranscodeFormats: e.target.checked });
        }
    });

    // Auto-quality checkbox
    attr($('#gs-auto-quality', popup), {
        onChange: (e) => {
            setPreferences({ autoSelectQuality: e.target.checked });
        }
    });

    // ABR checkbox
    attr($('#gs-enable-abr', popup), {
        onChange: (e) => {
            setPreferences({ enableABR: e.target.checked });
        }
    });

    // Close on outside click
    ensureGhoststreamLifecycle().timeout(() => {
        const closePopup = (e) => {
            if (!popup.contains(e.target) && e.target !== anchorElement) {
                popup.remove();
                ensureGhoststreamLifecycle().off(document, 'click', closePopup);
            }
        };
        ensureGhoststreamLifecycle().on(document, 'click', closePopup);
    }, 100);

    return popup;
}

/**
 * Check GhostStream service status
 */
export async function checkStatus(options = {}) {
    const { force = false } = options;
    const now = Date.now();
    if (!force && ghoststreamStatusCache && (now - ghoststreamStatusCacheAt) < GHOSTSTREAM_STATUS_CACHE_TTL_MS) {
        applyStatus(ghoststreamStatusCache);
        return ghoststreamStatusCache;
    }
    if (!force && ghoststreamStatusInFlight) {
        return ghoststreamStatusInFlight;
    }

    ghoststreamStatusInFlight = (async () => {
        try {
            const response = await fetch('/api/ghoststream/status');
            if (!response.ok) {
                throw new Error('Status check failed: ' + response.status);
            }

            const data = await response.json();
            ghoststreamStatusCache = data;
            ghoststreamStatusCacheAt = Date.now();
            applyStatus(data);
            return data;
        } catch (error) {
            console.warn('[GhostStream] Status check failed:', error.message);
            ghoststreamAvailable = false;
            return null;
        } finally {
            ghoststreamStatusInFlight = null;
        }
    })();
    return ghoststreamStatusInFlight;
}

function applyStatus(data) {
    if (!data) return;
    const wasAvailable = ghoststreamAvailable;

    ghoststreamAvailable = data.available;
    ghoststreamServers = data.servers || [];
    preferredServer = data.preferred_server;
    capabilities = data.capabilities;

    // Notify if availability changed
    if (wasAvailable !== ghoststreamAvailable) {
        console.log('[GhostStream] Availability changed: ' + ghoststreamAvailable);
        triggerEvent('statusChange', {
            available: ghoststreamAvailable,
            servers: ghoststreamServers,
            capabilities
        });

        // Connect WebSocket for progress updates if available
        if (ghoststreamAvailable && preferredServer) {
            connectProgressWebSocket();
        }
    }
}


/**
 * Check if GhostStream transcoding is available
 */
export function isAvailable() {
    return ghoststreamAvailable;
}

/**
 * Get list of available servers
 */
export function getServers() {
    return ghoststreamServers;
}

/**
 * Get capabilities of the preferred server
 */
export function getCapabilities() {
    return capabilities;
}

/**
 * Check if a specific codec/format is supported
 */
export function supportsCodec(codec) {
    if (!capabilities) return false;
    return capabilities.video_codecs?.includes(codec) ||
        capabilities.audio_codecs?.includes(codec);
}

/**
 * Check if hardware acceleration is available
 */
export function hasHardwareAccel() {
    if (!capabilities) return false;
    return capabilities.hw_accels?.some(hw =>
        hw.type !== 'software' && hw.available
    );
}

/**
 * Check if a cached transcoded version exists
 * 
 * @param {string} categoryId - Category ID
 * @param {string} filename - Original filename
 * @param {string} resolution - Target resolution (default: original)
 * @param {string} videoCodec - Target codec (default: h264)
 * @returns {Promise<Object|null>} Cache info with URL if exists, null otherwise
 */
export async function checkCache(categoryId, filename, resolution = 'original', videoCodec = 'h264') {
    try {
        const response = await fetch('/api/ghoststream/cache/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category_id: categoryId,
                filename: filename,
                resolution: resolution,
                video_codec: videoCodec,
                audio_codec: 'aac'
            })
        });

        // Handle 404 gracefully - endpoint may not exist on older deployments
        if (response.status === 404) {
            console.log('[GhostStream] Cache endpoint not available');
            return null;
        }

        if (response.ok) {
            const data = await response.json();
            if (data.cached) {
                console.log(`[GhostStream] Cache hit for ${filename}: ${data.url}`);
                return data;
            }
        }
    } catch (e) {
        // Silently fail - cache is optional
    }
    return null;
}

/**
 * Start a transcoding job
 * 
 * @param {Object} options Transcoding options
 * @param {string} options.source - Source URL
 * @param {string} options.mode - "stream" or "batch"
 * @param {string} options.format - Output format (hls, mp4, webm)
 * @param {string} options.video_codec - Video codec (h264, h265, vp9)
 * @param {string} options.audio_codec - Audio codec (aac, opus, copy)
 * @param {string} options.resolution - Target resolution (4k, 1080p, 720p, 480p, original)
 * @param {string} options.bitrate - Target bitrate or "auto"
 * @param {string} options.hw_accel - Hardware acceleration (auto, nvenc, qsv, software)
 * @param {number} options.start_time - Start position in seconds
 * @returns {Promise<Object|null>} Job info or null on failure
 */
export async function transcode(options) {
    if (!ghoststreamAvailable) {
        console.warn('[GhostStream] Service not available');
        throw new Error('GhostStream transcoding service not available. Check Settings to add a server.');
    }

    try {
        const response = await fetch('/api/ghoststream/transcode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: options.source,
                category_id: options.category_id,
                filename: options.filename,
                mode: options.mode || 'stream',
                format: options.format || 'hls',
                video_codec: options.video_codec || 'h264',
                audio_codec: options.audio_codec || 'aac',
                resolution: options.resolution || 'original',
                bitrate: options.bitrate || 'auto',
                hw_accel: options.hw_accel || 'auto',
                start_time: options.start_time || 0,
                abr: options.abr !== undefined ? options.abr : userPrefs.enableABR
            })
        });

        const data = await response.json();

        if (!response.ok) {
            const errorMsg = data.error || 'Transcode request failed';
            console.error(`[GhostStream] Transcode failed: ${errorMsg}`);
            throw new Error(errorMsg);
        }

        // Check if the job itself is an error
        if (data.status === 'error' || data.error) {
            const errorMsg = data.error_message || data.error || 'Transcoding failed';
            console.error(`[GhostStream] Transcode error: ${errorMsg}`);
            throw new Error(errorMsg);
        }

        activeJobs.set(data.job_id, data);

        console.log(`[GhostStream] Job started: ${data.job_id}`);
        return data;
    } catch (error) {
        console.error('[GhostStream] Transcode error:', error.message);
        // Re-throw so callers can handle and show the error
        throw error;
    }
}

/**
 * Transcode a media file from GhostHub
 * Helper that builds the source URL automatically
 * 
 * @param {string} categoryId - Category ID
 * @param {string} filename - Media filename
 * @param {Object} options - Additional transcode options
 * @returns {Promise<Object|null>} Job info or null on failure
 */
export async function transcodeMedia(categoryId, filename, options = {}) {
    return transcode({
        ...options,
        category_id: categoryId,
        filename: filename
    });
}

/**
 * Get status of a transcoding job
 * 
 * @param {string} jobId - Job ID
 * @returns {Promise<Object|null>} Job status or null
 */
export async function getJobStatus(jobId) {
    try {
        const response = await fetch(`/api/ghoststream/transcode/${jobId}/status`);
        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`Status request failed: ${response.status}`);
        }

        const job = await response.json();
        activeJobs.set(jobId, job);

        return job;
    } catch (error) {
        console.error('[GhostStream] Get status error:', error);
        return null;
    }
}

/**
 * Cancel a transcoding job
 * 
 * @param {string} jobId - Job ID to cancel
 * @returns {Promise<boolean>} True if cancelled
 */
export async function cancelJob(jobId) {
    try {
        const response = await fetch(`/api/ghoststream/transcode/${jobId}/cancel`, {
            method: 'POST'
        });

        if (response.ok) {
            activeJobs.delete(jobId);
            console.log(`[GhostStream] Job cancelled: ${jobId}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('[GhostStream] Cancel error:', error);
        return false;
    }
}

/**
 * Wait for a job to be ready for streaming
 * 
 * @param {string} jobId - Job ID
 * @param {number} timeout - Max wait time in seconds
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object|null>} Ready job or null on timeout/error
 */
export async function waitForReady(jobId, timeout = 60, onProgress = null) {
    const startTime = Date.now();
    const pollInterval = 1000; // 1 second

    while (Date.now() - startTime < timeout * 1000) {
        const job = await getJobStatus(jobId);

        if (!job) return null;

        if (onProgress) {
            onProgress(job);
        }

        if (job.status === 'ready' || (job.status === 'processing' && job.stream_url)) {
            return job;
        }

        if (job.status === 'error' || job.status === 'cancelled') {
            return job;
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.warn(`[GhostStream] Timeout waiting for job ${jobId}`);
    return null;
}

/**
 * Connect to GhostStream WebSocket for real-time progress
 * Only connects when we have an active transcoding job
 */
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT = 3;

function connectProgressWebSocket() {
    // Only connect if we have a server AND active jobs - don't spam connections
    if (!preferredServer || progressWebSocket || activeJobs.size === 0) return;

    try {
        const wsUrl = `ws://${preferredServer.host}:${preferredServer.port}/ws/progress`;
        progressWebSocket = new WebSocket(wsUrl);

        progressWebSocket.onopen = () => {
            wsReconnectAttempts = 0;
        };

        progressWebSocket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWebSocketMessage(msg);
            } catch (e) {
                // Ignore invalid messages silently
            }
        };

        progressWebSocket.onclose = () => {
            progressWebSocket = null;

            // Only reconnect if we still have active jobs and haven't exceeded attempts
            if (ghoststreamAvailable && activeJobs.size > 0 && wsReconnectAttempts < MAX_WS_RECONNECT) {
                wsReconnectAttempts++;
                setTimeout(connectProgressWebSocket, 5000);
            }
        };

        progressWebSocket.onerror = () => {
            // Silent error - WebSocket is optional for progress updates
            progressWebSocket = null;
        };
    } catch (error) {
        // Silent failure - WebSocket is optional
    }
}

/**
 * Handle incoming WebSocket messages
 */
function handleWebSocketMessage(msg) {
    const { type, job_id, data } = msg;

    if (type === 'progress' && activeJobs.has(job_id)) {
        const job = activeJobs.get(job_id);
        Object.assign(job, data);
        triggerEvent('jobProgress', { job_id, ...data });
    }

    if (type === 'status_change') {
        const job = activeJobs.get(job_id);
        if (job) {
            job.status = data.status;

            if (data.status === 'ready') {
                triggerEvent('jobComplete', { job_id, job });
            } else if (data.status === 'error') {
                triggerEvent('jobError', { job_id, error: data.error_message });
            }
        }
    }
}

/**
 * Add manual server (for when mDNS discovery doesn't work)
 * 
 * @param {string} address - Server address (host:port)
 */
export async function addManualServer(address) {
    try {
        const response = await fetch('/api/ghoststream/servers/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        });

        const data = await response.json();

        if (response.ok) {
            await checkStatus({ force: true });
            return { success: true };
        }

        return { success: false, error: data.error || `HTTP ${response.status}` };
    } catch (error) {
        console.error('[GhostStream] Add server error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Start server discovery
 */
export async function startDiscovery() {
    try {
        const response = await fetch('/api/ghoststream/discovery/start', {
            method: 'POST'
        });
        return response.ok;
    } catch (error) {
        console.error('[GhostStream] Start discovery error:', error);
        return false;
    }
}

// Event system
function triggerEvent(eventName, data) {
    const callbacks = eventCallbacks[eventName] || [];
    callbacks.forEach(cb => {
        try {
            cb(data);
        } catch (e) {
            console.error(`[GhostStream] Event callback error:`, e);
        }
    });
}

/**
 * Register callback for status changes
 */
export function onStatusChange(callback) {
    eventCallbacks.statusChange.push(callback);
}

/**
 * Register callback for job progress updates
 */
export function onJobProgress(callback) {
    eventCallbacks.jobProgress.push(callback);
}

/**
 * Register callback for job completion
 */
export function onJobComplete(callback) {
    eventCallbacks.jobComplete.push(callback);
}

/**
 * Register callback for job errors
 */
export function onJobError(callback) {
    eventCallbacks.jobError.push(callback);
}

/**
 * Cleanup on module unload
 */
export function cleanup() {
    if (fastDiscoveryInterval) {
        if (ghoststreamLifecycle) ghoststreamLifecycle.clearInterval(fastDiscoveryInterval);
        else clearInterval(fastDiscoveryInterval);
        fastDiscoveryInterval = null;
    }
    if (statusCheckInterval) {
        if (ghoststreamLifecycle) ghoststreamLifecycle.clearInterval(statusCheckInterval);
        else clearInterval(statusCheckInterval);
        statusCheckInterval = null;
    }

    if (networkChangeCleanup) {
        try { networkChangeCleanup(); } catch (e) { /* ignore */ }
    }
    networkChangeCleanup = null;
    networkConnectionRef = null;
    networkChangeHandler = null;

    if (progressWebSocket) {
        progressWebSocket.close();
        progressWebSocket = null;
    }

    activeJobs.clear();

    if (ghoststreamLifecycle) {
        ghoststreamLifecycle.stop();
        ghoststreamLifecycle = null;
    }
}

/**
 * Add quality selector overlay to video for ABR streams
 * @private
 */
function addQualitySelector(videoElement, hls, levels) {
    // Don't add if already exists
    if (videoElement.parentElement && $('.gs-quality-selector', videoElement.parentElement)) return;

    const container = videoElement.parentElement || videoElement.closest('.ghoststream-transcode-container');
    if (!container) return;

    // Create quality selector button
    const selectorBtn = createElement('button', {
        className: 'gs-quality-selector-btn',
        innerHTML: '${gearIcon(14)} Auto',
        title: 'Change quality'
    });
    selectorBtn.style.cssText = `
        position: absolute;
        bottom: 60px;
        right: 10px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 13px;
        cursor: pointer;
        z-index: 10;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Create quality menu
    const menu = createElement('div', { className: 'gs-quality-menu' });
    menu.style.cssText = `
        position: absolute;
        bottom: 100px;
        right: 10px;
        background: rgba(20, 20, 20, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        padding: 8px 0;
        display: none;
        z-index: 11;
        min-width: 140px;
        backdrop-filter: blur(10px);
    `;

    // Add "Auto" option
    const autoOption = createElement('div', {
        className: 'gs-quality-option active',
        innerHTML: '<span>⚡ Auto</span><span style="font-size: 11px; color: #888;">Adaptive</span>',
        dataset: { level: '-1' }
    });
    autoOption.style.cssText = `
        padding: 10px 16px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: white;
        font-size: 14px;
    `;
    menu.appendChild(autoOption);

    // Add quality levels (sorted high to low)
    const sortedLevels = [...levels].sort((a, b) => b.height - a.height);
    sortedLevels.forEach((level, index) => {
        const resolution = `${level.height}p`;
        const bitrate = Math.round(level.bitrate / 1000);
        const option = createElement('div', {
            className: 'gs-quality-option',
            innerHTML: `<span>${resolution}</span><span style="font-size: 11px; color: #888;">${bitrate} kbps</span>`,
            dataset: { level: String(levels.indexOf(level)) }
        });
        option.style.cssText = autoOption.style.cssText;
        menu.appendChild(option);
    });

    // Style active option
    const styleOptions = () => {
        $$('.gs-quality-option', menu).forEach(opt => {
            opt.style.background = opt.classList.contains('active') ? 'rgba(99, 102, 241, 0.3)' : 'transparent';
        });
    };
    styleOptions();

    // Add hover effects and click handlers
    $$('.gs-quality-option', menu).forEach(opt => {
        attr(opt, {
            onMouseEnter: () => {
                if (!opt.classList.contains('active')) {
                    opt.style.background = 'rgba(255, 255, 255, 0.1)';
                }
            },
            onMouseLeave: () => {
                if (!opt.classList.contains('active')) {
                    opt.style.background = 'transparent';
                }
            },
            onClick: () => {
                const levelIndex = parseInt(opt.dataset.level);
                hls.currentLevel = levelIndex;

                $$('.gs-quality-option', menu).forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                styleOptions();

                if (levelIndex === -1) {
                    selectorBtn.innerHTML = `${gearIcon(14)} Auto`;
                } else {
                    const level = levels[levelIndex];
                    selectorBtn.innerHTML = `${gearIcon(14)} ${level.height}p`;
                }

                menu.style.display = 'none';
            }
        });
    });

    // Toggle menu
    attr(selectorBtn, {
        onClick: (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }
    });

    // Close menu when clicking outside
    ensureGhoststreamLifecycle().on(document, 'click', () => {
        menu.style.display = 'none';
    });

    // Update button when HLS auto-switches level
    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        if (hls.currentLevel === -1) {
            // Auto mode - show current playing level
            const playingLevel = levels[data.level];
            if (playingLevel) {
                selectorBtn.innerHTML = `${gearIcon(14)} Auto (${playingLevel.height}p)`;
            }
        }
    });

    container.style.position = 'relative';
    container.appendChild(selectorBtn);
    container.appendChild(menu);
}

/**
 * Get the HLS.js player instance or create video element for HLS playback
 * Returns a function to load and play HLS stream
 * 
 * @param {HTMLVideoElement} videoElement - Target video element
 * @param {string} streamUrl - HLS stream URL (.m3u8)
 * @returns {Object} Player control object
 */
export function createHLSPlayer(videoElement, streamUrl) {
    // Use console.warn for visibility even when DEBUG_MODE is off
    console.warn('[GhostStream HLS] createHLSPlayer called with URL:', streamUrl);
    console.warn('[GhostStream HLS] Hls defined:', typeof Hls !== 'undefined');
    console.warn('[GhostStream HLS] Hls.isSupported:', typeof Hls !== 'undefined' ? Hls.isSupported() : 'N/A');

    // Prefer HLS.js - more reliable cross-browser, better error handling
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        // Clean HLS.js config - GhostStream now sends proper VOD playlists
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90,
            startLevel: -1,
            capLevelToPlayerSize: true,
            // Aggressive retries - FFmpeg may take 10-20s to create first segments
            manifestLoadingMaxRetry: 30,
            manifestLoadingRetryDelay: 1000,
            manifestLoadingMaxRetryTimeout: 30000,
            levelLoadingMaxRetry: 10,
            levelLoadingRetryDelay: 1000,
            fragLoadingMaxRetry: 10
        });

        console.log(`[GhostStream HLS] Created HLS.js instance for: ${streamUrl}`);

        let jobStatusInterval = null;

        return {
            load: () => {
                return new Promise((resolve, reject) => {
                    let resolved = false;

                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            console.error('[GhostStream] HLS load timeout');
                            hls.destroy();
                            reject(new Error('HLS load timeout - stream may not be ready'));
                        }
                    }, 60000);

                    // Log all key HLS events for debugging
                    hls.on(Hls.Events.MANIFEST_LOADING, () => {
                        console.warn('[GhostStream HLS] MANIFEST_LOADING - fetching manifest...');
                    });
                    hls.on(Hls.Events.MANIFEST_LOADED, () => {
                        console.warn('[GhostStream HLS] MANIFEST_LOADED - manifest received!');
                    });
                    hls.on(Hls.Events.LEVEL_LOADING, (e, data) => {
                        console.warn(`[GhostStream HLS] LEVEL_LOADING - loading level ${data.level}`);
                    });
                    hls.on(Hls.Events.FRAG_LOADING, (e, data) => {
                        console.warn(`[GhostStream HLS] FRAG_LOADING - loading segment ${data.frag.sn}`);
                    });

                    // GhostStream server waits up to 30s for manifest, so just load directly
                    console.warn('[GhostStream HLS] Calling loadSource...');
                    hls.loadSource(streamUrl);
                    console.warn('[GhostStream HLS] Calling attachMedia...');
                    hls.attachMedia(videoElement);
                    console.warn('[GhostStream HLS] Waiting for MANIFEST_PARSED...');

                    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                        console.log('[GhostStream HLS] MANIFEST_PARSED event received!');
                        if (resolved) return;
                        resolved = true;
                        clearTimeout(timeout);
                        console.log(`[GhostStream] HLS manifest parsed, ${data.levels.length} quality levels`);

                        // Add quality selector if multiple levels available
                        // Use video controls quality picker instead of standalone overlay
                        if (data.levels.length > 1 && window.ragotModules?.videoControls?.updateQualityState) {
                            window.ragotModules.videoControls.updateQualityState(hls, data.levels);
                        } else if (data.levels.length > 1) {
                            // Fallback to standalone selector if video controls not available
                            addQualitySelector(videoElement, hls, data.levels);
                        }

                        // Remove poster once video is ready
                        videoElement.removeAttribute('poster');
                        videoElement.style.background = 'transparent';

                        videoElement.play()
                            .then(resolve)
                            .catch(e => {
                                console.warn('[GhostStream] Autoplay blocked, trying muted');
                                videoElement.muted = true;
                                videoElement.play().then(resolve).catch(reject);
                            });
                    });

                    // Also remove poster when first frame is shown
                    attr(videoElement, {
                        onLoadedData: () => {
                            videoElement.removeAttribute('poster');
                            videoElement.style.background = 'transparent';
                        }
                    });

                    // Track retry state for better error handling
                    let manifestRetries = 0;
                    let mediaRecoveryAttempts = 0;
                    const MAX_MEDIA_RECOVERY = 3;

                    hls.on(Hls.Events.ERROR, (event, data) => {
                        console.warn(`[GhostStream HLS] ERROR event: fatal=${data.fatal}, type=${data.type}, details=${data.details}`);

                        if (data.fatal) {
                            console.error(`[GhostStream HLS] Fatal HLS error: ${data.type} - ${data.details}`);

                            // Handle different error types
                            switch (data.type) {
                                case Hls.ErrorTypes.NETWORK_ERROR:
                                    // Network errors - try to recover
                                    if (data.details === 'manifestLoadError') {
                                        manifestRetries++;
                                        console.warn(`[GhostStream HLS] Manifest load failed, retry ${manifestRetries}...`);
                                        if (manifestRetries < 5) {
                                            // Manual retry after a delay
                                            setTimeout(() => {
                                                console.warn('[GhostStream HLS] Retrying manifest load...');
                                                hls.loadSource(streamUrl);
                                            }, 2000);
                                            return;
                                        }
                                    }

                                    // Try startLoad for other network errors
                                    console.warn('[GhostStream] Attempting to recover from network error...');
                                    hls.startLoad();
                                    break;

                                case Hls.ErrorTypes.MEDIA_ERROR:
                                    mediaRecoveryAttempts++;
                                    console.warn(`[GhostStream] Attempting media error recovery (attempt ${mediaRecoveryAttempts}/${MAX_MEDIA_RECOVERY})...`);
                                    if (mediaRecoveryAttempts <= MAX_MEDIA_RECOVERY) {
                                        hls.recoverMediaError();
                                        return;
                                    }
                                    break;

                                default:
                                    // manifestParsingError is truly unrecoverable
                                    if (data.details === 'manifestParsingError') {
                                        console.error('[GhostStream] Unrecoverable HLS error - malformed manifest');
                                    }
                                    break;
                            }

                            // If we get here for a fatal error, reject the promise
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                hls.destroy();
                                reject(new Error(`HLS error: ${data.details}`));
                            }
                        } else {
                            // Non-fatal errors - just log them
                            console.warn(`[GhostStream] Non-fatal HLS error: ${data.details}`);
                        }
                    });

                    // JOB STATUS POLLING: Detect when transcoding fails (for progress/sync)
                    const jobIdMatch = streamUrl.match(/\/stream\/([^/]+)\//);
                    const jobId = jobIdMatch ? jobIdMatch[1] : null;
                    const lifecycle = ensureGhoststreamLifecycle();

                    const clearJobStatusInterval = () => {
                        if (!jobStatusInterval) return;
                        lifecycle.clearInterval(jobStatusInterval);
                        jobStatusInterval = null;
                    };

                    if (jobId) {
                        let consecutiveErrors = 0;
                        jobStatusInterval = lifecycle.interval(async () => {
                            if (videoElement.ended) {
                                clearJobStatusInterval();
                                return;
                            }

                            try {
                                const resp = await fetch(`/api/ghoststream/transcode/${jobId}/status`);
                                if (resp.ok) {
                                    const status = await resp.json();
                                    consecutiveErrors = 0;

                                    if (status.status === 'error' || status.status === 'cancelled') {
                                        console.error(`[GhostStream] Transcoding job failed: ${status.error_message || status.status}`);
                                        clearJobStatusInterval();
                                        videoElement.dispatchEvent(new CustomEvent('transcodeerror', {
                                            detail: { jobId, status: status.status, error: status.error_message || 'Transcoding failed' }
                                        }));
                                    }

                                    if (status.status === 'ready' && status.progress >= 100) {
                                        console.log('[GhostStream] Transcoding complete');
                                        clearJobStatusInterval();
                                    }
                                } else {
                                    consecutiveErrors++;
                                    if (consecutiveErrors >= 3) {
                                        clearJobStatusInterval();
                                    }
                                }
                            } catch (e) {
                                consecutiveErrors++;
                            }
                        }, 5000);
                    }
                });
            },
            destroy: () => {
                clearJobStatusInterval();
                hls.destroy();
            },
            hls,
            isNative: false
        };
    }

    // Fallback to native HLS (Safari, iOS)
    console.log('[GhostStream HLS] Checking native HLS support...');
    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        console.log('[GhostStream HLS] Using native HLS playback');
        return {
            load: () => {
                return new Promise((resolve, reject) => {
                    let retryCount = 0;
                    const maxRetries = 8;
                    const retryDelay = 2000;

                    const attemptLoad = () => {
                        videoElement.src = '';
                        videoElement.load();
                        videoElement.src = streamUrl;

                        attr(videoElement, {
                            onLoadedMetadata: () => {
                                videoElement.currentTime = 0;
                                videoElement.play()
                                    .then(resolve)
                                    .catch(e => {
                                        videoElement.muted = true;
                                        videoElement.play().then(resolve).catch(reject);
                                    });
                            }
                        });

                    attr(videoElement, {
                        onError: () => {
                            retryCount++;
                            console.warn(`[GhostStream] Native HLS load failed, retry ${retryCount}/${maxRetries}`);
                            if (retryCount < maxRetries) {
                                setTimeout(attemptLoad, retryDelay);
                            } else {
                                reject(new Error('Failed to load HLS stream after retries'));
                            }
                            }
                    });
                    };

                    attemptLoad();
                });
            },
            destroy: () => {
                videoElement.src = '';
            },
            isNative: true
        };
    }

    // No HLS support
    console.error('[GhostStream HLS] No HLS support available! HLS.js:', typeof Hls, 'Native:', videoElement.canPlayType('application/vnd.apple.mpegurl'));
    return null;
}

// ============== PLEX-LIKE PLAYBACK DECISION ENGINE ==============

/**
 * Playback decision result (like Plex's Direct Play / Direct Stream / Transcode)
 * @typedef {Object} PlaybackDecision
 * @property {'direct'|'transcode'} mode - Playback mode
 * @property {string} reason - Why this decision was made
 * @property {Object} transcodeSettings - Settings if transcoding
 * @property {boolean} canDirectPlay - If direct play is possible
 */

/**
 * Analyze a video file and decide how to play it (Plex-like logic)
 *
 * @param {string} filename - Video filename
 * @param {Object} options - Additional info (codec, resolution, bitrate)
 * @returns {PlaybackDecision} How to play this file
 */
export function analyzePlayback(filename, options = {}) {
    const ext = filename.toLowerCase().split('.').pop();
    const codec = options.codec?.toLowerCase() || '';
    const audioCodec = options.audioCodec?.toLowerCase() || '';
    const sourceHeight = options.height || 1080;

    // Default decision
    const decision = {
        mode: 'direct',
        reason: 'Direct Play',
        canDirectPlay: true,
        transcodeSettings: null
    };

    // Check if GhostStream is even available
    if (!ghoststreamAvailable) {
        decision.reason = 'Direct Play (GhostStream unavailable)';
        return decision;
    }

    // User prefers transcoding
    if (userPrefs.preferTranscode) {
        decision.mode = 'transcode';
        decision.reason = 'User preference: Always transcode';
        decision.transcodeSettings = getTranscodeSettings(options);
        return decision;
    }

    // ALWAYS transcode these container formats
    if (ALWAYS_TRANSCODE.includes(ext)) {
        decision.mode = 'transcode';
        decision.canDirectPlay = false;
        decision.reason = `Container format (${ext.toUpperCase()}) not supported by browsers`;
        decision.transcodeSettings = getTranscodeSettings(options);
        return decision;
    }

    // Check for problematic video codecs
    if (PROBLEMATIC_CODECS.includes(codec)) {
        decision.mode = 'transcode';
        decision.canDirectPlay = false;
        decision.reason = `Video codec (${codec.toUpperCase()}) has limited browser support`;
        decision.transcodeSettings = getTranscodeSettings(options);
        return decision;
    }

    // Check for problematic audio codecs
    if (['ac3', 'dts', 'truehd', 'eac3'].includes(audioCodec)) {
        decision.mode = 'transcode';
        decision.canDirectPlay = false;
        decision.reason = `Audio codec (${audioCodec.toUpperCase()}) not supported by browsers`;
        decision.transcodeSettings = getTranscodeSettings(options);
        return decision;
    }

    // AUTO-SELECT QUALITY BASED ON NETWORK (skip in kiosk - local playback)
    if (userPrefs.autoSelectQuality && !isKioskMode) {
        const recommendedQuality = getRecommendedQuality(sourceHeight);

        // If recommended quality is lower than source, transcode
        if (recommendedQuality !== 'original' && recommendedQuality !== userPrefs.preferredQuality) {
            const preset = RESOLUTION_PRESETS[recommendedQuality];
            if (preset && sourceHeight > preset.maxHeight) {
                decision.mode = 'transcode';
                decision.reason = `Auto-selected ${preset.description} based on network (${connectionType}, ${networkBandwidth} Mbps)`;
                decision.transcodeSettings = getTranscodeSettings({
                    ...options,
                    resolution: recommendedQuality
                });
                return decision;
            }
        }
    }

    // Manual quality downgrade requested
    if (userPrefs.preferredQuality !== 'original') {
        const preset = RESOLUTION_PRESETS[userPrefs.preferredQuality];

        if (preset && preset.maxHeight && sourceHeight > preset.maxHeight) {
            decision.mode = 'transcode';
            decision.reason = `Quality reduced to ${preset.description}`;
            decision.transcodeSettings = getTranscodeSettings({
                ...options,
                resolution: userPrefs.preferredQuality
            });
            return decision;
        }
    }

    // MOV files - sometimes work, sometimes don't
    if (ext === 'mov') {
        const video = document.createElement('video');
        if (!video.canPlayType('video/quicktime')) {
            decision.mode = 'transcode';
            decision.canDirectPlay = false;
            decision.reason = 'QuickTime format not supported by this browser';
            decision.transcodeSettings = getTranscodeSettings(options);
            return decision;
        }
    }

    // HIGH BITRATE detection (Plex-like) - transcode heavy files for smoother streaming
    // Skip in kiosk mode - local playback can handle high bitrates
    if (userPrefs.autoTranscodeHighBitrate && options.bitrate && !isKioskMode) {
        const bitrateMbps = typeof options.bitrate === 'number'
            ? options.bitrate / 1000000
            : parseFloat(options.bitrate);

        if (bitrateMbps > userPrefs.highBitrateThreshold) {
            decision.mode = 'transcode';
            decision.reason = `High bitrate (${Math.round(bitrateMbps)} Mbps) - transcoding for smoother playback`;
            decision.transcodeSettings = getTranscodeSettings({
                ...options,
                // Use network-aware quality selection
                resolution: getRecommendedQuality(sourceHeight)
            });
            return decision;
        }
    }

    // Network-aware transcoding for high-resolution content
    // Skip in kiosk mode - local HDMI playback, no bandwidth constraint
    if (networkBandwidth && networkBandwidth < 15 && !isKioskMode) {
        // On slower connections, proactively transcode high-res content
        if (sourceHeight >= 2160 && networkBandwidth < 10) {
            decision.mode = 'transcode';
            decision.reason = `4K content on limited bandwidth (${networkBandwidth} Mbps) - transcoding to 1080p`;
            decision.transcodeSettings = getTranscodeSettings({
                ...options,
                resolution: '1080p'
            });
            return decision;
        } else if (sourceHeight >= 1080 && networkBandwidth < 5) {
            decision.mode = 'transcode';
            decision.reason = `1080p content on low bandwidth (${networkBandwidth} Mbps) - transcoding to 720p`;
            decision.transcodeSettings = getTranscodeSettings({
                ...options,
                resolution: '720p'
            });
            return decision;
        }
    }

    return decision;
}

/**
 * Get transcode settings based on user preferences and source
 */
function getTranscodeSettings(options = {}) {
    // Determine which quality preset to use
    let qualityKey = options.resolution || userPrefs.preferredQuality || 'original';

    // If auto-select is enabled, use recommended quality
    if (userPrefs.autoSelectQuality && !options.resolution) {
        qualityKey = getRecommendedQuality(options.height || 1080);
    }

    // Get preset profile
    const preset = RESOLUTION_PRESETS[qualityKey] || RESOLUTION_PRESETS['original'];

    return {
        format: 'hls',
        video_codec: preset.video_codec,
        audio_codec: preset.audio_codec,
        resolution: preset.resolution,
        bitrate: preset.bitrate !== 'auto' ? preset.bitrate : (userPrefs.maxBitrate || 'auto'),
        hw_accel: 'auto'
    };
}

/**
 * Convert quality string to height
 */
function getHeightFromQuality(quality) {
    const map = { '4k': 2160, '1080p': 1080, '720p': 720, '480p': 480 };
    return map[quality] || 2160;
}

/**
 * Set user playback preferences (persisted to server config)
 */
export async function setPreferences(prefs) {
    Object.assign(userPrefs, prefs);

    // Save to server config
    try {
        const nextConfig = JSON.parse(JSON.stringify(getRuntimeConfig() || {}));
        if (!nextConfig.javascript_config) nextConfig.javascript_config = {};
        nextConfig.javascript_config.ghoststream = { ...userPrefs };
        await saveConfig(nextConfig);
        console.log('[GhostStream] Preferences saved to server:', userPrefs);
    } catch (e) {
        console.error('[GhostStream] Failed to save preferences to server:', e);
    }
}

/**
 * Get current preferences
 */
export function getPreferences() {
    return { ...userPrefs };
}

/**
 * Load preferences from server config
 */
function loadPreferences() {
    try {
        const saved = getRuntimeConfig()?.javascript_config?.ghoststream;
        if (saved) {
            Object.assign(userPrefs, saved);
            console.log('[GhostStream] Loaded preferences:', userPrefs);
            return;
        }

        // Fallback to getConfigValue
        const fallback = getConfigValue('javascript_config.ghoststream', null);
        if (fallback) {
            Object.assign(userPrefs, fallback);
            console.log('[GhostStream] Loaded preferences (fallback):', userPrefs);
        } else {
            console.log('[GhostStream] No saved preferences, using defaults');
        }
    } catch (e) {
        console.warn('[GhostStream] Failed to load preferences:', e);
    }
}

/**
 * Reload preferences - call this after config is loaded or settings change
 */
export function reloadPreferences() {
    loadPreferences();
}

// ============== QUALITY SELECTOR UI ==============

/**
 * Create a quality selector popup (like Plex's quality menu)
 * 
 * @param {HTMLElement} anchorElement - Element to anchor the popup to
 * @param {Function} onSelect - Callback when quality is selected
 * @returns {HTMLElement} The popup element
 */
export function createQualitySelector(anchorElement, onSelect) {
    // Remove existing popup
    $('.ghoststream-quality-popup')?.remove();

    const popup = createElement('div', { className: 'ghoststream-quality-popup', innerHTML: `
        <div class="gs-quality-header">
            <span>Playback Quality</span>
            <button class="gs-close-btn">×</button>
        </div>
        <div class="gs-quality-options">
            <label class="gs-quality-option ${userPrefs.preferredQuality === 'original' ? 'selected' : ''}">
                <input type="radio" name="gs-quality" value="original" ${userPrefs.preferredQuality === 'original' ? 'checked' : ''}>
                <span class="gs-quality-label">Original</span>
                <span class="gs-quality-desc">Direct Play when possible</span>
            </label>
            <label class="gs-quality-option ${userPrefs.preferredQuality === '1080p' ? 'selected' : ''}">
                <input type="radio" name="gs-quality" value="1080p" ${userPrefs.preferredQuality === '1080p' ? 'checked' : ''}>
                <span class="gs-quality-label">1080p</span>
                <span class="gs-quality-desc">Full HD • Transcode</span>
            </label>
            <label class="gs-quality-option ${userPrefs.preferredQuality === '720p' ? 'selected' : ''}">
                <input type="radio" name="gs-quality" value="720p" ${userPrefs.preferredQuality === '720p' ? 'checked' : ''}>
                <span class="gs-quality-label">720p</span>
                <span class="gs-quality-desc">HD • Lower bandwidth</span>
            </label>
            <label class="gs-quality-option ${userPrefs.preferredQuality === '480p' ? 'selected' : ''}">
                <input type="radio" name="gs-quality" value="480p" ${userPrefs.preferredQuality === '480p' ? 'checked' : ''}>
                <span class="gs-quality-label">480p</span>
                <span class="gs-quality-desc">SD • Slow connections</span>
            </label>
        </div>
        <div class="gs-quality-footer">
            <label class="gs-auto-transcode">
                <input type="checkbox" ${userPrefs.autoTranscodeFormats ? 'checked' : ''}>
                <span>Auto-transcode incompatible formats</span>
            </label>
        </div>
    ` });

    // Position near anchor
    const rect = anchorElement.getBoundingClientRect();
    popup.style.cssText = `
        position: fixed;
        top: ${Math.min(rect.bottom + 5, window.innerHeight - 300)}px;
        right: ${window.innerWidth - rect.right}px;
        z-index: 10000;
    `;

    document.body.appendChild(popup);

    // Event handlers
    attr($('.gs-close-btn', popup), { onClick: () => popup.remove() });

    $$('input[name="gs-quality"]', popup).forEach(radio => {
        attr(radio, {
            onChange: (e) => {
                setPreferences({ preferredQuality: e.target.value });
                $$('.gs-quality-option', popup).forEach(opt => opt.classList.remove('selected'));
                e.target.closest('.gs-quality-option').classList.add('selected');
                if (onSelect) onSelect(e.target.value);
            }
        });
    });

    attr($('.gs-auto-transcode input', popup), {
        onChange: (e) => {
            setPreferences({ autoTranscodeFormats: e.target.checked });
        }
    });

    // Close on outside click
    ensureGhoststreamLifecycle().timeout(() => {
        const closePopup = (e) => {
            if (!popup.contains(e.target) && e.target !== anchorElement) {
                popup.remove();
                ensureGhoststreamLifecycle().off(document, 'click', closePopup);
            }
        };
        ensureGhoststreamLifecycle().on(document, 'click', closePopup);
    }, 100);

    return popup;
}

/**
 * Create transcoding status indicator (shows during active transcode)
 */
export function createTranscodeIndicator(container) {
    const indicator = createElement('div', { className: 'ghoststream-indicator', innerHTML: `
        <div class="gs-indicator-icon">⚡</div>
        <div class="gs-indicator-text">Transcoding</div>
        <div class="gs-indicator-progress">0%</div>
    ` });
    container.appendChild(indicator);
    return indicator;
}

/**
 * Update transcode indicator progress
 */
export function updateTranscodeIndicator(indicator, progress, status) {
    if (!indicator) return;
    const progressEl = $('.gs-indicator-progress', indicator);
    const textEl = $('.gs-indicator-text', indicator);

    if (progressEl) progressEl.textContent = `${Math.round(progress)}%`;
    if (textEl && status) textEl.textContent = status;
}

// ============== SMART PLAYBACK FUNCTION ==============

/**
 * Smart play - Automatically decides Direct Play or Transcode (like Plex)
 * 
 * @param {Object} file - File object with url, name, etc.
 * @param {HTMLElement} container - Container for the video
 * @param {Object} options - Additional options (codec info, etc.)
 * @returns {Promise<{element: HTMLVideoElement, mode: string, cleanup: Function}>}
 */
export async function smartPlay(file, container, options = {}) {
    const decision = analyzePlayback(file.name, options);

    console.log(`[GhostStream] Playback decision for ${file.name}:`, decision);
    triggerEvent('playbackModeChange', { file, decision });

    if (decision.mode === 'direct') {
        // Direct Play - return null to let normal playback handle it
        return {
            element: null,
            mode: 'direct',
            reason: decision.reason,
            cleanup: () => { }
        };
    }

    // Transcode mode
    return await playWithTranscode(file, container, decision.transcodeSettings);
}

/**
 * Play with transcoding (internal)
 */
async function playWithTranscode(file, container, settings) {
    // Extract category ID from URL
    const urlParts = file.url.split('/');
    const categoryId = urlParts[2];
    const filename = decodeURIComponent(urlParts.slice(3).join('/'));

    console.log(`[GhostStream] Starting transcode: ${filename}`);

    // Create indicator
    const indicator = createTranscodeIndicator(container);

    let job;
    try {
        // Start transcode job
        job = await transcode({
            category_id: categoryId,
            filename: filename,
            ghosthub_base_url: `${window.location.protocol}//${window.location.host}`,
            mode: 'stream',
            ...settings
        });
    } catch (error) {
        indicator.remove();
        throw new Error(`Transcode failed: ${error.message}`);
    }

    if (!job) {
        indicator.remove();
        throw new Error('Failed to start transcode - no response from server');
    }

    // Wait for stream to be ready
    const readyJob = await waitForReady(job.job_id, 120, (progress) => {
        updateTranscodeIndicator(indicator, progress.progress, 'Transcoding...');
    });

    indicator.remove();

    if (!readyJob?.stream_url) {
        throw new Error(readyJob?.error_message || 'Transcode failed');
    }

    // Create video element
    const video = createElement('video', {
        className: 'viewer-media active ghoststream-video',
        controls: true,
        playsInline: true,
        poster: file.thumbnailUrl || '',
        dataset: { ghoststreamJobId: job.job_id, originalUrl: file.url }
    });

    // Add transcode badge
    const badge = createElement('div', {
        className: 'ghoststream-badge',
        innerHTML: `${lightningIcon(14)} Transcoded`,
        title: `Playing via GhostStream (${settings.resolution || 'original'})`
    });

    container.appendChild(video);
    container.appendChild(badge);

    // Set up HLS
    const hlsPlayer = createHLSPlayer(video, readyJob.stream_url);
    if (!hlsPlayer) {
        throw new Error('HLS not supported');
    }

    await hlsPlayer.load();

    return {
        element: video,
        mode: 'transcode',
        reason: `Transcoding to ${settings.resolution || 'original'}`,
        hlsPlayer,
        jobId: job.job_id,
        cleanup: () => {
            hlsPlayer.destroy();
            badge.remove();
            cancelJob(job.job_id);
        }
    };
}

// ============== ORIGINAL FUNCTIONS ==============

/**
 * Check if the browser can play a video format natively
 * 
 * @param {string} filename - Video filename
 * @returns {boolean} True if likely playable without transcoding
 */
export function canPlayNatively(filename) {
    const ext = filename.toLowerCase().split('.').pop();

    // Formats that ALWAYS need transcoding
    if (ALWAYS_TRANSCODE.includes(ext)) {
        return false;
    }

    // Formats that might work - check browser support
    if (MAYBE_TRANSCODE.includes(ext)) {
        const video = document.createElement('video');
        const mimeTypes = {
            'mp4': 'video/mp4',
            'mov': 'video/quicktime',
            'webm': 'video/webm',
            'ogg': 'video/ogg'
        };
        return video.canPlayType(mimeTypes[ext] || '') !== '';
    }

    // Standard formats should work
    return ['mp4', 'webm'].includes(ext);
}

/**
 * Determine if transcoding should be offered for a video
 * 
 * @param {string} filename - Video filename  
 * @param {Object} options - Additional options
 * @returns {Object} Recommendation { shouldTranscode, reason, suggestedSettings }
 */
export function getTranscodeRecommendation(filename, options = {}) {
    if (!ghoststreamAvailable) {
        return {
            shouldTranscode: false,
            reason: 'GhostStream not available'
        };
    }

    const canPlay = canPlayNatively(filename);
    const ext = filename.toLowerCase().split('.').pop();

    // Known problematic formats
    if (['mkv', 'avi', 'wmv', 'flv'].includes(ext)) {
        return {
            shouldTranscode: true,
            reason: `${ext.toUpperCase()} format may not play in browser`,
            suggestedSettings: {
                video_codec: 'h264',
                format: 'hls',
                resolution: 'original'
            }
        };
    }

    // HEVC/H.265 - limited browser support
    if (options.codec === 'hevc' || options.codec === 'h265') {
        return {
            shouldTranscode: true,
            reason: 'HEVC/H.265 has limited browser support',
            suggestedSettings: {
                video_codec: 'h264',
                format: 'hls',
                resolution: 'original'
            }
        };
    }

    // 4K content on slow connection
    if (options.resolution === '4k' && options.slowConnection) {
        return {
            shouldTranscode: true,
            reason: 'Lower resolution recommended for slow connection',
            suggestedSettings: {
                video_codec: 'h264',
                format: 'hls',
                resolution: '1080p',
                bitrate: '8M'
            }
        };
    }

    return {
        shouldTranscode: false,
        reason: canPlay ? 'Format should play natively' : 'Unknown format'
    };
}

// Export default object for convenience
export default {
    // Core
    initGhostStream,
    checkStatus,
    isAvailable,
    getServers,
    getCapabilities,
    supportsCodec,
    hasHardwareAccel,

    // Transcoding
    transcode,
    transcodeMedia,
    getJobStatus,
    cancelJob,
    waitForReady,

    // Discovery
    addManualServer,
    startDiscovery,

    // Events
    onStatusChange,
    onJobProgress,
    onJobComplete,
    onJobError,
    cleanup,

    // Playback
    createHLSPlayer,
    canPlayNatively,
    getTranscodeRecommendation,

    // Plex-like features
    analyzePlayback,
    smartPlay,
    setPreferences,
    getPreferences,
    createQualitySelector,
    createTranscodeIndicator,
    updateTranscodeIndicator
};
