"""GhostHub progress domain controller built on Specter."""

import gevent
import logging
import os
import time
from urllib.parse import quote, unquote

from flask import has_request_context, request, session as flask_session
from gevent.lock import BoundedSemaphore

from app.constants import SOCKET_EVENTS as SE, TV_EVENTS
from app.services.core import profile_service, session_store, tv_store
from app.services.media import hidden_content_service, media_index_service, video_progress_service
from app.services.core.runtime_config_service import (
    get_runtime_config_value,
    get_runtime_flask_app,
)
from specter import Controller, Field, HTTPError, Schema, expect_json, registry
from app.utils.auth import (
    get_request_session_id,
    get_show_hidden_flag,
    session_or_admin_required,
)

from app.controllers._media_support import MediaVisibilitySupport

logger = logging.getLogger(__name__)


class ProgressController(MediaVisibilitySupport, Controller):
    """Progress and continue-watching composition root."""

    name = 'progress'
    url_prefix = '/api'
    PROGRESS_SAVE_INTERVAL = 30
    PROGRESS_TIMESTAMPS_MAX = 500
    RECENTLY_COMPLETED_TTL = 15
    TV_PROGRESS_SAVE_INTERVAL = 5.0
    schemas = {
        'save_progress': Schema('progress.save_progress', {
            'video_path': Field(str),
            'video_url': Field(str),
            'video_timestamp': Field(float),
            'video_duration': Field(float),
            'thumbnail_url': Field(str),
            'video_completed': Field(bool, default=False),
        }),
        'resolve_paths': Schema('progress.resolve_paths', {
            'paths': Field(list, required=True),
        }),
    }

    def __init__(self):
        super().__init__()
        self._progress_save_timestamps = {}
        self._progress_timestamps_lock = BoundedSemaphore(1)
        self._recently_completed_urls = {}
        self._tv_progress_lock = BoundedSemaphore(1)
        self._last_tv_progress_save = 0.0

    @staticmethod
    def _events():
        return registry.require('progress_events')

    def build_routes(self, router):
        @router.route(
            '/progress/video',
            methods=['GET'],
            json_errors='Failed to get video progress',
        )
        def get_single_video_progress():
            if not self.is_progress_enabled():
                return {}

            video_path = request.args.get('video_path')
            if not video_path:
                raise HTTPError('video_path required', status=400)

            progress = self.get_video_progress(video_path)
            return progress or {}

        @router.route(
            '/progress/videos',
            methods=['GET'],
            json_errors='Failed to get all video progress',
        )
        def get_all_video_progress():
            if not self.is_progress_enabled():
                return {'videos': []}
            if not self._get_active_profile_id():
                return {'videos': []}

            limit = request.args.get('limit', 50, type=int)
            videos = self.list_continue_watching_videos(
                limit=limit,
                show_hidden=get_show_hidden_flag(),
            )
            return {'videos': videos}

        @router.route(
            '/progress/<category_id>',
            methods=['POST'],
            json_errors='Failed to save progress',
        )
        @session_or_admin_required
        def save_progress_route(category_id):
            if not self.is_progress_enabled():
                return {
                    'success': False,
                    'message': 'Progress saving is disabled',
                }, 200

            payload = self.schema('save_progress').require(expect_json(
                error='Invalid or missing JSON data',
            ))
            video_path = payload.get('video_path') or payload.get('video_url')
            if not video_path:
                raise HTTPError(
                    'video_path or video_url required',
                    status=400,
                )

            if (
                not get_runtime_config_value('SAVE_PROGRESS_FOR_HIDDEN_FILES', True)
                and self.should_skip_hidden_progress(video_path, category_id)
            ):
                return {
                    'success': True,
                    'message': 'Progress skipped for hidden file or category',
                }, 200

            success, message = self.save_video_progress(
                video_path=video_path,
                category_id=category_id,
                video_timestamp=payload.get('video_timestamp'),
                video_duration=payload.get('video_duration'),
                thumbnail_url=payload.get('thumbnail_url'),
                video_completed=payload.get('video_completed', False),
            )
            if not success:
                return {'success': False, 'message': message}, 200

            if payload.get('video_completed', False):
                return {
                    'success': True,
                    'message': 'Progress cleared after completion',
                    'deleted': True,
                }

            return {'success': True, 'message': 'Progress saved'}

        @router.route(
            '/progress/clear-continue-watching',
            methods=['POST'],
            json_errors='Failed to clear Continue Watching history',
        )
        def clear_continue_watching():
            if not self.is_progress_enabled():
                raise HTTPError(
                    'Progress tracking disabled',
                    status=400,
                )

            active_profile_id = self._get_active_profile_id()
            if not active_profile_id:
                raise HTTPError(
                    'Select a profile before clearing profile video progress.',
                    status=400,
                )

            result = self.delete_all_progress(
                profile_id=active_profile_id,
            )
            if not result.get('success'):
                raise HTTPError(
                    result.get('error', 'Failed to clear video progress'),
                    status=500,
                )

            return {
                'success': True,
                'message': 'Continue Watching history cleared successfully.',
                'cleared_count': result.get('count', 0),
            }

        @router.route(
            '/progress/resolve-paths',
            methods=['POST'],
            json_errors='Failed to resolve stale paths',
        )
        @session_or_admin_required
        def resolve_stale_paths():
            payload = self.schema('resolve_paths').require(expect_json())
            paths = payload.get('paths') or []
            if not isinstance(paths, list):
                raise HTTPError('paths must be an array', status=400)

            return self.resolve_stale_paths(
                paths,
                show_hidden=get_show_hidden_flag(),
            )

    def build_events(self, handler):
        """Own shared playback-progress ingress from state and TV events."""
        handler.on(
            SE['UPDATE_MY_STATE'],
            self.handle_socket_state_update,
            priority=200,
        )
        handler.on(
            TV_EVENTS['TV_REPORT_STATE'],
            self.handle_tv_report_state,
            priority=200,
        )

    def is_progress_enabled(self):
        """Return ``True`` when video progress persistence is enabled."""
        return get_runtime_config_value('SAVE_VIDEO_PROGRESS', False)

    def delete_all_progress(self, profile_id=None):
        """Delete all persisted video progress data."""
        return video_progress_service.delete_all_video_progress(profile_id=profile_id)

    def _get_active_profile_id(self):
        """Return the active profile id for the current session, if any."""
        if not has_request_context():
            return None

        active_profile_id = flask_session.get('active_profile_id')
        if not active_profile_id:
            return None

        profile = profile_service.get_profile(active_profile_id, include_preferences=False)
        if not profile:
            flask_session.pop('active_profile_id', None)
            flask_session.modified = True

            current_session_id = get_request_session_id()
            if current_session_id:
                session_store.update_connection_profile(
                    current_session_id,
                    profile_id=None,
                    profile_name=None,
                )
            return None

        return profile['id']

    def delete_video_progress(self, video_path):
        """Delete progress for every normalized path candidate."""
        profile_id = self._get_active_profile_id()
        if not profile_id:
            return False

        deleted = False
        for candidate in self._candidate_video_paths(video_path):
            deleted = video_progress_service.delete_video_progress(
                candidate,
                profile_id=profile_id,
            ) or deleted
        return deleted

    def handle_media_delete(self, *, media_url=None, category_id=None, filename=None):
        """Apply progress-side cleanup after a media file is deleted."""
        cleared_progress = False

        if media_url:
            for candidate in self._candidate_video_paths(media_url):
                cleared_progress = video_progress_service.delete_video_progress(candidate) or cleared_progress
        return cleared_progress

    def handle_media_rename(
        self,
        *,
        old_media_url=None,
        new_media_url=None,
        category_id=None,
        old_filename=None,
        new_filename=None,
    ):
        """Apply progress-side updates after a media file is renamed."""
        remapped_progress = False

        if old_media_url and new_media_url:
            remapped_progress = self._remap_video_progress(
                old_media_url,
                new_media_url,
            )
        return remapped_progress

    def save_video_progress(
        self,
        video_path,
        category_id,
        video_timestamp,
        video_duration=None,
        thumbnail_url=None,
        video_completed=False,
    ):
        """Persist or clear progress for a single media item."""
        if not self.is_progress_enabled():
            return False, 'Progress saving is disabled.'

        profile_id = self._get_active_profile_id()
        if not profile_id:
            return False, 'Active profile is required.'

        if video_path and video_completed:
            self.delete_video_progress(video_path)
            return True, 'Video progress cleared after completion.'

        return video_progress_service.save_video_progress(
            video_path=video_path,
            category_id=category_id,
            video_timestamp=video_timestamp,
            video_duration=video_duration,
            thumbnail_url=thumbnail_url,
            profile_id=profile_id,
        )

    def get_video_progress(self, video_path):
        """Return normalized progress for a media URL/path."""
        profile_id = self._get_active_profile_id()
        if not profile_id:
            return None

        for candidate in self._candidate_video_paths(video_path):
            progress = video_progress_service.get_video_progress(
                candidate,
                profile_id=profile_id,
            )
            if progress:
                return progress
        return None

    def get_category_video_progress(self, category_id):
        """Return progress map for a category."""
        return video_progress_service.get_category_video_progress(
            category_id,
            profile_id=self._get_active_profile_id(),
        )

    def get_video_progress_batch(self, category_ids):
        """Return progress for multiple category IDs."""
        return video_progress_service.get_video_progress_batch(
            category_ids,
            profile_id=self._get_active_profile_id(),
        )

    def handle_socket_state_update(self, data=None):
        """Handle progress-related work for client playback state updates."""
        client_id = request.sid
        session_id = get_request_session_id()
        is_tv = client_id == tv_store.get_tv_sid()

        if (not session_id and not is_tv) or not data:
            return
        if 'category_id' not in data or 'index' not in data:
            return

        category_id = data.get('category_id')
        if not isinstance(category_id, str) or not category_id.strip():
            return

        try:
            index = int(data.get('index'))
            if index < 0:
                return
        except (TypeError, ValueError):
            return

        self.process_state_progress_update(
            session_id=session_id,
            is_tv=is_tv,
            category_id=category_id,
            index=index,
            video_url=data.get('video_url'),
            video_timestamp=data.get('video_timestamp'),
            video_duration=data.get('video_duration'),
            persist_video_progress=bool(data.get('persist_video_progress')),
            video_completed=bool(data.get('video_completed')),
            total_count=data.get('total_count'),
            thumbnail_url=data.get('thumbnail_url'),
            critical_save=bool(data.get('critical_save', False)),
        )

    def handle_tv_report_state(self, data=None):
        """Handle progress-related work for inbound TV playback reports."""
        tv_sid = tv_store.get_tv_sid()
        if request.sid != tv_sid:
            return

        state = tv_store.get_playback_state()
        if not state:
            return

        self.process_tv_progress_update(state)

    def process_state_progress_update(
        self,
        *,
        session_id,
        is_tv,
        category_id,
        index,
        video_url=None,
        video_timestamp=None,
        video_duration=None,
        persist_video_progress=False,
        video_completed=False,
        total_count=None,
        thumbnail_url=None,
        critical_save=False,
    ):
        """Own the runtime save/broadcast policy for client playback updates."""
        if not self.is_progress_enabled():
            return

        current_time = time.time()
        should_save = bool(critical_save)
        profile_id = self._get_active_profile_id()
        if not profile_id:
            return

        sync_controller = registry.require('sync')
        sync_enabled = sync_controller.is_sync_enabled()

        if sync_enabled:
            if should_save:
                logger.debug(
                    "[Sync Mode] Blocking progress save to SQLite for session %s",
                    session_id[:8] if session_id else 'N/A',
                )
            should_save = False

        if not should_save and not sync_enabled:
            with self._progress_timestamps_lock:
                last_save_time = self._progress_save_timestamps.get(category_id, 0)
            time_since_last_save = current_time - last_save_time
            if time_since_last_save >= self.PROGRESS_SAVE_INTERVAL:
                should_save = True
            else:
                logger.debug(
                    "[Debounce] Skipping progress save for %s - only %.1fs since last save (threshold: %ss)",
                    category_id,
                    time_since_last_save,
                    self.PROGRESS_SAVE_INTERVAL,
                )

        tv_state = tv_store.get_playback_state()
        tv_profile_id = tv_state.get('profile_id') if tv_state else None

        if is_tv and not tv_profile_id:
            if should_save:
                logger.debug(
                    "[Guest Cast] Blocking auto-progress save for TV guest cast session %s",
                    session_id[:8] if session_id else 'N/A',
                )
            should_save = False

        if should_save and self._is_tv_authority_for_category(category_id):
            logger.debug(
                "[TV Authority] Blocking browser save: TV is authority for category %s",
                category_id,
            )
            should_save = False

        if not should_save:
            return

        app = get_runtime_flask_app()
        if app is None:
            logger.warning("Skipping async progress persistence: Flask app unavailable")
            return
        self.spawn(
            self._persist_state_progress_update,
            app=app,
            category_id=category_id,
            index=index,
            total_count=total_count,
            video_url=video_url,
            video_timestamp=video_timestamp,
            video_duration=video_duration,
            thumbnail_url=thumbnail_url,
            persist_video_progress=persist_video_progress,
            video_completed=video_completed,
            profile_id=profile_id,
            sid=request.sid,
        )

        with self._progress_timestamps_lock:
            self._progress_save_timestamps[category_id] = current_time
            if len(self._progress_save_timestamps) > self.PROGRESS_TIMESTAMPS_MAX:
                oldest = min(
                    self._progress_save_timestamps,
                    key=self._progress_save_timestamps.get,
                )
                del self._progress_save_timestamps[oldest]

    def process_tv_progress_update(self, state, *, force=False):
        """Own TV-cast progress persistence for profile-backed playback."""
        if not self.is_progress_enabled():
            return
        if not state:
            return
        profile_id = state.get('profile_id')
        if not profile_id:
            return

        now = time.time()
        should_save = False
        with self._tv_progress_lock:
            if force or now - self._last_tv_progress_save >= self.TV_PROGRESS_SAVE_INTERVAL:
                self._last_tv_progress_save = now
                should_save = True

        if not should_save:
            return

        category_id = state.get('category_id')
        media_id = state.get('mediaId')
        video_url = state.get('media_path')
        thumbnail_url = state.get('thumbnail_url')
        video_timestamp = state.get('current_time', 0)
        video_duration = state.get('duration', 0)
        video_completed = bool(state.get('video_completed'))

        if not category_id:
            return

        result = self._persist_runtime_progress(
            video_url=video_url,
            category_id=category_id,
            video_timestamp=video_timestamp,
            video_duration=video_duration,
            thumbnail_url=thumbnail_url,
            video_completed=video_completed,
            persist_requested=bool(video_url and (video_completed or video_timestamp > 0)),
            profile_id=profile_id,
        )

        if result['failure']:
            logger.warning(
                "Failed to save video progress for %s: %s",
                video_url,
                result['message'],
            )
        elif result['saved']:
            if result['deleted']:
                logger.info("[TV Save] Cleared completed video progress: %s", video_url)
            else:
                logger.info(
                    "[TV Save] Profile progress saved: cat=%s, media=%s, time=%.1fs",
                    category_id,
                    media_id or video_url,
                    video_timestamp,
                )

        if result['skip_broadcast']:
            return
        if not result['saved']:
            return

        progress_payload = {
            'category_id': category_id,
            'mediaId': media_id,
            'video_timestamp': video_timestamp,
            'video_duration': result.get('video_duration', video_duration),
            'video_url': video_url,
            'thumbnail_url': result.get('thumbnail_url', thumbnail_url),
            'is_tv_authority': True,
            'video_progress_deleted': result['deleted'],
            'profile_id': profile_id,
        }
        self._emit_profile_progress_update(
            progress_payload,
            profile_id=profile_id,
        )

    def list_continue_watching_videos(self, *, limit=50, show_hidden=False):
        """Return filtered continue-watching rows."""
        videos = video_progress_service.get_all_video_progress(
            limit,
            profile_id=self._get_active_profile_id(),
        )
        filtered_videos = []

        for video in videos:
            category_id = video.get('category_id')
            if not category_id:
                filtered_videos.append(video)
                continue

            category_path = media_index_service.resolve_category_path_from_id(category_id)
            if category_path and os.path.exists(category_path):
                filtered_videos.append(video)
            else:
                logger.debug(
                    "Continue Watching dropped unplugged video from UI: %s",
                    video.get('video_path'),
                )

        if show_hidden:
            return filtered_videos

        visible = []
        hidden_files_set = hidden_content_service.get_hidden_files_set()
        category_path_cache = {}

        for video in filtered_videos:
            category_id = video.get('category_id')
            if hidden_content_service.should_block_category_access(category_id, show_hidden=False):
                continue

            video_url = video.get('video_path')
            if not video_url:
                continue

            try:
                parts = video_url.strip('/').split('/')
                if len(parts) >= 3 and parts[0] == 'media':
                    cat_id = parts[1]
                    filename = unquote('/'.join(parts[2:]))

                    if cat_id not in category_path_cache:
                        from app.services.media.category_query_service import get_category_by_id

                        category = get_category_by_id(cat_id)
                        category_path_cache[cat_id] = (
                            category.get('path') if category else None
                        )

                    category_path = category_path_cache[cat_id]
                    if category_path:
                        absolute_path = os.path.normcase(
                            os.path.normpath(
                                os.path.join(category_path, filename)
                            )
                        )
                        if hidden_files_set == 'OVERFLOW':
                            if hidden_content_service.is_file_hidden(
                                os.path.join(category_path, filename)
                            ):
                                continue
                        elif absolute_path in hidden_files_set:
                            continue

                visible.append(video)
            except Exception:
                visible.append(video)

        return visible

    def resolve_stale_paths(self, paths, *, show_hidden=False):
        """Resolve stale media URLs through the alias table."""
        mappings = {}
        stale = []

        for path in paths:
            if not path:
                continue

            resolved = video_progress_service.resolve_file_alias(path)
            if resolved and resolved != path:
                if self._media_url_exists(resolved, show_hidden=show_hidden):
                    mappings[path] = resolved
                else:
                    stale.append(path)
                continue

            if not self._media_url_exists(path, show_hidden=show_hidden):
                stale.append(path)

        if stale:
            stale = list(dict.fromkeys(stale))

        return {'mappings': mappings, 'stale': stale}

    def should_skip_hidden_progress(self, video_path, category_id):
        """Return ``True`` when hidden content should not persist progress."""
        file_path, _ = self._resolve_media_item_path({
            'url': video_path,
            'category_id': category_id,
        })
        if not file_path:
            return False
        return (
            hidden_content_service.is_file_hidden(file_path) or
            hidden_content_service.should_block_category_access(category_id, show_hidden=False)
        )

    def _persist_state_progress_update(
        self,
        *,
        app,
        category_id,
        index,
        total_count,
        video_url,
        video_timestamp,
        video_duration,
        thumbnail_url,
        persist_video_progress,
        video_completed,
        profile_id,
        sid,
    ):
        with app.app_context():
            result = self._persist_runtime_progress(
                video_url=video_url,
                category_id=category_id,
                video_timestamp=video_timestamp,
                video_duration=video_duration,
                thumbnail_url=thumbnail_url,
                video_completed=video_completed,
                persist_requested=bool(persist_video_progress or video_completed),
                profile_id=profile_id,
            )

            if result['failure']:
                logger.warning(
                    "Failed to save video progress for %s: %s",
                    video_url,
                    result['message'],
                )
            elif result['saved']:
                if result['deleted']:
                    logger.info(
                        "[ContinueWatching] Cleared completed video progress: %s",
                        video_url,
                    )
                else:
                    logger.info(
                        "[ContinueWatching] Saved video progress: %s, time=%s",
                        video_url,
                        video_timestamp,
                    )

            if result['skip_broadcast']:
                return
            if not result['saved']:
                return

            blocked = hidden_content_service.should_block_category_access(category_id, show_hidden=False)
            if blocked:
                logger.info(
                    "Skipping progress broadcast for hidden category %s",
                    category_id,
                )
                return

            progress_data = {
                'category_id': category_id,
                'index': index,
                'total_count': total_count,
                'video_timestamp': video_timestamp,
                'video_duration': result.get('video_duration', video_duration),
                'thumbnail_url': result.get('thumbnail_url', thumbnail_url),
                'video_url': video_url,
                'tracking_mode': 'video',
                'profile_id': profile_id,
            }
            if result['deleted']:
                progress_data['video_progress_deleted'] = True

            if sid:
                self._events().emit_progress_update(progress_data, room=sid)

    def _persist_runtime_progress(
        self,
        *,
        video_url,
        category_id,
        video_timestamp,
        video_duration,
        thumbnail_url,
        video_completed,
        persist_requested,
        profile_id,
    ):
        result = {
            'saved': False,
            'deleted': False,
            'skip_broadcast': False,
            'failure': False,
            'message': '',
            'video_duration': video_duration,
            'thumbnail_url': thumbnail_url,
        }

        has_valid_progress_payload = video_completed or (
            video_timestamp is not None and video_timestamp > 0
        )
        if not persist_requested or not video_url or not has_valid_progress_payload:
            return result

        if (
            not get_runtime_config_value('SAVE_PROGRESS_FOR_HIDDEN_FILES', True) and
            self.should_skip_hidden_progress(video_url, category_id)
        ):
            result['message'] = 'Progress skipped for hidden file or category'
            result['skip_broadcast'] = True
            return result

        if not video_completed and self._was_recently_completed(video_url):
            result['message'] = 'Blocked stale save for recently-completed media'
            return result

        if not profile_id:
            result['message'] = 'Active profile is required.'
            return result

        existing_progress = video_progress_service.get_video_progress(
            video_url,
            profile_id=profile_id,
        )
        if (
            (video_duration is None or video_duration <= 0)
            and existing_progress
            and existing_progress.get('video_duration')
        ):
            video_duration = existing_progress.get('video_duration')
            result['video_duration'] = video_duration
        if not thumbnail_url and existing_progress and existing_progress.get('thumbnail_url'):
            thumbnail_url = existing_progress.get('thumbnail_url')
            result['thumbnail_url'] = thumbnail_url

        if video_completed:
            deleted = False
            for candidate in self._candidate_video_paths(video_url):
                deleted = video_progress_service.delete_video_progress(
                    candidate,
                    profile_id=profile_id,
                ) or deleted
            result['message'] = 'Video progress cleared after completion.'
            result['saved'] = deleted
            result['deleted'] = deleted
            if deleted:
                self._record_recent_completion(video_url)
            return result

        success, message = video_progress_service.save_video_progress(
            video_path=video_url,
            category_id=category_id,
            video_timestamp=video_timestamp,
            video_duration=video_duration,
            thumbnail_url=thumbnail_url,
            profile_id=profile_id,
        )
        result['message'] = message
        if not success:
            result['failure'] = True
            return result

        result['saved'] = True
        return result

    def _candidate_video_paths(self, video_path):
        candidates = set()
        if not video_path:
            return []

        raw = str(video_path)
        base = raw.split('#', 1)[0].split('?', 1)[0]
        candidates.add(raw)
        candidates.add(base)

        for value in (raw, base):
            try:
                candidates.add(unquote(value))
            except Exception:
                pass
            try:
                candidates.add(quote(value, safe='/:'))
            except Exception:
                pass

        return [value for value in candidates if value]

    def _remap_video_progress(self, old_video_path, new_video_path):
        remapped = False
        alias_added = False

        for candidate in self._candidate_video_paths(old_video_path):
            if not remapped:
                remapped = video_progress_service.update_video_progress_path(candidate, new_video_path)
            alias_added = video_progress_service.add_file_path_alias(candidate, new_video_path) or alias_added

        return remapped or alias_added

    def _is_tv_authority_for_category(self, category_id):
        state = tv_store.get_playback_state()
        return (
            state is not None
            and state.get('category_id') == category_id
            and bool(state.get('profile_id'))
        )

    def _emit_profile_progress_update(self, payload, *, profile_id):
        if not profile_id:
            return

        owner_session_id = session_store.get_profile_owner_session(profile_id)
        if not owner_session_id:
            return

        for sid in session_store.list_session_sids(owner_session_id):
            if sid:
                self._events().emit_progress_update(payload, room=sid)

    def _normalize_video_url(self, video_url):
        if not video_url:
            return ''
        try:
            video_url = unquote(str(video_url))
        except Exception:
            video_url = str(video_url)
        return video_url.split('#')[0].split('?')[0]

    def _record_recent_completion(self, video_url):
        self._recently_completed_urls[self._normalize_video_url(video_url)] = time.time()
        cutoff = time.time() - self.RECENTLY_COMPLETED_TTL
        stale = [
            key for key, value in self._recently_completed_urls.items()
            if value < cutoff
        ]
        for key in stale:
            self._recently_completed_urls.pop(key, None)

    def _was_recently_completed(self, video_url):
        completed_at = self._recently_completed_urls.get(
            self._normalize_video_url(video_url)
        )
        if not completed_at:
            return False
        return (time.time() - completed_at) < self.RECENTLY_COMPLETED_TTL
