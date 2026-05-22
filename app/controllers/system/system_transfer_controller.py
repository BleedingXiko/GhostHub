"""System transfer controller built on Specter."""

import logging
import os
import traceback

from flask import Response, request, send_file

from app.services.storage import storage_io_service
from app.services.storage import storage_archive_service
from app.services.media.category_query_service import get_category_by_id
from specter import Controller
from app.utils.auth import get_show_hidden_flag, session_or_admin_required

logger = logging.getLogger(__name__)


class SystemTransferController(Controller):
    """Own category download and gallery transfer endpoints."""

    name = 'system_transfer'
    url_prefix = '/api'

    def build_routes(self, router):
        @router.route('/categories/<category_id>/download/info', methods=['GET'])
        def get_category_download_info(category_id):
            """Get ZIP/download metadata for a category."""
            return self.get_category_download_info(category_id)

        @router.route('/categories/<category_id>/file/<path:filename>', methods=['GET'])
        def download_category_file(category_id, filename):
            """Download a single file from a category."""
            return self.download_category_file(category_id, filename)

        @router.route(
            '/categories/<category_id>/download',
            methods=['GET'],
            endpoint='download_category_zip',
        )
        def download_category_zip(category_id):
            """Download a category as a streaming ZIP."""
            return self.download_category_zip(category_id, part=None)

        @router.route(
            '/categories/<category_id>/download/<int:part>',
            methods=['GET'],
            endpoint='download_category_zip_part',
        )
        def download_category_zip_part(category_id, part):
            """Download a specific ZIP part for a category."""
            return self.download_category_zip(category_id, part=part)

        @router.route('/gallery/upload', methods=['POST'])
        @session_or_admin_required
        def gallery_upload():
            """Upload media files to a gallery folder."""
            return self.gallery_upload()

        @router.route('/gallery/download', methods=['POST'])
        @session_or_admin_required
        def gallery_download():
            """Download one or more gallery files."""
            return self.gallery_download()

    @staticmethod
    def _get_visible_category_files(category_id, folder_path, show_hidden):
        """Return the visible files in a category folder for the current caller."""
        from app.services.media.hidden_content_service import should_block_file_access

        files_list = storage_archive_service.get_folder_file_list(folder_path)
        if show_hidden:
            return files_list

        return [
            (file_path, arcname, size)
            for file_path, arcname, size in files_list
            if not should_block_file_access(file_path, category_id, show_hidden)
        ]

    def get_category_download_info(self, category_id):
        """Get size and part information for a category download."""
        try:
            from app.services.media.hidden_content_service import should_block_category_access

            show_hidden = get_show_hidden_flag()
            if should_block_category_access(category_id, show_hidden):
                return {'error': 'Category not found'}, 404

            category = get_category_by_id(category_id)
            if not category or not category.get('path'):
                return {'error': 'Category not found'}, 404

            folder_path = category['path']
            if not os.path.isdir(folder_path):
                return {'error': 'Category folder not found'}, 404

            folder_name = os.path.basename(folder_path)
            files_list = self._get_visible_category_files(category_id, folder_path, show_hidden)
            total_size = sum(size for _, _, size in files_list)
            parts = storage_archive_service.split_files_into_parts(
                files_list,
                max_size=storage_archive_service.get_max_zip_part_size(),
            ) if files_list else []

            parts_info = []
            for part_files in parts:
                part_size = sum(size for _, _, size in part_files)
                is_single = len(part_files) == 1
                part_info = {
                    'size': part_size,
                    'size_formatted': storage_io_service.format_bytes(part_size),
                    'is_single': is_single,
                    'file_count': len(part_files),
                }
                if is_single:
                    file_path, arcname, _ = part_files[0]
                    part_info['filename'] = arcname
                    part_info['filepath'] = file_path
                parts_info.append(part_info)

            return {
                'success': True,
                'folder_name': folder_name,
                'total_size': total_size,
                'total_size_formatted': storage_io_service.format_bytes(total_size),
                'num_parts': len(parts),
                'parts': parts_info,
            }
        except Exception as exc:
            logger.error("Error getting category download info %s: %s", category_id, exc)
            return {'error': str(exc)}, 500

    def download_category_file(self, category_id, filename):
        """Direct download of a single file from a category."""
        try:
            from app.services.media.hidden_content_service import (
                should_block_category_access,
                should_block_file_access,
            )

            show_hidden = get_show_hidden_flag()
            if should_block_category_access(category_id, show_hidden):
                return {'error': 'Category not found'}, 404

            category = get_category_by_id(category_id)
            if not category or not category.get('path'):
                return {'error': 'Category not found'}, 404

            folder_path = category['path']
            file_path = os.path.join(folder_path, filename)

            real_file = os.path.realpath(file_path)
            if not storage_io_service.is_path_within(folder_path, real_file):
                return {'error': 'Invalid file path'}, 403

            if should_block_file_access(real_file, category_id, show_hidden):
                return {'error': 'File not found'}, 404

            if not os.path.isfile(real_file):
                return {'error': 'File not found'}, 404

            return send_file(real_file, as_attachment=True, download_name=filename)
        except Exception as exc:
            logger.error("Error downloading file from category %s: %s", category_id, exc)
            return {'error': str(exc)}, 500

    def download_category_zip(self, category_id, part=None):
        """Download a category as a streaming ZIP, optionally by part."""
        try:
            from app.services.media.hidden_content_service import should_block_category_access

            show_hidden = get_show_hidden_flag()
            if should_block_category_access(category_id, show_hidden):
                return {'error': 'Category not found'}, 404

            category = get_category_by_id(category_id)
            if not category or not category.get('path'):
                return {'error': 'Category not found'}, 404

            folder_path = category['path']
            if not os.path.isdir(folder_path):
                return {'error': 'Category folder not found'}, 404

            folder_name = os.path.basename(folder_path)
            files_list = self._get_visible_category_files(category_id, folder_path, show_hidden)
            if not files_list:
                return {'error': 'No downloadable files found'}, 404

            parts = storage_archive_service.split_files_into_parts(
                files_list,
                max_size=storage_archive_service.get_max_zip_part_size(),
            )
            num_parts = len(parts)

            if part is None and num_parts <= 1:
                zip_filename = f"{folder_name}.zip"

                def generate():
                    file_list = [(file_path, arcname) for file_path, arcname, _ in files_list]
                    for chunk in storage_archive_service.stream_zip_from_file_list(file_list):
                        yield chunk

                return Response(
                    generate(),
                    mimetype='application/zip',
                    headers={
                        'Content-Disposition': f'attachment; filename="{zip_filename}"',
                        'Cache-Control': 'no-cache',
                        'X-Total-Parts': '1',
                        'X-Current-Part': '1',
                    },
                )

            if part is None:
                part = 1

            if part < 1 or part > num_parts:
                return {'error': f'Invalid part number. Must be 1-{num_parts}'}, 400

            zip_filename = f"{folder_name}_part{part}of{num_parts}.zip"

            def generate():
                file_list = [
                    (file_path, arcname)
                    for file_path, arcname, _ in parts[part - 1]
                ]
                for chunk in storage_archive_service.stream_zip_from_file_list(file_list):
                    yield chunk

            return Response(
                generate(),
                mimetype='application/zip',
                headers={
                    'Content-Disposition': f'attachment; filename="{zip_filename}"',
                    'Cache-Control': 'no-cache',
                    'X-Total-Parts': str(num_parts),
                    'X-Current-Part': str(part),
                },
            )
        except Exception as exc:
            logger.error("Error downloading category %s: %s", category_id, exc)
            return {'error': str(exc)}, 500

    def gallery_upload(self):
        """Upload media files to a drive/folder for gallery flows."""
        try:
            from werkzeug.utils import secure_filename
            from app.services.storage.storage_drive_service import get_storage_drive_for_path
            from app.services.storage import standard_upload_service

            drive_path = request.form.get('drive_path')
            target_path = request.form.get('target_path')
            new_folder_name = request.form.get('new_folder_name')

            files = request.files.getlist('files')
            if not files:
                return {'error': 'No files provided'}, 400

            upload_path = None
            if new_folder_name and drive_path:
                safe_name = secure_filename(new_folder_name) or 'New_Folder'
                upload_path = os.path.join(drive_path, safe_name)
            elif target_path:
                upload_path = target_path
            else:
                return {'error': 'Target path or new folder name required'}, 400

            owning_drive = get_storage_drive_for_path(
                upload_path,
                require_writable=True,
            )
            if owning_drive is None:
                return {'error': 'Invalid upload path'}, 403

            if drive_path and not storage_io_service.is_path_within(drive_path, upload_path):
                return {'error': 'Invalid upload path'}, 403

            if not os.path.exists(upload_path):
                os.makedirs(upload_path, exist_ok=True)
                if new_folder_name and drive_path:
                    logger.info("[GalleryUpload] Created new folder: %s", upload_path)

            if not os.path.isdir(upload_path):
                return {'error': 'Upload path not found'}, 404

            drive_root = owning_drive.get('path') or drive_path
            if not drive_root:
                return {'error': 'Invalid upload path'}, 403

            subfolder = os.path.relpath(upload_path, drive_root)
            if subfolder == '.':
                subfolder = ''

            result = standard_upload_service.upload_files(
                files,
                drive_root,
                subfolder=subfolder,
            )
            uploaded = [
                item.get('filename')
                for item in result.get('results', [])
                if item.get('success') and item.get('filename')
            ]
            errors = [
                {'file': item.get('filename'), 'error': item.get('message')}
                for item in result.get('results', [])
                if not item.get('success')
            ]

            return {
                'success': result.get('success', False),
                'uploaded': uploaded,
                'errors': errors,
                'message': f'Uploaded {len(uploaded)} file(s)',
            }
        except Exception as exc:
            logger.error("[GalleryUpload] Error: %s", exc)
            logger.debug(traceback.format_exc())
            return {'error': str(exc)}, 500

    def gallery_download(self):
        """Download selected gallery media files."""
        try:
            from urllib.parse import unquote
            from app.services.media.hidden_content_service import (
                should_block_category_access,
                should_block_file_access,
            )

            data = request.get_json(silent=True) or {}
            urls = data.get('urls', [])
            if not urls:
                return {'error': 'No URLs provided'}, 400

            show_hidden = get_show_hidden_flag()
            file_paths = []
            for url in urls:
                try:
                    if not url.startswith('/media/'):
                        continue
                    parts = url[7:].split('/', 1)
                    if len(parts) != 2:
                        continue
                    category_id = parts[0]
                    filename = unquote(parts[1])
                    if should_block_category_access(category_id, show_hidden):
                        continue
                    category = get_category_by_id(category_id)
                    if not category:
                        continue
                    filepath = os.path.realpath(os.path.join(category['path'], filename))
                    if not storage_io_service.is_path_within(category['path'], filepath):
                        continue
                    if should_block_file_access(filepath, category_id, show_hidden):
                        continue
                    if os.path.isfile(filepath):
                        file_paths.append((filepath, filename))
                except Exception as exc:
                    logger.warning("[GalleryDownload] Error resolving %s: %s", url, exc)
                    continue

            if not file_paths:
                return {'error': 'No valid files found'}, 404

            if len(file_paths) == 1:
                filepath, filename = file_paths[0]
                return send_file(filepath, as_attachment=True, download_name=filename)

            def generate():
                for chunk in storage_archive_service.stream_zip_from_file_list(file_paths):
                    yield chunk

            return Response(
                generate(),
                mimetype='application/zip',
                headers={
                    'Content-Disposition': f'attachment; filename="ghosthub-{len(file_paths)}-files.zip"',
                    'Cache-Control': 'no-cache',
                },
            )
        except Exception as exc:
            logger.error("[GalleryDownload] Error: %s", exc)
            logger.debug(traceback.format_exc())
            return {'error': str(exc)}, 500
