/**
 * Help Command Module
 * Handles the /help command which displays available commands
 */

import { displayLocalSystemMessage } from '../modules/chatManager.js';

// Import all command modules to get their help text
import * as myviewCommand from './myview.js';

/**
 * Execute the /help command
 * @param {Object} socket - The socket.io instance
 * @param {Function} displayLocalMessage - Function to display local-only messages
 * @param {string} arg - Command arguments (unused for help)
 */
export function execute(socket, displayLocalMessage, arg) {
  // Collect help text from all command modules
  const helpLines = [
    myviewCommand.getHelpText(),
    '• /help             Show this help message'
  ];

  // Format the help text
  const helpText = `
Available commands:
${helpLines.join('\n')}
`;

  // Display the help text
  displayLocalSystemMessage(helpText.trim());
}

/**
 * Get help text for this command
 * @returns {string} Help text
 */
export function getHelpText() {
  return '• /help             Show this help message';
}
