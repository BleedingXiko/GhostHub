"""Storage upload controller built on Specter."""

import logging
import os
import traceback

from flask import request

import app.services.system.rate_limit_service as rate_limit_service
from specter import Controller
from app.utils.auth import session_or_admin_required

logger = logging.getLogger(__name__)


class StorageUploadController(Controller):
    """Own storage upload pipeline endpoints."""

    name = 'storage_upload'
    url_prefix = '/api/storage'

    @staticmethod
    def _is_valid_writable_storage_path(path):
        """Return True when the request path belongs to a writable mounted drive."""
        from app.services.storage.storage_drive_service import is_managed_storage_path

        return is_managed_storage_path(path, require_writable=True)

    def build_routes(self, router):
        @router.route('/upload', methods=['POST'])
        @session_or_admin_required
        def upload_to_storage():
            """Upload one or more files to storage."""
            return self.upload_to_storage()

        @router.route('/upload/negotiate', methods=['GET'])
        def negotiate_upload_settings():
            """Get recommended upload settings for the current client."""
            return self.negotiate_upload_settings()

        @router.route('/upload/init', methods=['POST'])
        @session_or_admin_required
        def init_chunked_upload():
            """Initialize a chunked upload session."""
            return self.init_chunked_upload()

        @router.route('/upload/chunk', methods=['POST'])
        @session_or_admin_required
        def upload_chunk():
            """Receive a single chunk for an active upload."""
            return self.upload_chunk()

        @router.route('/upload/status/<upload_id>', methods=['GET'])
        @session_or_admin_required
        def get_upload_status(upload_id):
            """Get chunked upload status."""
            return self.get_upload_status(upload_id)

        @router.route('/upload/cancel/<upload_id>', methods=['POST'])
        @session_or_admin_required
        def cancel_upload(upload_id):
            """Cancel a chunked upload."""
            return self.cancel_upload(upload_id)

        @router.route('/upload/check-duplicates', methods=['POST'])
        @session_or_admin_required
        def check_duplicate_files():
            """Check whether upload targets already exist."""
            return self.check_duplicate_files()

    def upload_to_storage(self):
        """Upload file(s) to a storage drive."""
        if 'file' not in request.files:
            return {'error': 'No file provided'}, 400

        drive_path = request.form.get('drive_path', '')
        subfolder = request.form.get('subfolder', '')
        relative_path = request.form.get('relative_path', '')
        custom_filename = request.form.get('custom_filename', '')

        if not drive_path:
            return {'error': 'drive_path is required'}, 400
        if not self._is_valid_writable_storage_path(drive_path):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import standard_upload_service

            files = request.files.getlist('file')
            client_ip = request.remote_addr
            for file_storage in files:
                upload_size = self._file_storage_size(file_storage)
                # Same reasoning as the chunked path: wait for capacity
                # rather than hard-failing, so the upload completes at the
                # configured rate instead of getting bounced.
                if upload_size and not rate_limit_service.wait_for_upload_capacity(
                    client_ip, upload_size, timeout=30.0
                ):
                    return {
                        'error': 'Upload rate limit exceeded. Please try again in a moment.',
                    }, 429
            return standard_upload_service.upload_files(
                files,
                drive_path,
                subfolder,
                relative_path,
                custom_filename,
            )
        except Exception as exc:
            logger.error("Error uploading file: %s", exc)
            logger.debug(traceback.format_exc())
            return {'error': 'Upload failed'}, 500

    @staticmethod
    def _file_storage_size(file_storage):
        size = getattr(file_storage, 'content_length', None)
        if size:
            return int(size)
        stream = getattr(file_storage, 'stream', None)
        if not stream:
            return 0
        try:
            current_pos = stream.tell()
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(current_pos)
            return int(size)
        except Exception:
            return 0

    def negotiate_upload_settings(self):
        """Get optimal upload settings based on connection type."""
        try:
            from app.services import network_detection_service

            client_ip = request.remote_addr
            user_agent = request.headers.get('User-Agent', '')
            return network_detection_service.get_upload_settings(client_ip, user_agent)
        except Exception as exc:
            logger.error("Error negotiating upload settings: %s", exc)
            return {
                'chunk_size': 2 * 1024 * 1024,
                'tier': 'medium',
                'connection_type': 'unknown',
                'interface': 'unknown',
                'max_concurrent_chunks': 2,
                'hardware_tier': 'LITE',
            }

    def init_chunked_upload(self):
        """Initialize a chunked upload session for large files."""
        data = request.get_json(silent=True)
        if not data:
            return {'error': 'Request body required'}, 400

        filename = data.get('filename')
        total_chunks = data.get('total_chunks')
        total_size = data.get('total_size')
        drive_path = data.get('drive_path')
        subfolder = data.get('subfolder', '')
        relative_path = data.get('relative_path', '')
        chunk_size = data.get('chunk_size', 2 * 1024 * 1024)
        custom_filename = data.get('custom_filename', '')

        if not all([filename, total_chunks, total_size, drive_path]):
            return {
                'error': 'filename, total_chunks, total_size, and drive_path are required',
            }, 400
        if not self._is_valid_writable_storage_path(drive_path):
            return {'error': 'Access denied'}, 403

        max_upload_size = 16 * 1024 * 1024 * 1024
        total_size_int = int(total_size)
        if total_size_int > max_upload_size:
            logger.warning(
                "Upload rejected: %s (%s bytes) exceeds 16GB limit",
                filename,
                total_size_int,
            )
            return {
                'error': (
                    "File size exceeds maximum upload limit of 16GB. "
                    f"File size: {total_size_int / (1024**3):.2f}GB"
                ),
            }, 413

        try:
            from specter import registry

            success, message, upload_id = registry.require('upload_session_runtime').init_chunked_upload(
                filename,
                int(total_chunks),
                total_size_int,
                drive_path,
                subfolder,
                relative_path,
                int(chunk_size),
                custom_filename=custom_filename,
            )

            if success:
                return {'success': True, 'upload_id': upload_id, 'message': message}
            return {'success': False, 'error': message}, 400
        except Exception as exc:
            logger.error("Error initializing chunked upload: %s", exc)
            return {'error': str(exc)}, 500

    def upload_chunk(self):
        """Receive a single chunk of a file upload."""
        upload_id = request.form.get('upload_id')
        chunk_index = request.form.get('chunk_index')

        if not upload_id or chunk_index is None:
            return {'error': 'upload_id and chunk_index are required'}, 400

        if 'chunk' not in request.files:
            return {'error': 'No chunk data provided'}, 400

        try:
            from specter import registry

            chunk_file = request.files['chunk']
            chunk_stream = chunk_file.stream

            chunk_size = getattr(chunk_file, 'content_length', None)
            if not chunk_size:
                current_pos = chunk_stream.tell()
                chunk_stream.seek(0, os.SEEK_END)
                chunk_size = chunk_stream.tell()
                chunk_stream.seek(current_pos)

            client_ip = request.remote_addr
            # Block-and-wait on the limiter instead of returning 429. Chunked
            # uploads are already paced by the client; a hard rejection here
            # makes the browser exhaust its retry budget and abort the file
            # mid-stream, leaving nothing on disk. Waiting for tokens lets
            # the upload proceed at the configured rate instead of failing.
            if not rate_limit_service.wait_for_upload_capacity(client_ip, chunk_size, timeout=30.0):
                return {
                    'error': 'Upload rate limit exceeded. Please try again in a moment.',
                }, 429

            success, message, status = registry.require('upload_session_runtime').upload_chunk(
                upload_id,
                int(chunk_index),
                chunk_stream,
                chunk_size=chunk_size,
            )

            if not success:
                return {'success': False, 'error': message}, 400

            response = {'success': True, 'message': message}
            if status:
                response.update(status)
            return response
        except Exception as exc:
            logger.error("Error uploading chunk: %s", exc)
            return {'error': str(exc)}, 500

    def get_upload_status(self, upload_id):
        """Get the status of an ongoing chunked upload."""
        try:
            from specter import registry

            status = registry.require('upload_session_runtime').get_upload_status(upload_id)
            if status:
                return {'success': True, **status}
            return {'success': False, 'error': 'Upload not found'}, 404
        except Exception as exc:
            logger.error("Error getting upload status: %s", exc)
            return {'error': str(exc)}, 500

    def cancel_upload(self, upload_id):
        """Cancel an in-progress chunked upload."""
        try:
            from specter import registry

            success, message = registry.require('upload_session_runtime').cancel_chunked_upload(upload_id)
            if success:
                return {'success': True, 'message': message}
            return {'success': False, 'error': message}, 400
        except Exception as exc:
            logger.error("Error cancelling upload: %s", exc)
            return {'error': str(exc)}, 500

    def check_duplicate_files(self):
        """Check whether files already exist at their target upload path."""
        data = request.get_json(silent=True)
        if not data or 'drive_path' not in data or 'files' not in data:
            return {'error': 'drive_path and files are required'}, 400

        drive_path = data.get('drive_path')
        subfolder = data.get('subfolder', '')
        files_to_check = data.get('files', [])

        if not isinstance(files_to_check, list):
            return {'error': 'files must be an array'}, 400
        if not self._is_valid_writable_storage_path(drive_path):
            return {'error': 'Access denied'}, 403

        try:
            from app.services.storage import storage_path_service

            duplicates = []
            for file_info in files_to_check:
                filename = file_info.get('filename', '')
                relative_path = file_info.get('relativePath', '')
                if not filename:
                    continue
                exists = storage_path_service.check_file_exists(
                    drive_path,
                    subfolder,
                    relative_path,
                    filename,
                )
                if exists:
                    duplicates.append(relative_path if relative_path else filename)

            return {
                'duplicates': duplicates,
                'count': len(duplicates),
            }
        except Exception as exc:
            logger.error("Error checking duplicates: %s", exc)
            return {'error': 'Failed to check duplicates'}, 500
