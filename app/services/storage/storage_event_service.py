"""Storage event service for Socket.IO broadcasts."""

import logging

from app.constants import SOCKET_EVENTS
from specter import Service, registry

logger = logging.getLogger(__name__)


class StorageEventService(Service):
    """Own storage broadcasts that are not library/media invalidations."""

    def __init__(self):
        super().__init__('storage_events')

    def emit_usb_mounts_changed(self, payload=None, **kwargs):
        return self._emit(SOCKET_EVENTS['USB_MOUNTS_CHANGED'], payload or {}, **kwargs)

    @staticmethod
    def _socket_transport():
        return registry.require('socket_transport')

    def _emit(self, event_name, payload, **kwargs):
        return self._socket_transport().emit(event_name, payload, **kwargs)
