"""Tests for profile HTTP routes."""

from unittest.mock import MagicMock

import pytest


class TestProfileController:
    def test_list_profiles_returns_profiles_payload(self, client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Alice Controller List')
        client.set_cookie('localhost', 'session_id', 'list-session-id')
        response = client.get('/api/profiles')

        assert response.status_code == 200
        data = response.get_json()
        assert 'profiles' in data
        assert any(profile['id'] == created['id'] for profile in data['profiles'])

    def test_create_profile_route(self, admin_client, app_context):
        response = admin_client.post(
            '/api/profiles',
            json={'name': 'Bob', 'avatar_color': '#112233', 'avatar_icon': 'ghost'},
        )

        assert response.status_code == 201
        data = response.get_json()
        assert data['success'] is True
        assert data['profile']['name'] == 'Bob'
        assert data['profile']['avatar_color'] == '#112233'
        assert data['profile']['avatar_icon'] == 'ghost'

    def test_select_profile_sets_active_profile(self, client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Selector')
        response = client.post('/api/profiles/select', json={'profile_id': created['id']})

        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert data['profile']['id'] == created['id']
        assert data['active_profile']['id'] == created['id']
        assert any(profile['id'] == created['id'] for profile in data['profiles'])

        with client.session_transaction() as sess:
            assert sess.get('active_profile_id') == created['id']

    def test_select_profile_rejects_other_active_session(self, app, client, app_context):
        from app.services.core import profile_service, session_store

        created = profile_service.create_profile('Busy Profile')
        other_session_id = 'other-session-id'

        session_store.connect_client(
            other_session_id,
            'sid-other',
            '10.0.0.8',
            profile_id=created['id'],
            profile_name=created['name'],
        )

        client.set_cookie('localhost', 'session_id', 'new-session-id')
        response = client.post('/api/profiles/select', json={'profile_id': created['id']})

        assert response.status_code == 409
        assert response.get_json()['error'] == 'Profile is already active in another session.'

    def test_list_profiles_marks_profiles_active_elsewhere(self, app, client, app_context):
        from app.services.core import profile_service, session_store

        created = profile_service.create_profile('Occupied')
        session_store.connect_client(
            'other-session-id',
            'sid-other',
            '10.0.0.8',
            profile_id=created['id'],
            profile_name=created['name'],
        )

        client.set_cookie('localhost', 'session_id', 'new-session-id')
        response = client.get('/api/profiles')

        assert response.status_code == 200
        data = response.get_json()
        busy_profile = next(profile for profile in data['profiles'] if profile['id'] == created['id'])
        assert busy_profile['is_active_elsewhere'] is True
        assert busy_profile['is_active_in_session'] is True

    def test_delete_profile_route(self, admin_client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Delete Me')
        response = admin_client.delete(f"/api/profiles/{created['id']}")

        assert response.status_code == 200
        assert response.get_json()['success'] is True
        assert profile_service.get_profile(created['id']) is None

    def test_update_profile_route(self, admin_client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Movie Night Controller', '#112233')
        response = admin_client.patch(
            f"/api/profiles/{created['id']}",
            json={
                'name': 'Family Night Controller',
                'avatar_color': '#445566',
                'avatar_icon': 'orbit',
                'preferences': {
                    'theme': 'midnight',
                    'features': {'chat': False},
                },
            },
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert data['profile']['name'] == 'Family Night Controller'
        assert data['profile']['avatar_color'] == '#445566'
        assert data['profile']['avatar_icon'] == 'orbit'
        assert data['profile']['preferences']['theme'] == 'midnight'
        assert data['profile']['preferences']['features']['chat'] is False

    def test_select_profile_with_empty_payload_clears_active_profile(self, client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Selector Clear')
        response = client.post('/api/profiles/select', json={'profile_id': created['id']})
        assert response.status_code == 200

        cleared = client.post('/api/profiles/select', json={})
        assert cleared.status_code == 200
        data = cleared.get_json()
        assert data['success'] is True
        assert data['profile'] is None

        with client.session_transaction() as sess:
            assert sess.get('active_profile_id') is None

    def test_list_profiles_returns_active_profile_preferences(self, client, app_context):
        from app.services.core import profile_service

        created = profile_service.create_profile('Prefs User Active')
        profile_service.update_profile(
            created['id'],
            preferences={'theme': 'nord', 'features': {'chat': False}},
        )

        client.set_cookie('localhost', 'session_id', 'prefs-session-id')
        selected = client.post('/api/profiles/select', json={'profile_id': created['id']})
        assert selected.status_code == 200

        response = client.get('/api/profiles')
        assert response.status_code == 200
        data = response.get_json()
        assert data['active_profile']['preferences']['theme'] == 'nord'
        assert data['active_profile']['preferences']['features']['chat'] is False

    @pytest.mark.parametrize(
        ('method', 'path', 'payload'),
        [
            ('post', '/api/profiles/{profile_id}/rename', {'name': 'Blocked Rename'}),
            ('patch', '/api/profiles/{profile_id}', {'name': 'Blocked Patch'}),
            ('delete', '/api/profiles/{profile_id}', None),
        ],
    )
    def test_non_admin_cannot_mutate_another_profile(
        self,
        client,
        app_context,
        method,
        path,
        payload,
    ):
        from app.services.core import profile_service

        owned = profile_service.create_profile(f'Owned Profile {method}')
        other = profile_service.create_profile(f'Other Profile {method}')

        client.set_cookie('localhost', 'session_id', 'owner-session-id')
        with client.session_transaction() as sess:
            sess['active_profile_id'] = owned['id']

        response = getattr(client, method)(
            path.format(profile_id=other['id']),
            json=payload,
        )

        assert response.status_code == 403
        assert response.get_json()['error'] == 'You can only modify your own active profile.'

    def test_unauthenticated_client_cannot_list_profiles(self, client, app_context):
        response = client.get('/api/profiles')

        assert response.status_code == 401
        assert response.get_json()['error'] == 'Session password or administrator privileges required.'

    def test_profile_socket_events_are_scoped_to_current_session(self, client, app_context):
        from app.services.core import profile_service, session_store
        from specter import registry

        created = profile_service.create_profile('Socket Scoped')
        transport = registry.require('socket_transport')
        original_emit_to_sid = transport.emit_to_sid
        transport.emit_to_sid = MagicMock(return_value=True)

        try:
            session_store.connect_client(
                'session-a',
                'sid-a',
                '10.0.0.1',
            )
            session_store.connect_client(
                'session-b',
                'sid-b',
                '10.0.0.2',
            )

            client.set_cookie('localhost', 'session_id', 'session-a')
            response = client.post('/api/profiles/select', json={'profile_id': created['id']})

            assert response.status_code == 200
            emitted_rooms = {
                call.args[2]
                for call in transport.emit_to_sid.call_args_list
            }
            emitted_payloads = [
                call.args[1]
                for call in transport.emit_to_sid.call_args_list
            ]

            assert emitted_rooms == {'sid-a'}
            assert emitted_payloads == [{}]
        finally:
            transport.emit_to_sid = original_emit_to_sid
