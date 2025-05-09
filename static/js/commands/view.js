/**
 * View Command Module
 * Handles the /view {session_id} command which allows a user to jump to another user's shared view.
 */

import { app } from '../core/app.js';
import { ensureFeatureAccess } from '../utils/authManager.js';

/**
 * Execute the /view command
 * @param {Object} socket - The socket.io instance
 * @param {Function} displayLocalMessage - Function to display local-only messages
 * @param {string} arg - Command arguments (target_session_id)
 */
export async function execute(socket, displayLocalMessage, arg) {
  const accessGranted = await ensureFeatureAccess();
  if (!accessGranted) {
    displayLocalMessage('Password validation required to use /view. Please try again after validating.');
    console.log('Access to /view command denied by password protection.');
    return;
  }

  const targetSessionId = arg ? arg.trim() : null;

  if (!targetSessionId) {
    displayLocalMessage('Usage: /view {session_id}');
    return;
  }

  // Emit to server to request view information for the target session
  socket.emit('request_view_info', { target_session_id: targetSessionId });
  displayLocalMessage(`Requesting view for session ${targetSessionId}...`);
}

/**
 * Get help text for this command
 * @returns {string} Help text
 */
export function getHelpText() {
  return '• /view {session_id}  Jump to another user\'s shared view (password protected)';
}
