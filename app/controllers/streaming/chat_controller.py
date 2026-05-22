"""Chat realtime domain controller built on Specter."""

import logging
import os
from urllib.parse import unquote

from flask import request

from app.constants import CHAT_ROOM, SOCKET_EVENTS as SE
from app.services.core import session_store
from specter import Controller, registry
from app.utils.auth import get_request_session_id

logger = logging.getLogger(__name__)


class ChatController(Controller):
    """Own shared chat and command-sharing socket ingress."""

    name = 'chat'

    @staticmethod
    def _events():
        return registry.require('chat_events')

    @staticmethod
    def _transport():
        return registry.require('socket_transport')

    def build_events(self, handler):
        handler.on(SE['JOIN_CHAT'], self.handle_join_chat)
        handler.on(SE['REJOIN_CHAT'], self.handle_rejoin_chat)
        handler.on(SE['LEAVE_CHAT'], self.handle_leave_chat)
        handler.on(SE['CHAT_MESSAGE'], self.handle_chat_message)
        handler.on(SE['COMMAND'], self.handle_command)

    def handle_join_chat(self):
        """Join the shared chat room."""
        try:
            client_id = request.sid
            session_id = get_request_session_id()
            logger.info(
                "Client %s (Session: %s) joined chat room.",
                client_id,
                session_id,
            )
            self._transport().join_room(CHAT_ROOM, sid=client_id)
            self._events().emit_notification(
                {
                    'type': 'join',
                    'message': 'A new user joined the chat',
                },
                room=CHAT_ROOM,
                include_self=False,
            )
        except Exception as exc:
            logger.error("Error during join_chat: %s", exc)

    def handle_rejoin_chat(self):
        """Rejoin the chat room after a page refresh."""
        try:
            client_id = request.sid
            session_id = get_request_session_id()
            logger.info(
                "Client %s (Session: %s) rejoined chat room after refresh.",
                client_id,
                session_id,
            )
            self._transport().join_room(CHAT_ROOM, sid=client_id)
        except Exception as exc:
            logger.error("Error during rejoin_chat: %s", exc)

    def handle_leave_chat(self):
        """Leave the shared chat room."""
        try:
            client_id = request.sid
            logger.info("Client %s left chat room.", client_id)
            self._transport().leave_room(CHAT_ROOM, sid=client_id)
            self._events().emit_notification(
                {
                    'type': 'leave',
                    'message': 'A user left the chat',
                },
                room=CHAT_ROOM,
                include_self=False,
            )
        except Exception as exc:
            logger.error("Error during leave_chat: %s", exc)

    def handle_chat_message(self, data):
        """Broadcast a chat message to the shared room."""
        try:
            if not data or 'message' not in data or not data['message'].strip():
                return

            client_id = request.sid
            session_id = get_request_session_id() or 'unknown'
            user_id = self._resolve_user_id(session_id)
            message_data = {
                'user_id': user_id,
                'message': data['message'].strip(),
                'timestamp': data.get('timestamp'),
            }

            logger.info(
                "Chat message from %s (client %s): %s",
                user_id,
                client_id,
                message_data['message'],
            )
            self._events().emit_message(message_data, room=CHAT_ROOM)
        except Exception as exc:
            logger.error("Error handling chat message: %s", exc)
            try:
                self._events().emit_error('Failed to send message', room=client_id)
            except Exception:
                logger.debug("Failed to emit chat error to client")

    def handle_command(self, data):
        """Broadcast supported slash commands."""
        try:
            if not data or 'cmd' not in data:
                return

            client_id = request.sid
            session_id = get_request_session_id() or 'unknown'

            if data['cmd'] != 'myview':
                logger.warning("Unsupported command type: %s", data['cmd'])
                return

            if 'arg' not in data or 'from' not in data:
                logger.warning(
                    "Invalid command data from %s: missing required fields",
                    client_id,
                )
                return

            if (
                not isinstance(data['arg'], dict) or
                'category_id' not in data['arg'] or
                'mediaId' not in data['arg']
            ):
                logger.warning(
                    "Invalid myview command data from %s: missing category_id "
                    "or mediaId",
                    client_id,
                )
                return

            sender_state = registry.require('sync').get_session_state(session_id) or {}
            view_payload = {
                'category_id': sender_state.get('category_id') or data['arg'].get('category_id'),
                'viewKey': sender_state.get('viewKey') or data['arg'].get('viewKey'),
                'viewType': sender_state.get('viewType') or data['arg'].get('viewType'),
                'viewParams': sender_state.get('viewParams') or data['arg'].get('viewParams') or {},
                'mediaId': sender_state.get('mediaId') or data['arg'].get('mediaId'),
            }

            from app.services.media.hidden_content_service import should_block_category_access

            category_id = view_payload['category_id']
            if should_block_category_access(category_id, show_hidden=False):
                logger.warning(
                    "Blocked /myview for hidden category %s from %s",
                    category_id,
                    session_id,
                )
                self._events().emit_error(
                    'Cannot share view of hidden categories',
                    room=request.sid,
                )
                return

            user_id = self._resolve_user_id(session_id)
            data['from'] = user_id

            data['arg'].update(view_payload)

            logger.info(
                "Command from %s (session %s, client %s): %s with args: %s",
                user_id,
                session_id,
                client_id,
                data['cmd'],
                data['arg'],
            )

            try:
                media_id = data['arg'].get('mediaId') or ''
                # mediaId is "<category_id>::<rel_path>", but category_id itself
                # can contain '::' (e.g. "auto::Movies::Action"). Strip the known
                # category prefix instead of splitting on the first delimiter.
                rel_path = None
                if category_id and media_id.startswith(f"{category_id}::"):
                    rel_path = media_id[len(category_id) + 2:]
                elif '::' in media_id:
                    rel_path = media_id.split('::', 1)[1]
                rel_path = unquote(rel_path) if rel_path else None
                filename = os.path.basename(rel_path) if rel_path else None

                from app.utils.media_utils import get_thumbnail_url

                thumbnail_url = (
                    get_thumbnail_url(category_id, rel_path)
                    if rel_path else None
                )
                data['arg']['filename'] = filename
                data['arg']['thumbnail_url'] = thumbnail_url
                logger.info(
                    "Added filename '%s' and thumbnail to /myview broadcast",
                    filename,
                )
            except Exception as exc:
                logger.warning(
                    "Could not extract filename/thumbnail from mediaId: %s",
                    exc,
                )

            self._events().emit_command(data, room=CHAT_ROOM, include_self=True)
        except Exception as exc:
            logger.error("Error handling command: %s", exc)
            try:
                self._events().emit_error('Failed to process command', room=client_id)
            except Exception:
                logger.debug("Failed to emit command error to client")

    def _resolve_user_id(self, session_id):
        if not session_id:
            return 'unknown'

        connection = session_store.get_connection(session_id)
        if connection and connection.get('user_id'):
            return connection['user_id']

        return session_id[:8]
