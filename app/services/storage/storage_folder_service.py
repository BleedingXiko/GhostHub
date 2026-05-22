"""Folder-management workflows for storage domains."""

import logging
import os
import shutil
import time
from typing import Dict, List, Optional, Tuple

from werkzeug.utils import secure_filename

logger = logging.getLogger(__name__)

SYSTEM_DIR_NAMES = {
    '$recycle.bin',
    'system volume information',
    '.ghosthub',
    '.ghosthub_uploads',
    'ghosthubbackups',
}

def _has_subdirectories(path: str) -> bool:
    """Check whether a directory has any non-system subdirectories."""
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if entry.is_dir() and not entry.name.startswith('.'):
                    if entry.name.lower() not in SYSTEM_DIR_NAMES:
                        return True
    except (PermissionError, OSError) as exc:
        logger.debug("Could not scan subdirectories for %s: %s", path, exc)
    return False


def _get_folder_size(folder_path: str) -> int:
    """Get total size of a folder in bytes."""
    total_size = 0
    try:
        for dirpath, _dirnames, filenames in os.walk(folder_path):
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                try:
                    total_size += os.path.getsize(filepath)
                except (OSError, PermissionError) as exc:
                    logger.debug("Could not stat %s while sizing %s: %s", filepath, folder_path, exc)
    except (OSError, PermissionError) as exc:
        logger.debug("Could not walk folder size for %s: %s", folder_path, exc)
    return total_size


def get_drive_folders(drive_path: str, show_hidden: bool = False, include_subdirs: bool = False,
                      include_hidden_info: bool = False, _parent_chain: list = None,
                      _base_root: str = None) -> List[Dict]:
    """Get visible folders in a drive for selection and admin management."""
    folders = []

    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(drive_path):
            logger.warning("Rejected folder listing outside managed storage roots: %s", drive_path)
            return folders

        if not os.path.exists(drive_path):
            return folders

        from app.services.media.hidden_content_service import (
            is_category_hidden,
            should_block_category_access,
        )

        if _parent_chain is None:
            _parent_chain = []
            usb_roots = ['/media', '/media/usb', '/media/ghost', '/mnt']
            path_normalized = os.path.normpath(drive_path)

            for root in usb_roots:
                root_normalized = os.path.normpath(root)
                if path_normalized.startswith(root_normalized + os.sep):
                    _base_root = root_normalized
                    rel_path = os.path.relpath(path_normalized, root_normalized)
                    if rel_path and rel_path != '.':
                        _parent_chain = [part for part in rel_path.replace(os.sep, '/').split('/') if part]
                    break

            if _base_root is None:
                _base_root = drive_path

        with os.scandir(drive_path) as entries:
            for entry in entries:
                if not entry.is_dir() or entry.name.startswith('.'):
                    continue
                if entry.name.lower() in SYSTEM_DIR_NAMES:
                    continue

                should_filter = False
                category_id = None
                is_hidden = False

                try:
                    id_parts = ['auto'] + _parent_chain + [entry.name]
                    category_id = '::'.join(id_parts)
                    is_effectively_hidden = is_category_hidden(category_id)

                    if not is_effectively_hidden:
                        current_chain = _parent_chain + [entry.name]
                        for index in range(len(current_chain) - 1, 0, -1):
                            check_id = 'auto::' + '::'.join(current_chain[:index])
                            if is_category_hidden(check_id):
                                is_effectively_hidden = True
                                break

                    if include_hidden_info:
                        is_hidden = is_effectively_hidden
                    elif is_effectively_hidden and not show_hidden:
                        logger.debug(
                            "Filtering hidden category recursively: %s (%s)",
                            entry.name,
                            category_id,
                        )
                        should_filter = True
                    elif should_block_category_access(category_id, show_hidden):
                        logger.debug("Filtering hidden category: %s (%s)", entry.name, category_id)
                        should_filter = True
                except Exception as exc:
                    logger.debug("Could not generate category ID for %s: %s", entry.name, exc)

                if should_filter:
                    continue

                folder_info = {
                    'name': entry.name,
                    'path': entry.path,
                }

                if include_hidden_info:
                    folder_info['hidden'] = is_hidden
                    folder_info['category_id'] = category_id

                if include_subdirs:
                    try:
                        new_parent_chain = _parent_chain + [entry.name]
                        subdirs = get_drive_folders(
                            entry.path,
                            show_hidden,
                            include_subdirs=True,
                            include_hidden_info=include_hidden_info,
                            _parent_chain=new_parent_chain,
                            _base_root=_base_root,
                        )
                        if subdirs:
                            folder_info['children'] = subdirs
                    except Exception as exc:
                        logger.debug("Could not list subfolders for %s: %s", entry.path, exc)

                if not show_hidden and not include_hidden_info and include_subdirs:
                    if _has_subdirectories(entry.path) and 'children' not in folder_info:
                        logger.debug(
                            "Hiding parent folder %s because all children are hidden",
                            entry.name,
                        )
                        continue

                folders.append(folder_info)

        folders.sort(key=lambda item: item['name'].lower())
    except (PermissionError, OSError) as exc:
        logger.debug("Error listing folders in %s: %s", drive_path, exc)
    except Exception as exc:
        logger.error("Unexpected error in get_drive_folders for %s: %s", drive_path, exc)

    return folders


def create_folder(drive_path: str, folder_name: str) -> Tuple[bool, str]:
    """Create a new folder on a drive."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(drive_path, require_writable=True):
            return False, "Access denied"

        folder_name = secure_filename(folder_name)
        if not folder_name:
            return False, "Invalid folder name"

        folder_path = os.path.join(drive_path, folder_name)
        if os.path.exists(folder_path):
            return False, "Folder already exists"

        os.makedirs(folder_path)
        logger.info("Created folder: %s", folder_path)
        return True, f"Folder created: {folder_name}"
    except PermissionError:
        return False, "Permission denied"
    except OSError as exc:
        return False, f"Failed to create folder: {str(exc)}"


def get_folder_contents(folder_path: str) -> Tuple[bool, str, Optional[List[Dict]]]:
    """Get recursive contents of a folder for upload preview."""
    try:
        if not os.path.exists(folder_path):
            return False, "Folder not found", None

        from app.services.storage import storage_io_service

        contents = []
        for root, dirs, files in os.walk(folder_path):
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            for file in files:
                if file.startswith('.'):
                    continue
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, folder_path)
                try:
                    size = os.path.getsize(file_path)
                    contents.append({
                        'name': file,
                        'relative_path': rel_path,
                        'size': size,
                        'size_formatted': storage_io_service.format_bytes(size),
                    })
                except OSError as exc:
                    logger.debug("Could not stat folder content %s: %s", file_path, exc)

        return True, f"Found {len(contents)} files", contents
    except Exception as exc:
        logger.error("Error getting folder contents: %s", exc)
        return False, str(exc), None


def delete_folder(folder_path: str, force: bool = False) -> Tuple[bool, str]:
    """Delete a folder, optionally recursively."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(folder_path, require_writable=True):
            return False, "Access denied"

        if not os.path.exists(folder_path):
            return False, "Folder not found"
        if not os.path.isdir(folder_path):
            return False, "Path is not a folder"
        if os.path.islink(folder_path):
            return False, "Cannot delete symbolic links through this API"

        contents = list(os.scandir(folder_path))
        is_empty = len(contents) == 0
        if not is_empty and not force:
            return False, f"Folder is not empty ({len(contents)} items). Use force=True to delete anyway."

        if is_empty:
            from app.services.storage import storage_io_service

            storage_io_service.get_file_io_pool().spawn(os.rmdir, folder_path).get()
        else:
            from app.services.storage import storage_io_service

            storage_io_service.get_file_io_pool().spawn(shutil.rmtree, folder_path).get()

        logger.info("Deleted folder: %s", folder_path)
        try:
            from specter import bus
            from app.services.storage import storage_path_service

            category_id = storage_path_service._get_category_id_from_path(folder_path)
            if category_id:
                from app.constants import BUS_EVENTS
                bus.emit(BUS_EVENTS['STORAGE_FOLDER_DELETED'], {
                    'folder_path': folder_path,
                    'category_id': category_id,
                    'timestamp': time.time(),
                })
        except Exception as exc:
            logger.debug("Media index cleanup event skipped for deleted folder %s: %s", folder_path, exc)

        return True, "Folder deleted successfully"
    except PermissionError:
        return False, "Permission denied"
    except OSError as exc:
        logger.error("Error deleting folder: %s", exc)
        return False, f"Failed to delete folder: {str(exc)}"


def cleanup_empty_folders(drive_path: str = None, dry_run: bool = False) -> Tuple[bool, str, List[str]]:
    """Recursively find and optionally delete empty folders on a drive."""
    if drive_path is None:
        from app.services.storage import storage_drive_service

        all_deleted = []
        drives = storage_drive_service.get_storage_drives()
        for drive in drives:
            if drive.get('writable', False):
                try:
                    _, _, deleted = cleanup_empty_folders(drive['path'], dry_run)
                    all_deleted.extend(deleted)
                except Exception as exc:
                    logger.debug("Cleanup skipped for %s: %s", drive['path'], exc)
        return True, f"Cleaned {len(all_deleted)} empty folder(s)", all_deleted

    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path

        if not is_managed_storage_path(drive_path, require_writable=True):
            return False, "Access denied", []

        if not os.path.exists(drive_path):
            return False, "Drive not found", []

        empty_folders = []
        for root, _dirs, _files in os.walk(drive_path, topdown=False):
            if any(part.startswith('.') for part in root.split(os.sep)):
                continue
            if os.path.basename(root).lower() in SYSTEM_DIR_NAMES:
                continue

            try:
                contents = list(os.scandir(root))
                visible_contents = [
                    entry for entry in contents
                    if not entry.name.startswith('.')
                    and entry.name not in ['.ghosthub', '.ghosthub_uploads']
                ]

                if len(visible_contents) == 0 and root != drive_path:
                    empty_folders.append(root)
                    if not dry_run:
                        try:
                            for entry in contents:
                                if entry.is_file():
                                    os.remove(entry.path)
                            os.rmdir(root)
                            logger.info("Deleted empty folder: %s", root)
                        except OSError as exc:
                            logger.warning("Could not delete %s: %s", root, exc)
            except PermissionError:
                continue

        action = "Found" if dry_run else "Deleted"
        return True, f"{action} {len(empty_folders)} empty folder(s)", empty_folders
    except Exception as exc:
        logger.error("Error cleaning up empty folders: %s", exc)
        return False, f"Cleanup failed: {str(exc)}", []
