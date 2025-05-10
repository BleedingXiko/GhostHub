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

  const match = message.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) {
    displayLocalMessage('Invalid command format');
    return true;
  }

  const cmd = match[1].toLowerCase();
  const arg = match[2] || '';

  // Rate-limit
  const now = Date.now();
  RATE_LIMIT.commands = RATE_LIMIT.commands.filter(t => now - t < RATE_LIMIT.timeWindow);
  if (RATE_LIMIT.commands.length >= RATE_LIMIT.maxCommands) {
    displayLocalMessage('Slow down... Command rate limit exceeded');
    return true;
  }
  RATE_LIMIT.commands.push(now);

  // Dispatch to modular command system
  if (commands[cmd]) {
    commands[cmd].execute(socket, displayLocalMessage, arg);
  } else {
    displayLocalMessage(`Unknown command: /${cmd}`);
  }
  return true;
}
