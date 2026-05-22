/**
 * Show Hidden Manager
 * -------------------
 * Manages the show_hidden flag using sessionStorage for tab-scoped persistence.
 *
 * sessionStorage clears when the tab is closed (not on page refresh),
 * providing the desired "temporary reveal" behavior for hidden categories.
 */

import { bus } from '../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../core/appEvents.js';
import { isUserAdmin } from './progressDB.js';

function bumpStreamingVisibilityEpoch() {
  // Invalidate the mediaOrdering cache synchronously first — its entries cache
  // orderedIds + viewMeta.subfolders that were computed under the prior
  // show_hidden flag. Without this, requestOrder() short-circuits on
  // status==='ready' and returns the stale order without re-fetching, so
  // newly-revealed (or newly-hidden) subfolder cards never appear after a toggle.
  try {
    window.ragotModules?.mediaOrdering?.invalidateAllViews?.();
  } catch (_) { /* best-effort */ }

  return import('../modules/layouts/streaming/state.js')
    .then(m => m.bumpVisibilityEpoch?.())
    .catch(() => {});
}

/**
 * Check if show_hidden flag is enabled in sessionStorage.
 * @returns {boolean} True if flag is set, false otherwise
 */
export function isShowHiddenEnabled() {
  if (!isUserAdmin()) {
    return false;
  }
  return sessionStorage.getItem('show_hidden') === 'true';
}

/**
 * Enable show_hidden flag in sessionStorage.
 * This will persist across page refreshes within the same tab.
 */
export function enableShowHidden() {
  if (!isUserAdmin()) {
    return;
  }
  if (sessionStorage.getItem('show_hidden') === 'true') {
    return;
  }
  sessionStorage.setItem('show_hidden', 'true');
  bus.emit(APP_EVENTS.SHOW_HIDDEN_TOGGLED, { showHidden: true });
  return bumpStreamingVisibilityEpoch();
}

/**
 * Disable show_hidden flag by removing it from sessionStorage.
 */
export function disableShowHidden() {
  if (sessionStorage.getItem('show_hidden') !== 'true') {
    return;
  }
  sessionStorage.removeItem('show_hidden');
  bus.emit(APP_EVENTS.SHOW_HIDDEN_TOGGLED, { showHidden: false });
  return bumpStreamingVisibilityEpoch();
}

/**
 * Get HTTP headers object to include with fetch requests.
 * Includes X-Show-Hidden header if the flag is enabled.
 *
 * @returns {Object} Headers object to spread into fetch options
 *
 * @example
 * const response = await fetch('/api/categories', {
 *   headers: {
 *     'Content-Type': 'application/json',
 *     ...getShowHiddenHeaders()
 *   }
 * });
 */
export function getShowHiddenHeaders() {
  if (isShowHiddenEnabled()) {
    return { 'X-Show-Hidden': 'true' };
  }
  return {};
}

/**
 * Append show_hidden query param to a URL if show_hidden is enabled.
 * Use this for img src URLs which can't send custom headers.
 *
 * @param {string} url - The URL to modify
 * @returns {string} URL with ?show_hidden=true appended if enabled
 */
export function appendShowHiddenParam(url) {
  if (!url || !isShowHiddenEnabled()) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}show_hidden=true`;
}
/**
 * Check server status for hidden content and sync local state.
 * @returns {Promise<boolean>} True if hidden content is active.
 */
export async function checkRevealHiddenStatus() {
  try {
    const response = await fetch('/api/admin/categories/show-status', {
      credentials: 'include'
    });

    if (!response.ok) {
      disableShowHidden();
      return false;
    }

    const data = await response.json();

    if (data.active) {
      await enableShowHidden();
      return true;
    } else {
      await disableShowHidden();
      return false;
    }
  } catch (error) {
    console.error('Error checking reveal hidden status:', error);
    disableShowHidden();
    return false;
  }
}

/**
 * Sync show-hidden state from a category_updated socket event.
 * Trusts the event's show_hidden flag when present to avoid a race-condition
 * round-trip to the server that can revert visibility state incorrectly.
 * @param {Object} data - category_updated event payload
 */
export async function syncShowHiddenFromEvent(data) {
  try {
    if (data.reason === 'show_hidden_enabled' && data.show_hidden === true) {
      await enableShowHidden();
    } else if (data.reason === 'show_hidden_disabled' && data.show_hidden === false) {
      await disableShowHidden();
    } else if (data.reason === 'category_hidden' || data.reason === 'category_unhidden') {
      await checkRevealHiddenStatus();
    }
  } catch (err) {
    console.warn('[ShowHidden] Failed to sync from event:', err);
  }
}
