/**
 * Kick Command Module
 * Allows administrators to kick users from the session and temporarily block their IP.
 */

// Define necessary socket event names locally.
// Ideally, these would come from a shared JS constants module or be passed from the backend.
const KICK_COMMAND_SOCKET_EVENTS = {
    ADMIN_KICK_USER: 'admin_kick_user'
    // ADMIN_KICK_CONFIRMATION is handled in main.js
    // YOU_HAVE_BEEN_KICKED is handled in main.js
};


/**
 * Executes the /kick command.
 * @param {object} socket - The socket.io instance.
 * @param {function} displayLocalMessage - Function to display messages locally in chat.
 * @param {string} args - Arguments passed to the command (e.g., target_user_id).
 */
export async function execute(socket, displayLocalMessage, args) {
    if (!args || args.trim() === '') {
        displayLocalMessage('Usage: /kick <user_id>');
        displayLocalMessage('Hint: user_id is usually the first 8 characters of a session ID, often seen in chat.');
        return;
    }

    const target_user_id = args.trim();

    if (target_user_id.length !== 8) {
        // Basic validation, could be more robust depending on actual user_id format
        displayLocalMessage('Error: Invalid user_id format. It should typically be 8 characters long.');
        return;
    }

    // Client-side admin check
    try {
        const response = await fetch('/api/admin/status');
        if (!response.ok) {
            displayLocalMessage('Error: Could not verify admin status. Please try again.');
            console.error('Failed to fetch admin status:', response.status);
            return;
        }
        const adminStatus = await response.json();

        if (!adminStatus.isAdmin) {
            displayLocalMessage('Error: This command is for administrators only.');
            return;
        }

        // If admin, proceed to emit the kick event
        displayLocalMessage(`Attempting to kick user: ${target_user_id}...`);
        socket.emit(KICK_COMMAND_SOCKET_EVENTS.ADMIN_KICK_USER, { target_user_id: target_user_id });

    } catch (error) {
        displayLocalMessage('Error: Failed to check admin status or send kick command. See console for details.');
        console.error('Error during kick command execution:', error);
    }
}

/**
 * Gets the help text for the /kick command.
 * @returns {string} The help text.
 */
export function getHelpText() {
    return '/kick <user_id>: Kicks a user and blocks their IP for the current session (Admin only).';
}
