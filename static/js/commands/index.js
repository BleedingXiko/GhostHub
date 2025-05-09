/**
 * Commands Index Module
 * Exports all available commands for easy registration
 */

import * as myviewCommand from './myview.js';
import * as helpCommand from './help.js';
import * as viewCommand from './view.js';

// Export all commands with their names as keys
export const commands = {
  myview: myviewCommand,
  help: helpCommand,
  view: viewCommand
};

// Export a function to get all help text
export function getAllHelpText() {
  return Object.values(commands)
    .map(cmd => cmd.getHelpText())
    .join('\n');
}
