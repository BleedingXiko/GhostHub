/**
 * View Command Module
 * Handles the /view {session_id} command which allows a user to jump to another user's shared view.
 */

import { app } from '../core/app.js';
import { ensureFeatureAccess } from '../utils/authManager.js';

// Define the functions first
async function executeView(socket, displayLocalMessage, arg) {
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

  socket.emit('request_view_info', { target_session_id: targetSessionId });
  displayLocalMessage(`Requesting view for session ${targetSessionId}...`);
}

function getViewHelpText() {
  return '• /view {session_id}  Jump to another user\'s shared view (password protected)';
}

// Export the command object
export const view = {
    description: "Jump to another user's shared view using their session ID.",
    execute: executeView,
    getHelpText: getViewHelpText
};
