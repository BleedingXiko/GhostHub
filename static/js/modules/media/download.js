/**
 * Download Manager Module
 * Handles file and category downloads with smart batching for large categories.
 */

import { ensureFeatureAccess } from '../../utils/authManager.js';
import { videoIcon, archiveIcon, downloadIcon, folderIcon, fileIcon } from '../../utils/icons.js';
import { isUserAdmin } from '../../utils/progressDB.js';
import { Module, createElement, attr, $, $$ } from '../../libs/ragot.esm.min.js';
import { getCurrentViewerRecord } from './viewerState.js';

// Reference to app state (set via init)
let appState = null;
let mediaViewer = null;
let downloadLifecycle = null;
let floatingDownloadVisible = true;

function ensureDownloadLifecycle() {
    if (!downloadLifecycle) {
        downloadLifecycle = new Module();
        downloadLifecycle.start();
        downloadLifecycle.on(document, 'click', handleGlobalDownloadClick);
    }
    return downloadLifecycle;
}

/**
 * Initialize the download manager
 * @param {Object} state - Reference to app.state
 * @param {HTMLElement} container - The media viewer element
 */
function initDownloadManager(state, container) {
    appState = state;
    mediaViewer = container;
    floatingDownloadVisible = true;
    ensureDownloadLifecycle();
}

function updateFloatingDownloadVisibility() {
    const container = $('#download-btn-container');
    if (!container) return;

    const currentMedia = getCurrentMediaItem();
    container.style.display = (floatingDownloadVisible && currentMedia) ? 'block' : 'none';
}

/**
 * Get the current active media item from the global state.
 * @returns {Object|null} The current media item or null if not available.
 */
function getCurrentMediaItem() {
    return getCurrentViewerRecord(appState);
}

/**
 * Download the current media file using native browser download
 * Password protected to prevent resource abuse on Pi
 */
async function downloadCurrentMedia() {
    // Check password protection first
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        console.log('Download denied by password protection.');
        return;
    }

    const currentMedia = getCurrentMediaItem();
    if (!currentMedia || !currentMedia.url) {
        console.warn('No media to download');
        return;
    }

    // Create a temporary anchor element for download
    const link = createElement('a', { href: currentMedia.url, download: currentMedia.name || currentMedia.url.split('/').pop() || 'media', style: { display: 'none' } });

    // Append to body, click, and remove
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    console.log(`Download initiated: ${currentMedia.name}`);
}

/**
 * Show a notification toast
 * @param {string} message - Message to show
 * @param {string} type - 'success', 'error', or 'info'
 * @param {number} duration - How long to show (ms)
 */
function showDownloadNotification(message, type = 'info', duration = 4000) {
    // Remove any existing notification
    const existing = $('.download-notification');
    if (existing) existing.remove();

    const notification = createElement('div', {
        className: `download-notification download-notification--${type}`,
        innerHTML: `<span class="notification-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span><span class="notification-text">${message}</span>`
    });

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('notification-leaving');
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

/**
 * Download the current category as a ZIP file
 * Admin-only with password protection
 * Supports multi-part downloads for large categories (>200MB)
 */
async function downloadCurrentCategory() {
    // Check admin status
    if (!isUserAdmin()) {
        showDownloadNotification('Only admin can download categories', 'error');
        return;
    }

    // Check password protection
    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        console.log('Category download denied by password protection.');
        return;
    }

    const categoryId = appState?.currentCategoryId;
    const categoryName = appState?.currentCategoryName || categoryId;

    if (!categoryId) {
        showDownloadNotification('No category selected', 'error');
        return;
    }

    // Hide dropdown immediately
    hideDownloadDropdown();

    try {
        // Check how many parts we need
        const infoResponse = await fetch(`/api/categories/${categoryId}/download/info`);
        if (!infoResponse.ok) {
            const error = await infoResponse.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to get download info');
        }

        const info = await infoResponse.json();
        const { folder_name, total_size_formatted, num_parts, parts } = info;

        console.log(`[Download] Category: ${folder_name}, Size: ${total_size_formatted}, Parts: ${num_parts}`);

        if (!parts || parts.length === 0) {
            showDownloadNotification('No files to download', 'error');
            return;
        }

        if (parts.length > 1) {
            // Multiple items - show modal with smart download options
            showSmartDownloadModal(categoryId, categoryName, total_size_formatted, parts);
            return;
        }

        // Single item - direct download (no modal needed)
        const part = parts[0];
        if (part.is_single) {
            // Direct file download - no ZIP
            showDownloadNotification(`Downloading "${part.filename}"...`, 'info', 5000);
            const a = createElement('a', { href: `/api/categories/${categoryId}/file/${encodeURIComponent(part.filename)}`, download: part.filename, style: { display: 'none' } });
            document.body.appendChild(a);
            a.click();
            a.remove();
        } else {
            // Batched small files - ZIP
            showDownloadNotification(`Downloading "${categoryName}.zip"...`, 'info', 5000);
            const a = createElement('a', { href: `/api/categories/${categoryId}/download/1`, download: `${categoryName}.zip`, style: { display: 'none' } });
            document.body.appendChild(a);
            a.click();
            a.remove();
        }

    } catch (error) {
        console.error('Error downloading category:', error);
        showDownloadNotification(`Download failed: ${error.message}`, 'error', 6000);
    }
}

/**
 * Show smart download modal - single files get direct download, batched files get ZIP
 * Uses existing modal CSS from layout.css
 */
function showSmartDownloadModal(categoryId, categoryName, totalSize, parts) {
    // Remove existing modal if any
    const existing = $('#smart-download-modal');
    if (existing) existing.remove();

    // Create download link elements - different for single files vs batched
    const linkElements = parts.map((part, i) => {
        const partNum = i + 1;
        if (part.is_single) {
            // Single file - direct download link (no ZIP)
            return createElement('a', {
                href: `/api/categories/${categoryId}/file/${encodeURIComponent(part.filename)}`,
                download: part.filename,
                className: 'download-part-link',
                onClick: (e) => e.currentTarget.classList.add('downloaded'),
                children: [
                    createElement('span', { className: 'part-icon', innerHTML: videoIcon(20) }),
                    createElement('span', { className: 'part-name', textContent: part.filename }),
                    createElement('span', { className: 'part-size', textContent: part.size_formatted }),
                    createElement('span', { className: 'part-action', textContent: 'Download' })
                ]
            });
        } else {
            // Multiple small files - ZIP bundle
            return createElement('a', {
                href: `/api/categories/${categoryId}/download/${partNum}`,
                download: `${categoryName}_bundle${partNum}.zip`,
                className: 'download-part-link',
                onClick: (e) => e.currentTarget.classList.add('downloaded'),
                children: [
                    createElement('span', { className: 'part-icon', innerHTML: archiveIcon(20) }),
                    createElement('span', { className: 'part-name', textContent: `${part.file_count} files (ZIP)` }),
                    createElement('span', { className: 'part-size', textContent: part.size_formatted }),
                    createElement('span', { className: 'part-action', textContent: 'Download' })
                ]
            });
        }
    });

    const closeBtn = createElement('button', { className: 'btn btn--icon modal__close', id: 'close-smart-modal', innerHTML: '&times;' });

    // Create modal using existing .modal class pattern
    const modal = createElement('div', {
        id: 'smart-download-modal',
        className: 'modal',
        children: [
            createElement('style', {
                textContent: `
                #smart-download-modal .download-parts-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #smart-download-modal .download-part-link {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 8px;
                    color: var(--text-primary, #fff);
                    text-decoration: none;
                    transition: background 0.2s;
                }
                #smart-download-modal .download-part-link:hover {
                    background: rgba(255,255,255,0.1);
                }
                #smart-download-modal .download-part-link.downloaded {
                    background: rgba(34, 197, 94, 0.2);
                    border: 1px solid #22c55e;
                }
                #smart-download-modal .download-part-link.downloaded .part-action::after {
                    content: ' ✓';
                    color: #22c55e;
                }
                #smart-download-modal .part-icon { font-size: 20px; }
                #smart-download-modal .part-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                #smart-download-modal .part-size { color: var(--text-secondary, #888); font-size: 12px; flex-shrink: 0; }
                #smart-download-modal .part-action { color: var(--accent-color, #6366f1); font-weight: 500; flex-shrink: 0; }
                #smart-download-modal .modal-info {
                    color: var(--text-secondary, #aaa);
                    font-size: 13px;
                    margin-bottom: 16px;
                }
            `
            }),
            createElement('div', {
                className: 'modal__content',
                children: [
                    createElement('div', {
                        className: 'modal__header',
                        children: [
                            createElement('h2', { className: 'modal__title', textContent: 'Download Category' }),
                            closeBtn
                        ]
                    }),
                    createElement('div', {
                        className: 'modal__body',
                        children: [
                            createElement('div', {
                                className: 'modal-info',
                                innerHTML: `
                                "${categoryName}" • ${totalSize}<br>
                                ${parts.length} item${parts.length > 1 ? 's' : ''} • ${videoIcon(14)} = direct file, ${archiveIcon(14)} = bundled ZIP
                            `
                            }),
                            createElement('div', {
                                className: 'download-parts-list',
                                children: linkElements
                            })
                        ]
                    })
                ]
            })
        ]
    });

    document.body.appendChild(modal);

    // Prevent page scrolling behind modal
    document.body.style.overflow = 'hidden';

    const closeModal = () => {
        modal.remove();
        document.body.style.overflow = '';
        ensureDownloadLifecycle().off(document, 'keydown', escHandler);
    };

    // Close button handler
    attr($('#close-smart-modal'), { onClick: closeModal });

    // Click overlay to close
    attr(modal, {
        onClick: (e) => {
            if (e.target === modal) {
                closeModal();
            }
        }
    });

    // ESC key to close
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    };
    ensureDownloadLifecycle().on(document, 'keydown', escHandler);
}

/**
 * Toggle the download dropdown menu
 */
function toggleDownloadDropdown(e) {
    e.stopPropagation();
    e.preventDefault();
    const dropdown = $('#download-dropdown');
    if (dropdown) {
        const isVisible = dropdown.style.display === 'flex';
        if (isVisible) {
            dropdown.style.display = 'none';
        } else {
            dropdown.style.display = 'flex';
        }
    }
}

/**
 * Hide the download dropdown
 */
function hideDownloadDropdown() {
    const dropdown = $('#download-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

/**
 * Update the download dropdown content based on admin status
 */
function updateDownloadDropdownContent() {
    const dropdown = $('#download-dropdown');
    if (!dropdown) return;

    const isAdmin = isUserAdmin();

    dropdown.innerHTML = `
        <button class="download-option" id="download-file-btn" title="Download this file">
            ${fileIcon(18)}
            <span>File</span>
        </button>
        ${isAdmin ? `
        <button class="download-option" id="download-folder-btn" title="Download entire category as ZIP">
            ${folderIcon(18)}
            <span>Category</span>
        </button>
        ` : ''}
    `;

    // Re-attach event listeners
    const fileBtn = $('#download-file-btn', dropdown);
    const folderBtn = $('#download-folder-btn', dropdown);

    if (fileBtn) {
        attr(fileBtn, {
            onClick: async (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('[Download] File button clicked');
                hideDownloadDropdown();
                await downloadCurrentMedia();
            }
        });
    }

    if (folderBtn) {
        attr(folderBtn, {
            onClick: async (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('[Download] Category button clicked');
                await downloadCurrentCategory();
            }
        });
    }
}

/**
 * Create or update the download button in the media view
 */
function ensureDownloadButton() {
    let downloadBtn = $('#media-download-btn');
    let downloadDropdown = $('#download-dropdown');

    if (!downloadBtn) {
        // Create container for button + dropdown
        const container = createElement('div', { className: 'download-btn-container', id: 'download-btn-container' });

        downloadBtn = createElement('button', { id: 'media-download-btn', className: 'media-download-btn', title: 'Download', innerHTML: downloadIcon(20), onClick: toggleDownloadDropdown });

        // Create dropdown
        downloadDropdown = createElement('div', { id: 'download-dropdown', className: 'download-dropdown', style: { display: 'none' } });

        container.appendChild(downloadBtn);
        container.appendChild(downloadDropdown);

        // Add to media viewer
        if (mediaViewer) {
            mediaViewer.appendChild(container);
        }

        // Populate dropdown
        updateDownloadDropdownContent();
    }

    updateFloatingDownloadVisibility();
}

function setFloatingDownloadVisible(visible) {
    floatingDownloadVisible = visible !== false;
    updateFloatingDownloadVisibility();
}

/**
 * Remove the download button (called when leaving media view)
 */
function removeDownloadButton() {
    const container = $('#download-btn-container');
    if (container) {
        container.remove();
    }
}

/**
 * Create a unified download button element with dropdown menu
 * @returns {HTMLElement} The download container element
 */
function createDownloadButton() {
    const container = createElement('div', { className: 'media-download-container' });

    container.innerHTML = `
        <button class="media-download-btn" aria-label="Download" title="Download">
            ${downloadIcon(20)}
        </button>
        <div class="media-download-menu">
            <div class="media-download-option" data-action="file">
                ${fileIcon(20)}
                FILE
            </div>
            <div class="media-download-option" data-action="category">
                ${folderIcon(20)}
                CATEGORY
            </div>
        </div>
    `;

    const btn = $('.media-download-btn', container);
    const menu = $('.media-download-menu', container);

    // Toggle menu
    attr(btn, {
        onClick: (e) => {
            e.stopPropagation();
            e.preventDefault();

            // Close other open menus first (optional, but good practice)
            $$('.media-download-menu.visible').forEach(m => {
                if (m !== menu) m.classList.remove('visible');
            });

            menu.classList.toggle('visible');
        }
    });

    // Handle menu clicks
    attr(menu, {
        onClick: (e) => {
            e.stopPropagation();
            const option = e.target.closest('.media-download-option');
            if (!option) return;

            const action = option.dataset.action;
            if (action === 'file') {
                downloadCurrentMedia();
            } else if (action === 'category') {
                downloadCurrentCategory();
            }

            menu.classList.remove('visible');
        }
    });

    return container;
}

function handleGlobalDownloadClick(e) {
    if (!e.target.closest('#download-btn-container')) {
        hideDownloadDropdown();
    }

    if (!e.target.closest('.media-download-container')) {
        $$('.media-download-menu.visible').forEach(menu => {
            menu.classList.remove('visible');
        });
    }
}

function cleanupDownloadManager() {
    if (downloadLifecycle) {
        downloadLifecycle.stop();
        downloadLifecycle = null;
    }
}

export {
    initDownloadManager,
    getCurrentMediaItem,
    downloadCurrentMedia,
    showDownloadNotification,
    downloadCurrentCategory,
    ensureDownloadButton,
    cleanupDownloadManager,
    removeDownloadButton,
    hideDownloadDropdown,
    createDownloadButton,
    setFloatingDownloadVisible
};
