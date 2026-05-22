"""Storage management controller built on Specter."""

import logging
import os
import time

from flask import request

from specter import Controller, Field, Schema
from app.utils.auth import (
    admin_required,
    get_show_hidden_flag,
    is_current_admin_session,
    session_or_admin_required,
)

logger = logging.getLogger(__name__)


class StorageManagementController(Controller):
    """Own storage drive and folder management endpoints."""

    name = 'storage_management'
    url_prefix = '/api/storage'

    schemas = {
        'create_folder': Schema('storage_management.create_folder', {
            'drive_path': Field(str, required=True),
            'folder_name': Field(str, required=True),
        }, strict=True),
        'delete_folder': Schema('storage_management.delete_folder', {
            'folder_path': Field(str, required=True),
            'force': Field(bool, default=False),
        }, strict=True),
        'cleanup_empty': Schema('storage_management.cleanup_empty', {
            'drive_path': Field(str, required=True),
            'dry_run': Field(bool, default=False),
        }, strict=True),
        'rename_drive': Schema('storage_management.rename_drive', {
            'device_key': Field(str, required=True),
            'label': Field(str, required=True),
        }, strict=True),
        'delete_drive_label': Schema('storage_management.delete_drive_label', {
            'device_key': Field(str, required=True),
        }, strict=True),
    }

    def build_routes(self, router):
        @router.route('/drives', methods=['GET'])
        def list_storage_drives():
            """Get latest known storage drives and schedule a background refresh."""
            return self.list_storage_drives()

        @router.route('/check-mounts', methods=['GET'])
        def check_usb_mounts():
            """Check for USB mount changes."""
            return self.check_usb_mounts()

        @router.route('/folders', methods=['GET'])
        def list_drive_folders():
            """List folders in a drive while respecting hidden-content rules."""
            return self.list_drive_folders()

        @router.route('/folder', methods=['POST'])
        @session_or_admin_required
        def create_drive_folder():
            """Create a folder on a storage drive."""
            return self.create_drive_folder()

        @router.route('/folder', methods=['DELETE'])
        @admin_required
        def delete_drive_folder():
            """Delete a folder on a storage drive."""
            return self.delete_drive_folder()

        @router.route('/cleanup-empty', methods=['POST'])
        @admin_required
        def cleanup_empty_folders():
            """Delete empty folders on a storage drive."""
            return self.cleanup_empty_folders()

        @router.route('/drive-label', methods=['PUT'])
        @admin_required
        def rename_drive_label():
            """Create or update a custom drive label."""
            return self.rename_drive_label()

        @router.route('/drive-label', methods=['DELETE'])
        @admin_required
        def delete_drive_label():
            """Remove a custom drive label."""
            return self.delete_drive_label()

    def list_storage_drives(self):
        """Get list of available storage drives with formatted sizes and labels."""
        try:
            from app.services.storage import storage_drive_service, storage_io_service
            from app.services.storage import drive_label_service

            drives = storage_drive_service.get_storage_drives(force_refresh=False)
            if not drives:
                drives = storage_drive_service.get_storage_drives_fresh()
            else:
                self.spawn(storage_drive_service.get_storage_drives, force_refresh=True)

            show_hidden = get_show_hidden_flag()
            if not (show_hidden or is_current_admin_session()):
                drives = storage_drive_service.filter_hidden_only_drives(drives)

            labels = drive_label_service.get_all_drive_labels()

            for drive in drives:
                drive['total_formatted'] = storage_io_service.format_bytes(drive['total'])
                drive['used_formatted'] = storage_io_service.format_bytes(drive['used'])
                drive['free_formatted'] = storage_io_service.format_bytes(drive['free'])
                device_key = drive.get('device_key')
                if device_key and device_key in labels:
                    drive['label'] = labels[device_key]

            return {'drives': drives}
        except Exception as exc:
            logger.error("Error listing storage drives: %s", exc)
            return {'error': 'Failed to list storage drives'}, 500

    def check_usb_mounts(self):
        """Check if USB mounts changed and refresh cached drive data if needed."""
        try:
            from app.services.storage import storage_drive_service

            changed = storage_drive_service.has_mounts_changed()
            if changed:
                storage_drive_service.get_storage_drives(force_refresh=True)

            return {'changed': changed}
        except Exception as exc:
            logger.error("Error checking USB mounts: %s", exc)
            return {'changed': False, 'error': str(exc)}, 500

    def list_drive_folders(self):
        """Get folders for a drive path, respecting active show-hidden state."""
        drive_path = request.args.get('path', '')
        include_subdirs = request.args.get('include_subdirs', 'false').lower() == 'true'
        include_hidden_info = request.args.get('include_hidden_info', 'false').lower() == 'true'

        if not drive_path:
            return {'error': 'path parameter is required'}, 400

        try:
            from app.services.storage import storage_folder_service
            from app.services.storage.storage_drive_service import is_managed_storage_path

            if not is_managed_storage_path(drive_path):
                return {'error': 'Access denied'}, 403

            show_hidden = get_show_hidden_flag()
            folders = storage_folder_service.get_drive_folders(
                drive_path,
                show_hidden=show_hidden,
                include_subdirs=include_subdirs,
                include_hidden_info=include_hidden_info,
            )
            return {'folders': folders, 'show_hidden': show_hidden}
        except Exception as exc:
            logger.error("Error listing folders: %s", exc)
            return {'error': 'Failed to list folders'}, 500

    def create_drive_folder(self):
        """Create a new folder on a drive."""
        payload = request.get_json(silent=True)
        if not payload:
            return {'error': 'Request body is required'}, 400
        payload = self.schema('create_folder').require(payload)
        drive_path = payload['drive_path']
        folder_name = payload['folder_name']

        try:
            from app.services.storage import storage_folder_service

            success, message = storage_folder_service.create_folder(drive_path, folder_name)
            if success:
                return {'success': True, 'message': message}
            if message == 'Access denied':
                return {'success': False, 'error': message}, 403
            return {'success': False, 'error': message}, 400
        except Exception as exc:
            logger.error("Error creating folder: %s", exc)
            return {'error': 'Failed to create folder'}, 500

    def delete_drive_folder(self):
        """Delete a folder and refresh affected category cache state."""
        payload = request.get_json(silent=True)
        if not payload:
            return {'error': 'Request body is required'}, 400
        payload = self.schema('delete_folder').require(payload)
        folder_path = payload['folder_path']
        force = bool(payload.get('force', False))

        try:
            from app.services.storage import storage_folder_service

            success, message = storage_folder_service.delete_folder(folder_path, force)
            if not success:
                if message == 'Access denied':
                    return {'success': False, 'error': message}, 403
                return {'success': False, 'error': message}, 400

            category_path = os.path.dirname(folder_path)
            self._refresh_category_cache_for_path(category_path)
            return {'success': True, 'message': message}
        except Exception as exc:
            logger.error("Error deleting folder: %s", exc)
            return {'error': 'Failed to delete folder'}, 500

    def cleanup_empty_folders(self):
        """Clean up empty folders on a drive and refresh affected caches."""
        payload = request.get_json(silent=True)
        if not payload:
            return {'error': 'Request body is required'}, 400
        payload = self.schema('cleanup_empty').require(payload)
        drive_path = payload['drive_path']
        dry_run = bool(payload.get('dry_run', False))

        try:
            from app.services.storage import storage_folder_service

            success, message, folders = storage_folder_service.cleanup_empty_folders(
                drive_path,
                dry_run,
            )
            if not success and message == 'Access denied':
                return {'success': False, 'error': message}, 403

            if success and not dry_run:
                updated_categories = set()
                for folder_path in folders:
                    from app.services.storage import storage_path_service

                    category_id = storage_path_service.get_category_id_from_path(
                        os.path.dirname(folder_path),
                    )
                    if category_id:
                        updated_categories.add(category_id)

                if updated_categories:
                    from app.services.media.category_cache_service import (
                        update_cached_category,
                    )

                    for category_id in updated_categories:
                        update_cached_category(category_id)
                else:
                    from app.services.media.category_cache_service import invalidate_cache

                    invalidate_cache()

            return {
                'success': success,
                'message': message,
                'folders': folders,
                'count': len(folders),
            }
        except Exception as exc:
            logger.error("Error cleaning up empty folders: %s", exc)
            return {'error': 'Cleanup failed'}, 500

    def rename_drive_label(self):
        """Create or update a custom drive label."""
        payload = request.get_json(silent=True)
        if not payload:
            return {'error': 'Request body is required'}, 400
        payload = self.schema('rename_drive').require(payload)
        device_key = payload['device_key']
        label = payload['label'].strip()
        if not label:
            return {'error': 'Label cannot be empty'}, 400
        if len(label) > 64:
            return {'error': 'Label must be 64 characters or fewer'}, 400

        from app.services.storage import drive_label_service

        if drive_label_service.set_drive_label(device_key, label):
            self._handle_drive_label_change('drive_label_updated', device_key)
            return {'success': True, 'label': label}
        return {'error': 'Failed to save drive label'}, 500

    def delete_drive_label(self):
        """Remove a custom drive label."""
        payload = request.get_json(silent=True)
        if not payload:
            return {'error': 'Request body is required'}, 400
        payload = self.schema('delete_drive_label').require(payload)
        device_key = payload['device_key']

        from app.services.storage import drive_label_service

        if drive_label_service.delete_drive_label(device_key):
            self._handle_drive_label_change('drive_label_deleted', device_key)
            return {'success': True}
        return {'error': 'Failed to delete drive label'}, 500

    def _handle_drive_label_change(self, reason, device_key):
        """Refresh affected caches and notify clients after a drive-label mutation."""
        self._refresh_storage_drive_cache_for_label_change()
        self._invalidate_category_cache_for_label_change()
        self._emit_category_updated_for_label_change(reason, device_key)

    def _refresh_storage_drive_cache_for_label_change(self):
        """Refresh the drive cache so label mapping uses the latest mounted drives."""
        try:
            from app.services.storage import storage_drive_service

            storage_drive_service.get_storage_drives_fresh()
        except Exception as exc:
            logger.debug("Could not refresh storage drive cache after label change: %s", exc)

    def _invalidate_category_cache_for_label_change(self):
        """Invalidate the category cache so display names regenerate with new labels."""
        try:
            from app.services.media.category_cache_service import invalidate_cache
            invalidate_cache()
        except Exception as exc:
            logger.debug("Could not invalidate category cache after label change: %s", exc)

    def _emit_category_updated_for_label_change(self, reason, device_key):
        """Notify clients to refetch category data after drive labels change."""
        try:
            from specter import registry

            registry.require('library_events').emit_category_updated({
                'reason': reason,
                'device_key': device_key,
                'force_refresh': True,
                'invalidateAll': True,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.debug("Could not emit category_updated after label change: %s", exc)

    def _refresh_category_cache_for_path(self, category_path):
        """Refresh a single category cache when possible, else invalidate globally."""
        from app.services.storage import storage_path_service
        from app.services.media.category_cache_service import (
            invalidate_cache,
            update_cached_category,
        )

        category_id = storage_path_service.get_category_id_from_path(category_path)
        if category_id:
            update_cached_category(category_id)
            return
        invalidate_cache()
