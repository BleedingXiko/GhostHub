/**
 * Help Command Module
 * Handles the /help command which displays available commands
 */

import { displayLocalSystemMessage } from '../modules/chatManager.js';
// Import getAllHelpText from its own index file to dynamically get all help texts
import { getAllHelpText } from './index.js'; 

// Define the functions first
function executeHelp(socket, displayLocalMessage, arg) {
  const allHelp = getAllHelpText(); // Get all help texts dynamically
  const helpText = `Available commands:\n${allHelp}`;
  displayLocalSystemMessage(helpText.trim()); // Use the passed displayLocalMessage for consistency
}

function getHelpHelpText() {
  return '• /help             Show this help message';
}

// Export the command object
export const help = {
    description: "Displays a list of available slash commands and their descriptions.",
    execute: executeHelp,
    getHelpText: getHelpHelpText
};
