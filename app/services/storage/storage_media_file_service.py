"""Media-file listing and mutation workflows for storage domains."""

import hashlib
import logging
import os
import time
from typing import Dict, List, Optional, Tuple

from werkzeug.utils import secure_filename

logger = logging.getLogger(__name__)


def list_media_files(
    folder_path: str,
    show_hidden: bool = False,
    page: int = 1,
    limit: int = 50,
    search: str = None,
) -> Dict:
    """List media files in a folder for the admin file browser."""
    from app.services.media.hidden_content_service import (
        is_category_hidden,
        is_file_hidden,
    )
    from app.utils.media_utils import get_media_type, is_media_file

    limit = max(1, limit)
    page = max(1, page)

    result = {
        'files': [],
        'pagination': {
            'page': page,
            'limit': limit,
            'total': 0,
            'hasMore': False,
            'totalPages': 0,
        },
    }

    from app.services.storage.storage_drive_service import is_managed_storage_path

    if not is_managed_storage_path(folder_path):
        logger.warning("Rejected media listing outside managed storage roots: %s", folder_path)
        return result

    if not os.path.exists(folder_path) or not os.path.isdir(folder_path):
        return result

    from app.services.storage import storage_io_service, storage_path_service

    category_id = None
    try:
        category_id = storage_path_service.get_category_id_from_path(folder_path)
    except Exception as exc:
        logger.debug("Could not determine category ID for %s: %s", folder_path, exc)

    folder_is_hidden = False
    if category_id:
        try:
            if is_category_hidden(category_id):
                folder_is_hidden = True
            elif '::' in category_id:
                parts = [part for part in category_id.split('::') if part]
                for index in range(1, len(parts)):
                    check_id = '::'.join(parts[:index])
                    if is_category_hidden(check_id):
                        folder_is_hidden = True
                        break
        except Exception:
            folder_is_hidden = False

    search_lower = search.lower().strip() if search else None

    try:
        all_files = []
        with os.scandir(folder_path) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False) or entry.name.startswith('.'):
                    continue
                if not is_media_file(entry.name):
                    continue
                if search_lower and search_lower not in entry.name.lower():
                    continue

                try:
                    stat = entry.stat()
                    media_type = get_media_type(entry.name)
                    file_is_hidden = is_file_hidden(entry.path)
                    is_hidden = folder_is_hidden or file_is_hidden

                    if show_hidden or not is_hidden:
                        all_files.append({
                            'name': entry.name,
                            'path': entry.path,
                            'size': stat.st_size,
                            'size_formatted': storage_io_service.format_bytes(stat.st_size),
                            'type': media_type,
                            'modified': stat.st_mtime,
                            'hidden': is_hidden,
                        })
                except OSError as exc:
                    logger.debug("Error getting file info for %s: %s", entry.name, exc)

        all_files.sort(key=lambda item: item['name'].lower())

        total = len(all_files)
        total_pages = (total + limit - 1) // limit if total > 0 else 1
        start_idx = (page - 1) * limit
        end_idx = min(start_idx + limit, total)

        result['files'] = all_files[start_idx:end_idx]
        result['pagination'] = {
            'page': page,
            'limit': limit,
            'total': total,
            'hasMore': end_idx < total,
            'totalPages': total_pages,
        }
    except (PermissionError, OSError) as exc:
        logger.error("Error listing media files in %s: %s", folder_path, exc)

    return result


def delete_file(file_path: str) -> Tuple[bool, str]:
    """Delete a media file from storage."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(file_path, require_writable=True):
            return False, "Access denied"
        if not os.path.exists(file_path):
            return False, "File not found"
        if not os.path.isfile(file_path):
            return False, "Path is not a file"

        from app.utils.media_utils import is_media_file, is_video_file

        if not is_media_file(os.path.basename(file_path)):
            return False, "Can only delete media files"

        from app.services.storage import storage_io_service, storage_path_service
        filename = os.path.basename(file_path)
        directory = os.path.dirname(file_path)
        category_id = storage_path_service._get_category_id_from_path(directory)
        media_url = storage_path_service.get_media_url_from_path(file_path)
        is_video = is_video_file(filename)

        storage_io_service.get_file_io_pool().spawn(os.remove, file_path).get()

        try:
            from specter import bus
            from app.constants import BUS_EVENTS
            
            bus.emit(BUS_EVENTS['STORAGE_FILE_DELETED'], {
                'file_path': file_path,
                'filename': filename,
                'directory': directory,
                'category_id': category_id,
                'media_url': media_url,
                'is_video': is_video,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.error("Failed to emit STORAGE_FILE_DELETED bus event: %s", exc)

        logger.info("File deleted: %s", file_path)
        return True, f"Deleted: {filename}"
    except PermissionError:
        return False, "Permission denied - cannot delete this file"
    except OSError as exc:
        logger.error("Error deleting file %s: %s", file_path, exc)
        return False, f"Delete failed: {str(exc)}"
    except Exception as exc:
        logger.error("Unexpected error deleting file: %s", exc)
        return False, "Delete failed due to server error"


def delete_files(file_paths: List[str]) -> Dict:
    """Delete multiple media files and emit one grouped storage event."""
    from app.services.storage.storage_drive_service import is_managed_storage_path
    from app.services.storage import storage_io_service, storage_path_service
    from app.utils.media_utils import is_media_file, is_video_file

    results = []
    deleted_items = []
    affected_category_ids = set()
    invalidated_ids = []

    for file_path in file_paths:
        item = {'file_path': file_path, 'success': False}
        try:
            if not is_managed_storage_path(file_path, require_writable=True):
                item['error'] = 'Access denied'
            elif not os.path.exists(file_path):
                item['error'] = 'File not found'
            elif not os.path.isfile(file_path):
                item['error'] = 'Path is not a file'
            elif not is_media_file(os.path.basename(file_path)):
                item['error'] = 'Can only delete media files'
            else:
                filename = os.path.basename(file_path)
                directory = os.path.dirname(file_path)
                category_id = storage_path_service._get_category_id_from_path(directory)
                media_url = storage_path_service.get_media_url_from_path(file_path)
                is_video = is_video_file(filename)
                rel_path = filename
                try:
                    from app.services.media.category_query_service import get_category_by_id

                    cat_info = get_category_by_id(category_id) if category_id else None
                    cat_root = cat_info.get('path') if cat_info else None
                    if cat_root:
                        rel_path = os.path.relpath(file_path, cat_root).replace(os.sep, '/')
                except Exception as exc:
                    logger.debug("Could not derive deleted rel_path for %s: %s", file_path, exc)

                storage_io_service.get_file_io_pool().spawn(os.remove, file_path).get()

                deleted = {
                    'file_path': file_path,
                    'filename': filename,
                    'directory': directory,
                    'category_id': category_id,
                    'media_url': media_url,
                    'is_video': is_video,
                    'rel_path': rel_path,
                }
                deleted_items.append(deleted)
                if category_id:
                    affected_category_ids.add(category_id)
                    if rel_path:
                        invalidated_ids.append(f'{category_id}::{rel_path}')
                item.update({
                    'success': True,
                    'message': f"Deleted: {filename}",
                    'category_id': category_id,
                    'media_url': media_url,
                })
        except PermissionError:
            item['error'] = 'Permission denied - cannot delete this file'
        except OSError as exc:
            logger.error("Error deleting file %s: %s", file_path, exc)
            item['error'] = f"Delete failed: {str(exc)}"
        except Exception as exc:
            logger.error("Unexpected error deleting file %s: %s", file_path, exc)
            item['error'] = 'Delete failed due to server error'
        results.append(item)

    if deleted_items:
        try:
            from specter import bus
            from app.constants import BUS_EVENTS

            bus.emit(BUS_EVENTS['STORAGE_FILES_DELETED'], {
                'files': deleted_items,
                'affected_category_ids': sorted(affected_category_ids),
                'invalidated_ids': invalidated_ids,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.error("Failed to emit STORAGE_FILES_DELETED bus event: %s", exc)

    deleted_count = sum(1 for result in results if result.get('success'))
    return {
        'deleted': deleted_count,
        'failed': len(results) - deleted_count,
        'results': results,
        'affected_category_ids': sorted(affected_category_ids),
        'invalidated_media_ids': invalidated_ids,
    }


def rename_file(file_path: str, new_name: str) -> Tuple[bool, str, Optional[str]]:
    """Rename a media file and update related metadata."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(file_path, require_writable=True):
            return False, "Access denied", None
        if not os.path.exists(file_path):
            return False, "File not found", None
        if not os.path.isfile(file_path):
            return False, "Path is not a file", None

        from app.utils.media_utils import get_media_type, is_media_file, is_video_file

        if not is_media_file(os.path.basename(file_path)):
            return False, "Can only rename media files", None

        safe_new_name = secure_filename(new_name)
        if not safe_new_name:
            return False, "Invalid filename", None

        old_name = os.path.basename(file_path)
        _, old_ext = os.path.splitext(old_name)
        _, new_ext = os.path.splitext(safe_new_name)
        if not new_ext and old_ext:
            safe_new_name = safe_new_name + old_ext

        directory = os.path.dirname(file_path)
        from app.services.storage import storage_io_service, storage_path_service

        unique_name = storage_path_service.get_unique_filename(directory, safe_new_name)
        new_path = os.path.join(directory, unique_name)

        was_hidden = False
        try:
            from app.services.media.hidden_content_service import is_file_hidden

            was_hidden = bool(is_file_hidden(file_path))
        except Exception:
            was_hidden = False

        storage_io_service.get_file_io_pool().spawn(os.rename, file_path, new_path).get()

        category_id = None
        try:
            category_id = storage_path_service._get_category_id_from_path(directory)
        except Exception:
            category_id = None

        try:
            from specter import bus
            from app.constants import BUS_EVENTS

            old_media_url = storage_path_service.get_media_url_from_path(file_path)
            new_media_url = storage_path_service.get_media_url_from_path(new_path)

            bus.emit(BUS_EVENTS['STORAGE_FILE_RENAMED'], {
                'file_path': file_path,
                'new_path': new_path,
                'old_name': old_name,
                'new_name': unique_name,
                'directory': directory,
                'category_id': category_id,
                'was_hidden': was_hidden,
                'old_media_url': old_media_url,
                'new_media_url': new_media_url,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.error("Failed to emit STORAGE_FILE_RENAMED bus event: %s", exc)

        logger.info("File renamed: %s -> %s", file_path, new_path)
        return True, f"Renamed to: {unique_name}", new_path
    except PermissionError:
        return False, "Permission denied - cannot rename this file", None
    except OSError as exc:
        logger.error("Error renaming file %s: %s", file_path, exc)
        return False, f"Rename failed: {str(exc)}", None
    except Exception as exc:
        logger.error("Unexpected error renaming file: %s", exc)
        return False, "Rename failed due to server error", None


def _rename_thumbnail(file_dir: str, old_filename: str, new_filename: str) -> bool:
    """Rename a thumbnail file when its media file is renamed."""
    try:
        from app.utils.media_utils import get_thumbnail_filename

        search_dir = file_dir
        thumbnail_dir = None

        for _ in range(5):
            ghosthub_dir = os.path.join(search_dir, ".ghosthub")
            potential_thumb_dir = os.path.join(ghosthub_dir, "thumbnails")
            if os.path.exists(potential_thumb_dir):
                thumbnail_dir = potential_thumb_dir
                break
            parent = os.path.dirname(search_dir)
            if parent == search_dir:
                break
            search_dir = parent

        if not thumbnail_dir:
            return False

        old_thumb_name = get_thumbnail_filename(old_filename)
        new_thumb_name = get_thumbnail_filename(new_filename)
        old_thumb_path = os.path.join(thumbnail_dir, old_thumb_name)
        new_thumb_path = os.path.join(thumbnail_dir, new_thumb_name)

        renamed = False
        if os.path.exists(old_thumb_path):
            os.rename(old_thumb_path, new_thumb_path)
            logger.info("Thumbnail renamed: %s -> %s", old_thumb_name, new_thumb_name)
            renamed = True

        old_fail = old_thumb_path + ".failed"
        new_fail = new_thumb_path + ".failed"
        if os.path.exists(old_fail):
            os.rename(old_fail, new_fail)
        return renamed
    except Exception as exc:
        logger.warning("Failed to rename thumbnail for %s: %s", old_filename, exc)
        return False


def _delete_thumbnail(file_dir: str, filename: str) -> bool:
    """Delete a thumbnail file when its media file is removed."""
    try:
        from app.utils.media_utils import get_thumbnail_filename

        search_dir = file_dir
        thumbnail_dir = None

        for _ in range(5):
            ghosthub_dir = os.path.join(search_dir, ".ghosthub")
            potential_thumb_dir = os.path.join(ghosthub_dir, "thumbnails")
            if os.path.exists(potential_thumb_dir):
                thumbnail_dir = potential_thumb_dir
                break
            parent = os.path.dirname(search_dir)
            if parent == search_dir:
                break
            search_dir = parent

        if not thumbnail_dir:
            return False

        thumb_name = get_thumbnail_filename(filename)
        thumb_path = os.path.join(thumbnail_dir, thumb_name)
        deleted = False
        if os.path.exists(thumb_path):
            os.remove(thumb_path)
            logger.info("Thumbnail deleted: %s", thumb_name)
            deleted = True

        fail_marker = thumb_path + ".failed"
        if os.path.exists(fail_marker):
            os.remove(fail_marker)
            deleted = True
        return deleted
    except Exception as exc:
        logger.warning("Failed to delete thumbnail for %s: %s", filename, exc)
        return False


def _rename_associated_subtitles(file_dir: str, old_filename: str, new_filename: str) -> int:
    """Rename external subtitle files that track a renamed video."""
    subtitle_extensions = ['.srt', '.vtt', '.ass', '.ssa', '.sub']
    renamed_count = 0

    try:
        old_base = os.path.splitext(old_filename)[0]
        new_base = os.path.splitext(new_filename)[0]

        for extension in subtitle_extensions:
            old_sub_path = os.path.join(file_dir, old_base + extension)
            if os.path.exists(old_sub_path):
                new_sub_path = os.path.join(file_dir, new_base + extension)
                os.rename(old_sub_path, new_sub_path)
                logger.info("Subtitle renamed: %s%s -> %s%s", old_base, extension, new_base, extension)
                renamed_count += 1

            for entry in os.scandir(file_dir):
                if not entry.is_file():
                    continue
                name = entry.name
                if name.lower().endswith(extension.lower()) and name.lower().startswith(old_base.lower() + '.'):
                    suffix = name[len(old_base):]
                    new_sub_name = new_base + suffix
                    old_sub_full = os.path.join(file_dir, name)
                    new_sub_full = os.path.join(file_dir, new_sub_name)
                    if old_sub_full != new_sub_full and not os.path.exists(new_sub_full):
                        os.rename(old_sub_full, new_sub_full)
                        logger.info("Subtitle renamed: %s -> %s", name, new_sub_name)
                        renamed_count += 1

        return renamed_count
    except Exception as exc:
        logger.warning("Failed to rename subtitles for %s: %s", old_filename, exc)
        return renamed_count


def _invalidate_subtitle_cache(old_file_path: str) -> bool:
    """Remove cached extracted subtitles keyed by the old file path."""
    try:
        from app.services.core.runtime_config_service import get_runtime_config_value

        cache_dir = os.path.join(get_runtime_config_value('INSTANCE_FOLDER_PATH'), 'subtitle_cache')
        if not os.path.exists(cache_dir):
            return False

        video_hash = hashlib.md5(old_file_path.encode()).hexdigest()[:16]
        removed_count = 0
        for entry in os.scandir(cache_dir):
            if entry.is_file() and video_hash in entry.name:
                os.remove(entry.path)
                logger.info("Removed cached subtitle: %s", entry.name)
                removed_count += 1

        return removed_count > 0
    except Exception as exc:
        logger.warning("Failed to invalidate subtitle cache for %s: %s", old_file_path, exc)
        return False
