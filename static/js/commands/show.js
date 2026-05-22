/**
 * Show Command Module
 * Handles the /show command which temporarily reveals hidden categories (admin-only, session-only)
 */

import { isUserAdmin } from '../utils/progressDB.js';
import { enableShowHidden, disableShowHidden } from '../utils/showHiddenManager.js';
import { refreshAllLayouts } from '../utils/liveVisibility.js';

// Track the expiry timer so we can clear it if /show is called again
let showExpiryTimer = null;

async function executeShow(socket, displayLocalMessage, arg) {
  // Check if admin
  if (!isUserAdmin()) {
    displayLocalMessage('Admin only.', { icon: 'stop' });
    return;
  }

  try {
    // Parse optional time argument (e.g., "2h", "30m", "90s")
    let durationSeconds = 3600; // Default 1 hour
    if (arg) {
      const match = arg.trim().match(/^(\d+)([hms])$/);
      if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        if (unit === 'h') durationSeconds = value * 3600;
        else if (unit === 'm') durationSeconds = value * 60;
        else durationSeconds = value;
      } else {
        displayLocalMessage('Invalid time format (e.g. 1h, 30m, 90s).', { icon: 'x' });
        return;
      }
    }

    // Call API to enable show_hidden session flag
    const response = await fetch('/api/admin/categories/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ duration: durationSeconds })
    });

    const result = await response.json();

    if (response.ok && result.success) {
      enableShowHidden();
      displayLocalMessage(result.message, { icon: 'checkCircle' });

      // Clear any existing expiry timer
      if (showExpiryTimer) {
        clearTimeout(showExpiryTimer);
        showExpiryTimer = null;
      }

      // Set timer to refresh layout when /show expires
      showExpiryTimer = setTimeout(async () => {
        disableShowHidden();
        await refreshAllLayouts();
        showExpiryTimer = null;
      }, (durationSeconds + 2) * 1000);
    } else {
      displayLocalMessage(result.error || 'Failed to show.', { icon: 'x' });
    }
  } catch (error) {
    console.error('Error showing hidden categories:', error);
    displayLocalMessage('Failed to show.', { icon: 'x' });
  }
}

function getShowHelpText() {
  return '• /show [time]      Reveal hidden categories temporarily (admin-only). Optional time: 1h, 30m, 90s';
}

// Export the command object
export const show = {
  description: "Temporarily reveal hidden categories for this session only (admin-only)",
  execute: executeShow,
  getHelpText: getShowHelpText
};
