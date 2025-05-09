/**
 * MyView Command Module
 * Handles the /myview command which shares the user's current view with others in chat
 */

import { app } from '../core/app.js';
import { ensureFeatureAccess } from '../utils/authManager.js'; // Import the new auth utility

/**
 * Execute the /myview command
 * @param {Object} socket - The socket.io instance
 * @param {Function} displayLocalMessage - Function to display local-only messages
 * @param {string} arg - Command arguments (unused for myview)
 */
export async function execute(socket, displayLocalMessage, arg) { // Made async
  const accessGranted = await ensureFeatureAccess();
  if (!accessGranted) {
    displayLocalMessage('Password validation required to use /myview. Please try again after validating.');
    console.log('Access to /myview command denied by password protection.');
    return;
  }

  const categoryId = app.state.currentCategoryId;
  const index = app.state.currentMediaIndex;
  const sessionId = socket.id;

  if (!categoryId || index == null) {
    displayLocalMessage('Cannot share view: No media open');
    return;
  }

  // Emit to server for rebroadcast
  socket.emit('command', {
    cmd: 'myview',
    arg: { category_id: categoryId, index },
    from: sessionId
  });
  
}

/**
 * Get help text for this command
 * @returns {string} Help text
 */
export function getHelpText() {
  return '• /myview           Share your current view with others';
}
