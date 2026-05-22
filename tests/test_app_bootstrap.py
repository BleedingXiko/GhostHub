"""Tests for Specter service bootstrap helpers."""


def test_build_specter_services_returns_expected_service_manifest():
    """App boot should use a deterministic service manifest."""
    from app.app_bootstrap import build_specter_services

    services = build_specter_services()

    assert [service.name for service in services] == [
        'app_startup',
        'media_ordering',
        'media_records',
        'storage_drive_runtime',
        'user_data_transfer',
        'admin_events',
        'app_request_lifecycle',
        'chat_events',
        'factory_reset',
        'ghoststream_events',
        'ghoststream_runtime',
        'ghoststream_transcode_cache_runtime',
        'ghoststream_worker_boot',
        'hdmi_runtime_service',
        'headscale_runtime',
        'indexing_runtime',
        'library_events',
        'library_runtime',
        'media_storage_event_handler',
        'mesh_watchdog',
        'progress_events',
        'runtime_config',
        'socket_transport',
        'stale_media_cleanup_runtime',
        'storage_events',
        'storage_worker_boot',
        'sync_events',
        'thumbnail_runtime',
        'tunnel_url_capture',
        'tv_cast_service',
        'tv_events',
        'upload_session_runtime',
        'media_worker_boot',
        'system_worker_boot',
        'worker_runtime',
    ]
