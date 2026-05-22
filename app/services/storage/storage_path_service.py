"""Storage path, category, and filename helpers."""

import logging
import os
from typing import Optional, Tuple
from urllib.parse import quote

from werkzeug.utils import secure_filename

logger = logging.getLogger(__name__)


def secure_storage_relative_path(path_str: str) -> str:
    """Secure each component of a nested relative storage path."""
    if not path_str:
        return ''

    parts = path_str.replace('\\', '/').split('/')
    secured = [secure_filename(part) for part in parts if part]
    return os.path.join(*secured) if secured else ''


def build_storage_target_dir(
    drive_path: str,
    subfolder: str = '',
    relative_path: str = '',
) -> str:
    """Build a sanitized target directory inside a managed storage drive."""
    if relative_path:
        rel_dir = os.path.dirname(relative_path)
        if rel_dir:
            secured_subfolder = secure_storage_relative_path(subfolder)
            secured_rel_dir = secure_storage_relative_path(rel_dir)
            if secured_subfolder:
                return os.path.join(drive_path, secured_subfolder, secured_rel_dir)
            return os.path.join(drive_path, secured_rel_dir)

    secured_subfolder = secure_storage_relative_path(subfolder)
    return os.path.join(drive_path, secured_subfolder) if secured_subfolder else drive_path


def check_file_exists(drive_path: str, subfolder: str = '', relative_path: str = '', filename: str = '') -> bool:
    """Check if a target file path already exists."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(drive_path):
            return False
        if not os.path.exists(drive_path):
            return False

        filename = secure_filename(filename)
        if not filename:
            return False

        target_dir = build_storage_target_dir(
            drive_path,
            subfolder=subfolder,
            relative_path=relative_path,
        )

        return os.path.exists(os.path.join(target_dir, filename))
    except Exception as exc:
        logger.error("Error checking file existence: %s", exc)
        return False


def get_unique_filename(directory: str, filename: str) -> str:
    """Return a collision-free filename within a directory."""
    target_path = os.path.join(directory, filename)
    if not os.path.exists(target_path):
        return filename

    base, ext = os.path.splitext(filename)
    counter = 1
    while os.path.exists(target_path):
        filename = f"{base}_{counter}{ext}"
        target_path = os.path.join(directory, filename)
        counter += 1

    return filename


def _get_auto_category_id_from_path(directory: str) -> Optional[str]:
    """Resolve an auto category ID from a filesystem directory path."""
    usb_roots = ['/media', '/media/usb', '/media/ghost', '/media/pi', '/mnt']
    path_normalized = os.path.normpath(directory)

    for root in usb_roots:
        root_normalized = os.path.normpath(root)
        if path_normalized.startswith(root_normalized + os.sep) or path_normalized == root_normalized:
            rel_path = os.path.relpath(path_normalized, root_normalized)
            if rel_path and rel_path != '.':
                id_parts = ['auto'] + [part for part in rel_path.replace(os.sep, '/').split('/') if part]
                return '::'.join(id_parts)
            break

    return None


def _get_best_registered_category_for_path(path: str) -> Tuple[Optional[str], Optional[str]]:
    """Return the deepest registered category containing a path."""
    try:
        from app.services.media.category_query_service import get_all_categories_with_details

        normalized_path = os.path.normpath(path)
        best_match = None
        for category in get_all_categories_with_details(show_hidden=True):
            cat_path = category.get('path')
            if not cat_path:
                continue
            cat_path_norm = os.path.normpath(cat_path)
            if normalized_path == cat_path_norm or normalized_path.startswith(cat_path_norm + os.sep):
                if best_match is None or len(cat_path_norm) > len(os.path.normpath(best_match.get('path', ''))):
                    best_match = category
        if best_match:
            return best_match.get('id'), os.path.normpath(best_match.get('path'))
    except Exception as exc:
        logger.debug("Could not resolve registered category for %s: %s", path, exc)
    return None, None


def _get_category_id_from_path(directory: str) -> Optional[str]:
    """Resolve the category ID that owns a filesystem directory.

    Registered categories win over the auto-derived id: an upload into a
    subfolder (e.g. /media/ghost/Drive/Movies/x.mp4) must be attributed to
    the registered drive category (auto::ghost::Drive), not to a synthetic
    subfolder id (auto::ghost::Drive::Movies) that no category in the DB
    owns — otherwise the indexer writes the file under a phantom category
    and the UI invalidation targets nothing real.
    """
    category_id, _category_path = _get_best_registered_category_for_path(directory)
    if category_id:
        return category_id

    return _get_auto_category_id_from_path(directory)


def get_category_id_from_path(directory: str) -> Optional[str]:
    """Public wrapper for resolving a category ID from a path."""
    return _get_category_id_from_path(directory)


def get_media_url_from_path(file_path: str) -> Optional[str]:
    """Build a `/media/...` URL for a filesystem path when possible."""
    try:
        directory = os.path.normpath(os.path.dirname(file_path))
        filename = os.path.basename(file_path)
        if not filename:
            return None

        # Prefer the deepest registered category so subfolder uploads resolve
        # to the drive's actual category id (not a synthetic per-subfolder id).
        # Auto-derivation is a fallback only when no registered category owns
        # the path.
        category_id, category_root = _get_best_registered_category_for_path(directory)
        if not category_id:
            category_id = _get_auto_category_id_from_path(directory)
            category_root = directory if category_id else None

        if not category_id:
            return None

        rel_path = filename
        if category_root:
            rel_path = os.path.relpath(file_path, category_root).replace(os.sep, '/')

        return f"/media/{category_id}/{quote(rel_path)}"
    except Exception as exc:
        logger.debug("Could not build media URL for %s: %s", file_path, exc)
        return None


def cleanup_empty_parent(folder_path: str) -> int:
    """
    Delete empty parent folders after file removal until a stop path is reached.
    """
    deleted_count = 0
    stop_paths = {
        '/media',
        '/media/ghost',
        '/media/usb',
        '/mnt',
        '/media/ghost/',
        '/media/usb/',
        '/mnt/',
    }

    current = os.path.normpath(folder_path)

    while current and current not in stop_paths:
        if len(current) < 5 or current == '/':
            break

        parts = current.split(os.sep)
        if len(parts) <= 4 and any(part in ['media', 'mnt'] for part in parts):
            break

        try:
            contents = list(os.scandir(current))
            visible = [
                entry for entry in contents
                if not entry.name.startswith('.')
                and entry.name not in ['.ghosthub', '.ghosthub_uploads']
            ]

            if visible:
                break

            for entry in contents:
                if entry.is_file():
                    try:
                        os.remove(entry.path)
                    except Exception as exc:
                        logger.debug("Could not remove cleanup sidecar %s: %s", entry.path, exc)

            os.rmdir(current)
            logger.info("Auto-deleted empty folder: %s", current)
            deleted_count += 1
            current = os.path.dirname(current)
        except (PermissionError, OSError) as exc:
            logger.debug("Cannot cleanup %s: %s", current, exc)
            break

    return deleted_count


def _auto_hide_if_parent_hidden(file_path: str, drive_path: str) -> None:
    """Auto-hide a file if it lands inside a hidden folder tree."""
    try:
        from app.services.media.hidden_content_service import hide_file, is_category_hidden

        file_dir = os.path.dirname(file_path)
        usb_roots = ['/media', '/media/usb', '/media/ghost', '/mnt']
        parent_chain = []

        path_normalized = os.path.normpath(file_dir)
        for root in usb_roots:
            root_normalized = os.path.normpath(root)
            if path_normalized.startswith(root_normalized + os.sep):
                rel_path = os.path.relpath(path_normalized, root_normalized)
                if rel_path and rel_path != '.':
                    parent_chain = [part for part in rel_path.replace(os.sep, '/').split('/') if part]
                break

        if not parent_chain:
            rel_path = os.path.relpath(file_dir, drive_path)
            if rel_path and rel_path != '.':
                parent_chain = [part for part in rel_path.replace(os.sep, '/').split('/') if part]

        if not parent_chain:
            return

        category_id = 'auto::' + '::'.join(parent_chain)
        for index in range(len(parent_chain), 0, -1):
            check_id = 'auto::' + '::'.join(parent_chain[:index])
            if is_category_hidden(check_id):
                success, message = hide_file(file_path, category_id)
                if success:
                    logger.info(
                        "Auto-hid file in hidden folder: %s (parent: %s)",
                        file_path,
                        check_id,
                    )
                else:
                    logger.warning("Failed to auto-hide file: %s", message)
                break
    except Exception as exc:
        logger.warning("Error in auto-hide check: %s", exc)
