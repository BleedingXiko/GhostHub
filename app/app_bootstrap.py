"""Application bootstrap helpers for Flask/Specter composition."""

import logging
from datetime import timedelta

from flask_socketio import SocketIO

from app.config import Config, config_by_name
from app.utils.log_utils import LogObfuscationFilter


def configure_root_logging() -> None:
    """Configure root logging and obfuscation once per process."""
    log_level = logging.DEBUG if Config.DEBUG_MODE else logging.WARNING
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )

    root_logger = logging.getLogger()
    if not any(isinstance(current, LogObfuscationFilter) for current in root_logger.filters):
        root_logger.addFilter(LogObfuscationFilter())

    for handler in root_logger.handlers:
        if not any(isinstance(current, LogObfuscationFilter) for current in handler.filters):
            handler.addFilter(LogObfuscationFilter())


def create_socketio() -> SocketIO:
    """Create the shared Socket.IO server with GhostHub defaults."""
    return SocketIO(
        async_mode='gevent',
        ping_timeout=120,
        ping_interval=10,
        cors_allowed_origins="*",
        max_http_buffer_size=50 * 1024 * 1024,
        engineio_logger=False,
        logger=False,
    )


def configure_flask_app(app, config_name: str) -> None:
    """Apply Flask config normalization owned by the app composition layer."""
    app.config.from_object(config_by_name[config_name])

    raw_secure_setting = app.config.get('SESSION_COOKIE_SECURE', False)
    if isinstance(raw_secure_setting, str):
        secure_mode = raw_secure_setting.strip().lower()
        if secure_mode not in ('auto', 'true', 'false'):
            secure_mode = 'auto'
        app.config['SESSION_COOKIE_SECURE'] = secure_mode == 'true'
        app.config['SESSION_COOKIE_SECURE_MODE'] = secure_mode
    else:
        app.config['SESSION_COOKIE_SECURE'] = bool(raw_secure_setting)
        app.config['SESSION_COOKIE_SECURE_MODE'] = (
            'true' if app.config['SESSION_COOKIE_SECURE'] else 'false'
        )

    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024 * 1024
    app.config['PROPAGATE_EXCEPTIONS'] = True

    session_expiry_seconds = app.config.get('SESSION_EXPIRY', 604800)
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(seconds=session_expiry_seconds)


def build_specter_services():
    """Build the Specter-owned product/core services for app boot."""
    from app.services.core.admin_event_service import AdminEventService
    from app.services.core.app_request_lifecycle_service import AppRequestLifecycleService
    from app.services.core.app_startup_service import AppStartupService
    from app.services.core.runtime_config_service import RuntimeConfigService
    from app.services.core.socket_transport_service import SocketTransportService
    from app.services.core.stale_media_cleanup_runtime_service import (
        StaleMediaCleanupRuntimeService,
    )
    from app.services.core.worker_runtime_service import WorkerRuntimeService
    from app.services.ghoststream.ghoststream_event_service import GhostStreamEventService
    from app.services.ghoststream.ghoststream_runtime_service import GhostStreamRuntimeService
    from app.services.ghoststream.transcode_cache_service import (
        TranscodeCacheRuntimeService,
    )
    from app.services.ghoststream.worker_boot_service import GhostStreamWorkerBootService
    from app.services.media.indexing_runtime_service import IndexingRuntimeService
    from app.services.media.library_event_service import LibraryEventService
    from app.services.media.library_runtime_service import LibraryRuntimeService
    from app.services.media.media_ordering_service import MediaOrderingService
    from app.services.media.media_records_service import MediaRecordsService
    from app.services.media.progress_event_service import ProgressEventService
    from app.services.media.storage_event_handler_service import (
        MediaStorageEventHandlerService,
    )
    from app.services.media.thumbnail_runtime_service import ThumbnailRuntimeService
    from app.services.media.worker_boot_service import MediaWorkerBootService
    from app.services.storage.storage_drive_service import StorageDriveRuntimeService
    from app.services.storage.storage_event_service import StorageEventService
    from app.services.storage.upload_session_runtime_service import (
        UploadSessionRuntimeService,
    )
    from app.services.storage.worker_boot_service import StorageWorkerBootService
    from app.services.streaming.chat_event_service import ChatEventService
    from app.services.streaming.sync_event_service import SyncEventService
    from app.services.system.display.hdmi_runtime_service import HdmiRuntimeService
    from app.services.system.display.tv_cast_service import TVCastService
    from app.services.system.display.tv_event_service import TVEventService
    from app.services.system.headscale.runtime_service import HeadscaleRuntimeService
    from app.services.system.tunnel.mesh_watchdog_service import MeshWatchdogService
    from app.services.system.tunnel.url_capture_service import TunnelUrlCaptureService
    from app.services.system.factory_reset_service import FactoryResetService
    from app.services.system.user_data_transfer_service import UserDataTransferService
    from app.services.system.worker_boot_service import SystemWorkerBootService

    services = [
        StorageDriveRuntimeService(),
        AdminEventService(),
        FactoryResetService(),
        AppRequestLifecycleService(),
        ChatEventService(),
        GhostStreamEventService(),
        GhostStreamRuntimeService(),
        TranscodeCacheRuntimeService(),
        GhostStreamWorkerBootService(),
        HdmiRuntimeService(),
        HeadscaleRuntimeService(),
        IndexingRuntimeService(),
        LibraryEventService(),
        LibraryRuntimeService(),
        MediaStorageEventHandlerService(),
        MediaOrderingService(),
        MediaRecordsService(),
        MeshWatchdogService(),
        ProgressEventService(),
        RuntimeConfigService(),
        SocketTransportService(),
        StaleMediaCleanupRuntimeService(),
        StorageEventService(),
        StorageWorkerBootService(),
        SyncEventService(),
        ThumbnailRuntimeService(),
        TunnelUrlCaptureService(),
        TVCastService(),
        TVEventService(),
        UserDataTransferService(),
        UploadSessionRuntimeService(),
        AppStartupService(),
        MediaWorkerBootService(),
        SystemWorkerBootService(),
        WorkerRuntimeService(),
    ]
    services.sort(key=lambda s: (getattr(s, 'priority', 100), getattr(s, 'name', str(s.name))))
    logging.getLogger(__name__).info(
        "Registered %d Specter services from explicit manifest.",
        len(services),
    )
    return services


def install_specter(app, socketio):
    """Install Specter services/controllers into the Flask app."""
    from app.controllers import register_app_controllers
    from app.services.storage.upload_session_store import upload_sessions_store
    from app.services.system.display.hdmi_runtime_store import hdmi_runtime_store
    from specter import registry, HTTPError
    from specter.core.manager import ServiceManager

    @app.errorhandler(HTTPError)
    def handle_http_error(exc):
        return exc.to_response()

    manager = ServiceManager(app, socketio)
    registry.provide('hdmi_runtime', hdmi_runtime_store, owner=manager, replace=True)
    registry.provide('upload_sessions', upload_sessions_store, owner=manager, replace=True)

    # Database must be ready before any service starts — fatal if it fails.
    import os
    os.makedirs(app.instance_path, exist_ok=True)
    from app.services.core.database_bootstrap_service import ensure_database_ready
    ensure_database_ready()

    for service in build_specter_services():
        manager.register_service(service)

    register_app_controllers(manager)
    manager.boot()
    app.extensions['specter_manager'] = manager
    return manager


def log_app_creation(logger, app, config_name: str) -> None:
    """Emit the standard app-boot summary log lines."""
    logger.info("Flask-SocketIO initialized with gevent for WebSockets.")
    logger.info("Flask app created with config: %s", config_name)
    logger.info("Static folder: %s", app.static_folder)
    logger.info("Template folder: %s", app.template_folder)
    logger.info("Instance path: %s", app.instance_path)
    logger.info("Worker runtime initialization now resolves at explicit service boot")
