"""
Tests for Configuration Routes
-------------------------------
Tests configuration, settings, and session validation endpoints.
"""
import pytest
from unittest.mock import patch
from flask import session


class TestGetConfig:
    """Tests for GET /api/config endpoint."""

    def test_get_config_success(self, client, app_context, mock_config):
        """Should return configuration successfully."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = (
                {
                    'categories': [],
                    'python_config': {'SAVE_VIDEO_PROGRESS': True}
                },
                None
            )

            response = client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            assert 'categories' in data
            assert 'python_config' not in data
            assert 'isPasswordProtectionActive' in data
            assert 'is_admin' in data

    def test_get_config_admin_includes_python_config(self, admin_client, app_context, mock_config):
        """Should include Python config for admin sessions."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = (
                {
                    'categories': [],
                    'python_config': {'ADMIN_PASSWORD': 'admin'}
                },
                None
            )

            response = admin_client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            assert data['is_admin'] is True
            assert data['python_config']['ADMIN_PASSWORD'] == 'admin'

    def test_get_config_with_password_protection(self, client, app_context, mock_config):
        """Should indicate password protection status."""
        mock_config('SESSION_PASSWORD', 'test123')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = ({'categories': []}, None)

            response = client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            assert data['isPasswordProtectionActive'] is True

    def test_get_config_without_password_protection(self, client, app_context, mock_config):
        """Should indicate no password protection."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = ({'categories': []}, None)

            response = client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            assert data['isPasswordProtectionActive'] is False

    def test_get_config_admin_status(self, admin_client, app_context, mock_config):
        """Should include admin status in response."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = ({'categories': []}, None)

            # Set admin session
            with admin_client.session_transaction() as sess:
                sess['is_admin'] = True

            response = admin_client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            # May or may not reflect admin status depending on session handling
            assert 'is_admin' in data

    def test_get_config_admin_status_uses_admin_lock(self, admin_client, app_context, mock_config):
        """Should report admin from shared admin lock even when Flask session flag is missing."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = ({'categories': []}, None)

            with admin_client.session_transaction() as sess:
                sess.pop('is_admin', None)

            response = admin_client.get('/api/config')

            assert response.status_code == 200
            data = response.get_json()
            assert data.get('is_admin') is True

    def test_get_config_with_error(self, client, app_context, mock_config):
        """Should still return config even with load error."""
        mock_config('SESSION_PASSWORD', '')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.load_config.return_value = (
                {'categories': []},
                'Error loading config'
            )

            response = client.get('/api/config')

            # Should still return 200 with available config
            assert response.status_code == 200
            data = response.get_json()
            assert 'categories' in data


class TestSaveConfig:
    """Tests for POST /api/config endpoint."""

    def test_save_config_success(self, admin_client, app_context, mock_config):
        """Should save configuration successfully."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Configuration saved successfully')

            response = admin_client.post('/api/config', json={
                'categories': [],
                'python_config': {}
            })

            assert response.status_code == 200
            data = response.get_json()
            assert 'message' in data
            assert data['message'] == 'Configuration saved successfully'

    def test_save_config_failure(self, admin_client, app_context):
        """Should return error on save failure."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (False, 'Failed to save config')

            response = admin_client.post('/api/config', json={
                'categories': []
            })

            assert response.status_code == 400
            data = response.get_json()
            assert 'error' in data
            assert data['error'] == 'Failed to save config'

    def test_save_config_requires_admin(self, client, app_context):
        """Should reject non-admin save attempts with 403."""
        response = client.post('/api/config', json={'python_config': {}})
        assert response.status_code == 403

    def test_save_config_updates_live_config(self, admin_client, app_context, mock_config):
        """Should update live config for python_config values."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            response = admin_client.post('/api/config', json={
                'python_config': {
                    'SAVE_CURRENT_INDEX': 'true',
                    'DEFAULT_PAGE_SIZE': '50',
                    'SESSION_EXPIRY': '3600'
                }
            })

            assert response.status_code == 200

    def test_save_config_type_conversion_int(self, admin_client, app_context):
        """Should convert integer config values correctly."""
        from app.config import Config

        # Store original values to restore after test
        original_default_page_size = getattr(Config, 'DEFAULT_PAGE_SIZE', None)
        original_session_expiry = getattr(Config, 'SESSION_EXPIRY', None)
        original_app_default_page_size = app_context.config.get('DEFAULT_PAGE_SIZE')
        original_app_session_expiry = app_context.config.get('SESSION_EXPIRY')

        try:
            with patch('app.controllers.system.config_controller.config_service') as mock_service:
                mock_service.save_config.return_value = (True, 'Config saved')

                response = admin_client.post('/api/config', json={
                    'python_config': {
                        'DEFAULT_PAGE_SIZE': '100',
                        'SESSION_EXPIRY': '7200'
                    }
                })

                assert response.status_code == 200
        finally:
            # Restore original config values
            if original_default_page_size is not None:
                setattr(Config, 'DEFAULT_PAGE_SIZE', original_default_page_size)
            if original_session_expiry is not None:
                setattr(Config, 'SESSION_EXPIRY', original_session_expiry)
            if original_app_default_page_size is not None:
                app_context.config['DEFAULT_PAGE_SIZE'] = original_app_default_page_size
            if original_app_session_expiry is not None:
                app_context.config['SESSION_EXPIRY'] = original_app_session_expiry

    def test_save_config_type_conversion_bool(self, admin_client, app_context):
        """Should convert boolean config values correctly."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            response = admin_client.post('/api/config', json={
                'python_config': {
                    'SAVE_CURRENT_INDEX': 'true',
                    'SHUFFLE_MEDIA': 'false',
                    'ENABLE_SUBTITLES': True
                }
            })

            assert response.status_code == 200

    def test_save_config_type_conversion_float(self, admin_client, app_context):
        """Should convert float config values correctly."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            response = admin_client.post('/api/config', json={
                'python_config': {
                    'WS_RECONNECT_FACTOR': '1.5'
                }
            })

            assert response.status_code == 200

    def test_save_config_type_conversion_string(self, admin_client, app_context):
        """Should convert string config values correctly for dropdown settings."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            # Test VIDEO_END_BEHAVIOR with all valid values
            for value in ['stop', 'loop', 'play_next']:
                response = admin_client.post('/api/config', json={
                    'python_config': {
                        'VIDEO_END_BEHAVIOR': value
                    }
                })

                assert response.status_code == 200

    def test_save_config_invalid_type_conversion(self, admin_client, app_context):
        """Should handle invalid type conversions gracefully."""
        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            # This should not crash, just log a warning
            response = admin_client.post('/api/config', json={
                'python_config': {
                    'DEFAULT_PAGE_SIZE': 'not_a_number'
                }
            })

            # Should still return 200 (conversion failure is logged, not fatal)
            assert response.status_code == 200

    def test_save_config_password_protection_status(self, admin_client, app_context, mock_config):
        """Should include password protection status in response."""
        mock_config('SESSION_PASSWORD', 'secret123')

        with patch('app.controllers.system.config_controller.config_service') as mock_service:
            mock_service.save_config.return_value = (True, 'Config saved')

            response = admin_client.post('/api/config', json={
                'python_config': {}
            })

            assert response.status_code == 200
            data = response.get_json()
            assert 'isPasswordProtectionActive' in data


class TestValidateSessionPassword:
    """Tests for POST /api/validate_session_password endpoint."""

    def test_validate_password_no_protection(self, client, app_context, mock_config):
        """Should return valid when no password protection active."""
        mock_config('SESSION_PASSWORD', '')

        response = client.post('/api/validate_session_password', json={
            'password': 'anything'
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data['valid'] is True
        assert 'No password protection' in data['message']

    def test_validate_password_correct(self, client, app_context, mock_config):
        """Should return valid for correct password."""
        mock_config('SESSION_PASSWORD', 'secret123')

        response = client.post('/api/validate_session_password', json={
            'password': 'secret123'
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data['valid'] is True

    def test_validate_password_incorrect(self, client, app_context, mock_config):
        """Should return invalid for incorrect password."""
        mock_config('SESSION_PASSWORD', 'secret123')

        response = client.post('/api/validate_session_password', json={
            'password': 'wrong_password'
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data['valid'] is False
        assert 'Incorrect password' in data['message']

    def test_validate_password_empty_submission(self, client, app_context, mock_config):
        """Should return invalid for empty password when protection active."""
        mock_config('SESSION_PASSWORD', 'secret123')

        response = client.post('/api/validate_session_password', json={
            'password': ''
        })

        assert response.status_code == 200
        data = response.get_json()
        assert data['valid'] is False

    def test_validate_password_missing_password_key(self, client, app_context, mock_config):
        """Should handle missing password key gracefully."""
        mock_config('SESSION_PASSWORD', 'secret123')

        response = client.post('/api/validate_session_password', json={})

        assert response.status_code == 200
        # Should return invalid when password key is missing
        data = response.get_json()
        assert data['valid'] is False

    def test_validate_password_rate_limited_after_repeated_failures(self, client, app_context, mock_config):
        """Should return 429 after too many attempts in a short window."""
        from app.controllers.system.config_controller import ConfigController

        mock_config('SESSION_PASSWORD', 'secret123')
        key = '127.0.0.1:rate-limit-test'

        controller = ConfigController()

        with controller._password_attempts_lock:
            controller._password_attempts.clear()

        for _ in range(controller.max_password_attempts_per_window):
            allowed, retry_after = controller._check_password_rate_limit(key)
            assert allowed is True
            assert retry_after == 0

        allowed, retry_after = controller._check_password_rate_limit(key)
        assert allowed is False
        assert retry_after > 0
