"""GhostHub controller composition roots built on Specter primitives."""

import logging

logger = logging.getLogger(__name__)

def build_controller_classes():
    """Return the deterministic controller manifest used at app boot."""
    from app.controllers.admin.admin_controller import AdminController
    from app.controllers.admin.admin_maintenance_controller import (
        AdminMaintenanceController,
    )
    from app.controllers.admin.admin_system_controller import AdminSystemController
    from app.controllers.admin.admin_user_data_transfer_controller import (
        AdminUserDataTransferController,
    )
    from app.controllers.admin.admin_visibility_controller import AdminVisibilityController
    from app.controllers.core.connection_controller import ConnectionController
    from app.controllers.core.main_controller import MainController
    from app.controllers.core.profile_controller import ProfileController
    from app.controllers.ghoststream.ghoststream_controller import GhostStreamController
    from app.controllers.media.category_controller import CategoryController
    from app.controllers.media.media_controller import MediaController
    from app.controllers.media.media_delivery_controller import MediaDeliveryController
    from app.controllers.media.media_discovery_controller import (
        MediaDiscoveryController,
    )
    from app.controllers.media.media_ordering_controller import MediaOrderingController
    from app.controllers.media.media_records_controller import MediaRecordsController
    from app.controllers.media.progress_controller import ProgressController
    from app.controllers.media.subtitle_controller import SubtitleController
    from app.controllers.storage.storage_file_controller import StorageFileController
    from app.controllers.storage.storage_management_controller import (
        StorageManagementController,
    )
    from app.controllers.storage.storage_upload_controller import StorageUploadController
    from app.controllers.streaming.chat_controller import ChatController
    from app.controllers.streaming.sync_controller import SyncController
    from app.controllers.system.config_controller import ConfigController
    from app.controllers.system.system_transfer_controller import (
        SystemTransferController,
    )
    from app.controllers.system.system_tunnel_controller import SystemTunnelController
    from app.controllers.system.system_utility_controller import (
        SystemUtilityController,
    )
    from app.controllers.system.tv_controller import TVController

    controller_classes = [
        AdminController,
        AdminMaintenanceController,
        AdminSystemController,
        AdminUserDataTransferController,
        AdminVisibilityController,
        CategoryController,
        ChatController,
        ConfigController,
        ConnectionController,
        GhostStreamController,
        MainController,
        MediaController,
        MediaDeliveryController,
        MediaDiscoveryController,
        MediaOrderingController,
        MediaRecordsController,
        ProfileController,
        ProgressController,
        StorageFileController,
        StorageManagementController,
        StorageUploadController,
        SubtitleController,
        SyncController,
        SystemTransferController,
        SystemTunnelController,
        SystemUtilityController,
        TVController,
    ]
    controller_classes.sort(key=lambda controller_cls: controller_cls.__name__)
    return controller_classes


def register_app_controllers(manager):
    """Register the deterministic controller manifest."""
    for controller_cls in build_controller_classes():
        try:
            instance = controller_cls()
            prefix = getattr(instance, 'url_prefix', '')
            if prefix is None:
                prefix = ''
            manager.register_controller(instance, url_prefix=prefix)
            logger.debug(
                "[Bootstrap] Registered controller %s at prefix '%s'",
                instance.name,
                prefix,
            )
        except Exception as e:
            logger.error(
                "[Bootstrap] Failed to instantiate/register %s: %s",
                controller_cls.__name__,
                e,
            )

    return manager

__all__ = [
    'build_controller_classes',
    'register_app_controllers',
]
