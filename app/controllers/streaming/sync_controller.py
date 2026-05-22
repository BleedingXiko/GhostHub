"""Sync domain controller built on Specter."""

import logging
import time

from flask import request
from werkzeug.exceptions import BadRequest

from specter import Controller, registry
from app.constants import ERROR_MESSAGES, SOCKET_EVENTS as SE, SYNC_ROOM
from app.services.core import session_store, tv_store
from app.utils.auth import get_request_session_id

logger = logging.getLogger(__name__)

SESSION_STATE_EXPIRY = 3600
MAX_SESSION_STATES = 200
_VIEW_PARAM_WHITELIST = {
    'category_id',
    'subfolder',
    'media_filter',
    'sort_by',
    'sort_order',
    'query',
    'page',
    'limit',
    'include_total',
}


class SyncController(Controller):
    """Composition root for synchronous media casting."""

    name = 'sync'
    url_prefix = '/api/sync'

    @staticmethod
    def _events():
        return registry.require('sync_events')

    @staticmethod
    def _transport():
        return registry.require('socket_transport')

    def on_start(self):
        """Initialize gevent-safe store for sync state."""
        self.store = self.create_store('sync_state', {
            'enabled': False,
            'host_session_id': None,
            'current_media': {
                'category_id': None,
                'viewKey': None,
                'viewType': None,
                'viewParams': {},
                'mediaId': None,
                'timestamp': time.time(),
            },
            'playback_state': {
                'is_playing': False,
                'current_time': 0,
                'last_update': time.time(),
            },
            'session_states': {},
        })

    def build_routes(self, router):
        """Register HTTP endpoints for sync administration."""
        @router.route('/status', methods=['GET'])
        def sync_status():
            return self.get_status()

        @router.route('/toggle', methods=['POST'])
        def toggle_sync_mode():
            data = request.get_json(silent=True) or {}
            enabled = data.get('enabled')
            if enabled is None or not isinstance(enabled, bool):
                raise BadRequest("Invalid request data: 'enabled' (boolean) is required")

            return self.toggle_sync(
                enable=enabled,
                initial_media=data.get('media'),
                session_id=data.get('session_id')
            )

        @router.route('/current', methods=['GET'])
        def get_current_media_route():
            state = self.get_current_media()
            if "error" in state:
                return state, 400
            return state

        @router.route('/update', methods=['POST'])
        def update_current_media_route():
            data = request.get_json(silent=True) or {}
            media_payload = self._normalize_media_payload(data)
            success, error = self.update_current_media(media_payload)
            if not success:
                status_code = 403 if "host" in (error or "") else 400
                return {"error": error}, status_code

            session_id = request.cookies.get('session_id')
            if session_id:
                self.update_session_state(session_id, media_payload)

            return {"success": True}

    def build_events(self, handler):
        """Register Socket.IO event handlers."""
        handler.on(SE['JOIN_SYNC'], self.handle_join_sync)
        handler.on(SE['LEAVE_SYNC'], self.handle_leave_sync)
        handler.on(SE['SYNC_UPDATE'], self.handle_sync_update_ws)
        handler.on(SE['PLAYBACK_SYNC'], self.handle_playback_sync)
        handler.on(SE['UPDATE_MY_STATE'], self.handle_socket_state_update)
        handler.on(SE['REQUEST_VIEW_INFO'], self.handle_request_view_info)

    # ------------------------------------------------------------------
    # Socket Event Handlers
    # ------------------------------------------------------------------

    def _normalize_media_payload(self, data, allow_exit=False):
        """Validate and normalize view-identity sync payloads."""
        data = data or {}
        if allow_exit and (data.get('category_id') is None or data.get('mediaId') is None):
            return {
                'category_id': None,
                'viewKey': None,
                'viewType': None,
                'viewParams': {},
                'mediaId': None,
                'timestamp': time.time(),
            }

        category_id = data.get('category_id')
        media_id = data.get('mediaId')
        view_key = data.get('viewKey')
        view_type = data.get('viewType')
        view_params = data.get('viewParams') or {}

        if not isinstance(category_id, str) or not category_id.strip():
            raise BadRequest("Invalid update data: 'category_id' is required")
        if not isinstance(media_id, str) or not media_id.strip():
            raise BadRequest("Invalid update data: 'mediaId' is required")
        if view_key is not None and not isinstance(view_key, str):
            raise BadRequest("Invalid update data: 'viewKey' must be a string")
        if view_type is not None and not isinstance(view_type, str):
            raise BadRequest("Invalid update data: 'viewType' must be a string")
        if not isinstance(view_params, dict):
            raise BadRequest("Invalid update data: 'viewParams' must be an object")
        filtered_view_params = {
            key: value
            for key, value in view_params.items()
            if key in _VIEW_PARAM_WHITELIST
        }

        return {
            'category_id': category_id,
            'viewKey': view_key,
            'viewType': view_type,
            'viewParams': filtered_view_params,
            'mediaId': media_id,
            'timestamp': time.time(),
        }

    def handle_join_sync(self):
        client_id = request.sid
        session_id = get_request_session_id()
        
        if not self.is_sync_enabled():
            self._events().emit_sync_error(ERROR_MESSAGES['SYNC_NOT_ENABLED'], room=client_id)
            return {'status': 'error', 'message': ERROR_MESSAGES['SYNC_NOT_ENABLED']}

        self._transport().join_room(SYNC_ROOM, sid=client_id)
        logger.info("Client %s joined sync room.", client_id)

        current_state = self.get_current_media()
        self._events().emit_sync_state(current_state, room=client_id)
        
        self._events().emit_user_joined({'sid': client_id}, room=SYNC_ROOM, include_self=False)
        return {'status': 'ok'}

    def handle_leave_sync(self):
        client_id = request.sid
        self._transport().leave_room(SYNC_ROOM, sid=client_id)
        logger.info("Client %s left sync room.", client_id)
        self._events().emit_user_left({'sid': client_id}, room=SYNC_ROOM, include_self=False)
        return {'status': 'ok'}

    def handle_sync_update_ws(self, data):
        session_id = get_request_session_id()

        if not self.is_sync_enabled():
            return {'status': 'error', 'message': ERROR_MESSAGES['SYNC_NOT_ENABLED']}

        if session_id != self.get_host_session_id():
            return {'status': 'error', 'message': 'Only host can update sync state'}

        data = data or {}
        media_payload = self._normalize_media_payload(data, allow_exit=True)
        if media_payload.get('category_id') is None or media_payload.get('mediaId') is None:
            logger.info("Host exiting media viewer, broadcasting to all clients")
            self._events().emit_sync_state({
                'category_id': None, 'viewKey': None, 'viewType': None, 'viewParams': {}, 'mediaId': None,
                'playback_state': self.get_playback_state_for_broadcast()
            }, room=SYNC_ROOM)
            return {'status': 'ok'}

        self.update_current_media(media_payload)
        return {'status': 'ok'}

    def handle_playback_sync(self, data):
        client_id = request.sid
        session_id = get_request_session_id()

        if not self.is_sync_enabled():
            self._events().emit_sync_error('Sync mode is not active', room=client_id)
            return {'status': 'error', 'message': 'Sync mode is not active'}

        if session_id != self.get_host_session_id():
            return {'status': 'error', 'message': 'Only host can send playback sync'}

        data = data or {}
        action = data.get('action')
        current_time = data.get('currentTime', 0)
        timestamp = data.get('timestamp', time.time())
        is_playing = data.get('is_playing')

        if action not in ['play', 'pause', 'seek']:
            return {'status': 'error', 'message': 'Invalid playback action'}

        active_playing_state = is_playing if is_playing is not None else (action == 'play')
        self.update_playback_state(active_playing_state, current_time)

        relay_payload = {
            'action': action,
            'currentTime': current_time,
            'timestamp': timestamp,
        }
        if is_playing is not None:
            relay_payload['is_playing'] = is_playing
        for key in ('category_id', 'viewKey', 'viewType', 'viewParams', 'mediaId'):
            if key in data:
                relay_payload[key] = data[key]

        self._events().emit_playback_sync(relay_payload, room=SYNC_ROOM, include_self=False)
        return {'status': 'ok'}

    def handle_socket_state_update(self, data):
        """Persist a client's latest view-identity state for sync/view sharing."""
        # This event is shared with the progress controller. Progress-only
        # payloads (missing viewKey/viewType/mediaId) are valid for progress
        # persistence; silently skip view-sharing for them rather than erroring.
        client_id = request.sid
        try:
            session_id = get_request_session_id()
            is_tv = client_id == tv_store.get_tv_sid()

            if not session_id and not is_tv:
                return

            data = data or {}
            if not data.get('mediaId') or not data.get('viewKey') or not data.get('viewType'):
                return

            try:
                media_payload = self._normalize_media_payload(data)
            except BadRequest:
                return

            if session_id:
                self.update_session_state(session_id, media_payload)
        except Exception as exc:
            logger.error("Error handling state update: %s", exc)

    def handle_request_view_info(self, data):
        """Return a target session's current view state."""
        try:
            requesting_client_id = request.sid
            requesting_session_id = get_request_session_id() or 'unknown_requestor'

            if not data or 'target_session_id' not in data:
                logger.warning(
                    "Client %s (Session: %s) sent invalid request_view_info: %s",
                    requesting_client_id,
                    requesting_session_id,
                    data,
                )
                self._events().emit_view_info_response(
                    {'error': 'Invalid request. Missing target_session_id.'},
                    room=requesting_client_id,
                )
                return

            target_session_id = data['target_session_id']
            logger.info(
                "Client %s (Session: %s) requested view info for target session: %s",
                requesting_client_id,
                requesting_session_id,
                target_session_id,
            )

            target_state = self.get_session_state(target_session_id)
            if not target_state:
                logger.info("No state found for target session %s", target_session_id)
                self._events().emit_view_info_response(
                    {
                        'error': (
                            f'Could not find view information for session {target_session_id}. '
                            'User might not be active or sharing.'
                        ),
                    },
                    room=requesting_client_id,
                )
                return

            logger.info(
                "Found state for target session %s: %s",
                target_session_id,
                target_state,
            )

            if 'category_id' not in target_state or 'mediaId' not in target_state:
                logger.warning(
                    "Incomplete state for target session %s: %s",
                    target_session_id,
                    target_state,
                )
                self._events().emit_view_info_response(
                    {
                        'error': (
                            f'View information for session {target_session_id} is incomplete.'
                        ),
                    },
                    room=requesting_client_id,
                )
                return

            self._events().emit_view_info_response(
                {
                    'category_id': target_state.get('category_id'),
                    'viewKey': target_state.get('viewKey'),
                    'viewType': target_state.get('viewType'),
                    'viewParams': target_state.get('viewParams') or {},
                    'mediaId': target_state.get('mediaId'),
                    'target_session_id': target_session_id,
                },
                room=requesting_client_id,
            )
        except Exception as exc:
            logger.error("Error handling request_view_info: %s", exc)
            try:
                self._events().emit_view_info_response(
                    {'error': 'Server error processing your request.'},
                    room=requesting_client_id,
                )
            except Exception:
                logger.debug("Failed to emit error to client")

    # ------------------------------------------------------------------
    # Core Service Logic
    # ------------------------------------------------------------------

    def get_status(self):
        state = self.store.get()
        session_id = get_request_session_id()
        is_host = state['enabled'] and session_id == state['host_session_id']
        return {"active": state['enabled'], "is_host": is_host}

    def toggle_sync(self, enable, initial_media=None, session_id=None):
        if not session_id:
            session_id = get_request_session_id()
        elif session_id.startswith('"'):
            session_id = session_id[1:-1]

        if not session_id:
            logger.error("Cannot toggle sync mode: Session ID missing.")
            return self.get_status()

        action = {'type': None, 'data': None}

        def _toggle(draft):
            host_session_id = draft['host_session_id']
            host_active = False
            if host_session_id:
                host_active = session_store.get_connection(host_session_id) is not None

            should_initialize = False
            if enable:
                if not draft['enabled'] or not host_active or host_session_id == session_id:
                    should_initialize = True

            if should_initialize:
                draft['enabled'] = True
                draft['host_session_id'] = session_id

                if initial_media:
                    try:
                        draft['current_media'] = self._normalize_media_payload(initial_media)
                    except BadRequest:
                        draft['current_media'] = {
                            "category_id": None,
                            "viewKey": None,
                            "viewType": None,
                            "viewParams": {},
                            "mediaId": None,
                            "timestamp": time.time(),
                        }
                else:
                    draft['current_media'] = {
                        "category_id": None, "viewKey": None, "viewType": None, "viewParams": {}, "mediaId": None, "timestamp": time.time()
                    }

                action['type'] = 'enabled'
                action['data'] = {
                    "active": True,
                    "host_session_id": session_id,
                    "media": draft['current_media'].copy(),
                }

            elif not enable and draft['enabled']:
                if session_id != host_session_id:
                    action['type'] = 'early_return'
                    return

                draft['enabled'] = False
                draft['host_session_id'] = None
                draft['current_media'] = {
                    "category_id": None, "viewKey": None, "viewType": None, "viewParams": {}, "mediaId": None, "timestamp": time.time()
                }
                draft['session_states'].clear()
                action['type'] = 'disabled'

        self.store.update(_toggle)

        if action['type'] == 'early_return':
            return self.get_status()
        elif action['type'] == 'enabled':
            self._events().emit_sync_enabled(action['data'])
        elif action['type'] == 'disabled':
            self._events().emit_sync_disabled({"active": False})

        return self.get_status()

    def get_current_media(self):
        state = self.store.get()
        if not state['enabled']:
            return {"error": "Sync mode not enabled"}
        
        result = state['current_media'].copy()
        result["playback_state"] = state['playback_state'].copy()
        return result

    def update_playback_state(self, is_playing, current_time):
        session_id = get_request_session_id()
        result = [False]

        def _update(draft):
            if not draft['enabled'] or session_id != draft['host_session_id']:
                return
            draft['playback_state'] = {
                "is_playing": is_playing,
                "current_time": current_time,
                "last_update": time.time(),
            }
            result[0] = True

        self.store.update(_update)
        return result[0]

    def update_current_media(self, media_payload):
        session_id = get_request_session_id()
        result = {'ok': False, 'error': None, 'emit': None}

        def _update(draft):
            if not draft['enabled']:
                result['error'] = "Sync mode not enabled"
                return
            if session_id != draft['host_session_id']:
                result['error'] = "Only the host can update the current media"
                return

            draft['current_media'] = {
                **media_payload,
                "timestamp": time.time(),
            }
            result['ok'] = True
            result['emit'] = draft['current_media'].copy()

        self.store.update(_update)

        if result['error']:
            return False, result['error']
        if result['emit']:
            self._events().emit_sync_state(result['emit'], room=SYNC_ROOM)
        return True, None

    def is_sync_enabled(self):
        return self.store.get()['enabled']

    def get_host_session_id(self):
        return self.store.get()['host_session_id']

    def update_session_state(self, session_id, media_payload):
        if not session_id:
            return False

        def _update(draft):
            self._prune_session_states_locked(draft)

            draft['session_states'][session_id] = {
                "category_id": media_payload.get('category_id'),
                "viewKey": media_payload.get('viewKey'),
                "viewType": media_payload.get('viewType'),
                "viewParams": media_payload.get('viewParams') or {},
                "mediaId": media_payload.get('mediaId'),
                "timestamp": time.time(),
            }

        self.store.update(_update)
        return True

    def get_session_state(self, session_id_or_prefix):
        result = [None]

        def _update(draft):
            self._prune_session_states_locked(draft)

            # Exact session ID match
            s = draft['session_states'].get(session_id_or_prefix)
            if s:
                result[0] = s.copy()
                return

            # Prefix match on session IDs
            if len(session_id_or_prefix) < 16:
                for full_id, sd in draft['session_states'].items():
                    if full_id.startswith(session_id_or_prefix):
                        resolved = sd.copy()
                        resolved['resolved_session_id'] = full_id
                        result[0] = resolved
                        return

            # Profile name / user_id resolution — look up the active
            # connection that matches the given name, then check if that
            # session has a stored view state.
            resolved_sid, _ = session_store.find_connection_by_user_id(
                session_id_or_prefix,
            )
            if resolved_sid:
                s = draft['session_states'].get(resolved_sid)
                if s:
                    resolved = s.copy()
                    resolved['resolved_session_id'] = resolved_sid
                    result[0] = resolved

        self.store.update(_update)
        return result[0]

    def remove_session_state(self, session_id):
        def _update(draft):
            if session_id in draft['session_states']:
                del draft['session_states'][session_id]

        self.store.update(_update)

    def get_playback_state_for_broadcast(self):
        return self.store.get()['playback_state'].copy()

    # ------------------------------------------------------------------
    # Garbage Collection Helpers
    # ------------------------------------------------------------------

    def _prune_session_states_locked(self, state, now=None):
        if now is None:
            now = time.time()

        stale = [sid for sid, sd in state['session_states'].items() if now - sd.get('timestamp', 0) > SESSION_STATE_EXPIRY]
        for sid in stale:
            del state['session_states'][sid]

        while len(state['session_states']) > MAX_SESSION_STATES:
            oldest = min(state['session_states'].items(), key=lambda x: x[1].get('timestamp', 0))[0]
            del state['session_states'][oldest]
