"""Storage file operations controller built on Specter."""

import logging
import mimetypes
import os

from flask import Response, request

from specter import Controller
from app.utils.auth import admin_required, get_show_hidden_flag

logger = logging.getLogger(__name__)


class StorageFileController(Controller):
    """Own storage download and file-management endpoints."""

    name = 'storage_file'
    url_prefix = '/api/storage'

    @staticmethod
    def _is_managed_storage_path(path, *, require_writable=False):
        """Return True when a path belongs to a mounted GhostHub storage root."""
        from app.services.storage.storage_drive_service import is_managed_storage_path

        return is_managed_storage_path(path, require_writable=require_writable)

    def build_routes(self, router):
        @router.route('/download/folder', methods=['POST'])
        @admin_required
        def download_folder_zip():
            """Stream a ZIP archive of a folder."""
            return self.download_folder_zip()

        @router.route('/download/file', methods=['POST'])
        @admin_required
        def download_file_direct():
            """Stream a single file directly."""
            return self.download_file_direct()

        @router.route('/media/list', methods=['GET'])
        @admin_required
        def list_media_files():
            """List media files in a folder for admin management."""
            return self.list_media_files()

        @router.route('/media', methods=['DELETE'])
        @admin_required
        def delete_media_file():
            """Delete a media file from storage."""
            return self.delete_media_file()

        @router.route('/media/batch-delete', methods=['POST'])
        @admin_required
        def batch_delete_media_files():
            """Delete multiple media files from storage."""
            return self.batch_delete_media_files()

        @router.route('/media', methods=['PATCH'])
        @admin_required
        def rename_media_file():
            """Rename a media file."""
            return self.rename_media_file()

    def download_folder_zip(self):
        """Stream a ZIP of a folder."""
        data = request.get_json(silent=True)
        if not data or 'folder_path' not in data:
            return {'error': 'folder_path is required'}, 400

        folder_path = data.get('folder_path')
        if not self._is_managed_storage_path(folder_path):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_archive_service

            success, folder_name, _, _, _ = storage_archive_service.get_folder_zip_info(folder_path)
            if not success:
                return {'error': folder_name}, 404

            zip_filename = f"{folder_name}.zip"

            def generate():
                for chunk in storage_archive_service.stream_folder_zip(folder_path):
                    yield chunk

            return Response(
                generate(),
                mimetype='application/zip',
                headers={
                    'Content-Disposition': f'attachment; filename="{zip_filename}"',
                    'Cache-Control': 'no-cache',
                },
            )
        except Exception as exc:
            logger.error("Error streaming folder ZIP: %s", exc)
            return {'error': str(exc)}, 500

    def download_file_direct(self):
        """Stream a single file directly."""
        data = request.get_json(silent=True)
        if not data or 'file_path' not in data:
            return {'error': 'file_path is required'}, 400

        file_path = data.get('file_path')
        if not self._is_managed_storage_path(file_path):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_archive_service

            file_info = storage_archive_service.get_file_info(file_path)
            if not file_info:
                return {'error': 'File not found'}, 404

            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                mime_type = 'application/octet-stream'

            def generate():
                for chunk in storage_archive_service.stream_file_direct(file_path):
                    yield chunk

            return Response(
                generate(),
                mimetype=mime_type,
                headers={
                    'Content-Disposition': f'attachment; filename="{file_info["name"]}"',
                    'Content-Length': str(file_info['size']),
                    'Cache-Control': 'no-cache',
                },
            )
        except Exception as exc:
            logger.error("Error streaming file: %s", exc)
            return {'error': str(exc)}, 500

    def list_media_files(self):
        """List media files in a folder for the admin file browser."""
        folder_path = request.args.get('path', '')
        page = request.args.get('page', 1, type=int)
        limit = request.args.get('limit', 50, type=int)
        search = request.args.get('search', '')

        if not folder_path:
            return {'error': 'path parameter is required'}, 400
        if not self._is_managed_storage_path(folder_path):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_media_file_service

            show_hidden = get_show_hidden_flag()
            result = storage_media_file_service.list_media_files(
                folder_path,
                show_hidden=show_hidden,
                page=page,
                limit=limit,
                search=search if search else None,
            )
            return {
                'files': result['files'],
                'pagination': result['pagination'],
                'show_hidden': show_hidden,
            }
        except Exception as exc:
            logger.error("Error listing media files: %s", exc)
            return {'error': 'Failed to list media files'}, 500

    def delete_media_file(self):
        """Delete a media file and broadcast the removal."""
        data = request.get_json(silent=True)
        if not data or 'file_path' not in data:
            return {'error': 'file_path is required'}, 400

        file_path = data.get('file_path')
        if not self._is_managed_storage_path(file_path, require_writable=True):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_media_file_service

            parent_folder = os.path.dirname(file_path)

            success, message = storage_media_file_service.delete_file(file_path)
            if not success:
                if message == 'Access denied':
                    return {'success': False, 'error': message}, 403
                return {'success': False, 'error': message}, 400

            self.spawn(self._post_delete_cleanup, parent_folder)
            return {'success': True, 'message': message}
        except Exception as exc:
            logger.error("Error deleting file: %s", exc)
            return {'error': 'Failed to delete file'}, 500

    def batch_delete_media_files(self):
        """Delete a capped batch of media files and broadcast one grouped removal."""
        data = request.get_json(silent=True)
        file_paths = data.get('file_paths') if isinstance(data, dict) else None
        if not isinstance(file_paths, list):
            return {'success': False, 'error': 'file_paths must be a list'}, 400
        if len(file_paths) > 500:
            return {'success': False, 'error': 'Cannot delete more than 500 files at once'}, 413

        clean_paths = [path for path in file_paths if isinstance(path, str) and path.strip()]
        if not clean_paths:
            return {'success': False, 'error': 'No file paths provided'}, 400

        denied = [
            path for path in clean_paths
            if not self._is_managed_storage_path(path, require_writable=True)
        ]
        if denied:
            return {
                'success': False,
                'error': 'Access denied',
                'denied': denied[:10],
            }, 403

        try:
            from app.services.storage import storage_media_file_service

            result = storage_media_file_service.delete_files(clean_paths)
            parent_folders = sorted({
                os.path.dirname(path)
                for path in clean_paths
                if isinstance(path, str) and os.path.dirname(path)
            })
            if parent_folders:
                self.spawn(self._post_batch_delete_cleanup, parent_folders)
            return {
                'success': result['deleted'] > 0,
                **result,
            }
        except Exception as exc:
            logger.error("Error deleting file batch: %s", exc)
            return {'success': False, 'error': 'Failed to delete files'}, 500

    def rename_media_file(self):
        """Rename a media file and broadcast the new URL."""
        data = request.get_json(silent=True)
        if not data or 'file_path' not in data or 'new_name' not in data:
            return {'error': 'file_path and new_name are required'}, 400

        file_path = data.get('file_path')
        new_name = data.get('new_name')
        if not self._is_managed_storage_path(file_path, require_writable=True):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_path_service
            from app.services.storage import storage_media_file_service

            success, message, new_path = storage_media_file_service.rename_file(file_path, new_name)
            if not success:
                if message == 'Access denied':
                    return {'success': False, 'error': message}, 403
                return {'success': False, 'error': message}, 400

            non_fatal_warnings = []
            category_id = storage_path_service.get_category_id_from_path(os.path.dirname(file_path))
            try:
                self._refresh_category_cache(category_id)
            except Exception as exc:
                logger.warning("Cache update failed after rename: %s", exc)
                non_fatal_warnings.append('cache_update_failed')

            response_payload = {
                'success': True,
                'message': message,
                'new_path': new_path,
                'new_name': os.path.basename(new_path) if new_path else None,
            }
            if non_fatal_warnings:
                response_payload['warnings'] = non_fatal_warnings
            return response_payload
        except Exception as exc:
            logger.error("Error renaming file: %s", exc)
            return {'error': 'Failed to rename file'}, 500

    def _post_delete_cleanup(self, parent_folder):
        """Run post-delete folder cleanup and cache refresh asynchronously."""
        from app.services.storage import storage_path_service

        try:
            storage_path_service.cleanup_empty_parent(parent_folder)
        except Exception as exc:
            logger.debug("Cleanup after delete: %s", exc)

        try:
            category_id = storage_path_service.get_category_id_from_path(parent_folder)
            self._refresh_category_cache(category_id)
        except Exception as exc:
            logger.error("Cache invalidation after delete failed: %s", exc)

    def _post_batch_delete_cleanup(self, parent_folders):
        """Run post-delete folder cleanup and cache refresh once per affected category."""
        from app.services.storage import storage_path_service

        category_ids = set()
        for parent_folder in parent_folders:
            try:
                storage_path_service.cleanup_empty_parent(parent_folder)
            except Exception as exc:
                logger.debug("Cleanup after batch delete: %s", exc)

            try:
                category_id = storage_path_service.get_category_id_from_path(parent_folder)
                if category_id:
                    category_ids.add(category_id)
            except Exception as exc:
                logger.debug("Could not resolve category after batch delete: %s", exc)

        if not category_ids:
            self._refresh_category_cache(None)
            return
        for category_id in category_ids:
            try:
                self._refresh_category_cache(category_id)
            except Exception as exc:
                logger.error("Cache invalidation after batch delete failed: %s", exc)

    def _refresh_category_cache(self, category_id):
        """Refresh a single category cache when possible, else invalidate globally."""
        from app.services.media.category_cache_service import (
            invalidate_cache,
            update_cached_category,
        )

        if category_id:
            update_cached_category(category_id)
            return
        invalidate_cache()
