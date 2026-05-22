/**
 * Quick Actions Module
 * Admin-only gear button in the shared media viewer (bottom-left).
 * Provides Rename / Hide+Unhide / Delete with modal confirmations.
 * Implemented as a RAGOT Component for lifecycle + scoped event management.
 */

import { isUserAdmin } from '../../utils/progressDB.js';
import { editIcon, eyeOffIcon, eyeIcon, trashIcon } from '../../utils/icons.js';
import { updateMediaInfoOverlay } from './elementFactory.js';
import { refreshAllLayouts } from '../../utils/liveVisibility.js';
import { Component, createElement, attr, $ } from '../../libs/ragot.esm.min.js';
import { toast } from '../../utils/notificationManager.js';
import { createFocusTrap } from '../../utils/focusTrap.js';
import { scheduleAutofocus } from '../../utils/focusManager.js';
import { getCurrentViewerRecord } from './viewerState.js';

// Three-dot vertical kebab — standard "more options" icon not in icons.js
const KEBAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="19" r="2.5"/></svg>`;

function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ==========================================
// QuickActionsComponent
// ==========================================

class QuickActionsComponent extends Component {
    constructor(appState, mediaViewer, navCallbacks) {
        super({
            menuOpen: false,
            itemIsHidden: false,
            visible: false,
        });
        this._appState = appState;
        this._mediaViewer = mediaViewer;
        this._navCallbacks = navCallbacks;
        this._activeModal = null;
        this._activeModalEscHandler = null;
        this._activeModalFocusTrap = null;
    }

    // ------------------------------------------
    // Render
    // ------------------------------------------

    render() {
        const { menuOpen, itemIsHidden } = this.state;

        const hideLabel = itemIsHidden ? 'Unhide' : 'Hide';
        const hideIconFn = itemIsHidden ? eyeIcon : eyeOffIcon;

        const menu = createElement('div', {
            id: 'quick-actions-menu',
            className: 'quick-actions-dropdown',
            style: { display: menuOpen ? 'flex' : 'none' },
            role: 'menu',
            'aria-label': 'Quick actions'
        },
            createElement('button', {
                className: 'quick-action-option',
                id: 'qa-rename-btn',
                role: 'menuitem',
                tabindex: menuOpen ? '0' : '-1',
                onClick: (e) => { e.stopPropagation(); this._closeMenu(); this._showRenameModal(); }
            },
                createElement('span', { innerHTML: editIcon(18) }),
                createElement('span', {}, 'Rename')
            ),
            createElement('button', {
                className: 'quick-action-option',
                id: 'qa-hide-btn',
                role: 'menuitem',
                tabindex: menuOpen ? '0' : '-1',
                onClick: (e) => { e.stopPropagation(); this._closeMenu(); this._showHideModal(); }
            },
                createElement('span', { innerHTML: hideIconFn(18) }),
                createElement('span', {}, hideLabel)
            ),
            createElement('button', {
                className: 'quick-action-option danger',
                id: 'qa-delete-btn',
                role: 'menuitem',
                tabindex: menuOpen ? '0' : '-1',
                onClick: (e) => { e.stopPropagation(); this._closeMenu(); this._showDeleteModal(); }
            },
                createElement('span', { innerHTML: trashIcon(18) }),
                createElement('span', {}, 'Delete')
            )
        );

        const btn = createElement('button', {
            id: 'media-quick-actions-btn',
            className: 'media-download-btn',
            title: 'Quick Actions',
            innerHTML: KEBAB_ICON,
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen ? 'true' : 'false',
            onClick: this._toggleMenu,
        });

        return createElement('div', {
            id: 'quick-actions-btn-container',
            className: 'quick-actions-btn-container',
            style: { display: this.state.visible ? 'block' : 'none' },
        }, btn, menu);
    }

    onStart() {
        // Outside-click to close menu
        this.on(document, 'click', this._onOutsideClick);
        this.on(document, 'keydown', this._onDocumentKeyDown);
    }

    onStop() {
        this._closeActiveModal();
    }

    // ------------------------------------------
    // Public API (mirrors old imperative functions)
    // ------------------------------------------

    /** Show or refresh the button for the current media item */
    ensure() {
        const currentMedia = this._getCurrentItem();
        const shouldShow = currentMedia && floatingQuickActionsVisible;

        this.setState({ itemIsHidden: false, menuOpen: false, visible: shouldShow });
    }

    hide() {
        this.setState({ visible: false, menuOpen: false });
    }

    // ------------------------------------------
    // Private helpers
    // ------------------------------------------

    _getCurrentItem() {
        return getCurrentViewerRecord(this._appState);
    }

    _toggleMenu = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const willOpen = !this.state.menuOpen;
        this.setState({ menuOpen: willOpen });
        if (willOpen) {
            requestAnimationFrame(() => this._focusMenuItem(0));
        }
    };

    _closeMenu() {
        this.setState({ menuOpen: false });
    }

    _onOutsideClick = (e) => {
        if (!this.element?.contains(e.target) && this.state.menuOpen) {
            this._closeMenu();
        }
    };

    _onDocumentKeyDown = (e) => {
        if (!this.state.menuOpen) return;

        const items = this._getMenuItems();
        if (!items.length) return;

        const currentIndex = Math.max(0, items.indexOf(document.activeElement));
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._focusMenuItem((currentIndex + 1) % items.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._focusMenuItem((currentIndex - 1 + items.length) % items.length);
        } else if (e.key === 'Home') {
            e.preventDefault();
            this._focusMenuItem(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            this._focusMenuItem(items.length - 1);
        } else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('quick-action-option')) {
            e.preventDefault();
            document.activeElement.click();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this._closeMenu();
            $('#media-quick-actions-btn', this.element)?.focus();
        }
    };

    _getMenuItems() {
        return this.element ? Array.from(this.element.querySelectorAll('.quick-action-option')) : [];
    }

    _focusMenuItem(index) {
        const items = this._getMenuItems();
        const nextItem = items[index];
        if (nextItem) nextItem.focus();
    }

    _closeActiveModal() {
        if (this._activeModalEscHandler) {
            this.off(document, 'keydown', this._activeModalEscHandler);
            this._activeModalEscHandler = null;
        }
        this._activeModalFocusTrap?.deactivate();
        this._activeModalFocusTrap = null;
        if (this._activeModal?.isConnected) {
            this._activeModal.remove();
        }
        this._activeModal = null;
    }

    _mountManagedModal(modal, { initialFocus = null, returnFocusTo = null } = {}) {
        this._closeActiveModal();
        this._activeModal = modal;
        this._activeModalEscHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this._closeActiveModal();
            }
        };
        this.on(document, 'keydown', this._activeModalEscHandler);
        document.body.appendChild(modal);
        const modalContent = modal.querySelector('.modal__content, .modal-content') || modal;
        this._activeModalFocusTrap = createFocusTrap(modalContent, {
            initialFocus,
            returnFocusTo: returnFocusTo || $('#media-quick-actions-btn', this.element)
        });
        requestAnimationFrame(() => this._activeModalFocusTrap?.activate());
    }

    // ------------------------------------------
    // Modals
    // ------------------------------------------

    _showRenameModal() {
        const item = this._getCurrentItem();
        if (!item) return;

        const displayName = item.displayName || item.name || '';
        const lastDot = displayName.lastIndexOf('.');
        const baseName = lastDot > 0 ? displayName.slice(0, lastDot) : displayName;
        const ext = lastDot > 0 ? displayName.slice(lastDot) : '';

        const input = createElement('input', {
            id: 'qa-rename-input',
            type: 'text',
            value: baseName,
            placeholder: 'New filename',
            className: 'qa-modal-input'
        });

        const close = () => this._closeActiveModal();
        const confirm = async () => {
            const newBase = input.value.trim();
            if (!newBase) return;
            close();
            await this._executeAction('rename', { new_name: newBase + ext });
        };

        attr(input, {
            onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirm(); }
                if (e.key === 'Escape') { e.preventDefault(); close(); }
            }
        });

        const modal = createElement('div', {
            className: 'modal',
            id: 'qa-rename-modal',
            onClick: (e) => { if (e.target === modal) close(); }
        },
            createElement('div', {
                className: 'modal__content qa-modal-content',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': 'Rename file'
            },
                createElement('div', { className: 'modal__header' },
                    createElement('h2', { className: 'modal__title' }, 'Rename File'),
                    createElement('button', { className: 'btn btn--icon modal__close', onClick: close }, '×')
                ),
                createElement('div', { className: 'modal__body qa-modal-body' },
                    createElement('p', {
                        className: 'qa-modal-copy',
                        innerHTML: `Rename <strong>${_esc(displayName)}</strong>`
                    }),
                    input,
                    ext ? createElement('p', {
                        className: 'qa-modal-meta',
                        innerHTML: `Extension <strong>${_esc(ext)}</strong> will be preserved.`
                    }) : null,
                    createElement('div', { className: 'qa-modal-actions' },
                        createElement('button', {
                            className: 'qa-modal-btn qa-modal-btn--secondary',
                            onClick: close,
                        }, 'Cancel'),
                        createElement('button', {
                            className: 'qa-modal-btn qa-modal-btn--primary',
                            onClick: confirm,
                        }, 'Rename')
                    )
                )
            )
        );

        this._mountManagedModal(modal, { initialFocus: input });
        scheduleAutofocus(input, { selectionBehavior: 'select-all-desktop' });
    }

    _showHideModal() {
        const item = this._getCurrentItem();
        if (!item) return;
        const isHiding = !this.state.itemIsHidden;
        const verb = isHiding ? 'Hide' : 'Unhide';
        const action = isHiding ? 'hide' : 'unhide';
        const desc = isHiding
            ? 'This file will be hidden from all non-admin users.'
            : 'This file will become visible to all users.';

        this._showConfirmModal({
            title: `${verb} File`,
            body: `<strong class="qa-modal-emphasis">${_esc(item.displayName || item.name)}</strong><br><span class="qa-modal-meta">${desc}</span>`,
            confirmLabel: verb,
            confirmVariant: 'primary',
            onConfirm: () => this._executeAction(action),
        });
    }

    _showDeleteModal() {
        const item = this._getCurrentItem();
        if (!item) return;

        this._showConfirmModal({
            title: 'Delete File',
            body: `Delete <strong class="qa-modal-emphasis">${_esc(item.displayName || item.name)}</strong>?<br><span class="qa-modal-meta">This cannot be undone.</span>`,
            confirmLabel: 'Delete',
            confirmVariant: 'danger',
            onConfirm: () => this._executeAction('delete'),
        });
    }

    _showConfirmModal({ title, body, confirmLabel, confirmVariant = 'primary', onConfirm }) {
        const close = () => this._closeActiveModal();

        const modal = createElement('div', {
            className: 'modal',
            onClick: (e) => { if (e.target === modal) close(); }
        },
            createElement('div', {
                className: 'modal__content qa-modal-content qa-modal-content--compact',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': title
            },
                createElement('div', { className: 'modal__header' },
                    createElement('h2', { className: 'modal__title' }, title),
                    createElement('button', { className: 'btn btn--icon modal__close', onClick: close }, '×')
                ),
                createElement('div', { className: 'modal__body qa-modal-body' },
                    createElement('p', { className: 'qa-modal-copy', innerHTML: body }),
                    createElement('div', { className: 'qa-modal-actions qa-modal-actions--flush' },
                        createElement('button', {
                            className: 'qa-modal-btn qa-modal-btn--secondary',
                            onClick: close,
                        }, 'Cancel'),
                        createElement('button', {
                            className: `qa-modal-btn qa-modal-btn--${confirmVariant}`,
                            onClick: () => { close(); onConfirm(); },
                        }, confirmLabel)
                    )
                )
            )
        );

        this._mountManagedModal(modal, { initialFocus: () => modal.querySelector(`.qa-modal-btn--${confirmVariant}`) });
    }

    // ------------------------------------------
    // Action execution
    // ------------------------------------------

    async _executeAction(action, extra = {}) {
        const item = this._getCurrentItem();
        if (!item) return;

        const categoryId = item.categoryId || this._appState?.currentCategoryId;
        const relPath = item.name;

        if (!categoryId || !relPath) {
            toast.show('Cannot identify file — missing category or path.', 'error');
            return;
        }

        try {
            const response = await fetch('/api/admin/media/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_id: categoryId, rel_path: relPath, action, ...extra }),
            });

            const result = await response.json();
            if (!result.success) {
                toast.show(result.error || `Failed to ${action} file.`, 'error');
                return;
            }
            this._handleSuccess(action, item, result);
        } catch (err) {
            console.error(`[quickActions] ${action} failed:`, err);
            toast.show(`Network error during ${action}.`, 'error');
        }
    }

    _handleSuccess(action, item, result) {
        if (action === 'rename') {
            const updated = this._getCurrentItem();
            if (updated) {
                if (result.new_name) updated.displayName = result.new_name;
                if (result.new_rel_path) {
                    updated.name = result.new_rel_path;
                } else if (result.new_name) {
                    const oldName = updated.name || '';
                    const lastSlash = oldName.lastIndexOf('/');
                    const prefix = lastSlash >= 0 ? oldName.slice(0, lastSlash + 1) : '';
                    updated.name = prefix + result.new_name;
                }
                if (result.new_url) updated.url = result.new_url;
            }
            toast.show(`Renamed to "${result.new_name || 'file'}"`, 'success');
            this._navCallbacks?.goBackToCategories?.();
            return;
        }

        if (action === 'hide') {
            this.setState({ itemIsHidden: true });
            toast.show('File hidden.', 'success');
            this._navCallbacks?.goBackToCategories?.();
            return;
        }

        if (action === 'unhide') {
            this.setState({ itemIsHidden: false });
            toast.show('File unhidden.', 'success');
            this._navCallbacks?.goBackToCategories?.();
            return;
        }

        if (action === 'delete') {
            toast.show('File deleted.', 'success');
            refreshAllLayouts(true);
            this._navCallbacks?.goBackToCategories?.();
        }
    }
}

// ==========================================
// Module-level singleton + public API
// ==========================================

let _component = null;
let _initArgs = null;
let floatingQuickActionsVisible = true;

/**
 * Initialize the quick actions manager.
 * @param {Object} state - Reference to app.state
 * @param {HTMLElement} container - The #media-viewer element
 * @param {Object} callbacks - { navigateMedia, goBackToCategories }
 */
export function initQuickActionsManager(state, container, callbacks) {
    floatingQuickActionsVisible = true;
    _initArgs = { state, container, callbacks };
    if (_component) _component.unmount();
    _component = new QuickActionsComponent(state, container, callbacks);
    _component.mount(container);
}

/**
 * Create or update the quick actions button for the current media item.
 */
export function ensureQuickActionsButton() {
    if (!isUserAdmin()) {
        _component?.hide();
        return;
    }
    // Re-create component if it was destroyed by removeQuickActionsButton
    if (!_component && _initArgs) {
        _component = new QuickActionsComponent(_initArgs.state, _initArgs.container, _initArgs.callbacks);
        _component.mount(_initArgs.container);
    }
    _component?.ensure();
}

export function setQuickActionsVisibility(visible) {
    floatingQuickActionsVisible = visible !== false;

    if (!_component) return;
    if (!isUserAdmin()) {
        _component.hide();
        return;
    }

    if (!floatingQuickActionsVisible) {
        _component.hide();
        return;
    }
    _component.ensure();
}

/**
 * Remove the quick actions button (called when leaving media view).
 */
export function removeQuickActionsButton() {
    if (_component) {
        _component.unmount();
        _component = null;
    }
}
