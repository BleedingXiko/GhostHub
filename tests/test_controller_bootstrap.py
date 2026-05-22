"""Tests for controller bootstrap helpers."""


def test_build_controller_classes_returns_expected_controller_manifest():
    """Controller registration should use a deterministic manifest."""
    from app.controllers import build_controller_classes

    controller_classes = build_controller_classes()

    assert [controller_cls.__name__ for controller_cls in controller_classes] == [
        'AdminController',
        'AdminMaintenanceController',
        'AdminSystemController',
        'AdminUserDataTransferController',
        'AdminVisibilityController',
        'CategoryController',
        'ChatController',
        'ConfigController',
        'ConnectionController',
        'GhostStreamController',
        'MainController',
        'MediaController',
        'MediaDeliveryController',
        'MediaDiscoveryController',
        'MediaOrderingController',
        'MediaRecordsController',
        'ProfileController',
        'ProgressController',
        'StorageFileController',
        'StorageManagementController',
        'StorageUploadController',
        'SubtitleController',
        'SyncController',
        'SystemTransferController',
        'SystemTunnelController',
        'SystemUtilityController',
        'TVController',
    ]
