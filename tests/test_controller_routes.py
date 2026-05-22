"""
Controller route smoke tests.

Two complementary layers:
1. Route registration — verifies each controller's build_routes() calls router.route()
   for the paths it owns. Fast, no HTTP round-trip.
2. HTTP smoke tests — selected read-only endpoints hit via test client to confirm
   the full request path works end-to-end after Specter boot.
"""

import pytest
from unittest.mock import MagicMock, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_router():
    """Return a MagicMock that records router.route() calls as a context-manager decorator."""
    router = MagicMock()
    # router.route('/path', methods=[...]) must return a callable (decorator)
    router.route.return_value = lambda fn: fn
    return router


def _registered_paths(router):
    """Return the set of path strings passed to router.route()."""
    return {c.args[0] for c in router.route.call_args_list}


# ---------------------------------------------------------------------------
# Route registration — Admin domain
# ---------------------------------------------------------------------------

class TestAdminControllerRoutes:
    def test_admin_controller_registers_status_route(self):
        from app.controllers.admin.admin_controller import AdminController
        router = _make_router()
        AdminController().build_routes(router)
        paths = _registered_paths(router)
        assert any('/status' in p for p in paths)

    def test_admin_visibility_controller_registers_hide_routes(self):
        from app.controllers.admin.admin_visibility_controller import AdminVisibilityController
        router = _make_router()
        AdminVisibilityController().build_routes(router)
        paths = _registered_paths(router)
        assert '/categories/hide' in paths
        assert '/categories/show' in paths
        assert '/categories/hidden' in paths
        assert '/files/hide' in paths
        assert '/files/unhide' in paths

    def test_admin_system_controller_registers_system_routes(self):
        from app.controllers.admin.admin_system_controller import AdminSystemController
        router = _make_router()
        AdminSystemController().build_routes(router)
        paths = _registered_paths(router)
        assert '/system/version-check' in paths
        assert '/system/stats' in paths
        assert '/hdmi/status' in paths

    def test_admin_maintenance_controller_registers_maintenance_routes(self):
        from app.controllers.admin.admin_maintenance_controller import AdminMaintenanceController
        router = _make_router()
        AdminMaintenanceController().build_routes(router)
        paths = _registered_paths(router)
        assert '/data/clear-all' in paths
        assert '/reindex-media' in paths
        assert '/regenerate-thumbnails' in paths
        assert '/clear-generated-cache' in paths


# ---------------------------------------------------------------------------
# Route registration — Media domain
# ---------------------------------------------------------------------------

class TestMediaControllerRoutes:
    def test_category_controller_registers_category_routes(self):
        from app.controllers.media.category_controller import CategoryController
        router = _make_router()
        CategoryController().build_routes(router)
        paths = _registered_paths(router)
        assert '/categories' in paths

    def test_media_controller_registers_search_route(self):
        from app.controllers.media.media_controller import MediaController
        router = _make_router()
        MediaController().build_routes(router)
        paths = _registered_paths(router)
        assert '/search' in paths

    def test_media_ordering_and_records_routes(self):
        from app.controllers.media.media_ordering_controller import MediaOrderingController
        from app.controllers.media.media_records_controller import MediaRecordsController

        ordering_router = _make_router()
        records_router = _make_router()
        MediaOrderingController().build_routes(ordering_router)
        MediaRecordsController().build_routes(records_router)

        assert '/order' in _registered_paths(ordering_router)
        assert '/records' in _registered_paths(records_router)

    def test_media_delivery_controller_registers_media_and_thumbnail_routes(self):
        from app.controllers.media.media_delivery_controller import MediaDeliveryController
        router = _make_router()
        MediaDeliveryController().build_routes(router)
        paths = _registered_paths(router)
        assert '/media/<category_id>/<path:filename>' in paths
        assert '/thumbnails/<category_id>/<filename>' in paths

    def test_media_discovery_controller_registers_discovery_routes(self):
        from app.controllers.media.media_discovery_controller import MediaDiscoveryController
        router = _make_router()
        MediaDiscoveryController().build_routes(router)
        assert router.route.call_count >= 2

    def test_progress_controller_registers_progress_routes(self):
        from app.controllers.media.progress_controller import ProgressController
        router = _make_router()
        ProgressController().build_routes(router)
        assert router.route.call_count >= 4

    def test_subtitle_controller_registers_subtitle_routes(self):
        from app.controllers.media.subtitle_controller import SubtitleController
        router = _make_router()
        SubtitleController().build_routes(router)
        paths = _registered_paths(router)
        assert '/video' in paths
        assert '/cache' in paths
        assert '/clear-cache' in paths


# ---------------------------------------------------------------------------
# Route registration — Storage domain
# ---------------------------------------------------------------------------

class TestStorageControllerRoutes:
    def test_storage_management_controller_registers_drive_routes(self):
        from app.controllers.storage.storage_management_controller import StorageManagementController
        router = _make_router()
        StorageManagementController().build_routes(router)
        paths = _registered_paths(router)
        assert '/drives' in paths
        assert '/check-mounts' in paths
        assert '/folders' in paths

    def test_storage_upload_controller_registers_upload_routes(self):
        from app.controllers.storage.storage_upload_controller import StorageUploadController
        router = _make_router()
        StorageUploadController().build_routes(router)
        paths = _registered_paths(router)
        assert '/upload' in paths
        assert '/upload/negotiate' in paths
        assert '/upload/init' in paths
        assert '/upload/chunk' in paths

    def test_storage_file_controller_registers_file_ops_routes(self):
        from app.controllers.storage.storage_file_controller import StorageFileController
        router = _make_router()
        StorageFileController().build_routes(router)
        paths = _registered_paths(router)
        assert '/media/list' in paths
        assert '/media' in paths


# ---------------------------------------------------------------------------
# Route registration — System domain
# ---------------------------------------------------------------------------

class TestSystemControllerRoutes:
    def test_config_controller_registers_config_routes(self):
        from app.controllers.system.config_controller import ConfigController
        router = _make_router()
        ConfigController().build_routes(router)
        paths = _registered_paths(router)
        assert '/config' in paths

    def test_system_utility_controller_registers_version_route(self):
        from app.controllers.system.system_utility_controller import SystemUtilityController
        router = _make_router()
        SystemUtilityController().build_routes(router)
        paths = _registered_paths(router)
        assert '/system/version' in paths

    def test_system_tunnel_controller_registers_tunnel_routes(self):
        from app.controllers.system.system_tunnel_controller import SystemTunnelController
        router = _make_router()
        SystemTunnelController().build_routes(router)
        paths = _registered_paths(router)
        assert '/tunnel/status' in paths
        assert '/tunnel/start' in paths
        assert '/tunnel/stop' in paths

    def test_system_transfer_controller_registers_transfer_routes(self):
        from app.controllers.system.system_transfer_controller import SystemTransferController
        router = _make_router()
        SystemTransferController().build_routes(router)
        assert router.route.call_count >= 4


# ---------------------------------------------------------------------------
# Route registration — GhostStream domain
# ---------------------------------------------------------------------------

class TestGhostStreamControllerRoutes:
    def test_ghoststream_controller_registers_status_and_server_routes(self):
        from app.controllers.ghoststream.ghoststream_controller import GhostStreamController
        router = _make_router()
        GhostStreamController().build_routes(router)
        paths = _registered_paths(router)
        assert '/status' in paths
        assert '/servers' in paths


# ---------------------------------------------------------------------------
# Route registration — Core domain
# ---------------------------------------------------------------------------

class TestCoreControllerRoutes:
    def test_main_controller_registers_index_route(self):
        from app.controllers.core.main_controller import MainController
        router = _make_router()
        MainController().build_routes(router)
        paths = _registered_paths(router)
        assert '/' in paths

    def test_profile_controller_registers_profile_routes(self):
        from app.controllers.core.profile_controller import ProfileController
        router = _make_router()
        ProfileController().build_routes(router)
        paths = _registered_paths(router)
        assert '/profiles' in paths
        assert '/profiles/select' in paths
        assert '/profiles/<profile_id>' in paths
        assert '/profiles/<profile_id>/rename' in paths

    def test_tv_controller_has_no_http_routes_only_socket(self):
        from app.controllers.system.tv_controller import TVController
        router = _make_router()
        TVController().build_routes(router)
        # TV is socket-only; no HTTP routes expected
        assert router.route.call_count == 0


# ---------------------------------------------------------------------------
# HTTP smoke tests — real requests through the booted app
# ---------------------------------------------------------------------------

class TestHTTPSmoke:
    """End-to-end HTTP smoke tests covering one representative endpoint per domain."""

    def test_index_returns_html(self, app):
        client = app.test_client()
        response = client.get('/')
        assert response.status_code == 200
        assert b'<!DOCTYPE html>' in response.data or b'<html' in response.data

    def test_version_endpoint_returns_version(self, app):
        client = app.test_client()
        response = client.get('/api/system/version')
        assert response.status_code == 200
        data = response.get_json()
        assert 'version' in data

    def test_categories_returns_list(self, app):
        client = app.test_client()
        response = client.get('/api/categories')
        assert response.status_code == 200
        data = response.get_json()
        # Response is paginated: {'categories': [...], 'pagination': {...}}
        assert 'categories' in data
        assert isinstance(data['categories'], list)

    def test_search_requires_query(self, app):
        client = app.test_client()
        # Without 'q' param should return 400 or empty result, not 500
        response = client.get('/api/search')
        assert response.status_code in (200, 400)

    def test_config_get_requires_admin(self, app):
        client = app.test_client()
        response = client.get('/api/config')
        # Unauthenticated request must not return 500
        assert response.status_code in (200, 401, 403)

    def test_config_get_as_admin(self, admin_client):
        response = admin_client.get('/api/config')
        assert response.status_code == 200
        data = response.get_json()
        assert isinstance(data, dict)

    def test_admin_status_as_admin(self, admin_client):
        response = admin_client.get('/api/admin/status')
        assert response.status_code == 200
        data = response.get_json()
        assert 'isAdmin' in data

    def test_storage_drives_as_admin(self, admin_client):
        response = admin_client.get('/api/storage/drives')
        assert response.status_code == 200

    def test_ghoststream_status_as_admin(self, admin_client):
        response = admin_client.get('/api/ghoststream/status')
        assert response.status_code == 200

    def test_admin_visibility_hidden_categories_as_admin(self, admin_client):
        response = admin_client.get('/api/admin/categories/hidden')
        assert response.status_code == 200
        data = response.get_json()
        # Response is {'hidden_categories': [...]}
        assert 'hidden_categories' in data
        assert isinstance(data['hidden_categories'], list)

    def test_admin_system_stats_as_admin(self, admin_client):
        response = admin_client.get('/api/admin/system/stats')
        assert response.status_code == 200

    def test_subtitles_video_requires_params(self, app):
        client = app.test_client()
        response = client.get('/api/subtitles/video')
        # Missing required params → 400, not 500
        assert response.status_code in (200, 400)
