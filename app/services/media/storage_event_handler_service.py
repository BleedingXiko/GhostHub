"""Specter service to bridge storage domain events to media domain state."""

import logging
import os
import time

from app.constants import BUS_EVENTS
from specter import Service, registry
from app.services.media import (
    category_cache_service,
    media_index_service,
    hidden_content_service,
    category_persistence_service,
)
from app.services.media.category_query_service import get_all_categories_with_details, get_category_by_id
from app.utils.media_utils import get_media_type, is_video_file

logger = logging.getLogger(__name__)


class MediaStorageEventHandlerService(Service):
    """Listens to storage bus events and applies media domain state updates."""

    def __init__(self):
        super().__init__('media_storage_event_handler')

    def on_start(self):
        """Bind storage bus events to internal media handlers."""
        self.listen(BUS_EVENTS['STORAGE_FILE_UPLOADED'], self._handle_file_uploaded)
        self.listen(BUS_EVENTS['STORAGE_BATCH_UPLOADED'], self._handle_batch_uploaded)
        self.listen(BUS_EVENTS['STORAGE_FILE_DELETED'], self._handle_file_deleted)
        self.listen(BUS_EVENTS['STORAGE_FILES_DELETED'], self._handle_files_deleted)
        self.listen(BUS_EVENTS['STORAGE_FILE_RENAMED'], self._handle_file_renamed)
        self.listen(BUS_EVENTS['STORAGE_FOLDER_DELETED'], self._handle_folder_deleted)
        self.listen(BUS_EVENTS['STORAGE_MOUNT_CHANGED'], self._handle_mount_changed)
        logger.info("MediaStorageEventHandlerService started and listening.")

    def _handle_file_uploaded(self, payload: dict):
        target_dir = payload.get('target_dir')
        target_path = payload.get('target_path')
        filename = payload.get('filename')
        category_id = payload.get('category_id')

        if not category_id:
            return

        try:
            stats = os.stat(target_path)
            media_type = get_media_type(filename)
            category_path = target_dir
            rel_path = filename
            try:
                cat_info = get_category_by_id(category_id)
                cat_root = cat_info.get('path') if cat_info else None
                if cat_root:
                    category_path = cat_root
                    rel_path = os.path.relpath(target_path, cat_root).replace(os.sep, '/')
            except Exception as exc:
                logger.debug("Could not derive uploaded rel_path for %s: %s", target_path, exc)
            media_index_service.upsert_media_index_entry(
                category_id=category_id,
                category_path=category_path,
                rel_path=rel_path,
                size=stats.st_size,
                mtime=stats.st_mtime,
                file_type=media_type,
            )
            media_index_service.recalculate_category_version_hash(category_id)

            if media_type == 'video':
                try:
                    runtime = registry.require('thumbnail_runtime')
                    runtime.start_thumbnail_batch(category_id, 1)
                    runtime.queue_thumbnail(
                        target_dir,
                        category_id,
                        {'name': filename},
                        force_refresh=False,
                    )
                    runtime.finish_thumbnail_batch(category_id)
                except Exception as exc:
                    logger.debug("Thumbnail enqueue skipped for %s: %s", filename, exc)
        except Exception as exc:
            logger.error("Media index update skipped for %s: %s", filename, exc)

        try:
            registry.require('library_events').emit_category_updated({
                'reason': 'file_uploaded',
                'category_id': category_id,
                'filename': filename,
                'media_url': payload.get('media_url'),
                'force_refresh': True,
                'invalidateCategory': True,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.debug("Could not emit upload socket event: %s", exc)

    def _handle_batch_uploaded(self, payload: dict):
        uploaded_categories = payload.get('uploaded_categories', [])
        success_count = payload.get('success_count', 0)
        uploaded_category_ids = []

        for category_dir in uploaded_categories:
            category_id = None
            try:
                from app.services.storage.storage_path_service import get_category_id_from_path
                category_id = get_category_id_from_path(category_dir)
            except Exception as exc:
                logger.debug("Could not derive category id for uploaded dir %s: %s", category_dir, exc)
            if category_id:
                uploaded_category_ids.append(category_id)

            try:
                if category_id:
                    category_cache_service.update_cached_category(category_id)
                else:
                    category_cache_service.invalidate_cache()
            except Exception as exc:
                logger.error("Failed to update cache for %s: %s", category_dir, exc)

        try:
            registry.require('library_events').emit_category_updated({
                'reason': 'upload_complete',
                'count': success_count,
                'categories': uploaded_categories,
                'category_ids': uploaded_category_ids,
                'force_refresh': True,
                'invalidateAll': True,
                'timestamp': time.time()
            })
        except Exception as exc:
            logger.debug("Could not emit socket event: %s", exc)

    def _handle_file_deleted(self, payload: dict):
        file_path = payload.get('file_path')
        filename = payload.get('filename')
        directory = payload.get('directory')
        category_id = payload.get('category_id')
        media_url = payload.get('media_url')
        is_video = payload.get('is_video')

        try:
            if category_id:
                rel_path = os.path.basename(file_path)
                try:
                    cat_info = get_category_by_id(category_id)
                    cat_root = cat_info.get('path') if cat_info else None
                    if cat_root:
                        rel_path = os.path.relpath(file_path, cat_root).replace(os.sep, '/')
                except Exception as exc:
                    logger.debug("Could not derive deleted rel_path for %s: %s", file_path, exc)
                media_index_service.delete_media_index_entry(category_id, rel_path)
                media_index_service.recalculate_category_version_hash(category_id)
        except Exception as exc:
            logger.debug("Media index delete skipped for %s: %s", file_path, exc)

        try:
            from app.services.storage.storage_media_file_service import (
                _delete_thumbnail,
                _invalidate_subtitle_cache,
            )

            if directory and filename:
                _delete_thumbnail(directory, filename)
            if is_video and file_path:
                _invalidate_subtitle_cache(file_path)
        except Exception as exc:
            logger.debug("Thumbnail/subtitle cleanup skipped after delete: %s", exc)

        try:
            if media_url:
                registry.require('progress').handle_media_delete(
                    media_url=media_url,
                    category_id=category_id,
                    filename=filename,
                )
            hidden_content_service.delete_hidden_file_entry(file_path)
        except Exception as exc:
            logger.error("Database cleanup after delete failed: %s", exc)

        try:
            invalidated_ids = []
            if category_id and file_path:
                rel_path = filename
                try:
                    cat_info = get_category_by_id(category_id)
                    cat_root = cat_info.get('path') if cat_info else None
                    if cat_root:
                        rel_path = os.path.relpath(file_path, cat_root).replace(os.sep, '/')
                except Exception as exc:
                    logger.debug("Could not derive deleted rel_path for %s: %s", file_path, exc)
                if rel_path:
                    invalidated_ids.append(f'{category_id}::{rel_path}')
            registry.require('library_events').emit_category_updated({
                'reason': 'file_deleted',
                'category_id': category_id,
                'filename': filename,
                'media_url': media_url,
                'invalidatedIds': invalidated_ids,
                'force_refresh': True,
                'invalidateCategory': True,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.debug("Could not emit delete socket event: %s", exc)

    def _handle_files_deleted(self, payload: dict):
        files = payload.get('files') or []
        if not isinstance(files, list) or not files:
            return

        invalidated_by_category = {}
        media_urls_by_category = {}
        categories_to_rehash = set()

        for item in files:
            file_path = item.get('file_path')
            filename = item.get('filename')
            directory = item.get('directory')
            category_id = item.get('category_id')
            media_url = item.get('media_url')
            rel_path = item.get('rel_path') or filename

            try:
                if category_id and rel_path:
                    media_index_service.delete_media_index_entry(category_id, rel_path)
                    categories_to_rehash.add(category_id)
            except Exception as exc:
                logger.debug("Media index batch delete skipped for %s: %s", file_path, exc)

            try:
                from app.services.storage.storage_media_file_service import (
                    _delete_thumbnail,
                    _invalidate_subtitle_cache,
                )

                if directory and filename:
                    _delete_thumbnail(directory, filename)
                if item.get('is_video') and file_path:
                    _invalidate_subtitle_cache(file_path)
            except Exception as exc:
                logger.debug("Thumbnail/subtitle batch cleanup skipped: %s", exc)

            try:
                if media_url:
                    registry.require('progress').handle_media_delete(
                        media_url=media_url,
                        category_id=category_id,
                        filename=filename,
                    )
                hidden_content_service.delete_hidden_file_entry(file_path)
            except Exception as exc:
                logger.error("Database cleanup after batch delete failed: %s", exc)

            if category_id:
                if rel_path:
                    invalidated_by_category.setdefault(category_id, []).append(f'{category_id}::{rel_path}')
                if media_url:
                    media_urls_by_category.setdefault(category_id, []).append(media_url)

        for category_id in categories_to_rehash:
            try:
                media_index_service.recalculate_category_version_hash(category_id)
            except Exception as exc:
                logger.debug("Media index rehash skipped for %s: %s", category_id, exc)

        emitted_categories = set(invalidated_by_category) | set(media_urls_by_category)
        if not emitted_categories:
            emitted_categories = set(payload.get('affected_category_ids') or [])

        for category_id in emitted_categories:
            try:
                registry.require('library_events').emit_category_updated({
                    'reason': 'files_deleted',
                    'category_id': category_id,
                    'media_urls': media_urls_by_category.get(category_id, []),
                    'invalidatedIds': invalidated_by_category.get(category_id, []),
                    'force_refresh': True,
                    'invalidateCategory': True,
                    'timestamp': payload.get('timestamp') or time.time(),
                })
            except Exception as exc:
                logger.debug("Could not emit batch delete socket event: %s", exc)

    def _handle_file_renamed(self, payload: dict):
        file_path = payload.get('file_path')
        new_path = payload.get('new_path')
        old_name = payload.get('old_name')
        new_name = payload.get('new_name')
        directory = payload.get('directory')
        category_id = payload.get('category_id')
        was_hidden = payload.get('was_hidden')
        old_media_url = payload.get('old_media_url')
        new_media_url = payload.get('new_media_url')

        try:
            if category_id:
                cat_root = None
                try:
                    cat_info = get_category_by_id(category_id)
                    cat_root = cat_info.get('path') if cat_info else None
                except Exception:
                    cat_root = None

                if cat_root:
                    old_rel_path = os.path.relpath(file_path, cat_root).replace(os.sep, '/')
                    new_rel_path = os.path.relpath(new_path, cat_root).replace(os.sep, '/')
                else:
                    old_rel_path = old_name
                    new_rel_path = new_name

                media_index_service.delete_media_index_entry(category_id, old_rel_path)
                stats = os.stat(new_path)
                media_index_service.upsert_media_index_entry(
                    category_id=category_id,
                    category_path=cat_root or directory,
                    rel_path=new_rel_path,
                    size=stats.st_size,
                    mtime=stats.st_mtime,
                    file_type=get_media_type(new_rel_path),
                )
                media_index_service.recalculate_category_version_hash(category_id)
        except Exception as exc:
            logger.debug("Media index update skipped for rename %s: %s", file_path, exc)

        try:
            from app.services.storage.storage_media_file_service import (
                _rename_thumbnail,
                _rename_associated_subtitles,
                _invalidate_subtitle_cache,
            )

            if directory and old_name and new_name:
                _rename_thumbnail(directory, old_name, new_name)
            if old_name and is_video_file(old_name):
                if directory and new_name:
                    _rename_associated_subtitles(directory, old_name, new_name)
                if file_path:
                    _invalidate_subtitle_cache(file_path)
        except Exception as exc:
            logger.debug("Thumbnail/subtitle rename skipped: %s", exc)

        hidden_path_updated = hidden_content_service.update_hidden_file_path(file_path, new_path)
        if was_hidden and not hidden_path_updated:
            try:
                from app.services.storage.storage_path_service import _get_category_id_from_path
                hidden_content_service.hide_file(
                    new_path,
                    _get_category_id_from_path(directory),
                    admin_session_id='system_rename',
                )
            except Exception as exc:
                logger.debug("Could not re-hide renamed file %s: %s", new_path, exc)

        try:
            categories = get_all_categories_with_details()
            for category in categories:
                cat_path = category.get('path')
                if not cat_path:
                    continue
                if file_path.startswith(cat_path + os.sep) or file_path == cat_path:
                    rel_path = os.path.relpath(file_path, cat_path).replace(os.sep, '/')
                    media_index_service.delete_media_index_entry(category['id'], rel_path)
        except Exception as exc:
            logger.debug("Cross-category old rename cleanup skipped for %s: %s", file_path, exc)

        try:
            if old_media_url and new_media_url:
                registry.require('progress').handle_media_rename(
                    old_media_url=old_media_url,
                    new_media_url=new_media_url,
                    category_id=category_id,
                    old_filename=old_name,
                    new_filename=new_name,
                )
            elif category_id:
                registry.require('progress').handle_media_rename(
                    category_id=category_id,
                    old_filename=old_name,
                    new_filename=new_name,
                )
        except Exception as exc:
            logger.debug("Could not emit progress rename: %s", exc)

        try:
            invalidated_ids = []
            if category_id:
                old_rel_path = old_name
                try:
                    cat_info = get_category_by_id(category_id)
                    cat_root = cat_info.get('path') if cat_info else None
                    if cat_root:
                        old_rel_path = os.path.relpath(file_path, cat_root).replace(os.sep, '/')
                except Exception as exc:
                    logger.debug("Could not derive renamed rel_path for %s: %s", file_path, exc)
                if old_rel_path:
                    invalidated_ids.append(f'{category_id}::{old_rel_path}')
            registry.require('library_events').emit_category_updated({
                'reason': 'file_renamed',
                'category_id': category_id,
                'old_path': old_media_url,
                'new_path': new_media_url,
                'old_name': old_name,
                'new_name': new_name,
                'invalidatedIds': invalidated_ids,
                'force_refresh': True,
                'invalidateCategory': True,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.debug("Could not emit rename socket event: %s", exc)

    def _handle_folder_deleted(self, payload: dict):
        category_id = payload.get('category_id')
        if category_id:
            try:
                media_index_service.delete_media_index_by_category(category_id)
                category_cache_service.invalidate_cache()
            except Exception as exc:
                logger.error("Failed to delete media index by category: %s", exc)
        try:
            registry.require('library_events').emit_category_updated({
                'reason': 'folder_deleted',
                'category_id': category_id,
                'folder_path': payload.get('folder_path'),
                'force_refresh': True,
                'invalidateCategory': bool(category_id),
                'invalidateAll': not bool(category_id),
                'timestamp': payload.get('timestamp') or time.time(),
            })
        except Exception as exc:
            logger.debug("Could not emit folder-delete socket event: %s", exc)

    def _handle_mount_changed(self, payload: dict):
        mounted_paths = payload.get('mounted_paths', [])
        unmounted_paths = payload.get('unmounted_paths', [])

        try:
            category_cache_service.invalidate_cache()
            logger.info("Category cache invalidated due to USB mount change (handled via Specter bus)")

            valid_cats = get_all_categories_with_details(
                use_cache=False,
                show_hidden=True,
            )
            valid_ids = [category['id'] for category in valid_cats]
            media_index_service.cleanup_orphaned_media_index(valid_ids)

            if unmounted_paths:
                logger.info("Drives unmounted: %s - performing aggressive cleanup", unmounted_paths)
                for mount_path in unmounted_paths:
                    mount_path_normalized = os.path.normpath(mount_path)
                    logger.info("Cleaning up media_index for unmounted drive: %s", mount_path)
                    
                    try:
                        deleted = media_index_service.delete_media_index_by_path_prefix(mount_path_normalized)
                        if deleted:
                            logger.info("Deleted %s media_index entries for mount %s", deleted, mount_path)

                        deleted_categories = category_persistence_service.delete_categories_by_path_prefix(mount_path_normalized)
                        if deleted_categories:
                            logger.info("Deleted %s category entries for unmounted drive %s", deleted_categories, mount_path)
                    except Exception as exc:
                        logger.error("Error cleaning up media for unmounted drive %s: %s", mount_path, exc)

                deleted = media_index_service.cleanup_media_index_by_category_path_check()
                if deleted > 0:
                    logger.warning("USB cleanup DELETED %s stale media_index entries", deleted)

                all_cat_ids = media_index_service.get_all_category_ids_from_media_index()
                valid_cat_ids_set = set(valid_ids)
                orphaned_ids = [cid for cid in all_cat_ids if cid not in valid_cat_ids_set]
                if orphaned_ids:
                    logger.info("Found %s orphaned category IDs in media_index", len(orphaned_ids))
                    media_index_service.cleanup_orphaned_media_index(valid_ids)
            else:
                logger.info("No unmounted paths detected - skipping aggressive cleanup")
        except Exception as exc:
            logger.error("Could not invalidate category cache or cleanup index in event handler: %s", exc, exc_info=True)

        try:
            event_payload = {
                'mounted_paths': list(mounted_paths),
                'unmounted_paths': list(unmounted_paths),
                'force_refresh': bool(mounted_paths),
                'timestamp': time.time(),
            }
            registry.require('storage_events').emit_usb_mounts_changed(event_payload)
        except Exception as exc:
            logger.debug("Could not emit mount-change socket updates: %s", exc)
