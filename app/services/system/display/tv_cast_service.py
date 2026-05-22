"""TV cast/session ownership for the display subsystem."""

import logging
import math
import os
import time
from logging.handlers import RotatingFileHandler
from urllib.parse import unquote

from app.services.core import session_store, tv_store
from app.services.core.runtime_config_service import get_runtime_instance_path
from app.services.media import media_path_service
from specter import Service, registry

logger = logging.getLogger(__name__)

KIOSK_BOOT_TIMEOUT = 15


def _coerce_bool(value):
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ('1', 'true', 'yes', 'on'):
            return True
        if normalized in ('0', 'false', 'no', 'off', ''):
            return False
    return bool(value)


def _coerce_non_negative_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


class TVCastService(Service):
    """Own TV display connection, cast session, and playback-state coordination."""

    def __init__(self):
        super().__init__('tv_cast_service')
        self._tv_logger = None

    @staticmethod
    def _events():
        return registry.require('tv_events')

    @staticmethod
    def _transport():
        return registry.require('socket_transport')

    @staticmethod
    def _hdmi():
        return registry.require('hdmi_runtime_service')

    @staticmethod
    def _progress():
        return registry.require('progress')

    def get_connection_status_payload(self):
        """Build the current TV/cast status payload for a newly connected client."""
        tv_sid = tv_store.get_tv_sid()
        state = tv_store.get_playback_state()
        is_casting = tv_store.is_casting()
        casting_info = tv_store.build_casting_info(state) if is_casting else None
        hdmi_status = self._hdmi().get_status()

        payload = {
            'connected': bool(tv_sid),
            'tv_sid': tv_sid,
            'is_casting': is_casting,
            'hdmi_connected': hdmi_status['hdmi_connected'],
            'kiosk_running': hdmi_status['kiosk_running'],
        }
        if casting_info:
            payload['casting_info'] = casting_info
        return payload

    def handle_tv_disconnect(self, client_id):
        """Clear or preserve TV cast state when the TV display disconnects."""
        if client_id != tv_store.get_tv_sid():
            return False

        tv_store.clear_tv_sid()
        logger.info("TV Display client %s disconnected.", client_id)

        if self._hdmi().casting_active:
            logger.info("TV disconnected but casting still active - preserving state for reconnect")
            self._events().emit_status_update(
                {
                    'connected': False,
                    'is_casting': True,
                    'kiosk_restarting': True,
                },
                skip_sid=client_id,
            )
        else:
            logger.info("TV disconnected and casting stopped - clearing state")
            tv_store.clear_playback_state()
            self._events().emit_status_update(
                {'connected': False, 'is_casting': False},
                skip_sid=client_id,
            )
        return True

    def handle_tv_connected(self, client_id):
        """Register the TV client and replay any active cast."""
        tv_logger = self._get_tv_logger()
        current_tv = tv_store.get_tv_sid()
        if current_tv and current_tv != client_id:
            logger.warning(
                "A new TV client %s tried to connect while TV %s is already active. Disconnecting new TV.",
                client_id,
                current_tv,
            )
            self._events().emit_error('Another TV is already connected.', room=client_id)
            self._transport().disconnect(client_id)
            return

        tv_store.set_tv_sid(client_id)
        logger.info("TV Display client connected: %s. Broadcasting status.", client_id)
        tv_logger.info("tv_connected sid=%s", client_id)

        boot_pending = tv_store.get_kiosk_boot()
        if boot_pending:
            requester_sid = boot_pending.get('requester_sid')
            if requester_sid:
                self._events().emit_kiosk_boot_complete(
                    {'message': 'Kiosk ready! Starting playback...'},
                    room=requester_sid,
                )
                logger.info("Kiosk boot complete notification sent to %s", requester_sid)
            tv_store.clear_kiosk_boot()

        state = tv_store.get_playback_state()
        is_casting = tv_store.is_casting()
        status_update = {
            'connected': True,
            'tv_sid': client_id,
            'is_casting': is_casting,
        }
        if is_casting:
            status_update['casting_info'] = tv_store.build_casting_info(state)

        self._events().emit_status_update(status_update, skip_sid=client_id)
        self._events().emit_status_update(status_update, room=client_id)

        if not state or not state.get('media_path') or not state.get('media_type'):
            if state and (not state.get('media_path') or not state.get('media_type')):
                logger.warning("Pending cast state exists but missing required fields: %s", state)
            return

        logger.info("Sending pending cast to newly connected TV: %s", state['media_path'])
        tv_payload = {
            'media_type': state.get('media_type', 'video'),
            'media_path': state['media_path'],
            'loop': state.get('loop', True),
            'viewKey': state.get('viewKey'),
            'viewType': state.get('viewType'),
            'viewParams': state.get('viewParams') or {},
            'mediaId': state.get('mediaId'),
            'category_id': state.get('category_id'),
            'thumbnail_url': state.get('thumbnail_url'),
            'start_time': state.get('current_time', 0),
            'duration': state.get('duration', 0),
            'is_guest_cast': state.get('is_guest_cast', True),
        }
        if state.get('media_local_path'):
            tv_payload['media_local_path'] = state.get('media_local_path')
        if state.get('subtitle_url'):
            tv_payload['subtitle_url'] = state['subtitle_url']
            tv_payload['subtitle_label'] = state.get('subtitle_label', 'Subtitle')
            logger.info("Including subtitle with pending cast: %s", state.get('subtitle_label'))

        self._events().emit_display_media(tv_payload, room=client_id)
        self._events().emit_request_state(room=client_id)

    def handle_request_tv_status(self, client_id):
        """Return the current TV/cast status to the requesting client."""
        tv_logger = self._get_tv_logger()
        state = tv_store.get_playback_state()
        is_casting = tv_store.is_casting()
        tv_sid = tv_store.get_tv_sid()

        if not tv_sid:
            logger.info("Client %s requested TV status. No TV connected.", client_id)
            tv_logger.info("request_tv_status sid=%s connected=False casting=False", client_id)
            self._events().emit_status_update(
                {'connected': False, 'is_casting': False},
                room=client_id,
            )
            return

        response = {
            'connected': True,
            'tv_sid': tv_sid,
            'is_casting': is_casting,
        }
        if is_casting:
            response['casting_info'] = tv_store.build_casting_info(state)

        tv_logger.info(
            "request_tv_status sid=%s connected=True casting=%s",
            client_id,
            is_casting,
        )
        logger.info("Client %s requested TV status. TV connected, casting: %s", client_id, is_casting)
        self._events().emit_status_update(response, room=client_id)

    def start_cast(self, client_id, session_id, is_admin, data):
        """Start or queue a TV cast request."""
        data = data or {}
        tv_logger = self._get_tv_logger()
        logger.info(
            "Client %s (session: %s) requested to cast media to TV: %s",
            client_id,
            session_id,
            data,
        )
        tv_logger.info(
            "cast_media_to_tv sid=%s session=%s data_keys=%s",
            client_id,
            session_id[:8] if session_id else 'N/A',
            list(data.keys()),
        )

        media_type = data.get('media_type', 'video')
        media_path = data.get('media_path', '')
        media_id = data.get('mediaId')
        view_params = data.get('viewParams') if isinstance(data.get('viewParams'), dict) else {}
        loop = data.get('loop', True)
        start_time = data.get('start_time', 0)
        duration = data.get('duration', 0)
        try:
            duration = float(duration) if duration is not None else 0
        except (ValueError, TypeError):
            duration = 0

        is_guest_cast = not is_admin
        logger.info("[Cast] Initiating %s cast. Session: %s", 'Admin' if is_admin else 'Guest', session_id[:8] if session_id else 'N/A')
        tv_logger.info(
            "cast_start admin=%s guest=%s category_id=%s media_id=%s",
            is_admin,
            is_guest_cast,
            data.get('category_id'),
            media_id,
        )
        self._hdmi().on_cast_start()

        media_local_path = self._resolve_local_media_path(media_path)
        new_state = {
            'media_type': media_type,
            'media_path': media_path,
            'loop': loop,
            'viewKey': data.get('viewKey'),
            'viewType': data.get('viewType'),
            'viewParams': view_params,
            'mediaId': media_id,
            'category_id': data.get('category_id'),
            'thumbnail_url': data.get('thumbnail_url'),
            'current_time': start_time,
            'duration': duration if duration > 0 else 0,
            'paused': False,
            'last_update': time.time(),
            'is_guest_cast': is_guest_cast,
            'subtitle_url': data.get('subtitle_url'),
            'subtitle_label': data.get('subtitle_label'),
        }
        connection = session_store.get_connection(session_id) if session_id else None
        if connection and connection.get('profile_id'):
            new_state['profile_id'] = connection.get('profile_id')
        if media_local_path:
            new_state['media_local_path'] = media_local_path

        tv_store.set_playback_state(new_state)

        tv_sid = tv_store.get_tv_sid()
        self._events().emit_status_update(
            {
                'connected': bool(tv_sid),
                'tv_sid': tv_sid,
                'hdmi_connected': self._hdmi().connected,
                'is_casting': True,
                'casting_info': tv_store.build_casting_info(new_state),
            },
        )

        if not tv_sid:
            logger.info("Client %s requested to cast, but no TV is connected yet. Starting kiosk...", client_id)
            tv_logger.info("cast_waiting_for_tv")
            tv_store.set_kiosk_boot({
                'requester_sid': client_id,
                'timestamp': time.time(),
                'media_path': media_path,
                'media_type': media_type,
                'viewKey': data.get('viewKey'),
                'viewType': data.get('viewType'),
                'viewParams': view_params,
                'mediaId': media_id,
            })
            self._events().emit_kiosk_booting(
                {
                    'message': 'Starting TV kiosk... This may take a few seconds.',
                    'estimated_time': 3,
                },
                room=client_id,
            )
            self.spawn_later(KIOSK_BOOT_TIMEOUT, self._check_boot_timeout)
            return

        logger.info(
            "Casting media to TV %s: Type - %s, Path - %s, Loop - %s, Start - %ss, Guest Cast - %s",
            tv_sid,
            media_type,
            media_path,
            loop,
            start_time,
            is_guest_cast,
        )
        tv_logger.info(
            "cast_dispatch tv_sid=%s type=%s start=%s guest=%s",
            tv_sid,
            media_type,
            start_time,
            is_guest_cast,
        )

        tv_payload = {
            'media_type': media_type,
            'media_path': media_path,
            'loop': loop,
            'viewKey': data.get('viewKey'),
            'viewType': data.get('viewType'),
            'viewParams': view_params,
            'mediaId': media_id,
            'category_id': data.get('category_id'),
            'thumbnail_url': data.get('thumbnail_url'),
            'start_time': start_time,
            'duration': duration if duration > 0 else 0,
            'is_guest_cast': is_guest_cast,
        }
        if media_local_path:
            tv_payload['media_local_path'] = media_local_path

        subtitle_url = data.get('subtitle_url')
        subtitle_label = data.get('subtitle_label')
        if subtitle_url:
            tv_payload['subtitle_url'] = subtitle_url
            tv_payload['subtitle_label'] = subtitle_label or 'Subtitle'
            logger.info("Including subtitle with cast: %s (%s)", subtitle_label, subtitle_url)

        self._events().emit_display_media(tv_payload, room=tv_sid)
        self._events().emit_request_state(room=tv_sid)
        self._events().emit_cast_success('Media sent to TV successfully.', room=client_id)

    def relay_playback_control(self, client_id, is_admin, data):
        """Relay playback controls to the TV runtime."""
        data = data or {}
        action = data.get('action')
        tv_logger = self._get_tv_logger()

        state = tv_store.get_playback_state()
        has_active_cast = tv_store.is_casting()
        if not has_active_cast:
            logger.warning("Client %s tried to control TV but no active cast.", client_id)
            tv_logger.info("control_reject no_active_cast action=%s sid=%s", action, client_id)
            self._events().emit_error('No active cast to control.', room=client_id)
            return

        is_guest_cast = state.get('is_guest_cast', True)
        if not is_guest_cast and not is_admin:
            logger.warning("Client %s tried to control admin cast but is not admin. Rejected.", client_id)
            tv_logger.info("control_reject not_admin action=%s sid=%s", action, client_id)
            self._events().emit_error('Only admin can control admin casts.', room=client_id)
            return

        if action != 'sync':
            logger.info("Client %s sent TV playback control: %s", client_id, data)

        tv_sid = tv_store.get_tv_sid()
        if not tv_sid:
            logger.warning("Client %s tried to control TV playback, but no TV is connected.", client_id)
            tv_logger.info("control_reject no_tv action=%s sid=%s", action, client_id)
            self._events().emit_error('No TV is currently connected.', room=client_id)
            return

        try:
            current_time = float(data.get('currentTime', 0) or 0)
        except (TypeError, ValueError):
            current_time = 0.0

        if action not in ['play', 'pause', 'seek', 'sync']:
            logger.warning("Invalid playback control action from %s: %s", client_id, action)
            tv_logger.info("control_reject invalid_action action=%s sid=%s", action, client_id)
            return

        update = {'current_time': current_time}
        if action == 'play':
            update['paused'] = False
        elif action == 'pause':
            update['paused'] = True
        tv_store.update_playback_state(update)

        if action in ['play', 'pause', 'seek']:
            self._commit_tv_progress(force=True)

        self._events().emit_playback_control(
            {
                'action': action,
                'currentTime': current_time,
            },
            room=tv_sid,
        )
        self._events().emit_request_state_later(0.35, room=tv_sid)

        if action != 'sync':
            logger.info("Relayed playback control to TV: %s at %ss", action, current_time)
            tv_logger.info("control_relay action=%s time=%s tv_sid=%s", action, current_time, tv_sid)

    def report_tv_state(self, client_id, data):
        """Update server-side TV state and broadcast it to other clients."""
        data = data or {}
        tv_logger = self._get_tv_logger()
        tv_sid = tv_store.get_tv_sid()

        if client_id != tv_sid:
            return

        state = tv_store.get_playback_state()
        if not state:
            return

        try:
            current_time = float(data.get('currentTime', 0) or 0)
        except (TypeError, ValueError):
            current_time = 0

        update = {
            'current_time': current_time,
            'paused': _coerce_bool(data.get('paused', False)),
            'last_update': time.time(),
        }

        tv_duration = data.get('duration')
        try:
            if tv_duration is not None and math.isfinite(float(tv_duration)):
                update['duration'] = float(tv_duration)
        except (ValueError, TypeError, OverflowError):
            pass

        tv_store.update_playback_state(update)
        state = tv_store.get_playback_state()
        broadcast_state = {
            'currentTime': state['current_time'],
            'duration': state.get('duration', 0),
            'isPlaying': not state['paused'],
            'viewKey': state.get('viewKey'),
            'viewType': state.get('viewType'),
            'viewParams': state.get('viewParams') or {},
            'mediaId': state.get('mediaId'),
            'category_id': state.get('category_id'),
            'media_path': state.get('media_path'),
            'thumbnail_url': state.get('thumbnail_url'),
            'is_guest_cast': state.get('is_guest_cast', True),
        }

        self._events().emit_playback_state(
            broadcast_state,
            broadcast=True,
            skip_sid=client_id,
        )
        tv_logger.info(
            "tv_report_state time=%.2f dur=%s paused=%s",
            broadcast_state['currentTime'],
            broadcast_state['duration'],
            not broadcast_state['isPlaying'],
        )

    def add_subtitle(self, client_id, data):
        """Relay a subtitle track to the TV runtime."""
        data = data or {}
        subtitle_url = data.get('subtitle_url', '')
        label = data.get('label', 'Subtitle')

        if not subtitle_url:
            logger.warning("Client %s tried to add subtitle but no URL provided", client_id)
            return

        tv_sid = tv_store.get_tv_sid()
        if not tv_sid:
            logger.warning("Client %s tried to add subtitle but no TV connected", client_id)
            return

        logger.info("Relaying subtitle to TV: %s (%s)", label, subtitle_url)
        self._events().emit_add_subtitle(
            {
                'subtitle_url': subtitle_url,
                'label': label,
                'tv_sid': tv_sid,
            },
            room=tv_sid,
        )

    def stop_cast(self, client_id, session_id, is_admin, data=None):
        """Stop the current cast and clear server-side cast state."""
        data = data or {}
        tv_logger = self._get_tv_logger()
        logger.info("Client %s requested to stop TV casting.", client_id)
        tv_logger.info(
            "stop_cast sid=%s session=%s",
            client_id,
            session_id[:8] if session_id else 'N/A',
        )

        state = tv_store.get_playback_state()
        has_active_cast = tv_store.is_casting()
        if not has_active_cast:
            logger.info("Client %s tried to stop casting but no active cast.", client_id)
            tv_sid = tv_store.get_tv_sid()
            if tv_sid:
                self._events().emit_stop_casting(room=tv_sid)
            self._events().emit_status_update(
                {
                    'connected': bool(tv_sid),
                    'is_casting': False,
                    'hdmi_connected': self._hdmi().connected,
                },
            )
            return

        is_guest_cast = state.get('is_guest_cast', True)
        if not is_guest_cast and not is_admin:
            logger.warning("Client %s tried to stop admin cast but is not admin. Rejected.", client_id)
            self._events().emit_error('Only admin can stop admin casts.', room=client_id)
            return

        stop_update = {}
        stop_time = _coerce_non_negative_float(data.get('currentTime'))
        stop_duration = _coerce_non_negative_float(data.get('duration'))
        if stop_time is not None:
            stop_update['current_time'] = stop_time
        if stop_duration is not None and stop_duration > 0:
            stop_update['duration'] = stop_duration
        if stop_update:
            state = {**state, **stop_update}
            tv_store.update_playback_state(stop_update)

        self._commit_tv_progress(state=state, force=True)
        tv_store.clear_playback_state()
        tv_sid = tv_store.get_tv_sid()
        if tv_sid:
            logger.info("Sending tv_stop_casting to TV display: %s", tv_sid)
            self._events().emit_stop_casting(room=tv_sid)
            self._hdmi().on_cast_stop()
        else:
            logger.warning("No TV connected - cannot send stop command")

        self._events().emit_status_update(
            {
                'tv_sid': tv_sid,
                'is_casting': False,
                'hdmi_connected': self._hdmi().connected,
            },
        )
        logger.info("Stop casting command processed.")

    def _commit_tv_progress(self, state=None, *, force=False):
        """Persist profile-owned progress from the server's TV cast state."""
        state = state or tv_store.get_playback_state()
        if not state:
            return
        try:
            self._progress().process_tv_progress_update(
                state,
                force=force,
            )
        except Exception as exc:
            logger.warning("Failed to commit TV progress: %s", exc)

    def _resolve_local_media_path(self, media_path):
        if not isinstance(media_path, str) or not media_path.startswith('/media/'):
            return None

        try:
            parts = media_path[len('/media/'):].split('/', 1)
            if len(parts) != 2:
                return None

            category_id, filename = parts[0], unquote(parts[1])
            resolved, error = media_path_service.get_media_filepath(category_id, filename)

            if (error or not resolved) and '/' in filename:
                filename_parts = filename.split('/')
                for index in range(1, len(filename_parts)):
                    candidate = '/'.join(filename_parts[index:])
                    resolved_try, error_try = media_path_service.get_media_filepath(category_id, candidate)
                    if not error_try and resolved_try:
                        resolved = resolved_try
                        error = None
                        break

            if (error or not resolved) and category_id.startswith('auto::'):
                rel_parts = [part for part in category_id.split('::')[1:] if part]
                rel_path = os.path.join(*rel_parts) if rel_parts else None
                if rel_path:
                    try:
                        from app.services.storage import storage_drive_service

                        roots = list(storage_drive_service.get_current_mount_paths())
                    except Exception:
                        roots = []
                    for root in ['/media', '/media/usb', '/media/ghost', '/mnt']:
                        if root not in roots:
                            roots.append(root)
                    for root in roots:
                        base = os.path.join(root, rel_path)
                        if not os.path.exists(base):
                            continue

                        candidate_full = os.path.normpath(os.path.join(base, filename))
                        if os.path.exists(candidate_full):
                            resolved = candidate_full
                            error = None
                            break

                        if '/' in filename:
                            filename_parts = filename.split('/')
                            for index in range(1, len(filename_parts)):
                                candidate = os.path.normpath(
                                    os.path.join(base, '/'.join(filename_parts[index:]))
                                )
                                if os.path.exists(candidate):
                                    resolved = candidate
                                    error = None
                                    break
                        if resolved:
                            break

            if error or not resolved:
                return None
            return resolved
        except Exception as exc:
            logger.warning("Failed to resolve media_local_path for %s: %s", media_path, exc)
            return None

    def _check_boot_timeout(self):
        """Emit a timeout event if kiosk boot never completed."""
        boot_pending = tv_store.get_kiosk_boot()
        if not boot_pending:
            return

        elapsed = time.time() - boot_pending['timestamp']
        if elapsed < KIOSK_BOOT_TIMEOUT:
            return

        requester_sid = boot_pending.get('requester_sid')
        if requester_sid:
            logger.warning("Kiosk boot timeout after %.1fs for requester %s", elapsed, requester_sid)
            self._events().emit_kiosk_boot_timeout(
                {
                    'message': 'Kiosk is taking longer than expected. Please check HDMI connection.',
                    'error': True,
                },
                room=requester_sid,
            )
        tv_store.clear_kiosk_boot()

    def _get_tv_logger(self):
        if self._tv_logger:
            return self._tv_logger

        tv_logger = logging.getLogger('ghosthub.tv_cast')
        tv_logger.setLevel(logging.INFO)

        try:
            logs_dir = os.path.join(get_runtime_instance_path(), 'logs')
            os.makedirs(logs_dir, exist_ok=True)
            log_path = os.path.join(logs_dir, 'tv_cast.log')

            handler = RotatingFileHandler(
                log_path,
                maxBytes=2 * 1024 * 1024,
                backupCount=3,
            )
            handler.setLevel(logging.INFO)
            handler.setFormatter(
                logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
            )
            tv_logger.addHandler(handler)
            tv_logger.propagate = False
        except Exception as exc:
            logger.warning("Failed to init tv_cast file logger: %s", exc)

        self._tv_logger = tv_logger
        return tv_logger
