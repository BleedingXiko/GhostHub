"""
TV runtime state store — Specter-owned replacement for current_app globals.

Replaces:
    - current_app.tv_display_sid
    - current_app.tv_playback_state
    - current_app.kiosk_boot_pending

All access is gevent-safe via the Store's built-in BoundedSemaphore.
"""

import logging

from specter import create_store

logger = logging.getLogger(__name__)


tv_store = create_store('tv', {
    'tv_display_sid': None,
    'playback_state': None,
    'kiosk_boot_pending': None,
})


# ---------------------------------------------------------------------------
# TV SID
# ---------------------------------------------------------------------------

def get_tv_sid():
    """Return the Socket.IO SID of the connected TV display, or None."""
    return tv_store.get('tv_display_sid')


def set_tv_sid(sid):
    """Register a TV display client SID."""
    tv_store.set({'tv_display_sid': sid})


def clear_tv_sid():
    """Clear the TV display client SID (TV disconnected)."""
    tv_store.set({'tv_display_sid': None})


# ---------------------------------------------------------------------------
# Playback state
# ---------------------------------------------------------------------------

def get_playback_state():
    """Return the current TV playback state dict, or None."""
    return tv_store.get('playback_state')


def set_playback_state(state):
    """Replace the TV playback state entirely."""
    tv_store.set({'playback_state': dict(state) if state else None})


def update_playback_state(partial):
    """Shallow-merge into the existing playback state."""
    def _merge(draft):
        current = draft.get('playback_state')
        if current is None:
            return
        current.update(partial)
    tv_store.update(_merge)


def clear_playback_state():
    """Clear the TV playback state (cast stopped)."""
    tv_store.set({'playback_state': None})


# ---------------------------------------------------------------------------
# Casting helpers
# ---------------------------------------------------------------------------

def is_casting():
    """Return True if there is an active cast."""
    state = tv_store.get('playback_state')
    return bool(
        state and (
            state.get('category_id') is not None
            or state.get('media_path')
            or state.get('media_type')
        )
    )


def build_casting_info(state=None):
    """Build a casting info dict suitable for client broadcast."""
    if state is None:
        state = tv_store.get('playback_state')
    if not state:
        return None
    return {
        'viewKey': state.get('viewKey'),
        'viewType': state.get('viewType'),
        'viewParams': state.get('viewParams') or {},
        'mediaId': state.get('mediaId'),
        'category_id': state.get('category_id'),
        'media_path': state.get('media_path'),
        'media_type': state.get('media_type'),
        'thumbnail_url': state.get('thumbnail_url'),
        'current_time': state.get('current_time', 0),
        'duration': state.get('duration', 0),
        'paused': state.get('paused', False),
        'is_guest_cast': state.get('is_guest_cast', True),
    }


# ---------------------------------------------------------------------------
# Kiosk boot
# ---------------------------------------------------------------------------

def get_kiosk_boot():
    """Return the pending kiosk boot dict, or None."""
    return tv_store.get('kiosk_boot_pending')


def set_kiosk_boot(data):
    """Set the pending kiosk boot request."""
    tv_store.set({'kiosk_boot_pending': dict(data) if data else None})


def clear_kiosk_boot():
    """Clear the pending kiosk boot request."""
    tv_store.set({'kiosk_boot_pending': None})
