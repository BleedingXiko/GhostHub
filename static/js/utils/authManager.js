/**
 * Authentication Manager Utility
 * Handles password validation for feature access.
 */

import { getConfigValue } from './configManager.js';

let positiveValidationTimestamp = 0;
const POSITIVE_VALIDATION_CACHE_DURATION = 2000; // Cache positive result for 2 seconds

/**
 * Ensures that the user has validated the session password if password protection is active.
 * Prompts for password if needed.
 * Uses a short-term in-memory cache for positive validation to avoid rapid re-prompts.
 * @returns {Promise<boolean>} True if access is granted (password validated or not required), false otherwise.
 */
export async function ensureFeatureAccess() {
    const now = Date.now();
    if ((now - positiveValidationTimestamp) < POSITIVE_VALIDATION_CACHE_DURATION) {
        // If a positive validation happened very recently (within cache duration), trust it.
        // console.log('[ensureFeatureAccess] Using recent positive validation from in-memory cache.');
        return true;
    }

    const appRequiresPassword = getConfigValue('isPasswordProtectionActive', false);
    const sessionPasswordValidated = sessionStorage.getItem('session_password_validated') === 'true';

    if (appRequiresPassword && !sessionPasswordValidated) {
        // console.log('[ensureFeatureAccess] Conditions met to prompt for password.');
        const enteredPassword = prompt("This feature is password protected. Please enter the password:");
        
        if (enteredPassword === null) { // User cancelled prompt
            // console.log('[ensureFeatureAccess] Password prompt cancelled by user.');
            return false; // Access denied
        }

        try {
            const response = await fetch('/api/validate_session_password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: enteredPassword })
            });
            const data = await response.json();

            if (data.valid) {
                sessionStorage.setItem('session_password_validated', 'true');
                positiveValidationTimestamp = Date.now(); // Cache this success
                // console.log('[ensureFeatureAccess] Password valid. sessionStorage set. In-memory cache updated.');
                return true; // Access granted
            } else {
                alert(data.message || 'Incorrect password.');
                // console.log('[ensureFeatureAccess] Password invalid.');
                // Do not update positiveValidationTimestamp on failure, let it expire or be overwritten by success.
                return false; // Access denied
            }
        } catch (error) {
            console.error('[ensureFeatureAccess] Password validation API error:', error);
            alert('Error validating password. Please try again.');
            return false; // Access denied due to error
        }
    } else {
        if (appRequiresPassword && sessionPasswordValidated) {
            // console.log('[ensureFeatureAccess] Access granted (password required and already validated in session).');
            positiveValidationTimestamp = Date.now(); // Refresh cache timestamp as sessionStorage confirmed it
        } else if (!appRequiresPassword) {
            // console.log('[ensureFeatureAccess] Access granted (password not required by app config).');
            // No need to update positiveValidationTimestamp here, as no actual validation occurred.
        }
        return true; // Access granted
    }
}
