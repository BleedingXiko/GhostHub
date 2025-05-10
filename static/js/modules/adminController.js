// SVG Icons (Font Awesome style for simplicity, replace with actual SVGs if preferred)
const ICONS = {
    OPEN_LOCK: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1m-6 0H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1M9 7V5a3 3 0 0 1 3-3v0a3 3 0 0 1 3 3v2"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/></svg>', // Open Lock
    LOCKED: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', // Locked
    ADMIN_ACTIVE: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>' // Shield for Admin
};

let adminLockBtn;
let adminFeatureElements;

async function fetchAdminStatusAndUpdateUI() {
    try {
        const response = await fetch('/api/admin/status');
        if (!response.ok) {
            console.error('Failed to fetch admin status:', response.status);
            applyUIState(false, false); // Default to non-admin, role not claimed
            return;
        }
        const data = await response.json();
        applyUIState(data.isAdmin, data.roleClaimedByAnyone);
    } catch (error) {
        console.error('Error fetching admin status:', error);
        applyUIState(false, false);
    }
}

function applyUIState(isCurrentUserAdmin, isRoleClaimedByAnyone) {
    if (!adminLockBtn || !adminFeatureElements) {
        // console.warn("Admin UI elements not ready for applyUIState");
        return;
    }

    adminFeatureElements.forEach(el => {
        if (isCurrentUserAdmin) {
            // Restore original display style based on element type/class
            if (el.classList.contains('config-toggle-btn')) { // Settings, Tunnel buttons
                el.style.display = 'flex';
            } else if (el.id === 'add-category-link') { // Add Category link (styled as add-category-btn)
                // Assuming .add-category-btn is typically inline-block or block
                // Check its default styling if issues persist. For now, 'inline-block' is a safe bet.
                el.style.display = 'inline-block'; 
            } else {
                 el.style.display = ''; // Fallback for other admin features if any
            }
        } else {
            el.style.display = 'none';
        }
    });

    // Also update visibility of dynamically added category delete buttons
    if (window.appModules && window.appModules.categoryManager && typeof window.appModules.categoryManager.refreshCategoryDeleteButtonVisibility === 'function') {
        window.appModules.categoryManager.refreshCategoryDeleteButtonVisibility(isCurrentUserAdmin);
    }
    

    if (isCurrentUserAdmin) {
        adminLockBtn.innerHTML = ICONS.ADMIN_ACTIVE;
        adminLockBtn.title = 'Admin Active';
        adminLockBtn.disabled = false; // Or true if they cannot unclaim easily
    } else if (isRoleClaimedByAnyone) {
        adminLockBtn.innerHTML = ICONS.LOCKED;
        adminLockBtn.title = 'Admin Role Claimed by Another User';
        adminLockBtn.disabled = true;
    } else {
        adminLockBtn.innerHTML = ICONS.OPEN_LOCK;
        adminLockBtn.title = 'Claim Admin Role';
        adminLockBtn.disabled = false;
    }
}

async function claimAdminRole() {
    if (!adminLockBtn) return;
    adminLockBtn.disabled = true; // Prevent double-clicks

    try {
        const response = await fetch('/api/admin/claim', { method: 'POST' });
        // const data = await response.json(); // We might not need the response data directly if fetchAdminStatusAndUpdateUI handles all UI
        // console.log('Claim admin response:', data);
        // if (data.message) {
            // Consider showing a small toast/notification with data.message
        // }
    } catch (error) {
        console.error('Error claiming admin role:', error);
        // Potentially show an error message to the user
    } finally {
        // Always refresh UI and re-enable button if appropriate
        await fetchAdminStatusAndUpdateUI(); 
        // The applyUIState called by fetchAdminStatusAndUpdateUI will set the correct disabled state.
    }
}

export function initAdminControls() {
    adminLockBtn = document.getElementById('adminLockBtn');
    // Query all elements that should only be visible to admins
    adminFeatureElements = document.querySelectorAll('.admin-feature'); // This queries static admin features

    if (adminLockBtn) {
        adminLockBtn.addEventListener('click', claimAdminRole);
        fetchAdminStatusAndUpdateUI(); // Initial check on page load, this will also call refreshCategoryDeleteButtonVisibility
    } else {
        console.warn('Admin lock button (#adminLockBtn) not found.');
    }

    // The call to refreshCategoryDeleteButtonVisibility inside applyUIState
    // will handle updates when admin status changes after initial load.
    // No need for polling just for this, but general status polling might still be considered for other reasons.
}
