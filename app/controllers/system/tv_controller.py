"""TV casting/runtime controller built on Specter."""

import logging
from flask import request

from app.constants import TV_EVENTS
from specter import Controller, registry
from app.utils.auth import get_request_session_id, is_current_admin_session_with_flag_sync

logger = logging.getLogger(__name__)


class TVController(Controller):
    """Own TV connect/cast/control/report socket ingress."""

    name = 'tv'

    @staticmethod
    def _events():
        return registry.require('tv_events')

    @staticmethod
    def _transport():
        return registry.require('socket_transport')

    @staticmethod
    def _cast():
        return registry.require('tv_cast_service')

    def build_events(self, handler):
        handler.on(TV_EVENTS['TV_CONNECTED'], self.handle_tv_connected)
        handler.on(TV_EVENTS['REQUEST_TV_STATUS'], self.handle_request_tv_status)
        handler.on(TV_EVENTS['CAST_MEDIA_TO_TV'], self.handle_cast_media_to_tv)
        handler.on(TV_EVENTS['TV_PLAYBACK_CONTROL'], self.handle_tv_playback_control)
        handler.on(TV_EVENTS['TV_REPORT_STATE'], self.handle_tv_report_state)
        handler.on(TV_EVENTS['TV_ADD_SUBTITLE'], self.handle_tv_add_subtitle)
        handler.on(TV_EVENTS['TV_STOP_CASTING'], self.handle_tv_stop_casting)

    def get_connection_status_payload(self):
        """Build the current TV/cast status payload for a newly connected client."""
        return self._cast().get_connection_status_payload()

    def handle_tv_disconnect(self, client_id):
        """Clear or preserve TV cast state when the TV display disconnects."""
        return self._cast().handle_tv_disconnect(client_id)

    def handle_tv_connected(self):
        """Register the TV client and replay any active cast."""
        return self._cast().handle_tv_connected(request.sid)

    def handle_request_tv_status(self):
        """Return the current TV/cast status to the requesting client."""
        return self._cast().handle_request_tv_status(request.sid)

    def handle_cast_media_to_tv(self, data):
        """Start or queue a TV cast request."""
        return self._cast().start_cast(
            request.sid,
            get_request_session_id(),
            is_current_admin_session_with_flag_sync(),
            data,
        )

    def handle_tv_playback_control(self, data):
        """Relay playback controls to the TV runtime."""
        return self._cast().relay_playback_control(
            request.sid,
            is_current_admin_session_with_flag_sync(),
            data,
        )

    def handle_tv_report_state(self, data):
        """Update server-side TV state and broadcast it to other clients."""
        return self._cast().report_tv_state(request.sid, data)

    def handle_tv_add_subtitle(self, data):
        """Relay a subtitle track to the TV runtime."""
        return self._cast().add_subtitle(request.sid, data)

    def handle_tv_stop_casting(self, data=None):
        """Stop the current cast and clear server-side cast state."""
        return self._cast().stop_cast(
            request.sid,
            get_request_session_id(),
            is_current_admin_session_with_flag_sync(),
            data,
        )
