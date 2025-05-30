/**
 * Commands Index Module
 * Exports all available commands for easy registration
 */

import * as helpCommand from './help.js';
import * as myviewCommand from './myview.js';
import * as viewCommand from './view.js';
import * as randomCommand from './random.js';
import * as kickCommand from './kick.js';

// Export all commands with their names as keys
export const commands = {
  help: helpCommand.help,
  myview: myviewCommand.myview,
  view: viewCommand.view,
  random: randomCommand.random,
  kick: kickCommand // Assuming kick.js exports execute and getHelpText directly
};

// Export a function to get all help text
export function getAllHelpText() {
  return Object.values(commands)
    .map(cmd => cmd.getHelpText())
    .join('\n');
}
