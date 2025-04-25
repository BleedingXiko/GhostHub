/**
 * MyView Command Module
 * Handles the /myview command which shares the user's current view with others in chat
 */

import { app } from '../core/app.js';

/**
 * Execute the /myview command
 * @param {Object} socket - The socket.io instance
 * @param {Function} displayLocalMessage - Function to display local-only messages
 * @param {string} arg - Command arguments (unused for myview)
 */
export function execute(socket, displayLocalMessage, arg) {
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
