/**
 * File Manager Module
 * Admin NAS-like file/upload management.
 *
 * RAGOT Architecture:
 *   FileManagerModule (Module)
 *     owns all state: drives, selectedDrive, selectedFolder, mode, uploads, reveal-hidden
 *     owns all lifecycle: timers, socket listeners, document listeners
 *     adopts FileManagerModalComponent (Component)
 *       owns modal DOM, mounts MediaListComponent for media browser
 *         MediaListComponent (Component)
 *           mounts VirtualScroller for large file lists
 *
 * Zero module-level mutable state. All state lives in FileManagerModule.
 */

import {
    uploadFiles as uploadFilesOptimized,
    cancelAllUploads as cancelUploadsShared,
    resetUploadState,
    resetDuplicateState,
    getDuplicateState,
    isUploadCancelled,
    beginUploadActivity,
    formatBytes as formatBytesShared,
    getCurrentUploadSession,
    updateSessionCallbacks
} from '../../utils/uploadManager.js';
import { showDuplicateWarning } from '../../utils/duplicateWarning.js';
import {
    uploadIcon, folderClosedIcon, folderOpenIcon, hardDriveIcon, usbIcon,
    plusIcon, checkIcon, refreshIcon, cancelIcon, eyeIcon, chevronDownIcon,
    searchIcon, editIcon, eyeOffIcon, trashIcon, videoIcon, imageIcon,
    usbPortIcon
} from '../../utils/icons.js';
import { renderFolderTree } from '../../utils/folderTree.js';
import { enableShowHidden, disableShowHidden, isShowHiddenEnabled, getShowHiddenHeaders } from '../../utils/showHiddenManager.js';
import { refreshAllLayouts } from '../../utils/liveVisibility.js';
import { Module, Component, createElement, $, $$, append, prepend, insertBefore, remove, clear, attr, renderList, VirtualScroller, createIcon } from '../../libs/ragot.esm.min.js';
import { toast, dialog } from '../../utils/notificationManager.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';
import { createFocusTrap } from '../../utils/focusTrap.js';
import { scheduleAutofocus } from '../../utils/focusManager.js';

// ── Constants ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 10;
const SUPPORTED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
const SUPPORTED_VIDEO_EXT = ['.mp4', '.webm', '.ogv', '.ogg', '.mov'];
const SUPPORTED_EXTENSIONS = [...SUPPORTED_IMAGE_EXT, ...SUPPORTED_VIDEO_EXT];

const ICONS = {
    UPLOAD: uploadIcon(20), FOLDER: folderClosedIcon(16), FOLDER_OPEN: folderOpenIcon(16),
    DRIVE: hardDriveIcon(20), USB: usbIcon(20), PLUS: plusIcon(16), CHECK: checkIcon(16),
    REFRESH: refreshIcon(16), CANCEL: cancelIcon(16), EYE: eyeIcon(16),
    CHEVRON_DOWN: chevronDownIcon(12), SEARCH: searchIcon(16), EDIT: editIcon(16),
    EYE_OFF: eyeOffIcon(16), TRASH: trashIcon(16)
};

function isSupportedMedia(filename) {
    return SUPPORTED_EXTENSIONS.includes('.' + filename.split('.').pop().toLowerCase());
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatBytes(bytes) { return formatBytesShared(bytes); }

function formatCountdown(seconds) {
    if (seconds <= 0) return 'Expired';
    if (seconds < 60) return `Hiding in ${seconds}s`;
    if (seconds < 3600) return `Hiding in ${Math.ceil(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return `Hiding in ${h}h ${m}m`;
}

function getCategoryIdFromPath(filePath) {
    const roots = ['/media', '/media/usb', '/media/ghost', '/media/pi', '/mnt'];
    for (const root of roots) {
        if (filePath.startsWith(root + '/')) {
            const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
            const parts = folderPath.substring(root.length + 1).split('/').filter(Boolean);
            return `auto::${parts.join('::')}`;
        }
    }
    return null;
}

// ── MediaListComponent ─────────────────────────────────────────────────────
/**
 * Owns the media file list DOM with bidirectional virtualization.
 * State: { files, selectedIndices (Set) }
 * External callbacks injected via setActionHandler.
 */
class MediaListComponent extends Component {
    constructor(files) {
        super({ files });
        this._vs = null;
        this._onAction = null; // (action, index) => void
        this._selectedIndices = new Set();
    }

    setActionHandler(fn) { this._onAction = fn; }
    getSelectedIndices() { return new Set(this._selectedIndices); }
    clearSelection() { this._selectedIndices.clear(); }

    render() {
        return createElement('div', { className: 'fm-media-list-inner' },
            createElement('div', { className: 'fm-media-count', textContent: `${this.state.files.length} files` }),
            createElement('div', { className: 'fm-virtual-list' })
        );
    }

    onStart() {
        const files = this.state.files;
        const listEl = $('.fm-virtual-list', this.element);

        // All item interactions delegated from the stable list container — registered
        // once here, never inside renderChunk. This way chunks can be freely evicted
        // and reloaded without accumulating listeners on the component.
        this.on(listEl, 'change', (e) => {
            const checkbox = e.target.closest('.fm-media-checkbox');
            if (!checkbox) return;
            const item = checkbox.closest('[data-index]');
            if (!item) return;
            const idx = parseInt(item.dataset.index);
            if (e.target.checked) this._selectedIndices.add(idx);
            else this._selectedIndices.delete(idx);
            if (this._onAction) this._onAction('selection-changed', idx);
        });

        this.on(listEl, 'click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                const action = btn.dataset.action;
                const idx = parseInt(btn.dataset.index);
                if (this._onAction) this._onAction(action, idx);
                return;
            }
            const staticName = e.target.closest('.fm-media-name-static');
            if (staticName) {
                const item = staticName.closest('[data-index]');
                if (!item) return;
                const idx = parseInt(item.dataset.index);
                if (this._onAction) this._onAction('edit-rename', idx);
            }
        });

        this.on(listEl, 'keydown', (e) => {
            const input = e.target.closest('.fm-file-rename-input');
            if (!input) return;
            const idx = parseInt(input.dataset.index);
            if (e.key === 'Enter') { e.preventDefault(); if (this._onAction) this._onAction('confirm-rename', idx); }
            else if (e.key === 'Escape') { e.preventDefault(); if (this._onAction) this._onAction('cancel-rename', idx); }
        });

        // The actual scroll container is .fm-media-list (overflow-y: auto),
        // not .file-manager-body. IO root must match the overflow element.
        const scrollRoot = this.element.closest('.fm-media-list') || null;
        // renderChunk and onRecycle read from this.state.files so rebind() updates
        // take effect without needing to pass new closures for these hooks.
        this._vs = new VirtualScroller({
            totalItems: () => this.state.files.length,
            chunkSize: PAGE_SIZE,
            maxChunks: 5,
            childPoolSize: 5,
            poolSize: 5,
            root: scrollRoot,
            rootMargin: '400px 0px',
            renderChunk: (i) => {
                // Pure DOM construction — no event listeners, no this.on().
                // Delegation above handles all interactions.
                const f = this.state.files;
                const start = i * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE, f.length);
                const wrapper = createElement('div', { className: 'fm-chunk loaded' });
                for (let j = start; j < end; j++) {
                    append(wrapper, _buildMediaItemEl(f[j], j, this._selectedIndices.has(j)));
                }
                return wrapper;
            },
            onRecycle: (el, i) => {
                const f = this.state.files;
                const start = i * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE, f.length);
                const items = el.querySelectorAll('.fm-media-item');
                // Patch existing rows if count matches, otherwise rebuild children.
                if (items.length === end - start) {
                    for (let k = 0; k < items.length; k++) {
                        _recycleMediaItemEl(items[k], f[start + k], start + k, this._selectedIndices.has(start + k));
                    }
                } else {
                    clear(el);
                    for (let j = start; j < end; j++) {
                        append(el, _buildMediaItemEl(f[j], j, this._selectedIndices.has(j)));
                    }
                }
            },
            measureChunk: (el, i) => {
                if (el.offsetHeight > 0) return el.offsetHeight;
                return Math.min(PAGE_SIZE, this.state.files.length - i * PAGE_SIZE) * 97;
            },
        });
        this._vs.mount(listEl);
    }

    onStop() {
        if (this._vs) { this._vs.unmount(); this._vs = null; }
    }

    /**
     * Swap the displayed file list without unmounting and remounting this component.
     * Recycles the existing VirtualScroller (preserves sentinels, IO, DOM shell)
     * and rebinds it to the new file array. Event delegation stays live.
     *
     * @param {Array} files - New file array to display
     */
    rebind(files) {
        this.state.files = files;
        const countEl = this.element?.querySelector('.fm-media-count');
        if (countEl) countEl.textContent = `${files.length} files`;

        if (!this._vs) return;
        const scrollRoot = this.element?.closest('.fm-media-list') || null;
        this._vs.recycle();
        // renderChunk, onRecycle, totalItems, and measureChunk all read from
        // this.state.files (updated above) so only root needs to be re-passed.
        this._vs.rebind({ root: scrollRoot }, this.element?.querySelector('.fm-virtual-list'));
    }
}

function _buildMediaItemEl(file, index, isSelected) {
    const lastDot = file.name.lastIndexOf('.');
    const baseName = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
    const ext = lastDot !== -1 ? file.name.substring(lastDot) : '';
    return createElement('div', {
        className: 'fm-media-item gh-stagger',
        style: { '--card-index': index % PAGE_SIZE },
        dataset: { index: String(index), path: file.path }
    },
        createElement('input', { type: 'checkbox', className: 'fm-media-checkbox', dataset: { index: String(index) }, ...(isSelected ? { checked: true } : {}) }),
        createElement('div', { className: 'fm-media-icon', innerHTML: file.type === 'video' ? videoIcon(20) : imageIcon(20) }),
        createElement('div', { className: 'fm-media-info' },
            createElement('div', { className: 'fm-media-name-container', dataset: { index: String(index) } },
                createElement('span', { className: 'fm-media-name-static', title: 'Click to rename', textContent: file.name }),
                createElement('div', { className: 'fm-rename-container hidden' },
                    createElement('input', { type: 'text', className: 'fm-file-rename-input', value: baseName, dataset: { index: String(index) }, placeholder: 'New name...' }),
                    createElement('span', { className: 'fm-file-ext', textContent: ext }),
                    createElement('button', { className: 'fm-icon-btn fm-rename-confirm-btn', dataset: { action: 'confirm-rename', index: String(index) }, title: 'Confirm', innerHTML: ICONS.CHECK })
                )
            ),
            createElement('div', { className: 'fm-media-meta', innerHTML: `${escapeHtml(file.size_formatted)}${file.hidden ? ' • <span class="fm-hidden-badge">Hidden</span>' : ''}` })
        ),
        createElement('div', { className: 'fm-media-actions-inline' },
            createElement('button', { className: 'fm-icon-btn', dataset: { action: 'edit-rename', index: String(index) }, title: 'Rename', innerHTML: ICONS.EDIT }),
            createElement('button', { className: 'fm-icon-btn', dataset: { action: 'hide', index: String(index) }, title: file.hidden ? 'Unhide' : 'Hide', innerHTML: file.hidden ? ICONS.EYE : ICONS.EYE_OFF }),
            createElement('button', { className: 'fm-icon-btn fm-delete-btn', dataset: { action: 'delete', index: String(index) }, title: 'Delete', innerHTML: ICONS.TRASH })
        )
    );
}

/**
 * Patch an existing .fm-media-item element in-place with new file data.
 * Called by onRecycle to update pooled chunk elements without DOM recreation.
 */
function _recycleMediaItemEl(el, file, index, isSelected) {
    const lastDot = file.name.lastIndexOf('.');
    const baseName = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
    const ext = lastDot !== -1 ? file.name.substring(lastDot) : '';
    const idxStr = String(index);

    el.dataset.index = idxStr;
    el.dataset.path = file.path;

    const checkbox = el.querySelector('.fm-media-checkbox');
    if (checkbox) { checkbox.dataset.index = idxStr; checkbox.checked = isSelected; }

    const icon = el.querySelector('.fm-media-icon');
    if (icon) icon.innerHTML = file.type === 'video' ? videoIcon(20) : imageIcon(20);

    const nameContainer = el.querySelector('.fm-media-name-container');
    if (nameContainer) nameContainer.dataset.index = idxStr;

    const nameStatic = el.querySelector('.fm-media-name-static');
    if (nameStatic) nameStatic.textContent = file.name;

    const renameInput = el.querySelector('.fm-file-rename-input');
    if (renameInput) { renameInput.value = baseName; renameInput.dataset.index = idxStr; }

    const extSpan = el.querySelector('.fm-file-ext');
    if (extSpan) extSpan.textContent = ext;

    const renameConfirm = el.querySelector('.fm-rename-confirm-btn');
    if (renameConfirm) renameConfirm.dataset.index = idxStr;

    const meta = el.querySelector('.fm-media-meta');
    if (meta) meta.innerHTML = `${escapeHtml(file.size_formatted)}${file.hidden ? ' • <span class="fm-hidden-badge">Hidden</span>' : ''}`;

    const actions = el.querySelectorAll('[data-action]');
    actions.forEach(btn => {
        btn.dataset.index = idxStr;
        if (btn.dataset.action === 'hide') {
            btn.title = file.hidden ? 'Unhide' : 'Hide';
            btn.innerHTML = file.hidden ? ICONS.EYE : ICONS.EYE_OFF;
        }
    });
}

// ── FileManagerModule ──────────────────────────────────────────────────────
/**
 * Owns ALL file manager state and lifecycle.
 * Instantiated once (singleton). start()/stop() called on open/close.
 */
class FileManagerModule extends Module {
    constructor() {
        super({});
        // All state as instance vars (not reactive Module state — no subscribers need reactivity here)
        this.modal = null;
        this.manageMode = false;
        this.drives = [];
        this.selectedDrive = null;
        this.selectedFolder = '';
        this.mediaFiles = [];
        this.selectedFiles = [];
        this.selectedUploadFileIndices = new Set();
        this.stagedUploads = [];
        this.isUploading = false;
        this.revealHiddenActive = false;
        this.revealHiddenExpiry = null;
        this._mediaListComp = null;
        this._folderTreeApi = null;
        this._folderSearchDebounce = null;
        this._revealHiddenTimer = null;
        this._focusTrap = null;
        this._returnFocusEl = null;
        this._activeRenameIndex = null;
        this._activeDriveRenameIndex = null;
        this._drivesRequestId = 0;
        this._foldersRequestId = 0;
        this._mediaRequestId = 0;
        this._socketHandlersBound = false;
        this._handleUsbMountsChanged = () => this._onUsbMountsChanged();
        this._handleCategoryUpdated = (data) => this._onCategoryUpdated(data);
    }

    // ── USB socket events ──────────────────────────────────────────────────
    _onUsbMountsChanged() { this._loadDrives(); }

    async _onCategoryUpdated(data) {
        if (data?.reason === 'category_hidden' || data?.reason === 'category_unhidden') {
            await this._checkRevealHiddenStatus();
            if (this.selectedDrive && this.manageMode) await this._loadFolders(this.selectedDrive.path);
        }
    }

    _startUsbPolling() {
        if (this._socketHandlersBound) return;
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
        if (socket) {
            this.onSocket(socket, SOCKET_EVENTS.USB_MOUNTS_CHANGED, this._handleUsbMountsChanged);
            this.onSocket(socket, SOCKET_EVENTS.CATEGORY_UPDATED, this._handleCategoryUpdated);
            this._socketHandlersBound = true;
        }
    }

    _stopUsbPolling() {
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
        if (!socket || !this._socketHandlersBound) return;
        this.offSocket(socket, SOCKET_EVENTS.USB_MOUNTS_CHANGED, this._handleUsbMountsChanged);
        this.offSocket(socket, SOCKET_EVENTS.CATEGORY_UPDATED, this._handleCategoryUpdated);
        this._socketHandlersBound = false;
    }

    async _refreshLayoutsAfterRevealChange() {
        const socket = window.ragotModules?.appStore?.get?.('socket', null);
        // The server emits a session-scoped category_updated socket event for
        // reveal/stop-reveal. When a socket is present, let that be the single
        // source of truth so we don't trigger overlapping row refreshes that can
        // leave placeholder shells stuck. Fall back to a direct refresh only if
        // this client does not have a socket connection.
        if (socket) return;
        await refreshAllLayouts(false, false, true, { refreshCategoryList: true });
    }

    // ── Modal construction ────────────────────────────────────────────────
    _buildModal() {
        const modal = createElement('div', { id: 'file-manager-modal', className: 'modal hidden' });

        const titleEl = createElement('h2', { className: 'fm-modal-title', textContent: 'File Manager' });

        const revealHiddenContainer = createElement('div', { id: 'fm-reveal-hidden-container', className: 'fm-reveal-hidden-container hidden' });
        const revealHiddenText = createElement('span', { id: 'fm-reveal-hidden-text', textContent: 'Reveal Hidden' });
        const revealChevron = createElement('span', { innerHTML: ICONS.CHEVRON_DOWN });
        const revealBtn = createElement('button', {
            id: 'fm-reveal-hidden-btn',
            className: 'fm-reveal-hidden-btn',
            'aria-haspopup': 'menu',
            'aria-expanded': 'false'
        });
        append(revealBtn, [revealHiddenText, revealChevron]);

        const revealDropdown = createElement('div', { id: 'fm-reveal-hidden-dropdown', className: 'fm-reveal-hidden-dropdown hidden' });
        append(revealDropdown, [
            createElement('div', { className: 'fm-reveal-dropdown-header', textContent: 'Duration' }),
            createElement('label', { className: 'fm-reveal-option' },
                createElement('input', { type: 'radio', name: 'reveal-duration', value: '900' }),
                ' 15 minutes'
            ),
            createElement('label', { className: 'fm-reveal-option' },
                createElement('input', { type: 'radio', name: 'reveal-duration', value: '1800' }),
                ' 30 minutes'
            ),
            createElement('label', { className: 'fm-reveal-option' },
                createElement('input', { type: 'radio', name: 'reveal-duration', value: '3600', checked: true }),
                ' 1 hour'
            ),
            createElement('label', { className: 'fm-reveal-option' },
                createElement('input', { type: 'radio', name: 'reveal-duration', value: '7200' }),
                ' 2 hours'
            ),
            createElement('div', { className: 'fm-reveal-dropdown-divider' })
        ]);
        const revealConfirmBtn = createElement('button', { id: 'fm-reveal-confirm-btn', className: 'btn btn--sm btn--primary fm-reveal-confirm-btn', textContent: 'Reveal Hidden' });
        const revealStopBtn = createElement('button', { id: 'fm-reveal-stop-btn', className: 'btn btn--sm btn--danger fm-reveal-stop-btn hidden', textContent: 'Stop Revealing' });
        append(revealDropdown, [revealConfirmBtn, revealStopBtn]);
        append(revealHiddenContainer, [revealBtn, revealDropdown]);

        const closeBtn = createElement('button', { id: 'file-manager-close-btn', className: 'btn btn--icon modal__close', textContent: '×' });

        const modalContent = createElement('div', {
            className: 'modal__content file-manager-modal-content',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'File manager'
        });
        const header = createElement('div', { className: 'modal__header' });
        const headerActions = createElement('div', { className: 'fm-header-actions' });
        append(headerActions, [revealHiddenContainer, closeBtn]);
        append(header, [titleEl, headerActions]);

        // Body sections
        const drivesSection = createElement('div', { className: 'fm-section' });
        const drivesHeader = createElement('div', { className: 'fm-section-header' },
            createElement('h3', { textContent: 'Select Storage Drive' })
        );
        const refreshDrivesBtn = createElement('button', { id: 'fm-refresh-drives', className: 'fm-icon-btn', title: 'Refresh drives' });
        append(refreshDrivesBtn, createIcon(ICONS.REFRESH));
        append(drivesHeader, refreshDrivesBtn);
        const drivesList = createElement('div', { id: 'fm-drives-list', className: 'fm-drives-list' },
            createElement('div', { className: 'fm-loading', textContent: 'Loading drives...' })
        );
        append(drivesSection, [drivesHeader, drivesList]);

        const folderSection = createElement('div', { id: 'fm-folder-section', className: 'fm-section', style: { display: 'none' } });
        const folderHeader = createElement('div', { className: 'fm-section-header' },
            createElement('h3', { textContent: 'Select Folder (Optional)' })
        );
        const newFolderBtn = createElement('button', { id: 'fm-new-folder-btn', className: 'fm-icon-btn', title: 'Create new folder' });
        append(newFolderBtn, createIcon(ICONS.PLUS));
        append(folderHeader, newFolderBtn);
        const folderSearchContainer = createElement('div', { className: 'fm-folder-search-container' },
            createElement('input', {
                type: 'text',
                id: 'fm-folder-search',
                className: 'fm-folder-search-input',
                placeholder: 'Search folders...',
                'aria-label': 'Search folders',
                'aria-keyshortcuts': '/'
            }),
            createElement('button', {
                id: 'fm-folder-search-clear',
                className: 'fm-folder-search-clear hidden',
                title: 'Clear search',
                'aria-label': 'Clear folder search'
            }, createIcon(ICONS.CANCEL))
        );
        const foldersList = createElement('div', {
            id: 'fm-folders-list',
            className: 'fm-folders-list',
            role: 'region',
            'aria-label': 'Folder browser'
        });
        const newFolderInput = createElement('div', { id: 'fm-new-folder-input', className: 'fm-new-folder-input hidden' },
            createElement('input', { type: 'text', id: 'fm-folder-name', placeholder: 'New folder name' }),
            createElement('button', { id: 'fm-create-folder-btn', className: 'btn btn--sm btn--primary', textContent: 'Create' })
        );
        append(folderSection, [folderHeader, folderSearchContainer, foldersList, newFolderInput]);

        const mediaBrowserSection = createElement('div', { id: 'fm-media-browser-section', className: 'fm-section', style: { display: 'none' } });
        const mediaHeader = createElement('div', { className: 'fm-section-header' },
            createElement('h3', { textContent: 'Media Files' })
        );
        const mediaActions = createElement('div', { className: 'fm-media-actions', style: { display: 'flex', gap: 'var(--space-sm)' } });
        const deleteSelectedBtn = createElement('button', { id: 'fm-delete-selected-btn', className: 'btn btn--sm btn--danger', disabled: true, textContent: 'Delete Selected' });
        const hideSelectedBtn = createElement('button', { id: 'fm-hide-selected-btn', className: 'btn btn--sm btn--warning', disabled: true, textContent: 'Hide Selected' });
        append(mediaActions, [deleteSelectedBtn, hideSelectedBtn]);
        append(mediaHeader, mediaActions);
        const mediaList = createElement('div', {
            id: 'fm-media-list',
            className: 'fm-media-list',
            role: 'region',
            'aria-label': 'Media files in selected folder'
        },
            createElement('div', { className: 'fm-loading', textContent: 'Select a folder to view media files' })
        );
        append(mediaBrowserSection, [mediaHeader, mediaList]);

        const uploadSection = createElement('div', { id: 'fm-upload-section', className: 'fm-section', style: { display: 'none' } });
        append(uploadSection, [
            createElement('div', { className: 'fm-section-header' },
                createElement('h3', { textContent: 'Upload Files or Folders' })
            ),
            createElement('div', { id: 'fm-drop-zone', className: 'fm-drop-zone' },
                createElement('div', { className: 'fm-drop-zone-content' },
                    createIcon(ICONS.UPLOAD),
                    createElement('p', { textContent: 'Drag & drop files or folders here' }),
                    createElement('p', { className: 'fm-drop-zone-hint', textContent: 'or click buttons below' })
                ),
                createElement('input', { type: 'file', id: 'fm-file-input', multiple: true, hidden: true }),
                createElement('input', { type: 'file', id: 'fm-folder-input', webkitdirectory: true, directory: true, multiple: true, hidden: true })
            ),
            createElement('div', { className: 'fm-upload-buttons' },
                createElement('button', { id: 'fm-select-files-btn', className: 'btn btn--sm' }, createIcon(ICONS.UPLOAD), ' Select Files'),
                createElement('button', { id: 'fm-select-folder-btn', className: 'btn btn--sm' }, createIcon(ICONS.FOLDER_OPEN), ' Select Folder')
            ),
            createElement('div', { id: 'fm-selected-files', className: 'fm-selected-files hidden' },
                createElement('div', { className: 'fm-upload-list-header' },
                    createElement('h4', { textContent: 'Files to Stage' }),
                    createElement('div', { className: 'fm-upload-list-actions' },
                        createElement('button', { id: 'fm-upload-select-all-btn', className: 'btn btn--sm', type: 'button', textContent: 'Select All' }),
                        createElement('button', { id: 'fm-upload-clear-selection-btn', className: 'btn btn--sm', type: 'button', textContent: 'Clear' })
                    )
                ),
                createElement('ul', { id: 'fm-file-list' })
            ),
            createElement('div', { id: 'fm-staged-uploads', className: 'fm-staged-uploads hidden' },
                createElement('h4', { textContent: 'Staged Uploads' }),
                createElement('ul', { id: 'fm-staged-list' })
            )
        ]);

        const progressSection = createElement('div', { id: 'fm-upload-progress', className: 'fm-upload-progress hidden' });
        append(progressSection, [
            createElement('div', { className: 'fm-progress-bar' },
                createElement('div', { id: 'fm-progress-fill', className: 'fm-progress-fill' })
            ),
            createElement('p', { id: 'fm-progress-text', textContent: 'Uploading...' })
        ]);

        const resultsSection = createElement('div', { id: 'fm-upload-results', className: 'fm-upload-results hidden' });
        append(resultsSection, [
            createElement('h4', { textContent: 'Upload Results:' }),
            createElement('ul', { id: 'fm-results-list' })
        ]);

        const body = createElement('div', { className: 'modal__body file-manager-body' });
        append(body, [drivesSection, folderSection, mediaBrowserSection, uploadSection, progressSection, resultsSection]);

        const uploadBtn = createElement('button', { id: 'fm-upload-btn', className: 'btn btn--primary', disabled: true }, createIcon(ICONS.UPLOAD), ' Stage to Selected Folder');
        const startUploadBtn = createElement('button', { id: 'fm-start-upload-btn', className: 'btn btn--primary hidden', disabled: true }, createIcon(ICONS.UPLOAD), ' Start Uploads');
        const cancelUploadBtn = createElement('button', { id: 'fm-cancel-upload-btn', className: 'btn btn--danger hidden' }, createIcon(ICONS.CANCEL), ' Cancel Upload');
        const cancelBtn = createElement('button', { id: 'fm-cancel-btn', className: 'btn', textContent: 'Close' });

        const footer = createElement('div', { className: 'modal__footer' });
        append(footer, [uploadBtn, startUploadBtn, cancelUploadBtn, cancelBtn]);

        append(modalContent, [header, body, footer]);
        append(modal, modalContent);

        return modal;
    }

    _attachModalListeners() {
        const modal = this.modal;
        const m = (id) => document.getElementById(id);

        this.on(m('file-manager-close-btn'), 'click', () => this.close());
        this.on(m('fm-cancel-btn'), 'click', () => this.close());
        this.on(modal, 'click', (e) => { if (e.target === modal) this.close(); });
        this.on(m('fm-refresh-drives'), 'click', () => this._loadDrives());
        this.on(m('fm-delete-selected-btn'), 'click', () => this._deleteSelectedFiles());
        this.on(m('fm-hide-selected-btn'), 'click', () => this._hideSelectedFiles());
        this.on(m('fm-new-folder-btn'), 'click', () => {
            const input = m('fm-new-folder-input');
            input.classList.toggle('hidden');
            if (!input.classList.contains('hidden')) scheduleAutofocus(m('fm-folder-name'));
        });
        this.on(m('fm-create-folder-btn'), 'click', () => this._createNewFolder());
        this.on(m('fm-folder-name'), 'keypress', (e) => { if (e.key === 'Enter') this._createNewFolder(); });

        const dropZone = m('fm-drop-zone');
        this.on(m('fm-select-files-btn'), 'click', () => m('fm-file-input').click());
        this.on(m('fm-select-folder-btn'), 'click', () => m('fm-folder-input').click());
        this.on(dropZone, 'dragover', (e) => { e.preventDefault(); dropZone.classList.add('fm-drop-zone-active'); });
        this.on(dropZone, 'dragleave', () => dropZone.classList.remove('fm-drop-zone-active'));
        this.on(dropZone, 'drop', (e) => { e.preventDefault(); dropZone.classList.remove('fm-drop-zone-active'); this._handleDroppedItems(e.dataTransfer); });
        this.on(m('fm-file-input'), 'change', (e) => this._handleFiles(e.target.files, false));
        this.on(m('fm-folder-input'), 'change', (e) => this._handleFiles(e.target.files, true));
        this.on(m('fm-upload-select-all-btn'), 'click', () => this._selectAllPendingUploadFiles(true));
        this.on(m('fm-upload-clear-selection-btn'), 'click', () => this._selectAllPendingUploadFiles(false));
        this.on(m('fm-upload-btn'), 'click', () => this._stageSelectedFiles());
        this.on(m('fm-start-upload-btn'), 'click', () => this._startStagedUploads());
        this.on(m('fm-cancel-upload-btn'), 'click', () => cancelUploadsShared());
        this.on(m('fm-file-list'), 'change', (e) => {
            const checkbox = e.target.closest('.fm-upload-file-checkbox');
            if (!checkbox) return;
            const idx = Number.parseInt(checkbox.dataset.index, 10);
            if (!Number.isFinite(idx)) return;
            if (checkbox.checked) this.selectedUploadFileIndices.add(idx);
            else this.selectedUploadFileIndices.delete(idx);
            this._renderPendingUploadFiles();
            this._updateUploadControls();
        });
        this.on(m('fm-file-list'), 'input', (e) => {
            const input = e.target.closest('.fm-file-rename-input');
            if (!input) return;
            const idx = Number.parseInt(input.dataset.index, 10);
            if (Number.isFinite(idx) && this.selectedFiles[idx]) {
                this.selectedFiles[idx].customFilename = input.value.trim();
            }
        });
        this.on(m('fm-file-list'), 'click', (e) => {
            const removeBtn = e.target.closest('.fm-upload-file-remove');
            if (!removeBtn) return;
            const idx = Number.parseInt(removeBtn.dataset.index, 10);
            if (Number.isFinite(idx)) this._removePendingUploadFile(idx);
        });
        this.on(m('fm-staged-list'), 'click', (e) => {
            const removeBtn = e.target.closest('.fm-staged-upload-remove');
            if (!removeBtn) return;
            const idx = Number.parseInt(removeBtn.dataset.index, 10);
            if (Number.isFinite(idx)) this._unstageBatch(idx);
        });

        const revealBtn = m('fm-reveal-hidden-btn');
        const revealDropdown = m('fm-reveal-hidden-dropdown');
        this.on(revealBtn, 'click', (e) => {
            e.stopPropagation();
            const nextHidden = !revealDropdown.classList.contains('hidden');
            revealDropdown.classList.toggle('hidden');
            revealBtn.setAttribute('aria-expanded', String(!nextHidden));
        });
        this.on(document, 'click', (e) => {
            if (!revealBtn.contains(e.target) && !revealDropdown.contains(e.target)) {
                revealDropdown.classList.add('hidden');
                revealBtn.setAttribute('aria-expanded', 'false');
            }
        });
        this.on(m('fm-reveal-confirm-btn'), 'click', async () => {
            const sel = document.querySelector('input[name="reveal-duration"]:checked');
            await this._activateRevealHidden(sel ? parseInt(sel.value) : 3600);
            revealDropdown.classList.add('hidden');
            revealBtn.setAttribute('aria-expanded', 'false');
        });
        this.on(m('fm-reveal-stop-btn'), 'click', async () => {
            await this._deactivateRevealHidden();
            revealDropdown.classList.add('hidden');
            revealBtn.setAttribute('aria-expanded', 'false');
        });

        const searchInput = m('fm-folder-search');
        const searchClear = m('fm-folder-search-clear');
        this.on(searchInput, 'input', (e) => {
            const query = e.target.value.trim();
            searchClear.classList.toggle('hidden', query.length === 0);
            if (this._folderSearchDebounce) this.clearTimeout(this._folderSearchDebounce);
            this._folderSearchDebounce = this.timeout(() => this._filterFolderTree(query), 150);
        });
        this.on(searchClear, 'click', () => {
            searchInput.value = '';
            searchClear.classList.add('hidden');
            this._filterFolderTree('');
            scheduleAutofocus(searchInput);
        });
        this.on(searchInput, 'keydown', (e) => {
            if (e.key === 'Escape') { searchInput.value = ''; searchClear.classList.add('hidden'); this._filterFolderTree(''); }
        });
        this.on(modal, 'keydown', (e) => {
            const target = e.target;
            const isTypingField = target instanceof HTMLElement
                && (target.matches('input, textarea, select') || target.isContentEditable);
            const folderSection = document.getElementById('fm-folder-section');

            if (e.key === '/' && !isTypingField) {
                e.preventDefault();
                if (folderSection && folderSection.style.display !== 'none') {
                    scheduleAutofocus(searchInput);
                }
                return;
            }

            if (e.key === 'Escape' && !isTypingField) {
                e.preventDefault();
                this.close();
            }
        });
    }

    // ── Open/close ────────────────────────────────────────────────────────

    open(manageMode = false, options = {}) {
        const statusOnly = options.statusOnly === true;
        if (!this.modal) {
            this.modal = this._buildModal();
            append(document.body, this.modal);
            this._attachModalListeners();
        }

        this._returnFocusEl = document.activeElement;

        this.manageMode = manageMode && !statusOnly;
        this.mediaFiles = [];
        this.selectedFiles = [];
        this.selectedUploadFileIndices.clear();
        this.stagedUploads = [];
        this.isUploading = false;
        this.drives = [];
        this.selectedDrive = null;
        this.selectedFolder = '';

        // Reset UI
        const m = (id) => document.getElementById(id);
        const titleEl = this.modal.querySelector('.modal__header h2');
        if (titleEl) {
            clear(titleEl);
            if (statusOnly) {
                titleEl.textContent = 'Upload Status';
            } else if (manageMode) {
                titleEl.textContent = 'Manage Content';
            } else {
                titleEl.textContent = 'File Manager';
            }
        }
        const driveHeaderEl = this.modal.querySelector('.fm-section h3');
        if (driveHeaderEl) {
            driveHeaderEl.textContent = statusOnly ? 'Current Upload' : 'Select Storage Drive';
        }
        const revealContainer = m('fm-reveal-hidden-container');
        if (revealContainer) {
            revealContainer.classList.toggle('hidden', !this.manageMode);
            if (this.manageMode) this._checkRevealHiddenStatus();
        }
        m('fm-drives-list').innerHTML = '<div class="fm-loading">Loading drives...</div>';
        m('fm-results-list').innerHTML = '';
        m('fm-folder-section').style.display = 'none';
        m('fm-media-browser-section').style.display = 'none';
        m('fm-upload-section').style.display = 'none';
        m('fm-selected-files').classList.add('hidden');
        m('fm-staged-uploads').classList.add('hidden');
        m('fm-upload-progress').classList.add('hidden');
        m('fm-upload-results').classList.add('hidden');
        m('fm-upload-btn').disabled = true;
        m('fm-upload-btn').classList.remove('hidden');
        m('fm-start-upload-btn').disabled = true;
        m('fm-start-upload-btn').classList.add('hidden');
        if (statusOnly) {
            m('fm-upload-btn').classList.add('hidden');
        }
        m('fm-file-input').value = '';
        m('fm-folder-input').value = '';
        this._renderPendingUploadFiles();
        this._renderStagedUploads();
        this.modal.classList.remove('hidden');

        // Reconnect to background upload session if any
        const session = getCurrentUploadSession();
        if (session?.isRunning) {
            this.isUploading = true;
            m('fm-upload-progress').classList.remove('hidden');
            m('fm-upload-results').classList.add('hidden');
            m('fm-upload-btn').classList.add('hidden');
            m('fm-start-upload-btn').classList.add('hidden');
            m('fm-cancel-upload-btn').classList.remove('hidden');
            const pct = session.totalBytes > 0 ? Math.round((session.uploadedBytes / session.totalBytes) * 100) : 0;
            const fill = m('fm-progress-fill');
            const text = m('fm-progress-text');
            if (fill) fill.style.width = `${pct}%`;
            if (text) text.textContent = `Uploading... ${pct}%`;
            updateSessionCallbacks(
                (p) => { const f = m('fm-progress-fill'), t = m('fm-progress-text'); if (f) f.style.width = `${p}%`; if (t) t.textContent = `Uploading... ${Math.round(p)}%`; },
                (filename, success, error) => {
                    const list = m('fm-results-list');
                    if (list) {
                        append(list, createElement('li', { className: success ? 'fm-result-success' : 'fm-result-error', innerHTML: `${success ? ICONS.CHECK : '✗'} <span>${escapeHtml(filename)}</span> <span class="fm-result-message">${escapeHtml(success ? 'Uploaded' : (error || 'Failed'))}</span>` }));
                        m('fm-upload-results').classList.remove('hidden');
                    }
                }
            );
        } else if (session?.results && (session.results.success > 0 || session.results.failed > 0)) {
            m('fm-upload-progress').classList.remove('hidden');
            m('fm-progress-fill').style.width = '100%';
            m('fm-progress-text').textContent = `Upload complete: ${session.results.success} succeeded, ${session.results.failed} failed`;
            m('fm-upload-results').classList.remove('hidden');
            const log = session.results.log || [];
            m('fm-results-list').innerHTML = log.slice(0, 20).map(r => `<li class="${r.success ? 'fm-result-success' : 'fm-result-error'}">${r.success ? ICONS.CHECK : '✗'} <span>${escapeHtml(r.filename)}</span> <span class="fm-result-message">${escapeHtml(r.success ? 'Uploaded' : (r.error || 'Failed'))}</span></li>`).join('');
            if (log.length > 20) m('fm-results-list').innerHTML += `<li class="fm-result-more">... and ${log.length - 20} more files</li>`;
        }

        if (!statusOnly) {
            this._loadDrives();
            this._startUsbPolling();
        } else {
            this._stopUsbPolling();
            this._drivesRequestId += 1;
            const drivesList = m('fm-drives-list');
            if (drivesList) {
                clear(drivesList);
                append(drivesList, createElement('div', {
                    className: 'fm-empty fm-upload-status-empty',
                    textContent: session ? 'Upload details are shown below.' : 'No active upload.'
                }));
            }
        }
        this._focusTrap?.deactivate({ restoreFocus: false });
        this._focusTrap = createFocusTrap($('.file-manager-modal-content', this.modal) || this.modal, {
            initialFocus: () => statusOnly
                ? (session?.isRunning ? document.getElementById('fm-cancel-upload-btn') : document.getElementById('file-manager-close-btn'))
                : (document.getElementById('fm-folder-search') || document.getElementById('fm-refresh-drives') || document.getElementById('file-manager-close-btn')),
            returnFocusTo: this._returnFocusEl
        });
        requestAnimationFrame(() => this._focusTrap?.activate());
    }

    close() {
        this._focusTrap?.deactivate();
        this._focusTrap = null;
        if (this.modal) this.modal.classList.add('hidden');
        this._cancelAllRenameModes();
        if (this._mediaListComp) { this._mediaListComp.unmount(); this._mediaListComp = null; }
        const mediaList = document.getElementById('fm-media-list');
        if (mediaList) clear(mediaList);
        this._stopUsbPolling();
        this._drivesRequestId += 1;
        this._foldersRequestId += 1;
        this._mediaRequestId += 1;
        this._folderTreeApi = null;
        if (this._folderSearchDebounce) { this.clearTimeout(this._folderSearchDebounce); this._folderSearchDebounce = null; }
        this.drives = [];
        this.selectedDrive = null;
        this.selectedFolder = '';
        this.mediaFiles = [];
        this.selectedFiles = [];
        this.selectedUploadFileIndices.clear();
        this.stagedUploads = [];

        // Consume deferred layout refresh flags now that the file manager is closed.
        const appState = window.ragotModules?.appState;
        if (appState) {
            const needsDeferredRefresh = !!appState.needsMediaRefresh;
            const forceDeferredRefresh = !!appState.forceMediaRefresh;
            appState.needsMediaRefresh = false;
            appState.forceMediaRefresh = false;

            if (needsDeferredRefresh) {
                refreshAllLayouts(forceDeferredRefresh).catch(e => {
                    console.warn('[FileManager] Deferred refresh failed:', e);
                });
            }
        }
    }

    destroy() {
        this.close();
        if (this.modal) { remove(this.modal); this.modal = null; }
        this.stop();
    }

    // ── Drives ────────────────────────────────────────────────────────────

    async _loadDrives() {
        const container = document.getElementById('fm-drives-list');
        if (!container) return;
        const requestId = ++this._drivesRequestId;
        const selectedPath = this.selectedDrive?.path || null;
        const hasRenderedDrives = container.querySelector('.fm-drive-card') !== null;
        if (!hasRenderedDrives) {
            container.innerHTML = '<div class="fm-loading">Loading drives...</div>';
        }
        try {
            const resp = await fetch('/api/storage/drives');
            if (!resp.ok) throw new Error('Failed to load drives');
            const data = await resp.json();
            if (requestId !== this._drivesRequestId) return;
            this.drives = data.drives || [];
            clear(container);
            if (this.drives.length === 0) {
                container.innerHTML = '<div class="fm-empty"><p>No storage drives found</p><p class="fm-hint">Connect a USB drive and click refresh</p></div>';
                return;
            }
            let restoredDrive = null;
            this.drives.forEach((drive, driveIndex) => {
                const card = createElement('div', {
                    className: `fm-drive-card ${!drive.writable ? 'fm-drive-readonly' : ''}`,
                    dataset: { driveId: drive.id, drivePath: drive.path },
                    role: 'button',
                    tabindex: '0'
                });

                const displayName = drive.label || drive.name;

                // Name row: name text + edit button (+ port indicator if available)
                const nameRow = createElement('div', { className: 'fm-drive-name-row' });
                const nameEl = createElement('div', { className: 'fm-drive-name', textContent: displayName });
                append(nameRow, nameEl);

                if (drive.device_key) {
                    const renameBtn = createElement('button', {
                        className: 'fm-drive-rename-btn',
                        type: 'button',
                        title: 'Rename drive',
                    });
                    renameBtn.innerHTML = ICONS.EDIT;
                    this.on(renameBtn, 'click', (e) => {
                        e.stopPropagation();
                        this._startDriveRename(card, drive, nameEl, driveIndex);
                    });
                    append(nameRow, renameBtn);
                }

                const pathEl = createElement('div', { className: 'fm-drive-path' });
                if (drive.label) {
                    pathEl.textContent = drive.name;
                    pathEl.title = drive.path;
                } else {
                    pathEl.textContent = drive.path;
                }

                const infoChildren = [
                    nameRow,
                    pathEl,
                    createElement('div', { className: 'fm-drive-space' },
                        createElement('div', { className: 'fm-space-bar' },
                            createElement('div', { className: 'fm-space-used', style: { width: `${drive.percent_used}%` } })
                        ),
                        createElement('span', { className: 'fm-space-text', textContent: `${drive.free_formatted} free of ${drive.total_formatted}` })
                    ),
                ];

                const cardChildren = [
                    createElement('div', { className: 'fm-drive-icon' }, createIcon(drive.path.includes('usb') || drive.path.includes('media') ? ICONS.USB : ICONS.DRIVE)),
                    createElement('div', { className: 'fm-drive-info' }, ...infoChildren),
                ];

                if (drive.usb_port != null) {
                    const portEl = createElement('div', { className: 'fm-drive-port-indicator', title: `USB port ${drive.usb_port + 1}` });
                    portEl.innerHTML = usbPortIcon(28, drive.usb_port);
                    cardChildren.push(portEl);
                }

                append(card, cardChildren);

                if (!drive.writable) {
                    append(card, createElement('div', { className: 'fm-drive-badge', textContent: 'Read Only' }));
                }
                this.on(card, 'click', () => this._selectDrive(card));
                this.on(card, 'keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this._selectDrive(card);
                    }
                });
                if (selectedPath && drive.path === selectedPath) {
                    card.classList.add('selected');
                    restoredDrive = drive;
                }
                append(container, card);
            });
            if (restoredDrive) {
                this.selectedDrive = { ...restoredDrive };
            } else if (this.selectedDrive && !this.drives.some(d => d.path === this.selectedDrive.path)) {
                this.selectedDrive = null;
                this.selectedFolder = '';
                document.getElementById('fm-folder-section').style.display = 'none';
                document.getElementById('fm-upload-section').style.display = 'none';
            }
        } catch (err) {
            console.error('[FileManager] Load drives error:', err);
            clear(container);
            append(container, createElement('div', { className: 'fm-error' },
                createElement('p', { textContent: 'Failed to load drives' }),
                createElement('button', { className: 'btn btn--sm', textContent: 'Retry', onClick: () => this._loadDrives() })
            ));
        }
    }

    _selectDrive(card) {
        const driveId = card.dataset.driveId;
        const drivePath = card.dataset.drivePath;
        const drive = this.drives.find(d => d.id === driveId);
        if (!this.manageMode && drive && !drive.writable) { toast.error('This drive is read-only.'); return; }
        if (this.selectedDrive?.path === drivePath && card.classList.contains('selected')) return;
        $$('.fm-drive-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedDrive = drive ? { ...drive } : { id: driveId, path: drivePath };
        this.selectedFolder = '';
        document.getElementById('fm-folder-section').style.display = 'block';
        if (this.manageMode) {
            document.getElementById('fm-media-browser-section').style.display = 'block';
            document.getElementById('fm-upload-section').style.display = 'block';
        } else {
            document.getElementById('fm-media-browser-section').style.display = 'none';
            document.getElementById('fm-upload-section').style.display = 'block';
        }
        this._loadFolders(drivePath);
        this._updateUploadControls();
        scheduleAutofocus(document.getElementById('fm-folder-search'));
    }

    // ── Drive Rename ──────────────────────────────────────────────────────

    _startDriveRename(card, drive, nameEl, driveIndex) {
        if (this._activeDriveRenameIndex != null) return;
        this._activeDriveRenameIndex = driveIndex;

        const currentName = drive.label || drive.name;
        const input = createElement('input', {
            className: 'fm-drive-rename-input',
            type: 'text',
            value: currentName,
            maxLength: 64,
        });

        nameEl.textContent = '';
        append(nameEl, input);
        input.focus();
        input.select();

        const cleanup = () => {
            this._activeDriveRenameIndex = null;
            this.off(input, 'keydown', onKey);
            this.off(input, 'blur', onBlur);
        };

        const commit = async () => {
            const newLabel = input.value.trim();
            cleanup();
            if (!newLabel || newLabel === currentName) {
                nameEl.textContent = currentName;
                return;
            }
            try {
                const resp = await fetch('/api/storage/drive-label', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ device_key: drive.device_key, label: newLabel }),
                });
                if (resp.ok) {
                    drive.label = newLabel;
                    nameEl.textContent = newLabel;
                    toast.success(`Drive renamed to "${newLabel}"`);
                    refreshAllLayouts(false, false, true, { refreshCategoryList: true });
                } else {
                    nameEl.textContent = currentName;
                    toast.error('Failed to rename drive');
                }
            } catch {
                nameEl.textContent = currentName;
                toast.error('Failed to rename drive');
            }
        };

        const onKey = (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cleanup(); nameEl.textContent = currentName; }
        };

        const onBlur = () => commit();

        this.on(input, 'keydown', onKey);
        this.on(input, 'blur', onBlur);
    }

    // ── Folders ───────────────────────────────────────────────────────────

    async _loadFolders(drivePath) {
        const container = document.getElementById('fm-folders-list');
        if (!container) return;
        const requestId = ++this._foldersRequestId;
        container.innerHTML = '<div class="fm-loading">Loading folders...</div>';
        try {
            const params = new URLSearchParams({ path: drivePath, include_subdirs: 'true', include_hidden_info: this.manageMode ? 'true' : 'false' });
            const resp = await fetch(`/api/storage/folders?${params}`, { headers: getShowHiddenHeaders() });
            if (!resp.ok) throw new Error('Failed to load folders');
            const data = await resp.json();
            if (requestId !== this._foldersRequestId || this.selectedDrive?.path !== drivePath) return;
            const folders = data.folders || [];
            if (this.selectedDrive) this.selectedDrive.show_hidden = data.show_hidden || false;
            this._folderTreeApi = renderFolderTree(container, folders, {
                drivePath, folderIcon: ICONS.FOLDER, manageMode: this.manageMode,
                onToggleHide: this.manageMode ? (params) => this._handleFolderHideToggle(params) : null,
                onSelect: ({ relativePath, fullPath }) => {
                    this.selectedFolder = relativePath;
                    this._updateUploadControls();
                    if (this.manageMode) {
                        const pathToLoad = (fullPath === 'root' || !fullPath) ? drivePath : fullPath;
                        this._loadMediaFiles(pathToLoad);
                    }
                }
            });
            this.selectedFolder = this._folderTreeApi.getSelected().relativePath;
            this._updateUploadControls();
            const searchInput = document.getElementById('fm-folder-search');
            const searchClear = document.getElementById('fm-folder-search-clear');
            if (searchInput) searchInput.value = '';
            if (searchClear) searchClear.classList.add('hidden');
            if (this.manageMode) {
                const selected = this._folderTreeApi.getSelected();
                const path = (selected.fullPath === 'root' || !selected.fullPath) ? drivePath : selected.fullPath;
                this._loadMediaFiles(path);
            }
        } catch (err) {
            if (requestId !== this._foldersRequestId || this.selectedDrive?.path !== drivePath) return;
            console.error('[FileManager] Load folders error:', err);
            if (container) container.innerHTML = `<div class="fm-folder-item selected" data-folder="">${ICONS.FOLDER}<span>Root (no subfolder)</span></div>`;
            if (this.manageMode) this._loadMediaFiles(drivePath);
        }
    }

    async _handleFolderHideToggle({ categoryId, hidden, folderName }) {
        const endpoint = hidden ? '/api/admin/categories/unhide' : '/api/admin/categories/hide';
        try {
            const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category_id: categoryId }) });
            const result = await resp.json();
            if (result.success) {
                if (this.selectedDrive) await this._loadFolders(this.selectedDrive.path);
                refreshAllLayouts();
            } else { toast.error(`Failed to ${hidden ? 'unhide' : 'hide'} folder: ${result.error}`); }
        } catch (err) { toast.error(`Failed: ${err.message}`); }
    }

    _filterFolderTree(query) {
        if (this._folderTreeApi?.filter) { this._folderTreeApi.filter(query); }
    }

    async _createNewFolder() {
        const input = document.getElementById('fm-folder-name');
        const folderName = input.value.trim();
        if (!folderName) { toast.error('Please enter a folder name'); return; }
        if (!this.selectedDrive) { toast.error('Please select a drive first'); return; }
        const parentPath = this.selectedFolder ? `${this.selectedDrive.path}/${this.selectedFolder}`.replace(/\\/g, '/') : this.selectedDrive.path;
        try {
            const resp = await fetch('/api/storage/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drive_path: parentPath, folder_name: folderName }) });
            const data = await resp.json();
            if (data.success) {
                input.value = '';
                document.getElementById('fm-new-folder-input').classList.add('hidden');
                const newRelPath = this.selectedFolder ? `${this.selectedFolder}/${folderName}` : folderName;
                await this._loadFolders(this.selectedDrive.path);
                this.selectedFolder = newRelPath;
            } else { toast.error(data.error || 'Failed to create folder'); }
        } catch (err) { toast.error('Failed to create folder'); }
    }

    // ── Media browser ─────────────────────────────────────────────────────

    async _loadMediaFiles(folderPath) {
        const container = document.getElementById('fm-media-list');
        if (!container) return;
        const requestId = ++this._mediaRequestId;
        this.mediaFiles = [];
        this._updateBulkActionButtons();

        // Show loading state. If the component is already mounted we can show the
        // spinner inside it; otherwise clear the container and append fresh.
        if (!this._mediaListComp) {
            clear(container);
            append(container, createElement('div', { className: 'fm-loading', textContent: 'Loading media files...' }));
        }

        try {
            const url = new URL('/api/storage/media/list', window.location.origin);
            url.searchParams.set('path', folderPath);
            url.searchParams.set('limit', '5000');
            const headers = this.manageMode ? { 'X-Show-Hidden': 'true' } : getShowHiddenHeaders();
            const resp = await fetch(url.toString(), { headers });
            if (!resp.ok) throw new Error('Failed to load media files');
            const data = await resp.json();
            if (requestId !== this._mediaRequestId) return;
            this.mediaFiles = data.files || [];

            if (this.mediaFiles.length === 0) {
                // No files — unmount component (if any) and show empty state
                if (this._mediaListComp) { this._mediaListComp.unmount(); this._mediaListComp = null; }
                clear(container);
                append(container, createElement('div', { className: 'fm-empty', textContent: 'No media files in this folder' }));
                return;
            }

            if (this._mediaListComp) {
                // Reuse existing component: recycle VS and rebind to new file array
                this._mediaListComp.clearSelection();
                this._mediaListComp.rebind(this.mediaFiles);
            } else {
                // First load or after an empty-state: mount fresh
                clear(container);
                this._mediaListComp = new MediaListComponent(this.mediaFiles);
                this._mediaListComp.setActionHandler((action, index) => this._handleMediaAction(action, index));
                this._mediaListComp.mount(container);
            }
        } catch (err) {
            if (requestId !== this._mediaRequestId) return;
            console.error('[FileManager] Load media error:', err);
            if (this._mediaListComp) { this._mediaListComp.unmount(); this._mediaListComp = null; }
            clear(container);
            append(container, createElement('div', { className: 'fm-error', textContent: 'Failed to load media files' }));
        }
    }

    async _handleMediaAction(action, index) {
        if (action === 'edit-rename') this._toggleRenameMode(index, true);
        else if (action === 'confirm-rename') await this._renameFile(index);
        else if (action === 'cancel-rename') this._toggleRenameMode(index, false);
        else if (action === 'hide') await this._toggleHideFile(index);
        else if (action === 'delete') await this._deleteFile(index);
        else if (action === 'selection-changed') this._updateBulkActionButtons();
    }

    _toggleRenameMode(index, isEditing) {
        if (isEditing && this._activeRenameIndex !== null && this._activeRenameIndex !== index) {
            this._toggleRenameMode(this._activeRenameIndex, false);
        }
        const container = document.querySelector(`.fm-media-name-container[data-index="${index}"]`);
        if (!container) return;
        const staticName = $('.fm-media-name-static', container);
        const renameBox = $('.fm-rename-container', container);
        const input = $('.fm-file-rename-input', container);
        if (isEditing) {
            this._activeRenameIndex = index;
            staticName.classList.add('hidden');
            renameBox.classList.remove('hidden');
            scheduleAutofocus(input, { selectionBehavior: 'select-all-desktop' });
            const handleOutsideClick = (e) => {
                if (!container.contains(e.target)) {
                    this._toggleRenameMode(index, false);
                    this.off(document, 'click', handleOutsideClick);
                }
            };
            this.timeout(() => this.on(document, 'click', handleOutsideClick), 10);
        } else {
            if (this._activeRenameIndex === index) this._activeRenameIndex = null;
            staticName.classList.remove('hidden');
            renameBox.classList.add('hidden');
        }
    }

    _cancelAllRenameModes() {
        document.querySelectorAll('.fm-media-name-container[data-index]').forEach((container) => {
            const index = Number.parseInt(container.dataset.index, 10);
            if (Number.isFinite(index)) {
                this._toggleRenameMode(index, false);
            }
        });
        this._activeRenameIndex = null;
    }

    async _renameFile(index) {
        const file = this.mediaFiles[index];
        const input = document.querySelector(`.fm-file-rename-input[data-index="${index}"]`);
        const newBaseName = input?.value.trim();
        const lastDot = file.name.lastIndexOf('.');
        const ext = lastDot !== -1 ? file.name.substring(lastDot) : '';
        const currentBaseName = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
        if (!newBaseName || newBaseName === currentBaseName) { this._toggleRenameMode(index, false); return; }
        try {
            const resp = await fetch('/api/storage/media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: file.path, new_name: newBaseName + ext }) });
            const result = await resp.json();
            if (result.success) {
                file.name = result.new_name; file.path = result.new_path;
                const c = document.querySelector(`.fm-media-name-container[data-index="${index}"]`);
                const sn = c ? $('.fm-media-name-static', c) : null;
                if (sn) sn.textContent = result.new_name;
                this._toggleRenameMode(index, false);
                refreshAllLayouts(true);
            } else { toast.error('Rename failed: ' + result.error); this._toggleRenameMode(index, false); }
        } catch (err) { toast.error('Rename failed: ' + err.message); if (input) input.value = file.name; }
    }

    async _toggleHideFile(index) {
        const file = this.mediaFiles[index];
        const categoryId = getCategoryIdFromPath(file.path);
        const endpoint = file.hidden ? '/api/admin/files/unhide' : '/api/admin/files/hide';
        const payload = { file_path: file.path };
        if (!file.hidden && categoryId) payload.category_id = categoryId;
        try {
            const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const result = await resp.json();
            if (result.success) {
                const folderPath = file.path.substring(0, file.path.lastIndexOf('/'));
                await this._loadMediaFiles(folderPath);
            } else { toast.error('Hide/unhide failed: ' + result.error); }
        } catch (err) { toast.error('Operation failed: ' + err.message); }
    }

    async _deleteFile(index) {
        const file = this.mediaFiles[index];
        if (!await dialog.confirm(`Delete "${file.name}"? This cannot be undone.`, { type: 'danger' })) return;
        try {
            const resp = await fetch('/api/storage/media', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: file.path }) });
            const result = await resp.json();
            if (result.success) {
                const folderPath = file.path.substring(0, file.path.lastIndexOf('/'));
                await this._loadMediaFiles(folderPath);
                refreshAllLayouts(true);
            } else { toast.error('Delete failed: ' + result.error); }
        } catch (err) { toast.error('Delete failed: ' + err.message); }
    }

    async _deleteSelectedFiles() {
        const selectedIndices = this._mediaListComp ? Array.from(this._mediaListComp.getSelectedIndices()) : [];
        if (selectedIndices.length === 0) return;
        if (!await dialog.confirm(`Delete ${selectedIndices.length} file(s)? This cannot be undone.`, { type: 'danger' })) return;
        const filesToDelete = selectedIndices.map(i => this.mediaFiles[i]).filter(Boolean);
        if (filesToDelete.length === 0) return;

        try {
            const resp = await fetch('/api/storage/media/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_paths: filesToDelete.map(file => file.path) })
            });
            const result = await resp.json();
            if (!resp.ok || result.success === false) {
                toast.error('Delete failed: ' + (result.error || 'Unknown error'));
                return;
            }

            const folderPath = filesToDelete[0].path.substring(0, filesToDelete[0].path.lastIndexOf('/'));
            await this._loadMediaFiles(folderPath);
            refreshAllLayouts(true);
            toast.success(`Deleted ${result.deleted || 0} of ${filesToDelete.length} file(s)`);
        } catch (err) {
            toast.error('Delete failed: ' + err.message);
        }
    }

    async _hideSelectedFiles() {
        const selectedIndices = this._mediaListComp ? Array.from(this._mediaListComp.getSelectedIndices()) : [];
        if (selectedIndices.length === 0) return;
        const selectedFilesArr = selectedIndices.map(i => this.mediaFiles[i]).filter(Boolean);
        if (selectedFilesArr.length === 0) return;
        const hiddenCount = selectedFilesArr.filter(f => f.hidden).length;
        const shouldUnhide = hiddenCount > selectedFilesArr.length / 2;
        try {
            const resp = await fetch('/api/admin/files/batch-visibility', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: shouldUnhide ? 'unhide' : 'hide',
                    files: selectedFilesArr.map(file => {
                        const payload = { file_path: file.path };
                        const id = getCategoryIdFromPath(file.path);
                        if (id) payload.category_id = id;
                        return payload;
                    })
                })
            });
            const result = await resp.json();
            if (!resp.ok || result.success === false) {
                toast.error('Hide/unhide failed: ' + (result.error || 'Unknown error'));
                return;
            }

            const folderPath = selectedFilesArr[0].path.substring(0, selectedFilesArr[0].path.lastIndexOf('/'));
            await this._loadMediaFiles(folderPath);
            refreshAllLayouts(true);
            toast.success(`${shouldUnhide ? 'Unhidden' : 'Hidden'} ${result.updated || 0} of ${selectedFilesArr.length} file(s)`);
        } catch (err) {
            toast.error('Operation failed: ' + err.message);
        }
    }

    _updateBulkActionButtons() {
        const selectedIndices = this._mediaListComp ? this._mediaListComp.getSelectedIndices() : new Set();
        const count = selectedIndices.size;
        const deleteBtn = document.getElementById('fm-delete-selected-btn');
        const hideBtn = document.getElementById('fm-hide-selected-btn');
        if (deleteBtn) { deleteBtn.disabled = count === 0; deleteBtn.textContent = count > 0 ? `Delete Selected (${count})` : 'Delete Selected'; }
        if (hideBtn) {
            hideBtn.disabled = count === 0;
            if (count > 0) {
                const selectedFilesArr = Array.from(selectedIndices).map(i => this.mediaFiles[i]);
                const hiddenCount = selectedFilesArr.filter(f => f.hidden).length;
                hideBtn.textContent = hiddenCount > selectedFilesArr.length / 2 ? `Unhide Selected (${count})` : `Hide Selected (${count})`;
            } else { hideBtn.textContent = 'Hide Selected'; }
        }
    }

    // ── File upload ───────────────────────────────────────────────────────

    async _handleDroppedItems(dataTransfer) {
        const files = [];
        const items = dataTransfer.items;
        if (items) {
            const entries = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry?.();
                    if (entry) entries.push(entry);
                    else files.push({ file: item.getAsFile(), relativePath: '' });
                }
            }
            for (const entry of entries) await this._traverseEntry(entry, '', files);
        } else {
            for (const file of dataTransfer.files) files.push({ file, relativePath: '' });
        }
        this._processSelectedFiles(files);
    }

    async _traverseEntry(entry, path, files) {
        if (entry.isFile) {
            const file = await new Promise(resolve => entry.file(resolve));
            files.push({ file, relativePath: path ? `${path}/${file.name}` : file.name });
        } else if (entry.isDirectory) {
            const allEntries = await new Promise(resolve => {
                const reader = entry.createReader();
                const acc = [];
                const read = () => reader.readEntries(r => { if (r.length) { acc.push(...r); read(); } else resolve(acc); });
                read();
            });
            const newPath = path ? `${path}/${entry.name}` : entry.name;
            for (const child of allEntries) await this._traverseEntry(child, newPath, files);
        }
    }

    _handleFiles(files, isFolder = false) {
        const list = [];
        for (const file of files) {
            const relativePath = isFolder && file.webkitRelativePath ? file.webkitRelativePath : '';
            list.push({ file, relativePath });
        }
        this._processSelectedFiles(list);
        const input = document.getElementById(isFolder ? 'fm-folder-input' : 'fm-file-input');
        if (input) input.value = '';
    }

    _processSelectedFiles(fileList) {
        const startIndex = this.selectedFiles.length;
        const nextFiles = fileList.map(f => ({
            ...f,
            customFilename: f.customFilename || f.file.name.substring(0, f.file.name.lastIndexOf('.')) || f.file.name
        }));
        this.selectedFiles.push(...nextFiles);
        nextFiles.forEach((_file, offset) => this.selectedUploadFileIndices.add(startIndex + offset));
        this._renderPendingUploadFiles();
        this._updateUploadControls();
    }

    _getPendingUploadSelectionCount() {
        let count = 0;
        this.selectedUploadFileIndices.forEach(index => {
            if (this.selectedFiles[index]) count++;
        });
        return count;
    }

    _getSelectedFolderLabel() {
        if (!this.selectedDrive) return 'No drive selected';
        const driveName = this.selectedDrive.label || this.selectedDrive.name || 'Drive';
        return this.selectedFolder ? `${driveName} / ${this.selectedFolder}` : `${driveName} / Root`;
    }

    _getStagedUploadStats() {
        return this.stagedUploads.reduce((stats, batch) => {
            stats.files += batch.files.length;
            stats.bytes += batch.files.reduce((sum, fileInfo) => sum + fileInfo.file.size, 0);
            return stats;
        }, { files: 0, bytes: 0 });
    }

    _renderPendingUploadFiles() {
        const container = document.getElementById('fm-selected-files');
        const list = document.getElementById('fm-file-list');
        if (this.selectedFiles.length === 0) { if (container) container.classList.add('hidden'); return; }
        const totalSize = this.selectedFiles.reduce((s, f) => s + f.file.size, 0);
        if (container) container.classList.remove('hidden');
        if (list) {
            clear(list);
            const selectedCount = this._getPendingUploadSelectionCount();
            append(list, createElement('li', { className: 'fm-file-summary' },
                createElement('span', { textContent: `${selectedCount} selected of ${this.selectedFiles.length} file${this.selectedFiles.length !== 1 ? 's' : ''}` }),
                createElement('span', { className: 'fm-file-size', textContent: `${formatBytes(totalSize)} total` })
            ));
            this.selectedFiles.forEach((fileInfo, index) => {
                const { file, customFilename } = fileInfo;
                const supported = isSupportedMedia(file.name);
                const lastDot = file.name.lastIndexOf('.');
                const ext = lastDot !== -1 ? file.name.substring(lastDot) : '';
                const icon = file.type.startsWith('video/') ? videoIcon(14) : imageIcon(14);
                const li = createElement('li', { className: supported ? 'fm-upload-file-row' : 'fm-upload-file-row fm-file-unsupported' },
                    createElement('input', {
                        type: 'checkbox',
                        className: 'fm-upload-file-checkbox',
                        dataset: { index: String(index) },
                        ...(this.selectedUploadFileIndices.has(index) ? { checked: true } : {}),
                        'aria-label': `Select ${file.name}`
                    }),
                    createElement('div', { className: 'fm-file-info' },
                        createElement('span', { className: 'fm-file-icon', innerHTML: icon }),
                        createElement('div', { className: 'fm-rename-container' },
                            createElement('input', { type: 'text', className: 'fm-file-rename-input', value: customFilename, dataset: { index: String(index) }, placeholder: 'New name...' }),
                            createElement('span', { className: 'fm-file-ext', textContent: ext })
                        )
                    ),
                    createElement('span', { className: 'fm-file-size', textContent: formatBytes(file.size) }),
                    createElement('button', { className: 'fm-icon-btn fm-upload-file-remove', dataset: { index: String(index) }, title: 'Remove from staging list', innerHTML: ICONS.CANCEL })
                );
                append(list, li);
            });
        }
    }

    _renderStagedUploads() {
        const container = document.getElementById('fm-staged-uploads');
        const list = document.getElementById('fm-staged-list');
        if (!container || !list) return;
        if (this.stagedUploads.length === 0) {
            container.classList.add('hidden');
            clear(list);
            return;
        }

        container.classList.remove('hidden');
        clear(list);
        this.stagedUploads.forEach((batch, index) => {
            const totalSize = batch.files.reduce((sum, fileInfo) => sum + fileInfo.file.size, 0);
            const previewNames = batch.files.slice(0, 3).map(fileInfo => fileInfo.file.name).join(', ');
            const moreCount = Math.max(0, batch.files.length - 3);
            append(list, createElement('li', { className: 'fm-staged-upload-row' },
                createElement('div', { className: 'fm-staged-upload-info' },
                    createElement('div', { className: 'fm-staged-upload-target', textContent: batch.label }),
                    createElement('div', {
                        className: 'fm-staged-upload-meta',
                        textContent: `${batch.files.length} file${batch.files.length !== 1 ? 's' : ''} · ${formatBytes(totalSize)}`
                    }),
                    createElement('div', {
                        className: 'fm-staged-upload-preview',
                        textContent: moreCount > 0 ? `${previewNames}, +${moreCount} more` : previewNames
                    })
                ),
                createElement('button', {
                    className: 'btn btn--sm fm-staged-upload-remove',
                    type: 'button',
                    dataset: { index: String(index) },
                    textContent: 'Unstage'
                })
            ));
        });

    }

    _selectAllPendingUploadFiles(shouldSelect) {
        if (shouldSelect) {
            this.selectedFiles.forEach((_file, index) => this.selectedUploadFileIndices.add(index));
        } else {
            this.selectedUploadFileIndices.clear();
        }
        this._renderPendingUploadFiles();
        this._updateUploadControls();
    }

    _removePendingUploadFile(index) {
        this.selectedFiles.splice(index, 1);
        const nextSelection = new Set();
        this.selectedUploadFileIndices.forEach(selectedIndex => {
            if (selectedIndex < index) nextSelection.add(selectedIndex);
            else if (selectedIndex > index) nextSelection.add(selectedIndex - 1);
        });
        this.selectedUploadFileIndices = nextSelection;
        this._renderPendingUploadFiles();
        this._updateUploadControls();
    }

    _stageSelectedFiles() {
        if (!this.selectedDrive || this.selectedFiles.length === 0 || this.isUploading) return;
        const selectedIndices = Array.from(this.selectedUploadFileIndices)
            .filter(index => this.selectedFiles[index])
            .sort((a, b) => a - b);
        if (selectedIndices.length === 0) {
            toast.error('Select at least one file to stage');
            return;
        }

        const filesForBatch = selectedIndices.map(index => this.selectedFiles[index]);
        const subfolder = this.selectedFolder || '';
        const existingBatch = this.stagedUploads.find(batch =>
            batch.drivePath === this.selectedDrive.path && batch.subfolder === subfolder
        );

        if (existingBatch) {
            existingBatch.files.push(...filesForBatch);
        } else {
            this.stagedUploads.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                drivePath: this.selectedDrive.path,
                driveLabel: this.selectedDrive.label || this.selectedDrive.name || 'Drive',
                subfolder,
                label: this._getSelectedFolderLabel(),
                files: filesForBatch
            });
        }

        this.selectedFiles = this.selectedFiles.filter((_file, index) => !this.selectedUploadFileIndices.has(index));
        this.selectedUploadFileIndices.clear();
        this._renderPendingUploadFiles();
        this._renderStagedUploads();
        this._updateUploadControls();
    }

    _unstageBatch(index) {
        const [batch] = this.stagedUploads.splice(index, 1);
        if (!batch) return;
        const startIndex = this.selectedFiles.length;
        this.selectedFiles.push(...batch.files);
        batch.files.forEach((_file, offset) => this.selectedUploadFileIndices.add(startIndex + offset));
        this._renderPendingUploadFiles();
        this._renderStagedUploads();
        this._updateUploadControls();
    }

    _updateUploadControls() {
        const stageBtn = document.getElementById('fm-upload-btn');
        const startBtn = document.getElementById('fm-start-upload-btn');
        const selectedCount = this._getPendingUploadSelectionCount();
        const stagedStats = this._getStagedUploadStats();

        if (stageBtn) {
            stageBtn.disabled = !this.selectedDrive || selectedCount === 0 || this.isUploading;
            stageBtn.classList.toggle('hidden', this.isUploading || this.selectedFiles.length === 0);
            const label = selectedCount > 0 ? `Stage ${selectedCount}` : 'Stage';
            stageBtn.innerHTML = `${ICONS.UPLOAD}${label}`;
            stageBtn.title = this.selectedDrive ? `Destination: ${this._getSelectedFolderLabel()}` : 'Select a drive first';
        }

        if (startBtn) {
            startBtn.disabled = stagedStats.files === 0 || this.selectedFiles.length > 0 || this.isUploading;
            startBtn.classList.toggle('hidden', this.isUploading || stagedStats.files === 0);
            startBtn.innerHTML = `${ICONS.UPLOAD} Start ${stagedStats.files} Upload${stagedStats.files === 1 ? '' : 's'}`;
            startBtn.title = this.selectedFiles.length > 0
                ? 'Stage or remove the remaining files before starting'
                : `Upload ${stagedStats.files} staged file${stagedStats.files === 1 ? '' : 's'}`;
        }
    }

    async _uploadBatchWithDuplicateHandling(batch, onProgress, onFileComplete) {
        const runUpload = (skipDuplicateCheck) => uploadFilesOptimized(
            batch.files,
            batch.drivePath,
            batch.subfolder,
            onProgress,
            onFileComplete,
            skipDuplicateCheck
        );

        resetDuplicateState();
        let result = await runUpload(false);
        if (result?.waitingForUser) {
            result = await new Promise((resolve, reject) => {
                const duplicateState = getDuplicateState();
                showDuplicateWarning(
                    batch.files,
                    async () => {
                        duplicateState.userChoice = 'skip';
                        try { resolve(await runUpload(true)); }
                        catch (error) { reject(error); }
                    },
                    async () => {
                        duplicateState.userChoice = 'upload';
                        try { resolve(await runUpload(true)); }
                        catch (error) { reject(error); }
                    },
                    () => {
                        reject(new Error('Duplicate review cancelled'));
                    }
                );
            });
        }
        resetDuplicateState();
        return result || { success: 0, failed: 0, errors: [], log: [] };
    }

    async _startStagedUploads() {
        if (this.stagedUploads.length === 0 || this.selectedFiles.length > 0 || this.isUploading) return;
        const m = (id) => document.getElementById(id);
        m('fm-upload-progress').classList.remove('hidden');
        m('fm-upload-results').classList.add('hidden');
        m('fm-upload-btn').disabled = true;
        m('fm-upload-btn').classList.add('hidden');
        m('fm-start-upload-btn').disabled = true;
        m('fm-start-upload-btn').classList.add('hidden');
        m('fm-cancel-upload-btn').classList.remove('hidden');
        this.isUploading = true;
        resetUploadState();
        resetDuplicateState();
        const results = [];
        const batches = [...this.stagedUploads];
        const totalBytes = batches.reduce((sum, batch) =>
            sum + batch.files.reduce((fileSum, fileInfo) => fileSum + fileInfo.file.size, 0), 0);
        let completedBytes = 0;
        let uploadedCount = 0;
        const totalFiles = batches.reduce((sum, batch) => sum + batch.files.length, 0);
        const endUploadActivity = beginUploadActivity();
        let uploadActivityActive = true;
        const finishUploadActivity = () => {
            if (!uploadActivityActive) return;
            uploadActivityActive = false;
            endUploadActivity();
        };

        try {
            for (const batch of batches) {
                if (isUploadCancelled()) break;
                const batchBytes = batch.files.reduce((sum, fileInfo) => sum + fileInfo.file.size, 0);
                const updateProgress = (batchProgress) => {
                    const uploadedBytes = completedBytes + (batchBytes * (batchProgress / 100));
                    const overallProgress = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
                    const f = m('fm-progress-fill');
                    const t = m('fm-progress-text');
                    if (f) f.style.width = `${overallProgress}%`;
                    if (t) t.textContent = `Uploading ${uploadedCount} of ${totalFiles} files... ${overallProgress}%`;
                };

                const result = await this._uploadBatchWithDuplicateHandling(
                    batch,
                    updateProgress,
                    (filename, success, error) => {
                        uploadedCount += 1;
                        results.push({
                            filename,
                            target: batch.label,
                            success,
                            message: success ? 'Uploaded' : (error || 'Failed')
                        });
                    }
                );
                completedBytes += batchBytes;
                if (result.skippedAll) {
                    batch.files.forEach(fileInfo => {
                        uploadedCount += 1;
                        results.push({
                            filename: fileInfo.customFilename || fileInfo.file.name,
                            target: batch.label,
                            success: true,
                            message: 'Skipped duplicate'
                        });
                    });
                }
                updateProgress(100);
            }

            m('fm-upload-progress').classList.add('hidden');
            m('fm-upload-results').classList.remove('hidden');
            m('fm-results-list').innerHTML = results.slice(0, 20).map(r => `<li class="${r.success ? 'fm-result-success' : 'fm-result-error'}">${r.success ? ICONS.CHECK : '✗'} <span>${escapeHtml(r.filename)}</span> <span class="fm-result-target">${escapeHtml(r.target || '')}</span> <span class="fm-result-message">${escapeHtml(r.message)}</span></li>`).join('');
            if (results.length > 20) m('fm-results-list').innerHTML += `<li class="fm-result-more">... and ${results.length - 20} more files</li>`;
            this.stagedUploads = [];
            const fileInput = m('fm-file-input'); if (fileInput) fileInput.value = '';
            const folderInput = m('fm-folder-input'); if (folderInput) folderInput.value = '';
            this._renderStagedUploads();
            const successfulUploads = results.filter(result => result.success && result.message !== 'Skipped duplicate').length;
            if (successfulUploads > 0) {
                m('fm-upload-progress').classList.remove('hidden');
                m('fm-progress-fill').style.width = '100%';
                m('fm-progress-fill').style.background = 'var(--accent-color)';
                m('fm-progress-text').textContent = `Successfully uploaded ${successfulUploads} of ${totalFiles} files`;
                finishUploadActivity();
                refreshAllLayouts();
            }
        } catch (err) {
            console.error('[FileManager] Upload error:', err);
            m('fm-upload-progress').classList.add('hidden');
            toast.error('Upload failed: ' + err.message);
        } finally {
            finishUploadActivity();
            this.isUploading = false;
            m('fm-upload-btn').disabled = false;
            m('fm-upload-btn').classList.remove('hidden');
            m('fm-start-upload-btn').classList.remove('hidden');
            m('fm-cancel-upload-btn').classList.add('hidden');
            this._updateUploadControls();
        }
    }

    // ── Reveal hidden ─────────────────────────────────────────────────────

    async _checkRevealHiddenStatus() {
        try {
            const resp = await fetch('/api/admin/categories/show-status', { credentials: 'include' });
            if (!resp.ok) { this._updateRevealHiddenUI(false); return; }
            const data = await resp.json();
            if (data.active) {
                enableShowHidden();
                this.revealHiddenActive = true;
                this.revealHiddenExpiry = Date.now() + (data.remaining_seconds * 1000);
                this._updateRevealHiddenUI(true, data.remaining_seconds);
                this._startRevealHiddenCountdown();
            } else {
                const wasActive = this.revealHiddenActive;
                disableShowHidden();
                this.revealHiddenActive = false;
                this.revealHiddenExpiry = null;
                this._stopRevealHiddenCountdown();
                this._updateRevealHiddenUI(false);
                if (wasActive) {
                    await refreshAllLayouts(false, false, true, { refreshCategoryList: true });
                }
            }
        } catch (err) { this._updateRevealHiddenUI(false); }
    }

    async _activateRevealHidden(durationSeconds) {
        try {
            const resp = await fetch('/api/admin/categories/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ duration: durationSeconds }) });
            const result = await resp.json();
            if (resp.ok && result.success) {
                enableShowHidden();
                this.revealHiddenActive = true;
                this.revealHiddenExpiry = Date.now() + (durationSeconds * 1000);
                this._updateRevealHiddenUI(true, durationSeconds);
                this._startRevealHiddenCountdown();
                if (this.selectedDrive) await this._loadFolders(this.selectedDrive.path);
                await this._refreshLayoutsAfterRevealChange();
            } else { toast.error('Failed to reveal hidden: ' + (result.error || result.message || 'Unknown')); }
        } catch (err) { toast.error('Failed: ' + err.message); }
    }

    async _deactivateRevealHidden() {
        try {
            await fetch('/api/admin/categories/clear-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
            disableShowHidden();
            this.revealHiddenActive = false;
            this.revealHiddenExpiry = null;
            this._stopRevealHiddenCountdown();
            this._updateRevealHiddenUI(false);
            await this._checkRevealHiddenStatus();
            if (this.selectedDrive) await this._loadFolders(this.selectedDrive.path);
            await this._refreshLayoutsAfterRevealChange();
        } catch (err) { console.error('[FileManager] Deactivate reveal error:', err); }
    }

    _updateRevealHiddenUI(isActive, remainingSeconds = null) {
        const btn = document.getElementById('fm-reveal-hidden-btn');
        const text = document.getElementById('fm-reveal-hidden-text');
        const confirmBtn = document.getElementById('fm-reveal-confirm-btn');
        const stopBtn = document.getElementById('fm-reveal-stop-btn');
        if (!btn || !text) return;
        if (isActive) {
            btn.classList.add('active');
            text.textContent = remainingSeconds !== null ? formatCountdown(remainingSeconds) : 'Revealing...';
            if (confirmBtn) confirmBtn.classList.add('hidden');
            if (stopBtn) stopBtn.classList.remove('hidden');
        } else {
            btn.classList.remove('active');
            text.textContent = 'Reveal Hidden';
            if (confirmBtn) confirmBtn.classList.remove('hidden');
            if (stopBtn) stopBtn.classList.add('hidden');
        }
    }

    _startRevealHiddenCountdown() {
        this._stopRevealHiddenCountdown();
        this._revealHiddenTimer = this.interval(async () => {
            if (!this.revealHiddenExpiry) { this._stopRevealHiddenCountdown(); return; }
            const remaining = Math.max(0, Math.floor((this.revealHiddenExpiry - Date.now()) / 1000));
            if (remaining <= 0) {
                this.revealHiddenActive = false;
                this.revealHiddenExpiry = null;
                this._stopRevealHiddenCountdown();
                disableShowHidden();
                this._updateRevealHiddenUI(false);
                if (this.selectedDrive && this.manageMode) await this._loadFolders(this.selectedDrive.path);
                await refreshAllLayouts();
            } else { this._updateRevealHiddenUI(true, remaining); }
        }, 1000);
    }

    _stopRevealHiddenCountdown() {
        if (this._revealHiddenTimer) { this.clearInterval(this._revealHiddenTimer); this._revealHiddenTimer = null; }
    }
}

// ── Singleton ──────────────────────────────────────────────────────────────
const _fileManager = new FileManagerModule();
_fileManager.start();

// ── Public API ─────────────────────────────────────────────────────────────

export function initFileManager() { /* No-op — module starts at module load */ }

export function openFileManager() { _fileManager.open(false); }

export function openUploadStatus() { _fileManager.open(false, { statusOnly: true }); }

export function openManageContent() { _fileManager.open(true); }

export function closeFileManager() { _fileManager.close(); }

export function destroyFileManager() { _fileManager.destroy(); }

export async function downloadCategoryAsZip(categoryId, categoryName) {
    try {
        const resp = await fetch(`/api/categories/${categoryId}/download`);
        if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Download failed'); }
        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);
        const a = createElement('a', { href: url, download: `${categoryName || categoryId}.zip` });
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        return true;
    } catch (err) { console.error('[FileManager] ZIP download error:', err); toast.error('Failed to download: ' + err.message); return false; }
}
