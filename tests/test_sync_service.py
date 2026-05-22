"""
Tests for Sync Controller runtime behavior.
"""

import time
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def sync_controller(app_context):
    """Return the booted sync controller with a clean in-memory state."""
    from specter import registry

    controller = registry.require('sync')
    controller.store.replace({
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
    return controller


class TestSyncController:
    def test_toggle_sync_mode_enable(self, sync_controller):
        fake_events = MagicMock()
        with patch.object(sync_controller, '_events', return_value=fake_events), \
             patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value='test-session-id'):
            status = sync_controller.toggle_sync(enable=True)

        assert status['active'] is True
        assert status['is_host'] is True
        assert sync_controller.is_sync_enabled() is True
        assert sync_controller.get_host_session_id() == 'test-session-id'
        fake_events.emit_sync_enabled.assert_called_once()

    def test_toggle_sync_mode_disable(self, sync_controller):
        fake_events = MagicMock()
        sync_controller.store.set({
            'enabled': True,
            'host_session_id': 'host-session-id',
        })

        with patch.object(sync_controller, '_events', return_value=fake_events), \
             patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value='host-session-id'):
            status = sync_controller.toggle_sync(enable=False)

        assert status['active'] is False
        assert sync_controller.is_sync_enabled() is False
        fake_events.emit_sync_disabled.assert_called_once()

    def test_toggle_sync_mode_disable_non_host_fails(self, sync_controller):
        fake_events = MagicMock()
        sync_controller.store.set({
            'enabled': True,
            'host_session_id': 'host-session-id',
        })

        with patch.object(sync_controller, '_events', return_value=fake_events), \
             patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value='guest-session-id'):
            status = sync_controller.toggle_sync(enable=False)

        assert status['active'] is True
        assert sync_controller.get_host_session_id() == 'host-session-id'
        fake_events.emit_sync_disabled.assert_not_called()

    def test_toggle_sync_mode_no_session(self, sync_controller):
        with patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value=None):
            status = sync_controller.toggle_sync(enable=True)

        assert status['active'] is False

    def test_update_current_media_host(self, sync_controller):
        fake_events = MagicMock()
        sync_controller.store.set({
            'enabled': True,
            'host_session_id': 'host-id',
        })

        with patch.object(sync_controller, '_events', return_value=fake_events), \
             patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value='host-id'):
            success, error = sync_controller.update_current_media(
                {
                    'category_id': 'cat1',
                    'viewKey': 'viewer::cat1',
                    'viewType': 'streaming_row',
                    'viewParams': {'category_id': 'cat1'},
                    'mediaId': 'cat1::video.mp4',
                }
            )

        assert success is True
        assert error is None
        state = sync_controller.get_current_media()
        assert state['category_id'] == 'cat1'
        assert state['mediaId'] == 'cat1::video.mp4'
        fake_events.emit_sync_state.assert_called_once()

    def test_update_current_media_client_fails(self, sync_controller):
        sync_controller.store.set({
            'enabled': True,
            'host_session_id': 'host-id',
        })

        with patch('app.controllers.streaming.sync_controller.get_request_session_id', return_value='client-id'):
            success, error = sync_controller.update_current_media(
                {
                    'category_id': 'cat1',
                    'viewKey': 'viewer::cat1',
                    'viewType': 'streaming_row',
                    'viewParams': {'category_id': 'cat1'},
                    'mediaId': 'cat1::video.mp4',
                }
            )

        assert success is False
        assert "Only the host" in error

    def test_update_session_state(self, sync_controller):
        success = sync_controller.update_session_state(
            session_id='user-1',
            media_payload={
                'category_id': 'movies',
                'viewKey': 'viewer::movies',
                'viewType': 'streaming_row',
                'viewParams': {'category_id': 'movies'},
                'mediaId': 'movies::clip.mp4',
            },
        )

        assert success is True
        state = sync_controller.get_session_state('user-1')
        assert state is not None
        assert state['category_id'] == 'movies'
        assert state['mediaId'] == 'movies::clip.mp4'

    def test_get_session_state_prefix_match(self, sync_controller):
        sync_controller.update_session_state('very-long-session-uuid-12345', {
            'category_id': 'cat',
            'viewKey': 'viewer::cat',
            'viewType': 'streaming_row',
            'viewParams': {'category_id': 'cat'},
            'mediaId': 'cat::one.mp4',
        })

        assert sync_controller.get_session_state('very-long-session-uuid-12345') is not None
        assert sync_controller.get_session_state('very-long') is not None
        assert sync_controller.get_session_state('wrong-prefix') is None

    def test_update_session_state_prunes_stale_sessions(self, sync_controller):
        from app.controllers.streaming.sync_controller import SESSION_STATE_EXPIRY

        stale_time = time.time() - (SESSION_STATE_EXPIRY + 10)
        sync_controller.store.set({
            'session_states': {
                'stale-1': {
                    'category_id': 'old',
                    'mediaId': 'old::1.mp4',
                    'timestamp': stale_time,
                },
                'stale-2': {
                    'category_id': 'old',
                    'mediaId': 'old::2.mp4',
                    'timestamp': stale_time,
                },
            }
        })

        sync_controller.update_session_state('fresh', {
            'category_id': 'new',
            'viewKey': 'viewer::new',
            'viewType': 'streaming_row',
            'viewParams': {'category_id': 'new'},
            'mediaId': 'new::0.mp4',
        })

        states = sync_controller.store.get('session_states')
        assert 'fresh' in states
        assert 'stale-1' not in states
        assert 'stale-2' not in states
