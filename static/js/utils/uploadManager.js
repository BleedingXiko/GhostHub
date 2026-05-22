/**
 * Upload Manager - Optimized for Pi 4 (2GB RAM)
 * Shared upload utility for fileManager and gallery drag-drop
 *
 * Features:
 * - Chunked uploads for large files (>10MB)
 * - Smart batching: packs small files into 200MB batches
 * - Memory efficient streaming
 * - Progress tracking
 * - Cancellation support
 * - Network-aware chunk sizing (auto-detects AP vs Ethernet)
 */

import { createElement, attr, $, $$ } from '../libs/ragot.esm.min.js';
import { dialog } from './notificationManager.js';
import { getCurrentLayout } from './layoutUtils.js';

// Detect mobile for reduced resource usage
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.innerWidth < 768;

// Configuration - Optimized for Pi 4 2GB in AP mode
// Chunk size is now negotiated based on connection type (AP mode vs Ethernet)
const DEFAULT_CHUNK_SIZE = isMobile ? 1 * 1024 * 1024 : 2 * 1024 * 1024;  // 1MB mobile, 2MB desktop fallback
const MAX_CONCURRENT_CHUNKS = isMobile ? 1 : 2;           // 2 concurrent on desktop (balanced for Pi RAM)
const LARGE_FILE_THRESHOLD = isMobile ? 8 * 1024 * 1024 : 16 * 1024 * 1024;  // 8MB mobile, 16MB desktop
const MAX_BATCH_SIZE = isMobile ? 100 * 1024 * 1024 : 300 * 1024 * 1024; // 100MB mobile, 300MB desktop
const MAX_CONCURRENT_FILES = 1;            // Always sequential for Pi stability

// Negotiated upload settings (cached per session)
let negotiatedSettings = null;

// Track active uploads
const activeUploads = new Map();
let uploadCancelled = false;
let uploadActivityDepth = 0;

// Background upload state
let currentUploadSession = null; // { files, drivePath, subfolder, results, totalBytes, uploadedBytes, onProgress, onFileComplete, isRunning }

// Duplicate detection state
let duplicateDetectionState = {
    duplicates: [],
    checked: false,
    userChoice: null // 'skip' or 'upload'
};

/**
 * Get the current background upload session if one exists
 */
export function getCurrentUploadSession() {
    return currentUploadSession;
}

export function beginUploadActivity() {
    uploadActivityDepth++;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        uploadActivityDepth = Math.max(0, uploadActivityDepth - 1);
    };
}

export function isUploadInProgress() {
    return currentUploadSession?.isRunning === true || uploadActivityDepth > 0;
}

/**
 * Get duplicate detection state
 */
export function getDuplicateState() {
    return duplicateDetectionState;
}

/**
 * Reset duplicate detection state
 */
export function resetDuplicateState() {
    duplicateDetectionState = {
        duplicates: [],
        checked: false,
        userChoice: null
    };
}

/**
 * Update callbacks for the current session
 */
export function updateSessionCallbacks(onProgress, onFileComplete) {
    if (currentUploadSession) {
        currentUploadSession.onProgress = onProgress;
        currentUploadSession.onFileComplete = onFileComplete;
        
        // Immediately trigger progress if running
        if (currentUploadSession.isRunning && onProgress) {
            const percent = currentUploadSession.totalBytes > 0 
                ? Math.round((currentUploadSession.uploadedBytes / currentUploadSession.totalBytes) * 100) 
                : 0;
            onProgress(percent);
        }
    }
}

/**
 * Negotiate upload settings with server based on connection type.
 * Silently determines optimal chunk size (AP mode vs Ethernet).
 * @returns {Promise<{chunk_size: number, tier: string, connection_type: string, interface: string}>}
 */
async function negotiateUploadSettings() {
    // Return cached settings if available
    if (negotiatedSettings) {
        return negotiatedSettings;
    }

    try {
        const response = await fetch('/api/storage/upload/negotiate');
        if (response.ok) {
            negotiatedSettings = await response.json();
            console.debug(`Upload settings negotiated: ${negotiatedSettings.tier} tier, ${negotiatedSettings.chunk_size / 1024 / 1024}MB chunks`);
            return negotiatedSettings;
        }
    } catch (error) {
        console.debug('Could not negotiate upload settings, using defaults:', error);
    }

    // Fallback to defaults if negotiation fails
    negotiatedSettings = {
        chunk_size: DEFAULT_CHUNK_SIZE,
        tier: isMobile ? 'slow' : 'medium',
        connection_type: 'unknown',
        interface: 'unknown'
    };
    return negotiatedSettings;
}

/**
 * Get current chunk size (negotiated or default)
 * @returns {number}
 */
function getChunkSize() {
    return negotiatedSettings?.chunk_size || DEFAULT_CHUNK_SIZE;
}

/**
 * Get current max concurrent chunks (negotiated or default)
 * @returns {number}
 */
export function getMaxConcurrentChunks() {
    const configuredLimit = negotiatedSettings?.max_concurrent_chunks || MAX_CONCURRENT_CHUNKS;
    if (getCurrentLayout() === 'streaming' && isUploadInProgress()) {
        return 1;
    }
    return configuredLimit;
}

/**
 * Get current hardware tier (negotiated or null)
 * @returns {string|null}
 */
export function getHardwareTier() {
    return negotiatedSettings?.hardware_tier || null;
}

/**
 * Check for duplicate files before uploading
 * @param {Array<{file: File, relativePath: string}>} files - Files to check
 * @param {string} drivePath - Target drive path
 * @param {string} subfolder - Target subfolder
 * @returns {Promise<Array<string>>} - Array of duplicate file paths
 */
export async function checkDuplicates(files, drivePath, subfolder = '') {
    try {
        const filesToCheck = files.map(f => ({
            filename: f.file.name,
            relativePath: f.relativePath || ''
        }));

        const response = await fetch('/api/storage/upload/check-duplicates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                drive_path: drivePath,
                subfolder: subfolder,
                files: filesToCheck
            })
        });

        if (response.ok) {
            const data = await response.json();
            duplicateDetectionState.duplicates = data.duplicates || [];
            duplicateDetectionState.checked = true;
            return duplicateDetectionState.duplicates;
        } else {
            console.error('Failed to check duplicates');
            return [];
        }
    } catch (error) {
        console.error('Error checking duplicates:', error);
        return [];
    }
}

/**
 * Upload files with smart batching and chunking
 * @param {Array<{file: File, relativePath: string}>} files - Files to upload
 * @param {string} drivePath - Target drive path
 * @param {string} subfolder - Target subfolder
 * @param {Function} onProgress - Progress callback (0-100)
 * @param {Function} onFileComplete - Called when each file completes
 * @param {boolean} skipDuplicateCheck - Skip duplicate detection (for when user has already decided)
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
export async function uploadFiles(files, drivePath, subfolder = '', onProgress = null, onFileComplete = null, skipDuplicateCheck = false) {
    // If there's already a session running, don't start a new one
    if (currentUploadSession && currentUploadSession.isRunning) {
        console.warn('Upload already in progress');
        return;
    }

    // Check for duplicates if not already done or explicitly skipped
    if (!skipDuplicateCheck && !duplicateDetectionState.checked) {
        await checkDuplicates(files, drivePath, subfolder);

        // If duplicates found and user hasn't made a choice, wait for user decision
        if (duplicateDetectionState.duplicates.length > 0 && !duplicateDetectionState.userChoice) {
            console.log('Duplicates detected, waiting for user decision');
            return { success: 0, failed: 0, errors: [], waitingForUser: true };
        }
    }

    // Filter out duplicates if user chose to skip them
    if (duplicateDetectionState.userChoice === 'skip' && duplicateDetectionState.duplicates.length > 0) {
        const duplicateSet = new Set(duplicateDetectionState.duplicates);
        files = files.filter(f => {
            const displayPath = f.relativePath || f.file.name;
            return !duplicateSet.has(displayPath);
        });

        if (files.length === 0) {
            console.log('All files were duplicates, nothing to upload');
            resetDuplicateState();
            return { success: 0, failed: 0, errors: [], skippedAll: true };
        }
    }

    uploadCancelled = false;

    // Initialize session state for background persistence
    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
    currentUploadSession = {
        files,
        fileCount: files.length,
        drivePath,
        subfolder,
        results: { success: 0, failed: 0, errors: [], log: [] }, // Added log
        totalBytes,
        uploadedBytes: 0,
        onProgress,
        onFileComplete,
        isRunning: true
    };

    // Show global indicator if it exists, or create it
    updateGlobalIndicator();

    // Negotiate upload settings before starting (silent, cached)
    await negotiateUploadSettings();

    const results = currentUploadSession.results;
    
    // Split files into large (chunked) and small (batched)
    const largeFiles = [];
    const smallFiles = [];
    
    for (const fileInfo of files) {
        if (fileInfo.file.size > LARGE_FILE_THRESHOLD) {
            largeFiles.push(fileInfo);
        } else {
            smallFiles.push(fileInfo);
        }
    }
    
    // Create batches from small files (max 200MB each)
    const batches = createBatches(smallFiles, MAX_BATCH_SIZE);
    
    const updateProgress = (currentFileBytes = 0) => {
        const percent = currentUploadSession.totalBytes > 0 
            ? Math.round(((currentUploadSession.uploadedBytes + currentFileBytes) / currentUploadSession.totalBytes) * 100) 
            : 0;
        
        if (currentUploadSession.onProgress) {
            currentUploadSession.onProgress(percent);
        }
        updateGlobalIndicator(percent);
    };
    
    try {
        // Upload small file batches
        for (const batch of batches) {
            if (uploadCancelled) break;
            
            try {
                const batchSize = batch.reduce((sum, f) => sum + f.file.size, 0);
                
                if (batch.length === 1) {
                    // Single file - simple upload
                    await uploadFileSimple(batch[0].file, drivePath, subfolder, batch[0].relativePath, (progress) => {
                        updateProgress(batchSize * (progress / 100));
                    }, batch[0].customFilename);
                } else {
                    // Multiple files - batch upload
                    await uploadFileBatch(batch, drivePath, subfolder);
                }
                
                // Update progress for batch
                currentUploadSession.uploadedBytes += batchSize;
                results.success += batch.length;
                // Add each file in batch to log (consistent with error handling at line 215)
                for (const f of batch) {
                    results.log.push({ filename: f.customFilename || f.file.name, success: true });
                }
                updateProgress();

                if (currentUploadSession.onFileComplete) {
                    for (const f of batch) {
                        currentUploadSession.onFileComplete(f.customFilename || f.file.name, true);
                    }
                }
            } catch (error) {
                results.failed += batch.length;
                const errorMsg = error.message;
                batch.forEach(f => results.log.push({ filename: f.customFilename || f.file.name, success: false, error: errorMsg }));
                results.errors.push({ files: batch.map(f => f.customFilename || f.file.name), error: errorMsg });
                currentUploadSession.uploadedBytes += batch.reduce((sum, f) => sum + f.file.size, 0);
                updateProgress();
                
                if (currentUploadSession.onFileComplete) {
                    for (const f of batch) {
                        currentUploadSession.onFileComplete(f.customFilename || f.file.name, false, error.message);
                    }
                }
            }
        }
        
        // Upload large files with chunking (sequential to save RAM)
        for (const fileInfo of largeFiles) {
            if (uploadCancelled) {
                results.errors.push({ files: [fileInfo.customFilename || fileInfo.file.name], error: 'Cancelled' });
                results.failed++;
                continue;
            }
            
            try {
                await uploadFileChunked(fileInfo.file, drivePath, subfolder, fileInfo.relativePath, (chunkProgress) => {
                    updateProgress(fileInfo.file.size * (chunkProgress / 100));
                }, fileInfo.customFilename);
                
                currentUploadSession.uploadedBytes += fileInfo.file.size;
                results.success++;
                results.log.push({ filename: fileInfo.customFilename || fileInfo.file.name, success: true });
                updateProgress();
                
                if (currentUploadSession.onFileComplete) {
                    currentUploadSession.onFileComplete(fileInfo.customFilename || fileInfo.file.name, true);
                }
            } catch (error) {
                results.failed++;
                const errorMsg = error.message;
                results.log.push({ filename: fileInfo.customFilename || fileInfo.file.name, success: false, error: errorMsg });
                results.errors.push({ files: [fileInfo.customFilename || fileInfo.file.name], error: errorMsg });
                currentUploadSession.uploadedBytes += fileInfo.file.size;
                updateProgress();
                
                if (currentUploadSession.onFileComplete) {
                    currentUploadSession.onFileComplete(fileInfo.customFilename || fileInfo.file.name, false, error.message);
                }
            }
        }
    } finally {
        currentUploadSession.isRunning = false;
        releaseCurrentSessionFileHandles();
        // Don't clear currentUploadSession yet so the UI can show final results
        updateGlobalIndicator(100, true);
    }
    
    return results;
}

/**
 * Create batches from files, respecting max batch size
 */
function createBatches(files, maxSize) {
    const batches = [];
    let currentBatch = [];
    let currentSize = 0;
    
    for (const fileInfo of files) {
        if (currentSize + fileInfo.file.size > maxSize && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(fileInfo);
        currentSize += fileInfo.file.size;
    }
    
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    
    return batches;
}

/**
 * Simple single file upload using XHR for progress tracking
 */
async function uploadFileSimple(file, drivePath, subfolder, relativePath = '', onProgress = null, customFilename = '') {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('drive_path', drivePath);
        formData.append('subfolder', subfolder);
        formData.append('file', file);
        if (relativePath) {
            formData.append('relative_path', relativePath);
        }
        if (customFilename) {
            // Append extension if not present in customFilename
            const originalExt = file.name.substring(file.name.lastIndexOf('.'));
            let finalName = customFilename;
            if (!finalName.toLowerCase().endsWith(originalExt.toLowerCase())) {
                finalName += originalExt;
            }
            formData.append('custom_filename', finalName);
        }
        
        const xhr = new XMLHttpRequest();

        // XHR event listeners below are intentionally unmanaged by RAGOT lifecycle.
        // They are short-lived: the XHR object is request-scoped and the listeners
        // are garbage-collected when the request settles (load/error/abort). No leak risk.
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress((e.loaded / e.total) * 100);
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                resolve();
            } else {
                try {
                    const data = JSON.parse(xhr.responseText);
                    reject(new Error(data.error || 'Upload failed'));
                } catch {
                    reject(new Error('Upload failed'));
                }
            }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
        
        xhr.open('POST', '/api/storage/upload');
        xhr.send(formData);
    });
}

/**
 * Batch upload multiple small files
 * Uploads files sequentially to be memory-friendly on Pi
 */
async function uploadFileBatch(batch, drivePath, subfolder) {
    // Upload files in batch sequentially (Pi RAM friendly)
    for (const fileInfo of batch) {
        if (uploadCancelled) throw new Error('Upload cancelled');
        await uploadFileSimple(fileInfo.file, drivePath, subfolder, fileInfo.relativePath, null, fileInfo.customFilename);
    }
}

/**
 * Chunked upload for large files
 */
async function uploadFileChunked(file, drivePath, subfolder, relativePath = '', onProgress = null, customFilename = '') {
    // Get negotiated chunk size (or default)
    const chunkSize = getChunkSize();
    const totalChunks = Math.ceil(file.size / chunkSize);

    const initData = {
        filename: file.name,
        total_chunks: totalChunks,
        total_size: file.size,
        drive_path: drivePath,
        subfolder: subfolder,
        relative_path: relativePath,
        chunk_size: chunkSize
    };

    if (customFilename) {
        // Append extension if not present in customFilename
        const originalExt = file.name.substring(file.name.lastIndexOf('.'));
        let finalName = customFilename;
        if (!finalName.toLowerCase().endsWith(originalExt.toLowerCase())) {
            finalName += originalExt;
        }
        initData.custom_filename = finalName;
    }

    // Initialize upload session with negotiated chunk size
    const initResponse = await fetch('/api/storage/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initData)
    });
    
    if (!initResponse.ok) {
        const error = await initResponse.json();
        throw new Error(error.error || 'Failed to initialize upload');
    }
    
    const { upload_id } = await initResponse.json();
    activeUploads.set(upload_id, { filename: file.name, cancelled: false });
    
    try {
        let completedChunks = 0;
        const pendingChunks = [];
        
        for (let i = 0; i < totalChunks; i++) {
            if (uploadCancelled || activeUploads.get(upload_id)?.cancelled) {
                throw new Error('Upload cancelled');
            }

            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);
            
            const chunkPromise = uploadChunk(upload_id, i, chunk).then(() => {
                completedChunks++;
                if (onProgress) {
                    onProgress((completedChunks / totalChunks) * 100);
                }
            });
            
            pendingChunks.push(chunkPromise);
            
            // Control concurrency
            if (pendingChunks.length >= getMaxConcurrentChunks()) {
                await Promise.race(pendingChunks);
                // Remove settled promises
                for (let j = pendingChunks.length - 1; j >= 0; j--) {
                    const settled = await Promise.race([
                        pendingChunks[j].then(() => true).catch(() => true),
                        Promise.resolve(false)
                    ]);
                    if (settled) {
                        pendingChunks.splice(j, 1);
                    }
                }
            }
        }
        
        // Wait for remaining chunks
        await Promise.all(pendingChunks);
        
    } catch (error) {
        // Cancel on error
        try {
            await fetch(`/api/storage/upload/cancel/${upload_id}`, { method: 'POST' });
        } catch {}
        throw error;
    } finally {
        activeUploads.delete(upload_id);
    }
}

/**
 * Upload a single chunk
 */
async function uploadChunk(uploadId, chunkIndex, chunkBlob) {
    const formData = new FormData();
    formData.append('upload_id', uploadId);
    formData.append('chunk_index', chunkIndex.toString());
    formData.append('chunk', chunkBlob);
    
    const response = await fetch('/api/storage/upload/chunk', {
        method: 'POST',
        body: formData
    });
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Chunk upload failed');
    }
    
    return response.json();
}

/**
 * Cancel all active uploads
 */
export function cancelAllUploads() {
    uploadCancelled = true;
    
    for (const [uploadId, info] of activeUploads) {
        info.cancelled = true;
        fetch(`/api/storage/upload/cancel/${uploadId}`, { method: 'POST' }).catch(() => {});
    }
    activeUploads.clear();
    
    if (currentUploadSession) {
        currentUploadSession.isRunning = false;
        releaseCurrentSessionFileHandles();
    }
    updateGlobalIndicator(0, true);
}

function releaseCurrentSessionFileHandles() {
    if (!currentUploadSession?.files) return;
    currentUploadSession.fileSummaries = currentUploadSession.files.map((item) => ({
        name: item.customFilename || item.file?.name || '',
        size: item.file?.size || 0,
        relativePath: item.relativePath || ''
    }));
    currentUploadSession.files = [];
}

/**
 * Check if uploads are cancelled
 */
export function isUploadCancelled() {
    return uploadCancelled;
}

/**
 * Update the global upload progress indicator in the UI
 * This indicator is visible even when the upload modal is closed.
 */
function updateGlobalIndicator(percent = 0, finished = false) {
    let indicator = $('#global-upload-indicator');
    
    if (finished || !currentUploadSession || !currentUploadSession.isRunning) {
        if (indicator) {
            indicator.classList.add('finished');
            setTimeout(() => {
                if (indicator && indicator.classList.contains('finished')) {
                    indicator.remove();
                }
            }, 3000);
        }
        return;
    }

    if (!indicator) {
        indicator = createElement('div', {
            id: 'global-upload-indicator',
            className: 'global-upload-indicator',
            onclick: () => {
                // Re-open focused upload status if clicked
                if (window.ragotModules && window.ragotModules.uiController && typeof window.ragotModules.uiController.openUploadStatus === 'function') {
                    window.ragotModules.uiController.openUploadStatus();
                } else if (window.ragotModules && window.ragotModules.uiController && typeof window.ragotModules.uiController.openFileManager === 'function') {
                    window.ragotModules.uiController.openFileManager();
                } else {
                    // Fallback: try to find the modal and show it
                    const modal = $('#file-manager-modal');
                    if (modal) modal.classList.remove('hidden');
                }
            },
            innerHTML: `
            <div class="gui-content">
                <div class="gui-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                </div>
                <div class="gui-details">
                    <div class="gui-text">Uploading ${currentUploadSession.fileCount || currentUploadSession.files.length} files...</div>
                    <div class="gui-progress-container">
                        <div class="gui-progress-fill" style="width: 0%"></div>
                    </div>
                </div>
                <button class="gui-cancel-btn" title="Cancel upload">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        `
        });
        document.body.appendChild(indicator);
        
        const cancelBtn = $('.gui-cancel-btn', indicator);
        if (cancelBtn) {
            attr(cancelBtn, {
                onClick: async (e) => {
                    e.stopPropagation();
                    if (await dialog.confirm('Cancel all active uploads?')) {
                        cancelAllUploads();
                    }
                }
            });
        }
    }

    const fill = $('.gui-progress-fill', indicator);
    if (fill) fill.style.width = `${percent}%`;
    
    const text = $('.gui-text', indicator);
    if (text) text.textContent = `Uploading ${currentUploadSession.fileCount || currentUploadSession.files.length} files (${percent}%)`;
}

/**
 * Reset cancelled state (call before starting new upload batch)
 */
export function resetUploadState() {
    uploadCancelled = false;
    // We don't reset currentUploadSession here as it might be used to show results
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
