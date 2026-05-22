"""Profile management controller built on Specter."""

import logging

from flask import request, session

from app.constants import SOCKET_EVENTS as SE
from app.services.core import profile_service, session_store
from specter import Controller, Field, HTTPError, Schema, expect_json, registry
from app.utils.auth import get_request_session_id, session_or_admin_required

logger = logging.getLogger(__name__)


class ProfileController(Controller):
    """Own profile CRUD and active-profile selection routes."""

    name = 'profile'
    url_prefix = '/api'

    schemas = {
        'create_profile': Schema('profile.create', {
            'name': Field(str, required=True),
            'avatar_color': Field(str),
            'avatar_icon': Field(str),
        }),
        'update_profile': Schema('profile.update', {
            'name': Field(str),
            'avatar_color': Field(str),
            'avatar_icon': Field(str),
            'preferences': Field(dict),
        }),
        'rename_profile': Schema('profile.rename', {
            'name': Field(str, required=True),
        }),
    }

    @staticmethod
    def _transport():
        return registry.require('socket_transport')

    @staticmethod
    def _current_session_id():
        return get_request_session_id()

    @classmethod
    def _require_established_session_or_admin(cls):
        """Reject profile enumeration for requests without an established session."""
        if session_store.is_admin_session(cls._current_session_id()):
            return
        if cls._current_session_id():
            return
        raise HTTPError(
            'Session password or administrator privileges required.',
            status=401,
        )

    @staticmethod
    def _require_profile_owner_or_admin(profile_id):
        """Raise 403 unless the caller's active profile matches or caller is admin."""
        current_session_id = get_request_session_id()
        if session_store.is_admin_session(current_session_id):
            return
        if session.get('active_profile_id') == profile_id:
            owner_session_id = session_store.get_profile_owner_session(profile_id)
            if owner_session_id and owner_session_id != current_session_id:
                raise HTTPError(
                    'Profile is currently active in another session.',
                    status=409,
                )
            return
        raise HTTPError('You can only modify your own active profile.', status=403)

    def _emit_private_signal(self, event_name, session_ids):
        """Send a payload-less socket signal only to the provided sessions."""
        transport = self._transport()
        unique_session_ids = {
            session_id
            for session_id in (session_ids or [])
            if session_id
        }
        for session_id in unique_session_ids:
            for sid in session_store.list_session_sids(session_id):
                transport.emit_to_sid(event_name, {}, sid)

    def build_routes(self, router):
        @router.route(
            '/profiles',
            methods=['GET'],
            json_errors='Failed to list profiles',
        )
        @session_or_admin_required
        def list_profiles_route():
            self._require_established_session_or_admin()
            active_profile = self._get_active_profile()
            current_session_id = self._current_session_id()
            return {
                'profiles': self._annotate_profiles(
                    profile_service.list_profiles(),
                    current_session_id=current_session_id,
                ),
                'active_profile': self._annotate_profile(
                    active_profile,
                    current_session_id=current_session_id,
                ),
            }

        @router.route(
            '/profiles',
            methods=['POST'],
            json_errors='Failed to create profile',
        )
        @session_or_admin_required
        def create_profile_route():
            payload = self.schema('create_profile').require(expect_json())
            try:
                profile = profile_service.create_profile(
                    payload.get('name'),
                    payload.get('avatar_color'),
                    payload.get('avatar_icon'),
                )
            except ValueError as exc:
                raise HTTPError(str(exc), status=400)

            self._emit_profiles_changed({self._current_session_id()})
            return {'success': True, 'profile': profile}, 201

        @router.route(
            '/profiles/<profile_id>',
            methods=['DELETE'],
            json_errors='Failed to delete profile',
        )
        @session_or_admin_required
        def delete_profile_route(profile_id):
            self._require_profile_owner_or_admin(profile_id)
            current_session_id = self._current_session_id()
            owner_session_id = session_store.get_profile_owner_session(profile_id)
            active_profile_id = session.get('active_profile_id')
            deleted = profile_service.delete_profile(profile_id)
            if not deleted:
                raise HTTPError('Profile not found.', status=404)

            if active_profile_id == profile_id:
                self._clear_active_profile()
            if owner_session_id:
                self._emit_profile_selected({owner_session_id})

            self._emit_profiles_changed({current_session_id, owner_session_id})
            return {'success': True}

        @router.route(
            '/profiles/select',
            methods=['POST'],
            json_errors='Failed to select profile',
        )
        @session_or_admin_required
        def select_profile_route():
            payload = request.get_json(silent=True) or {}
            profile_id = payload.get('profile_id')
            current_session_id = self._current_session_id()

            if not profile_id:
                self._clear_active_profile()
                self._emit_profile_selected({current_session_id})
                return {
                    'success': True,
                    'profile': None,
                    **self._profiles_state_payload(active_profile=None),
                }

            profile = profile_service.get_profile(profile_id)
            if not profile:
                self._clear_active_profile()
                raise HTTPError('Profile not found.', status=404)

            active_owner = session_store.get_profile_owner_session(
                profile['id'],
                exclude_session_id=current_session_id,
            )
            if active_owner:
                raise HTTPError(
                    'Profile is already active in another session.',
                    status=409,
                )

            session['active_profile_id'] = profile['id']
            session.modified = True

            if current_session_id:
                session_store.update_connection_profile(
                    current_session_id,
                    profile_id=profile['id'],
                    profile_name=profile['name'],
                )

            profile_service.update_profile_last_active(profile['id'])
            refreshed_profile = profile_service.get_profile(profile['id'])
            self._emit_profile_selected({current_session_id})
            return {
                'success': True,
                'profile': refreshed_profile,
                **self._profiles_state_payload(active_profile=refreshed_profile),
            }

        @router.route(
            '/profiles/<profile_id>/rename',
            methods=['POST'],
            json_errors='Failed to rename profile',
        )
        @session_or_admin_required
        def rename_profile_route(profile_id):
            self._require_profile_owner_or_admin(profile_id)
            payload = self.schema('rename_profile').require(expect_json())
            try:
                profile = profile_service.rename_profile(profile_id, payload.get('name'))
            except ValueError as exc:
                raise HTTPError(str(exc), status=400)

            if not profile:
                raise HTTPError('Profile not found.', status=404)

            current_session_id = self._current_session_id()
            owner_session_id = session_store.get_profile_owner_session(profile_id)
            if owner_session_id:
                session_store.update_connection_profile(
                    owner_session_id,
                    profile_id=profile['id'],
                    profile_name=profile['name'],
                )
                self._emit_profile_selected({owner_session_id})

            self._emit_profiles_changed({current_session_id, owner_session_id})
            return {'success': True, 'profile': profile}

        @router.route(
            '/profiles/<profile_id>',
            methods=['PATCH'],
            json_errors='Failed to update profile',
        )
        @session_or_admin_required
        def update_profile_route(profile_id):
            self._require_profile_owner_or_admin(profile_id)
            payload = self.schema('update_profile').require(expect_json())
            try:
                profile = profile_service.update_profile(
                    profile_id,
                    name=payload.get('name') if 'name' in payload else None,
                    avatar_color=payload.get('avatar_color') if 'avatar_color' in payload else None,
                    avatar_icon=payload.get('avatar_icon') if 'avatar_icon' in payload else None,
                    preferences=payload.get('preferences') if 'preferences' in payload else None,
                )
            except ValueError as exc:
                raise HTTPError(str(exc), status=400)

            if not profile:
                raise HTTPError('Profile not found.', status=404)

            current_session_id = self._current_session_id()
            owner_session_id = session_store.get_profile_owner_session(profile_id)
            if owner_session_id:
                session_store.update_connection_profile(
                    owner_session_id,
                    profile_id=profile['id'],
                    profile_name=profile['name'],
                )
                self._emit_profile_selected({owner_session_id})

            self._emit_profiles_changed({current_session_id, owner_session_id})
            return {'success': True, 'profile': profile}

    def _profiles_state_payload(self, active_profile=None):
        current_session_id = self._current_session_id()
        return {
            'profiles': self._annotate_profiles(
                profile_service.list_profiles(),
                current_session_id=current_session_id,
            ),
            'active_profile': self._annotate_profile(
                active_profile if active_profile is not None else self._get_active_profile(),
                current_session_id=current_session_id,
            ),
        }

    def _get_active_profile(self):
        active_profile_id = session.get('active_profile_id')
        if not active_profile_id:
            return None

        profile = profile_service.get_profile(active_profile_id)
        if profile:
            return profile

        self._clear_active_profile()
        return None

    def _clear_active_profile(self):
        session.pop('active_profile_id', None)
        session.modified = True

        current_session_id = get_request_session_id()
        if current_session_id:
            session_store.update_connection_profile(
                current_session_id,
                profile_id=None,
                profile_name=None,
            )

    def _emit_profiles_changed(self, session_ids):
        """Signal affected sessions to refetch profile state privately."""
        self._emit_private_signal(SE['PROFILES_CHANGED'], session_ids)

    def _emit_profile_selected(self, session_ids):
        """Signal affected sessions to refetch active-profile state privately."""
        self._emit_private_signal(SE['PROFILE_SELECTED'], session_ids)

    def _annotate_profile(self, profile, current_session_id=None):
        if not profile:
            return None

        owner_session_id = session_store.get_profile_owner_session(profile['id'])
        enriched_profile = dict(profile)
        enriched_profile['is_active_elsewhere'] = bool(
            owner_session_id and owner_session_id != current_session_id
        )
        enriched_profile['is_active_in_session'] = bool(owner_session_id)
        return enriched_profile

    def _annotate_profiles(self, profiles, current_session_id=None):
        return [
            self._annotate_profile(profile, current_session_id=current_session_id)
            for profile in profiles
        ]
