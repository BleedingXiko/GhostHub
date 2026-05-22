"""Admin visibility/content control controller built on Specter."""

import logging
import os
import time

from flask import request, session

from app.constants import SOCKET_EVENTS
from app.services.core import session_store
from specter import Controller, Field, Schema, expect_json, registry
from app.utils.auth import admin_required, get_request_session_id, is_current_admin_session

logger = logging.getLogger(__name__)


class AdminVisibilityController(Controller):
    """Own admin content visibility and show-hidden session endpoints."""

    name = 'admin_visibility'
    url_prefix = '/api/admin'

    schemas = {
        'hide_category': Schema('admin_visibility.hide_category', {
            'category_id': Field(str, required=True),
        }, strict=True),
        'show_hidden': Schema('admin_visibility.show_hidden', {
            'duration': Field(int, default=3600),
        }, strict=True),
        'unhide_category': Schema('admin_visibility.unhide_category', {
            'category_id': Field(str),
        }, strict=True),
        'file_visibility': Schema('admin_visibility.file_visibility', {
            'file_path': Field(str, required=True),
            'category_id': Field(str),
        }, strict=True),
        'media_action': Schema('admin_visibility.media_action', {
            'category_id': Field(str, required=True),
            'rel_path': Field(str, required=True),
            'action': Field(
                str,
                required=True,
                choices=('rename', 'hide', 'unhide', 'delete'),
            ),
            'new_name': Field(str),
        }, strict=True),
    }

    def build_routes(self, router):
        @router.route('/categories/hide', methods=['POST'])
        @admin_required
        def hide_category():
            """Hide a category from all users."""
            try:
                from app.services.media.hidden_content_service import (
                    get_all_child_category_ids,
                    hide_category as hidden_hide_category,
                )
                from app.services.media.category_cache_service import (
                    update_cached_category,
                )

                payload = self.schema('hide_category').require(expect_json())
                category_id = self._normalize_category_id(payload['category_id'])
                admin_session_id = get_request_session_id()

                success, message = hidden_hide_category(category_id, admin_session_id)
                if not success:
                    return {'success': False, 'error': message}, 500

                update_cached_category(category_id)
                children = get_all_child_category_ids(category_id)
                for child in children:
                    update_cached_category(child)

                registry.require('library_events').emit_category_updated(
                    {
                        'reason': 'category_hidden',
                        'category_id': category_id,
                        'invalidateCategory': True,
                        'timestamp': time.time(),
                    },
                )

                logger.info("Admin %s hid category: %s", admin_session_id, category_id)
                return {'success': True, 'message': message}
            except Exception as exc:
                logger.error("Error hiding category: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/categories/show', methods=['POST'])
        @admin_required
        def show_hidden_categories():
            """Temporarily reveal hidden categories in the current admin session."""
            try:
                payload = self.schema('show_hidden').require(
                    request.get_json(silent=True) or {},
                )
                duration_seconds = max(60, min(payload.get('duration', 3600), 86400))

                session['show_hidden'] = True
                session['show_hidden_timestamp'] = time.time()
                session['show_hidden_duration'] = duration_seconds
                session.modified = True

                admin_session_id = get_request_session_id()
                logger.info(
                    "Admin %s enabled show_hidden for %ss",
                    admin_session_id,
                    duration_seconds,
                )

                self._emit_category_refresh_to_session(
                    admin_session_id,
                    {
                        'reason': 'show_hidden_enabled',
                        'duration_seconds': duration_seconds,
                        'session_only': True,
                        'show_hidden': True,
                        'invalidateAll': True,
                        'timestamp': time.time(),
                    },
                )

                return {
                    'success': True,
                    'message': f'Hidden categories revealed for {duration_seconds} seconds',
                }
            except Exception as exc:
                logger.error("Error showing hidden categories: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/categories/unhide', methods=['POST'])
        @admin_required
        def unhide_categories():
            """Unhide one category or all hidden categories."""
            try:
                from app.services.media.hidden_content_service import (
                    get_all_child_category_ids,
                    unhide_all_categories as hidden_unhide_all,
                    unhide_category as hidden_unhide_category,
                )
                from app.services.media.category_cache_service import (
                    invalidate_cache,
                    update_cached_category,
                )

                payload = self.schema('unhide_category').require(
                    request.get_json(silent=True) or {},
                )
                category_id = payload.get('category_id')
                children = []

                if category_id:
                    children = get_all_child_category_ids(category_id)
                    success, message = hidden_unhide_category(
                        category_id,
                        cascade=True,
                    )
                else:
                    success, message = hidden_unhide_all()

                if not success:
                    return {'success': False, 'error': message}, 500

                if category_id:
                    update_cached_category(category_id)
                    for child in children:
                        update_cached_category(child)
                else:
                    invalidate_cache()

                registry.require('library_events').emit_category_updated(
                    {
                        'reason': 'category_unhidden',
                        'category_id': category_id if category_id else None,
                        'unhide_all': category_id is None,
                        'invalidateCategory': category_id is not None,
                        'invalidateAll': category_id is None,
                        'timestamp': time.time(),
                    },
                )

                admin_session_id = get_request_session_id()
                logger.info(
                    "Admin %s unhid category: %s",
                    admin_session_id,
                    category_id or 'ALL',
                )
                return {'success': True, 'message': message}
            except Exception as exc:
                logger.error("Error unhiding categories: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/files/hide', methods=['POST'])
        @admin_required
        def hide_file():
            """Hide an individual file."""
            try:
                from app.services.media.hidden_content_service import hide_file as hidden_hide_file

                payload = self.schema('file_visibility').require(expect_json())
                file_path = payload['file_path']
                category_id = payload.get('category_id') or self._resolve_file_category_id(
                    file_path,
                )
                admin_session_id = get_request_session_id()

                success, message = hidden_hide_file(file_path, category_id, admin_session_id)
                if not success:
                    return {'success': False, 'error': message}, 500

                self._refresh_category_cache(category_id)
                self._emit_media_record_invalidation(
                    'file_hidden',
                    category_id,
                    file_path,
                )

                logger.info("Admin %s hid file: %s", admin_session_id, file_path)
                return {'success': True, 'message': message}
            except Exception as exc:
                logger.error("Error hiding file: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/files/unhide', methods=['POST'])
        @admin_required
        def unhide_file():
            """Unhide an individual file."""
            try:
                from app.services.media.hidden_content_service import (
                    unhide_category as hidden_unhide_category,
                    unhide_file as hidden_unhide_file,
                )

                payload = self.schema('file_visibility').require(expect_json())
                file_path = payload['file_path']
                category_id = payload.get('category_id')

                success, message = hidden_unhide_file(file_path)
                if not success:
                    return {'success': False, 'error': message}, 500

                if category_id:
                    cat_success, _cat_message = hidden_unhide_category(
                        category_id,
                        cascade=False,
                    )
                    if cat_success:
                        message = f"{message} Parent category unhidden."

                self._refresh_category_cache(category_id)
                self._emit_media_record_invalidation(
                    'file_unhidden',
                    category_id,
                    file_path,
                )

                admin_session_id = get_request_session_id()
                logger.info("Admin %s unhid file: %s", admin_session_id, file_path)
                return {'success': True, 'message': message}
            except Exception as exc:
                logger.error("Error unhiding file: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/files/batch-visibility', methods=['POST'])
        @admin_required
        def batch_file_visibility():
            """Hide or unhide multiple files with one grouped refresh."""
            try:
                payload = expect_json()
                action = payload.get('action')
                files = payload.get('files')
                if action not in {'hide', 'unhide'}:
                    return {'success': False, 'error': 'action must be hide or unhide'}, 400
                if not isinstance(files, list):
                    return {'success': False, 'error': 'files must be a list'}, 400
                if len(files) > 500:
                    return {'success': False, 'error': 'Cannot update more than 500 files at once'}, 413

                result = self._batch_file_visibility(action, files)
                return {'success': result['updated'] > 0, **result}
            except Exception as exc:
                logger.error("Error updating file visibility batch: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/media/action', methods=['POST'])
        @admin_required
        def media_quick_action():
            """Perform rename/hide/unhide/delete on a media item via rel_path."""
            try:
                from app.services.storage import storage_path_service
                from app.services.storage import storage_media_file_service
                from app.services.media.hidden_content_service import (
                    hide_file as hidden_hide_file,
                    unhide_file as hidden_unhide_file,
                )
                from app.services.media.category_query_service import get_category_by_id

                payload = self.schema('media_action').require(expect_json())
                category_id = payload['category_id']
                rel_path = payload['rel_path']
                action = payload['action']

                category = get_category_by_id(category_id)
                if not category or not category.get('path'):
                    return {'success': False, 'error': 'Category not found'}, 404

                file_path = self._resolve_rel_media_path(category['path'], rel_path)
                if not file_path:
                    return {'success': False, 'error': 'Invalid rel_path'}, 400

                admin_session_id = get_request_session_id()

                if action == 'delete':
                    success, message = storage_media_file_service.delete_file(file_path)
                    if not success:
                        return {'success': False, 'error': message}, 400

                    self._refresh_category_cache(category_id)
                    return {'success': True, 'message': message}

                if action == 'rename':
                    new_name = (payload.get('new_name') or '').strip()
                    if not new_name:
                        return {
                            'success': False,
                            'error': 'new_name is required for rename',
                        }, 400

                    success, message, new_path = storage_media_file_service.rename_file(
                        file_path,
                        new_name,
                    )
                    if not success:
                        return {'success': False, 'error': message}, 400

                    new_url = (
                        storage_path_service.get_media_url_from_path(new_path)
                        if new_path else None
                    )
                    self._refresh_category_cache(category_id)
                    return {
                        'success': True,
                        'message': message,
                        'new_path': new_path,
                        'new_name': os.path.basename(new_path) if new_path else None,
                        'new_url': new_url,
                    }

                if action == 'hide':
                    success, message = hidden_hide_file(
                        file_path,
                        category_id,
                        admin_session_id,
                    )
                    if not success:
                        return {'success': False, 'error': message}, 500
                    self._refresh_category_cache(category_id)
                    self._emit_media_record_invalidation(
                        'file_hidden',
                        category_id,
                        file_path,
                    )
                    logger.info(
                        "Admin %s hid file via quick action: %s",
                        admin_session_id,
                        file_path,
                    )
                    return {'success': True, 'message': message}

                success, message = hidden_unhide_file(file_path)
                if not success:
                    return {'success': False, 'error': message}, 500
                self._refresh_category_cache(category_id)
                self._emit_media_record_invalidation(
                    'file_unhidden',
                    category_id,
                    file_path,
                )
                logger.info(
                    "Admin %s unhid file via quick action: %s",
                    admin_session_id,
                    file_path,
                )
                return {'success': True, 'message': message}
            except Exception as exc:
                logger.error("Error in media_quick_action: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/categories/show-status', methods=['GET'])
        def get_show_hidden_status():
            """Get current show_hidden session status."""
            try:
                if not is_current_admin_session():
                    return {
                        'active': False,
                        'remaining_seconds': 0,
                        'reason': 'not_admin',
                    }

                show_hidden = session.get('show_hidden', False)
                if not show_hidden:
                    return {
                        'active': False,
                        'remaining_seconds': 0,
                        'reason': 'not_set',
                    }

                timestamp = session.get('show_hidden_timestamp', 0)
                duration = session.get('show_hidden_duration', 3600)
                elapsed = time.time() - timestamp
                remaining = max(0, duration - elapsed)

                if remaining <= 0:
                    session.pop('show_hidden', None)
                    session.pop('show_hidden_timestamp', None)
                    session.pop('show_hidden_duration', None)
                    session.modified = True
                    return {
                        'active': False,
                        'remaining_seconds': 0,
                        'reason': 'expired',
                    }

                return {
                    'active': True,
                    'remaining_seconds': int(remaining),
                    'duration': duration,
                }
            except Exception as exc:
                logger.error("Error getting show_hidden status: %s", exc)
                return {
                    'active': False,
                    'remaining_seconds': 0,
                    'error': str(exc),
                }, 500

        @router.route('/categories/clear-session', methods=['POST'])
        def clear_hidden_session():
            """Clear the current admin session's show_hidden flag."""
            try:
                session.pop('show_hidden', None)
                session.pop('show_hidden_timestamp', None)
                session.pop('show_hidden_duration', None)
                session.modified = True

                admin_session_id = get_request_session_id()
                logger.info("Cleared show_hidden session for: %s", admin_session_id)

                self._emit_category_refresh_to_session(
                    admin_session_id,
                    {
                        'reason': 'show_hidden_disabled',
                        'session_only': True,
                        'show_hidden': False,
                        'invalidateAll': True,
                        'timestamp': time.time(),
                    },
                )

                return {'success': True}
            except Exception as exc:
                logger.error("Error clearing hidden session: %s", exc)
                return {'success': False, 'error': str(exc)}, 500

        @router.route('/categories/hidden', methods=['GET'])
        @admin_required
        def get_hidden_categories():
            """Get all hidden categories with metadata."""
            try:
                from app.services.media.hidden_content_service import (
                    get_hidden_categories_with_details,
                )
                from app.services.media.category_query_service import get_all_categories_with_details

                hidden_items = get_hidden_categories_with_details()
                all_categories = {
                    category['id']: category
                    for category in get_all_categories_with_details(
                        show_hidden=True,
                    )
                }

                enriched_items = []
                for item in hidden_items:
                    category = all_categories.get(item['category_id'])
                    enriched_items.append({
                        'category_id': item['category_id'],
                        'category_name': (
                            category['name']
                            if category else item['category_id']
                        ),
                        'hidden_at': item['hidden_at'],
                        'hidden_by': item['hidden_by'],
                    })

                return {'hidden_categories': enriched_items}
            except Exception as exc:
                logger.error("Error getting hidden categories: %s", exc)
                return {'error': str(exc)}, 500

    def _normalize_category_id(self, category_id):
        if category_id and str(category_id).startswith('auto-'):
            return "auto::" + str(category_id)[5:].replace('-', '::')
        return category_id

    def _emit_category_refresh_to_session(self, session_id, payload):
        for sid in session_store.list_session_sids(session_id):
            registry.require('library_events').emit_category_updated(payload, room=sid)

    def _emit_media_record_invalidation(self, reason, category_id, file_path):
        stable_id = self._stable_media_id_for_file_path(category_id, file_path)
        payload = {
            'reason': reason,
            'category_id': category_id,
            'media_url': self._media_url_for_file_path(file_path),
            'invalidateCategory': True,
            'timestamp': time.time(),
        }
        if stable_id:
            payload['invalidatedIds'] = [stable_id]
        registry.require('library_events').emit_category_updated(payload)

    def _media_url_for_file_path(self, file_path):
        if not file_path:
            return None
        try:
            from app.services.storage.storage_path_service import get_media_url_from_path

            return get_media_url_from_path(file_path)
        except Exception as exc:
            logger.debug("Could not derive media URL for %s: %s", file_path, exc)
            return None

    def _stable_media_id_for_file_path(self, category_id, file_path):
        if not category_id or not file_path:
            return None
        try:
            from app.services.media.category_query_service import get_category_by_id

            category = get_category_by_id(category_id)
            category_root = category.get('path') if category else None
            if not category_root:
                return None
            rel_path = os.path.relpath(file_path, category_root).replace(os.sep, '/')
            if rel_path.startswith('..'):
                return None
            return f"{category_id}::{rel_path}"
        except Exception as exc:
            logger.debug("Could not derive stable media id for %s: %s", file_path, exc)
            return None

    def _refresh_category_cache(self, category_id=None):
        from app.services.media.category_cache_service import (
            invalidate_cache,
            update_cached_category,
        )

        if category_id:
            update_cached_category(category_id)
        else:
            invalidate_cache()

    def _batch_file_visibility(self, action, files):
        from app.services.media.hidden_content_service import (
            hide_file as hidden_hide_file,
            unhide_category as hidden_unhide_category,
            unhide_file as hidden_unhide_file,
        )
        from app.services.storage.storage_drive_service import is_managed_storage_path

        admin_session_id = get_request_session_id()
        results = []
        affected_category_ids = set()
        invalidated_ids = []

        for entry in files:
            file_path = entry.get('file_path') if isinstance(entry, dict) else None
            category_id = entry.get('category_id') if isinstance(entry, dict) else None
            item = {'file_path': file_path, 'success': False}

            try:
                if not file_path:
                    item['error'] = 'file_path is required'
                elif not is_managed_storage_path(file_path):
                    item['error'] = 'Access denied'
                else:
                    if not category_id:
                        category_id = self._resolve_file_category_id(file_path)

                    if action == 'hide':
                        success, message = hidden_hide_file(file_path, category_id, admin_session_id)
                    else:
                        success, message = hidden_unhide_file(file_path)
                        if success and category_id:
                            hidden_unhide_category(category_id, cascade=False)

                    if success:
                        stable_id = self._stable_media_id_for_file_path(category_id, file_path)
                        if category_id:
                            affected_category_ids.add(category_id)
                        if stable_id:
                            invalidated_ids.append(stable_id)
                        item.update({
                            'success': True,
                            'message': message,
                            'category_id': category_id,
                            'media_url': self._media_url_for_file_path(file_path),
                        })
                    else:
                        item['error'] = message
            except Exception as exc:
                logger.debug("File visibility batch item failed for %s: %s", file_path, exc)
                item['error'] = str(exc)
            results.append(item)

        for category_id in affected_category_ids:
            self._refresh_category_cache(category_id)

        reason = 'files_hidden' if action == 'hide' else 'files_unhidden'
        for category_id in affected_category_ids:
            registry.require('library_events').emit_category_updated({
                'reason': reason,
                'category_id': category_id,
                'invalidatedIds': [
                    media_id for media_id in invalidated_ids
                    if media_id.startswith(f'{category_id}::')
                ],
                'force_refresh': True,
                'invalidateCategory': True,
                'timestamp': time.time(),
            })

        updated = sum(1 for item in results if item.get('success'))
        return {
            'updated': updated,
            'failed': len(results) - updated,
            'results': results,
            'affected_category_ids': sorted(affected_category_ids),
            'invalidated_media_ids': invalidated_ids,
        }

    def _resolve_file_category_id(self, file_path):
        from app.services.media.category_query_service import get_all_categories_with_details

        categories = get_all_categories_with_details(use_cache=True)
        best_match = None
        max_len = 0
        normalized_file_path = os.path.normpath(str(file_path))

        for category in categories:
            category_path = category.get('path')
            if not category_path:
                continue
            normalized_category_path = os.path.normpath(category_path)
            if normalized_file_path.startswith(normalized_category_path):
                if len(normalized_category_path) > max_len:
                    max_len = len(normalized_category_path)
                    best_match = category['id']

        return best_match

    def _resolve_rel_media_path(self, category_root, rel_path):
        if not isinstance(rel_path, str) or not rel_path.strip():
            return None
        if os.path.isabs(rel_path):
            return None

        category_root = os.path.realpath(category_root)
        file_path = os.path.realpath(os.path.join(category_root, rel_path))
        if os.path.commonpath([category_root, file_path]) != category_root:
            return None
        return file_path
