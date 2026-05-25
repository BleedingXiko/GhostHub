/**
 * Profile selector UI.
 * Provides the shared profile selection overlay.
 */

import { Module, createElement, clear, append, $ } from '../../libs/ragot.esm.min.js';
import { userIcon, plusIcon, xIcon } from '../../utils/icons.js';
import { ensureFeatureAccess } from '../../utils/authManager.js';
import { toast } from '../../utils/notificationManager.js';
import { createFocusTrap } from '../../utils/focusTrap.js';
import {
    applyProfileAvatar,
    createProfileAvatar,
    createProfileAvatarPicker,
    getDefaultProfileAvatarColor,
} from '../../utils/profileAvatarLibrary.js';
import {
    suspendConfigModalFocusTrap,
    resumeConfigModalFocusTrap,
} from '../config/modal.js';
import {
    PROFILE_SELECTED_EVENT,
    PROFILES_CHANGED_EVENT,
} from './events.js';
import {
    clearStoredProfile,
    getStoredProfileId,
    getStoredProfileName,
    syncActiveProfile,
    validateProfileName,
} from '../../utils/profileUtils.js';

const PROFILE_ROOT_ID = 'gh-profile-shell';

class ProfileSelector extends Module {
    constructor() {
        super();
        this.root = null;
        this.overlay = null;
        this.state = {
            profiles: [],
            activeProfile: null,
            overlayOpen: false,
            overlayRequired: false,
            loadingProfiles: false,
            createFormOpen: false,
            createPending: false,
            selectPendingId: null,
            errorMessage: '',
            searchQuery: '',
        };
        this.pendingResolver = null;
        this.focusTrap = null;
        this.suspendedConfigFocusTrap = false;
    }

    onStart() {
        this._ensureShell();
        this._renderOverlay();

        this.on(window, PROFILE_SELECTED_EVENT, (event) => {
            this.handleRemoteProfileSelected(event.detail);
        });
        this.on(window, PROFILES_CHANGED_EVENT, (event) => {
            this.handleRemoteProfilesChanged(event.detail);
        });
    }

    onStop() {
        this._setProfileSelectionActive(false);
        this.focusTrap?.deactivate({ restoreFocus: false });
        this.focusTrap = null;
    }

    async ensureActiveProfile() {
        const storedProfileId = getStoredProfileId();
        const data = await this.refreshProfiles();
        if (data.active_profile?.id) {
            return data.active_profile;
        }

        if (storedProfileId && data.profiles.some((profile) => profile.id === storedProfileId)) {
            const profile = await this.selectProfile(storedProfileId, { quiet: true });
            if (profile?.id) {
                return profile;
            }
        }

        this.open({ required: true });
        return new Promise((resolve) => {
            this.pendingResolver = resolve;
        });
    }

    async refreshProfiles() {
        try {
            const response = await fetch('/api/profiles', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`Failed to load profiles (${response.status})`);
            }

            const data = await response.json();
            this.state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
            this._setActiveProfile(data.active_profile || null, { closeIfSelected: false });
            return data;
        } finally {
            this.state.loadingProfiles = false;
            this._renderOverlay();
        }
    }

    async selectProfile(profileId, options = {}) {
        const { quiet = false } = options;
        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            return null;
        }

        this.state.selectPendingId = profileId;
        this._renderOverlay();

        try {
            const response = await fetch('/api/profiles/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile_id: profileId })
            });

            const data = await response.json().catch(() => ({}));

            if (response.status === 409) {
                this._handleProfileInUseElsewhere(profileId);
                return null;
            }

            if (!response.ok || (profileId && !data.profile)) {
                throw new Error(data.error || data.message || 'Failed to select profile.');
            }

            if (Array.isArray(data.profiles)) {
                this.state.profiles = data.profiles;
                this._setActiveProfile(data.active_profile || data.profile || null, { closeIfSelected: true });
            } else {
                await this.refreshProfiles();
                this._setActiveProfile(data.profile, { closeIfSelected: true });
            }
            window.dispatchEvent(new CustomEvent(PROFILE_SELECTED_EVENT, {
                detail: {
                    profile: data.profile || null,
                }
            }));
            if (!data.profile) {
                this.state.overlayOpen = false;
                this.state.overlayRequired = false;
                if (this.pendingResolver) {
                    this.pendingResolver(null);
                    this.pendingResolver = null;
                }
                this._renderOverlay();
            }
            toast.success(data.profile?.name
                ? `Switched to ${data.profile.name}.`
                : 'Continuing without a profile.');
            return data.profile;
        } catch (error) {
            if (!quiet) {
                toast.error(error.message || 'Failed to select profile.');
            }
            this.state.errorMessage = error.message || 'Failed to select profile.';
            this._renderOverlay();
            return null;
        } finally {
            this.state.selectPendingId = null;
            this._renderOverlay();
        }
    }

    async createProfile(name, avatarColor = null, avatarIcon = null, options = {}) {
        const { selectAfterCreate = false } = options;
        const validationError = validateProfileName(name);
        if (validationError) {
            toast.error(validationError);
            return null;
        }

        const accessGranted = await ensureFeatureAccess();
        if (!accessGranted) {
            return null;
        }

        this.state.createFormOpen = true;
        this.state.createPending = true;
        this.state.errorMessage = '';
        this._renderOverlay();

        try {
            const response = await fetch('/api/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: String(name).trim(),
                    avatar_color: avatarColor || null,
                    avatar_icon: avatarIcon || null,
                })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok || !data.profile) {
                throw new Error(data.error || data.message || 'Failed to create profile.');
            }

            toast.success(`Created ${data.profile.name}.`);
            await this.refreshProfiles();
            if (this.state.profiles.length > 0) {
                this.state.createFormOpen = false;
            }

            if (selectAfterCreate) {
                return this.selectProfile(data.profile.id);
            }

            return data.profile;
        } catch (error) {
            toast.error(error.message || 'Failed to create profile.');
            this.state.errorMessage = error.message || 'Failed to create profile.';
            this._renderOverlay();
            return null;
        } finally {
            this.state.createPending = false;
            this._renderOverlay();
        }
    }

    open(options = {}) {
        const { required = false, loading = false } = options;
        if (!this.suspendedConfigFocusTrap) {
            suspendConfigModalFocusTrap();
            this.suspendedConfigFocusTrap = true;
        }
        this.state.overlayOpen = true;
        this.state.overlayRequired = required;
        this.state.loadingProfiles = loading;
        this.state.createFormOpen = false;
        this.state.searchQuery = '';
        this._renderOverlay();
    }

    close() {
        if (this.state.overlayRequired && !this.state.activeProfile?.id) {
            return;
        }

        this.state.overlayOpen = false;
        this.state.errorMessage = '';
        this.state.searchQuery = '';
        this.state.createFormOpen = false;
        this._renderOverlay();
    }

    async handleRemoteProfileSelected(payload) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'profile')) {
            this._setActiveProfile(payload.profile || null, {
                closeIfSelected: true,
            });
            this._renderOverlay();
            return;
        }

        const data = await this.refreshProfiles();
        this._setActiveProfile(data.active_profile || null, { closeIfSelected: true });
        this._renderOverlay();
    }

    async handleRemoteProfilesChanged(_payload) {
        // Signal-only: refetch annotated profiles from the server so
        // is_active_elsewhere / is_active_in_session stay accurate.
        const previousActiveProfileId = this.state.activeProfile?.id;
        await this.refreshProfiles();

        const stillExists = previousActiveProfileId
            ? this.state.profiles.some((profile) => profile.id === previousActiveProfileId)
            : false;

        if (previousActiveProfileId && !stillExists) {
            this._setActiveProfile(null, { closeIfSelected: false });
            window.dispatchEvent(new CustomEvent(PROFILE_SELECTED_EVENT, {
                detail: {
                    profile: null,
                }
            }));
            toast.info('Your active profile is no longer available. Choose another profile from Preferences when you want one.');
            return;
        }

        this._renderOverlay();
    }

    _handleProfileInUseElsewhere(profileId) {
        const storedProfileId = getStoredProfileId();
        const isOwnStoredProfile = profileId && profileId === storedProfileId;
        const lockedProfile = this.state.profiles.find((profile) => profile.id === profileId);
        const profileName = lockedProfile?.name
            || (isOwnStoredProfile ? getStoredProfileName() : '')
            || '';

        if (isOwnStoredProfile) {
            clearStoredProfile();
            this._setActiveProfile(null, { closeIfSelected: false });
            window.dispatchEvent(new CustomEvent(PROFILE_SELECTED_EVENT, {
                detail: { profile: null },
            }));
        }

        const message = profileName
            ? (isOwnStoredProfile
                ? `${profileName} is already signed in on another device. You've been signed out — pick a profile to continue.`
                : `${profileName} is already in use on another device.`)
            : 'That profile is already in use on another device.';
        toast.warning(message);
        this.state.errorMessage = message;

        this.refreshProfiles().catch(() => {}).finally(() => {
            if (isOwnStoredProfile) {
                this.open({ required: true });
            } else {
                this._renderOverlay();
            }
        });
    }

    _setActiveProfile(profile, options = {}) {
        const { closeIfSelected = true } = options;
        this.state.activeProfile = profile || null;
        syncActiveProfile(profile || null);

        if (closeIfSelected) {
            this.state.overlayOpen = false;
            this.state.overlayRequired = false;
        }

        if (this.pendingResolver) {
            this.pendingResolver(profile || null);
            this.pendingResolver = null;
        }
    }

    _ensureShell() {
        this.root = document.getElementById(PROFILE_ROOT_ID);
        if (!this.root) {
            this.root = createElement('div', { id: PROFILE_ROOT_ID });
            document.body.appendChild(this.root);
        }

        this.overlay = $('.gh-profile-overlay', this.root);
        if (!this.overlay) {
            this.overlay = createElement('div', { className: 'gh-profile-overlay hidden' });
            this.root.appendChild(this.overlay);
        }
    }

    _renderOverlay() {
        if (!this.overlay) return;

        const shouldShow = this.state.overlayOpen || (this.state.overlayRequired && !this.state.activeProfile?.id);
        this._setProfileSelectionActive(shouldShow);
        this.overlay.classList.toggle('hidden', !shouldShow);

        this.focusTrap?.deactivate({ restoreFocus: false });
        this.focusTrap = null;
        clear(this.overlay);
        if (!shouldShow) {
            if (this.suspendedConfigFocusTrap) {
                resumeConfigModalFocusTrap();
                this.suspendedConfigFocusTrap = false;
            }
            return;
        }

        const panel = createElement('section', {
            className: 'gh-profile-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'Profile selector',
        });

        const header = createElement('div', { className: 'gh-profile-panel__header' },
            createElement('div', { className: 'gh-profile-panel__heading' },
                createElement('div', { className: 'gh-profile-panel__eyebrow', textContent: 'GhostHub' }),
                createElement('h2', {
                    className: 'gh-profile-panel__title',
                    textContent: "Who's watching?"
                })
            )
        );

        if (!this.state.overlayRequired) {
            append(panel, createElement('button', {
                className: 'gh-profile-close btn btn--icon',
                type: 'button',
                innerHTML: xIcon(20),
                onClick: () => this.close()
            }));
        }

        append(panel, header);

        if (this.state.errorMessage) {
            append(panel, createElement('div', {
                className: 'gh-profile-banner gh-profile-banner--error',
                textContent: this.state.errorMessage
            }));
        }

        if (this.state.loadingProfiles) {
            append(panel, createElement('div', { className: 'gh-profile-panel__body gh-profile-panel__body--loading' },
                createElement('div', { className: 'gh-profile-loading' },
                    createElement('div', {
                        className: 'spinner gh-profile-loading__spinner',
                        'aria-hidden': 'true'
                    }),
                    createElement('p', {
                        className: 'gh-profile-loading__label',
                        textContent: 'Loading profiles…'
                    })
                )
            ));
        } else {
            const showCreateInline = this.state.createFormOpen;
            append(panel, createElement('div', { className: 'gh-profile-panel__body' },
                createElement('section', {
                    className: `gh-profile-panel__section gh-profile-panel__section--selection ${showCreateInline && this.state.profiles.length > 0 ? 'is-collapsed' : ''}`.trim()
                }, this._buildProfilesGrid()),
                createElement('section', {
                    className: `gh-profile-panel__section gh-profile-panel__section--create ${showCreateInline ? 'is-expanded' : ''}`.trim()
                }, this._buildCreateForm())
            ));
        }
        this.overlay.appendChild(panel);

        this.focusTrap = createFocusTrap(panel, {
            initialFocus: () =>
                $('.gh-profile-search__input', panel)
                || $('.gh-profile-card:not(:disabled)', panel)
                || $('.gh-profile-create-form__name', panel)
                || panel.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
            returnFocusTo: document.activeElement,
        });
        this.focusTrap.activate();
    }

    _setProfileSelectionActive(isActive) {
        document.documentElement.setAttribute(
            'data-profile-selection-active',
            isActive ? 'true' : 'false'
        );
    }

    _buildProfilesGrid() {
        const wrapper = createElement('section', { className: 'gh-profile-selection' });
        const allProfiles = this._getSortedProfiles();
        const filteredProfiles = this._getFilteredProfiles(allProfiles);
        const hasSearch = this.state.profiles.length >= 5;
        const isCollapsed = this.state.createFormOpen && this.state.profiles.length > 0;

        if (isCollapsed) {
            const activeProfile = this.state.activeProfile || filteredProfiles[0] || allProfiles[0] || null;
            append(wrapper, createElement('div', { className: 'gh-profile-selection__collapsed' },
                activeProfile
                    ? createElement('div', { className: 'gh-profile-selection__collapsed-summary' },
                        createProfileAvatar(activeProfile),
                        createElement('div', { className: 'gh-profile-selection__collapsed-copy' },
                            createElement('div', {
                                className: 'gh-profile-selection__collapsed-title',
                                textContent: activeProfile.name
                            }),
                            createElement('div', {
                                className: 'gh-profile-selection__collapsed-meta',
                                textContent: `${this.state.profiles.length} profile${this.state.profiles.length === 1 ? '' : 's'} available`
                            })
                        )
                    )
                    : createElement('div', {
                        className: 'gh-profile-selection__collapsed-meta',
                        textContent: `${this.state.profiles.length} profiles available`
                    })
            ));
            return wrapper;
        }

        if (hasSearch) {
            append(wrapper, createElement('label', { className: 'gh-profile-search' },
                createElement('span', { className: 'gh-profile-search__label', textContent: 'Find a profile' }),
                createElement('input', {
                    type: 'search',
                    className: 'gh-input gh-profile-search__input',
                    placeholder: 'Search profiles…',
                    value: this.state.searchQuery,
                    onInput: (event) => {
                        this.state.searchQuery = event.target.value || '';
                        this._renderOverlay();
                    }
                })
            ));
        }

        const container = createElement('div', { className: 'gh-profile-grid' });

        if (this.state.profiles.length === 0) {
            append(container, createElement('div', {
                className: 'gh-profile-empty',
                textContent: 'No profiles yet — create one to get started.'
            }));
        }

        if (this.state.profiles.length > 0 && filteredProfiles.length === 0) {
            append(container, createElement('div', {
                className: 'gh-profile-empty',
                textContent: `No profiles match “${this.state.searchQuery.trim()}”.`
            }));
        }

        let avatarIndex = 0;
        filteredProfiles.forEach((profile) => {
            const isActive = profile.id === this.state.activeProfile?.id;
            const isPending = profile.id === this.state.selectPendingId;
            const isLocked = profile.is_active_elsewhere === true;

            const button = createElement('button', {
                type: 'button',
                className: `gh-profile-card ${isActive ? 'is-active' : ''}`,
                disabled: isPending || isLocked,
                onClick: () => this.selectProfile(profile.id),
            });
            button.style.setProperty('--profile-index-delay', `${300 + Math.min(avatarIndex, 6) * 80}ms`);

            append(button,
                createProfileAvatar(profile, 'gh-profile-avatar--lg'),
                createElement('div', { className: 'gh-profile-card__name', textContent: profile.name })
            );

            if (isActive) {
                append(button, createElement('span', {
                    className: 'gh-profile-card__badge',
                    textContent: 'Current'
                }));
            } else if (isLocked) {
                append(button, createElement('span', {
                    className: 'gh-profile-card__badge',
                    textContent: 'In Use'
                }));
            }

            container.appendChild(button);
            avatarIndex++;
        });

        const addBtn = createElement('button', {
            type: 'button',
            className: 'gh-profile-add-btn',
            onClick: () => {
                this.state.createFormOpen = true;
                this._renderOverlay();
            }
        });
        addBtn.style.setProperty('--profile-index-delay', `${300 + Math.min(avatarIndex, 6) * 80}ms`);
        append(addBtn,
            createElement('span', { className: 'gh-profile-add-btn__circle', innerHTML: plusIcon(28) }),
            createElement('span', { className: 'gh-profile-add-btn__label', textContent: 'Add Profile' })
        );
        container.appendChild(addBtn);

        append(wrapper, createElement('div', { className: 'gh-profile-selection__list' }, container));

        const noProfileIsActive = !this.state.activeProfile?.id;
        const guestLink = createElement('button', {
            type: 'button',
            className: `gh-profile-guest-link ${noProfileIsActive ? 'is-active' : ''}`,
            onClick: () => this.selectProfile(null),
        });
        append(guestLink,
            createElement('span', { innerHTML: userIcon(16) }),
            createElement('span', { textContent: noProfileIsActive ? 'Watching as Guest' : 'Continue as Guest' })
        );
        wrapper.appendChild(guestLink);

        return wrapper;
    }

    _buildCreateForm() {
        const isOpen = this.state.createFormOpen;
        if (!isOpen) {
            return createElement('div', { className: 'gh-profile-create-shell' });
        }

        const defaultColor = getDefaultProfileAvatarColor();
        let selectedAvatarIcon = null;
        const previewAvatar = createProfileAvatar({
            name: '',
            avatar_color: defaultColor,
            avatar_icon: selectedAvatarIcon,
        }, 'gh-profile-avatar--lg', {
            initialsFallback: 'AZ',
        });

        const form = createElement('form', {
            className: 'gh-profile-create-form',
            onSubmit: async (event) => {
                event.preventDefault();
                const nameEl = $('.gh-profile-create-form__name', form);
                const colorEl = $('.gh-profile-create-form__color', form);
                if (!nameEl) return;

                const created = await this.createProfile(
                    nameEl.value,
                    colorEl?.value || null,
                    selectedAvatarIcon,
                    { selectAfterCreate: this.state.profiles.length === 0 }
                );

                if (created?.id) {
                    nameEl.value = '';
                    colorEl.value = defaultColor;
                    selectedAvatarIcon = null;
                    avatarPicker.setValue(null);
                    updatePreview();
                }
            }
        });

        const nameInput = createElement('input', {
            type: 'text',
            className: 'gh-input gh-profile-create-form__name',
            placeholder: 'Profile name',
            maxLength: 24,
            disabled: this.state.createPending,
            onInput: () => updatePreview()
        });

        const colorInput = createElement('input', {
            type: 'color',
            className: 'gh-profile-create-form__color',
            value: defaultColor,
            disabled: this.state.createPending,
            onInput: () => updatePreview()
        });

        const updatePreview = () => {
            applyProfileAvatar(previewAvatar, {
                name: nameInput?.value || '',
                avatar_color: colorInput?.value || defaultColor,
                avatar_icon: selectedAvatarIcon,
            }, {
                initialsFallback: 'AZ',
            });
            avatarPicker.refresh();
        };

        const avatarPicker = createProfileAvatarPicker({
            getName: () => nameInput.value || '',
            getColor: () => colorInput.value || defaultColor,
            initialIcon: selectedAvatarIcon,
            onChange: (nextIcon) => {
                selectedAvatarIcon = nextIcon;
                updatePreview();
            },
        });

        append(form,
            createElement('div', { className: 'gh-profile-create-form__title', textContent: 'New Profile' }),
            createElement('div', { className: 'gh-profile-create-form__fields' },
                previewAvatar,
                nameInput,
                createElement('label', { className: 'gh-profile-create-form__swatch' },
                    createElement('span', { className: 'gh-profile-create-form__swatch-label', textContent: 'Color' }),
                    colorInput
                ),
                createElement('button', {
                    type: 'submit',
                    className: 'btn btn--primary gh-profile-create-form__submit',
                    disabled: this.state.createPending,
                    innerHTML: `${plusIcon(16)} <span>${this.state.createPending ? 'Creating…' : 'Create'}</span>`
                })
            ),
            avatarPicker.element
        );

        const wrapper = createElement('div', { className: 'gh-profile-create-shell is-open' });
        wrapper.appendChild(form);
        return wrapper;
    }

    _getSortedProfiles() {
        return [...this.state.profiles].sort((left, right) => {
            const leftActive = left.id === this.state.activeProfile?.id ? 1 : 0;
            const rightActive = right.id === this.state.activeProfile?.id ? 1 : 0;
            if (leftActive !== rightActive) return rightActive - leftActive;

            const leftLocked = left.is_active_elsewhere === true ? 1 : 0;
            const rightLocked = right.is_active_elsewhere === true ? 1 : 0;
            if (leftLocked !== rightLocked) return leftLocked - rightLocked;

            return String(left.name || '').localeCompare(String(right.name || ''));
        });
    }

    _getFilteredProfiles(profiles) {
        const query = String(this.state.searchQuery || '').trim().toLowerCase();
        if (!query) {
            return profiles;
        }

        return profiles.filter((profile) =>
            String(profile?.name || '').toLowerCase().includes(query)
        );
    }
}

let selectorInstance = null;

export function initProfileSelector() {
    if (!selectorInstance) {
        selectorInstance = new ProfileSelector();
    }
    selectorInstance.start();
    return selectorInstance;
}
