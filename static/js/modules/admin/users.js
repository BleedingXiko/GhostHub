/**
 * Users Management Module
 * Handles user listing, viewing, and kicking functionality for admin users.
 */

import { ensureFeatureAccess } from '../../utils/authManager.js';
import { eyeIcon, trashIcon, userIcon } from '../../utils/icons.js';
import { Module, createElement, $ } from '../../libs/ragot.esm.min.js';
import { toast, dialog } from '../../utils/notificationManager.js';
import { SOCKET_EVENTS } from '../../core/socketEvents.js';

// SVG Icons
const USER_ICONS = {
    VIEW: eyeIcon(18),
    KICK: trashIcon(18),
    USER: userIcon(18)
};

let usersListElement = null;
let socket = null;
let isInitialized = false;
let pendingKickSid = null;
let pendingViewSessionId = null;
let usersModuleLifecycle = null;

class UsersModuleLifecycle extends Module {
    constructor() {
        super();
        this.boundSocket = null;
        this.onDocumentClick = this.onDocumentClick.bind(this);
        this.onAdminKickConfirmation = this.onAdminKickConfirmation.bind(this);
        this.onViewInfoResponse = this.onViewInfoResponse.bind(this);
        this.onYouHaveBeenKicked = this.onYouHaveBeenKicked.bind(this);
    }

    start() {
        if (this._isMounted) return this;
        super.start();
        this.on(document, 'click', this.onDocumentClick);
        return this;
    }

    bindSocket(socketInstance) {
        if (!socketInstance || this.boundSocket === socketInstance) return;
        this.onSocket(socketInstance, SOCKET_EVENTS.ADMIN_KICK_CONFIRMATION, this.onAdminKickConfirmation);
        this.onSocket(socketInstance, SOCKET_EVENTS.VIEW_INFO_RESPONSE, this.onViewInfoResponse);
        this.onSocket(socketInstance, SOCKET_EVENTS.YOU_HAVE_BEEN_KICKED, this.onYouHaveBeenKicked);
        this.onSocket(socketInstance, SOCKET_EVENTS.PROFILE_SELECTED, () => fetchUsers());
        this.onSocket(socketInstance, SOCKET_EVENTS.PROFILES_CHANGED, () => fetchUsers());
        this.boundSocket = socketInstance;
    }

    onDocumentClick(event) {
        const kickBtn = event.target?.closest('.kick-user-btn');
        if (kickBtn) {
            event.preventDefault();
            if (kickBtn.dataset.isAdmin === 'true') {
                toast.error('Cannot kick yourself.');
                return;
            }
            handleKickUser(kickBtn.dataset.userid);
            return;
        }

        const viewBtn = event.target?.closest('.view-user-btn:not([disabled])');
        if (viewBtn) {
            event.preventDefault();
            handleViewUser(viewBtn.dataset.sessionId, viewBtn.dataset.userid);
        }
    }

    onAdminKickConfirmation(data) {
        console.log('Admin kick confirmation received:', data);
        toast.show('User kicked successfully.', 'success');
        if (pendingKickSid && data.kicked_user_sid === pendingKickSid) {
            pendingKickSid = null;
        }
        fetchUsers();
    }

    async onViewInfoResponse(data) {
        if (!pendingViewSessionId) return;

        if (data.error) {
            toast.show(`View error: ${data.error}`, 'error');
            pendingViewSessionId = null;
            return;
        }

        if (!data.category_id || !data.mediaId) {
            toast.show('User is not currently viewing any media.', 'info');
            pendingViewSessionId = null;
            return;
        }

        pendingViewSessionId = null;
        const navigate = window.ragotModules?.syncManager?.navigateToState;
        if (navigate) {
            const success = await navigate(data.category_id, data.mediaId, 'AdminViewUser', data);
            if (success === false) {
                toast.show('View error: media could not be resolved.', 'error');
                return;
            }
            toast.show(`Switched to view of session ${data.target_session_id}.`, 'success');
            const closeBtn = $('#config-modal-close-btn');
            if (closeBtn) closeBtn.click();
        } else {
            toast.show('View error: sync navigation is not available.', 'error');
        }
    }

    onYouHaveBeenKicked(data) {
        console.warn('This admin client has been kicked:', data);
        window.location.reload();
    }

    onStop() {
        this.boundSocket = null;
    }
}

/**
 * Fetches the list of users from the server and renders them
 */
async function fetchUsers() {
    usersListElement = $('#users-list');
    if (!usersListElement) {
        console.warn('Users list element (#users-list) not found in DOM');
        return;
    }

    usersListElement.innerHTML = '<p class="admin-users-state">Loading users...</p>';

    try {
        const response = await fetch('/api/admin/users');
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                usersListElement.innerHTML = '<p class="error-message admin-users-state admin-users-state--error">Unauthorized. Admin access required.</p>';
                console.error('Unauthorized to fetch users.');
                return;
            }
            throw new Error(`Failed to fetch users: ${response.status} ${response.statusText}`);
        }
        const users = await response.json();
        renderUsersList(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        usersListElement.innerHTML = '<p class="error-message admin-users-state admin-users-state--error">Could not load user data. Check console for details.</p>';
    }
}

/**
 * Renders the list of users in the UI
 * @param {Array} users - Array of user objects
 */
function renderUsersList(users) {
    if (!usersListElement) return;

    if (!users || users.length === 0) {
        usersListElement.innerHTML = '<p class="admin-users-state">No users currently connected.</p>';
        return;
    }

    const container = createElement('div', { className: 'users-list-container' });

    users.forEach(user => {
        const isAdminBadge = user.isAdmin ? '<span class="admin-badge">You</span>' : '';
        const isDisabled = user.isAdmin ? 'disabled' : '';
        const profileMeta = user.profile_name ? `
            <span class="user-profile-meta">Profile: ${user.profile_name}</span>
        ` : '';

        const item = createElement('div', {
            className: `user-item ${user.isAdmin ? 'admin-user-item' : ''}`,
            innerHTML: `
                <div class="user-icon">
                    ${USER_ICONS.USER}
                </div>
                <div class="user-info">
                    <div class="user-main-info">
                        <span class="user-identifier">${user.user_id || 'Unknown'}</span>
                        ${isAdminBadge}
                    </div>
                    <span class="user-ip">${user.ip || 'Unknown IP'}</span>
                    ${profileMeta}
                </div>
                <div class="user-actions">
                    <button
                        class="btn btn--icon view-user-btn"
                        title="View User Activity"
                        data-session-id="${user.session_id}"
                        data-userid="${user.user_id}"
                        ${isDisabled}>
                        ${USER_ICONS.VIEW}
                    </button>
                    <button
                        class="btn btn--icon btn--danger kick-user-btn"
                        title="Kick User & Block IP"
                        data-userid="${user.id}"
                        data-is-admin="${user.isAdmin}"
                        ${isDisabled}>
                        ${USER_ICONS.KICK}
                    </button>
                </div>
            `
        });

        container.appendChild(item);
    });

    usersListElement.innerHTML = '';
    usersListElement.appendChild(container);
}

/**
 * Handles viewing user details via /view command
 * @param {string} sessionId - The user's full session ID
 * @param {string} userId - The user's short ID (display purposes)
 */
async function handleViewUser(sessionId, userId) {
    console.log(`View user: session=${sessionId}, display=${userId}`);

    if (!sessionId) {
        toast.show('Missing session ID for view.', 'error');
        return;
    }

    if (!socket) {
        toast.show('View command not available. Socket is not initialized.', 'error');
        return;
    }

    const accessGranted = await ensureFeatureAccess();
    if (!accessGranted) {
        toast.show('Password validation required to use view.', 'error');
        return;
    }

    pendingViewSessionId = sessionId;
    socket.emit(SOCKET_EVENTS.REQUEST_VIEW_INFO, { target_session_id: sessionId });
    toast.show(`Requesting view for session ${userId}...`, 'info');
}

/**
 * Handles kicking a user
 * @param {string} userId - The user's socket ID
 */
async function handleKickUser(userId) {
    if (!await dialog.confirm(`Are you sure you want to kick this user?\n\nTheir IP will be temporarily blocked.`, { type: 'danger' })) {
        return;
    }

    try {
        pendingKickSid = userId;
        toast.show('Kicking user...', 'info');

        const response = await fetch('/api/admin/kick_user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ user_sid: userId })
        });

        let result = null;
        try {
            result = await response.json();
        } catch (error) {
            console.warn('Kick response was not valid JSON:', error);
        }

        if (!response.ok || result?.success === false) {
            const message = result?.message || result?.error || `Failed to kick user: ${response.status}`;
            throw new Error(message);
        }

        toast.show('User kicked successfully.', 'success');

        // Refresh user list
        setTimeout(() => fetchUsers(), 500);
    } catch (error) {
        console.error('Error kicking user:', error);
        if (pendingKickSid === userId) {
            pendingKickSid = null;
        }
        toast.show('User kicked successfully.', 'success');
        setTimeout(() => fetchUsers(), 500);
    }
}

/**
 * Initializes the users management module
 * @param {Object} socketInstance - Socket.IO client instance
 */
function initUsersModule(socketInstance) {
    if (!usersModuleLifecycle) {
        usersModuleLifecycle = new UsersModuleLifecycle();
    }
    usersModuleLifecycle.start();

    if (socketInstance) {
        socket = socketInstance;
        usersModuleLifecycle.bindSocket(socket);
    } else if (!socket) {
        console.warn('Socket instance not provided to initUsersModule. Real-time updates will not work.');
    }

    if (isInitialized) {
        console.log('Users module already initialized');
    } else {
        isInitialized = true;
        console.log('Users management module initialized');
    }
}

function cleanupUsersModule() {
    if (usersModuleLifecycle) {
        usersModuleLifecycle.stop();
        usersModuleLifecycle = null;
    }
    socket = null;
    isInitialized = false;
    pendingKickSid = null;
    pendingViewSessionId = null;
}

// Export functions for use in other modules
export {
    fetchUsers,
    initUsersModule,
    cleanupUsersModule,
    renderUsersList,
    handleKickUser,
    handleViewUser
};
