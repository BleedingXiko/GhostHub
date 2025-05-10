/**
 * Command Handler Module
 * Handles slash-command processing, rate limiting, and command execution.
 * Uses modular command system for easy extension.
 */

import { commands } from '../commands/index.js';

// Rate limiting configuration
const RATE_LIMIT = {
  maxCommands: 3,
  timeWindow: 5000, // ms
  commands: []
};

// Socket reference (initialized in initCommandHandler)
let socket = null;
// Function reference for local-only system messages
let displayLocalMessage = null;

/**
 * Initialize the command handler
 * @param {Object} socketInstance        The existing socket.io instance
 * @param {Function} displayLocalMessageFn  Function to display local-only msgs
 */
export function initCommandHandler(socketInstance, displayLocalMessageFn) {
  if (!socketInstance) {
    console.error('Command handler init failed: no socket provided');
    return null;
  }
  socket = socketInstance;
  displayLocalMessage = displayLocalMessageFn;
  
  // Expose commands through window object for the command popup
  if (!window.appModules) {
    window.appModules = {};
  }
  window.appModules.commandHandler = { commands };
  
  console.log('Command handler initialized with modular command system');
  return { processCommand };
}

/**
 * Process a chat message; if it's a slash command, execute it
 * @param {string} message - The chat input
 * @returns {boolean}      - True if handled as a command
 */
export function processCommand(message) {
  if (!message.startsWith('/')) return false;

  // Trim the message to avoid issues with extra spaces
  message = message.trim();
  
  // Fix potential double-slash issue 
  if (message.startsWith('//')) {
    message = message.replace('//', '/');
  }
  
  // Simple first pass - just get the command name
  const commandName = message.split(' ')[0].substring(1).toLowerCase();
  
  // Check if it's a valid command first
  if (!commandName || !commands[commandName]) {
    displayLocalMessage(`Unknown command: /${commandName}`);
    return true;
  }
  
  // Now parse the full command with arguments
  // Get everything after the command name as the argument
  let arg = '';
  if (message.length > commandName.length + 1) {
    // +2 accounts for the slash and the space
    arg = message.substring(commandName.length + 2).trim();
  }
  
  // Rate-limit
  const now = Date.now();
  RATE_LIMIT.commands = RATE_LIMIT.commands.filter(t => now - t < RATE_LIMIT.timeWindow);
  if (RATE_LIMIT.commands.length >= RATE_LIMIT.maxCommands) {
    displayLocalMessage('Slow down... Command rate limit exceeded');
    return true;
  }
  RATE_LIMIT.commands.push(now);

  // Execute the command
  try {
    commands[commandName].execute(socket, displayLocalMessage, arg);
  } catch (error) {
    console.error(`Error executing command /${commandName}:`, error);
    displayLocalMessage(`Error executing command /${commandName}: ${error.message}`);
  }
  
  return true;
}
