/**
 * MyView Command Module
 * Handles the /myview command which shares the user's current view with others in chat
 */

import { app } from '../core/app.js';
import { ensureFeatureAccess } from '../utils/authManager.js'; // Import the new auth utility

// Define the functions first
async function executeMyView(socket, displayLocalMessage, arg) {
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

function getMyViewHelpText() {
  return '• /myview           Share your current view with others';
}

// Export the command object
export const myview = {
    description: "Share your current media view with others in the chat.",
    execute: executeMyView,
    getHelpText: getMyViewHelpText
};
