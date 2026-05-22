"""Direct multipart upload lifecycle for storage uploads."""

import logging
import os
import time
from typing import Dict, Set, Tuple

import gevent
from werkzeug.utils import secure_filename

logger = logging.getLogger(__name__)


def _save_file_async(file_storage, target_path: str) -> None:
    """Save a werkzeug file object in the shared file I/O pool."""
    file_storage.save(target_path)


def upload_file(
    file,
    drive_path: str,
    subfolder: str = '',
    relative_path: str = '',
    custom_filename: str = '',
) -> Tuple[bool, str]:
    """Upload a single file to the specified drive."""
    try:
        from app.services.storage.storage_drive_service import is_managed_storage_path
        from app.services.storage import storage_io_service
        from app.services.storage import storage_path_service

        if not is_managed_storage_path(drive_path, require_writable=True):
            return False, "Access denied"
        if not os.path.exists(drive_path):
            return False, "Drive not found"
        if not storage_io_service.is_path_writable(drive_path):
            return False, "Drive is not writable"

        original_filename = file.filename
        filename = secure_filename(custom_filename or original_filename)
        if not filename:
            return False, "Invalid filename"

        target_dir = storage_path_service.build_storage_target_dir(
            drive_path,
            subfolder=subfolder,
            relative_path=relative_path,
        )

        os.makedirs(target_dir, exist_ok=True)

        filename = storage_path_service.get_unique_filename(target_dir, filename)
        target_path = os.path.join(target_dir, filename)

        storage_io_service.get_file_io_pool().spawn(_save_file_async, file, target_path).get()
        gevent.sleep(0)

        if not os.path.exists(target_path):
            return False, "File save failed"

        file_size = os.path.getsize(target_path)
        logger.info(
            "File uploaded successfully: %s (%s)",
            target_path,
            storage_io_service.format_bytes(file_size),
        )

        storage_path_service._auto_hide_if_parent_hidden(target_path, drive_path)
        try:
            from specter import bus
            from app.constants import BUS_EVENTS
            
            category_id = storage_path_service._get_category_id_from_path(target_dir)
            media_url = storage_path_service.get_media_url_from_path(target_path)
            bus.emit(BUS_EVENTS['STORAGE_FILE_UPLOADED'], {
                'target_dir': target_dir,
                'target_path': target_path,
                'filename': filename,
                'category_id': category_id,
                'media_url': media_url,
                'timestamp': time.time(),
            })
        except Exception as exc:
            logger.debug("Failed to emit STORAGE_FILE_UPLOADED bus event: %s", exc)

        return True, f"File uploaded: {filename}"
    except PermissionError:
        return False, "Permission denied - cannot write to this location"
    except OSError as exc:
        logger.error("OS error during upload: %s", exc)
        return False, f"Upload failed: {str(exc)}"
    except Exception as exc:
        logger.error("Unexpected error during upload: %s", exc)
        return False, "Upload failed due to server error"


def upload_files(
    files,
    drive_path: str,
    subfolder: str = '',
    relative_path: str = '',
    custom_filename: str = '',
) -> Dict:
    """Upload a batch of files and refresh affected library state."""
    results = []
    success_count = 0
    uploaded_categories: Set[str] = set()

    for file in files:
        if not file.filename:
            continue

        success, message = upload_file(
            file,
            drive_path,
            subfolder,
            relative_path,
            custom_filename,
        )
        results.append({
            'filename': custom_filename if custom_filename and success else file.filename,
            'success': success,
            'message': message,
        })
        if success:
            success_count += 1
            target_dir = os.path.join(drive_path, subfolder if subfolder else '')
            if relative_path:
                target_dir = os.path.join(target_dir, os.path.dirname(relative_path))
            uploaded_categories.add(target_dir)

    try:
        from specter import bus
        from app.constants import BUS_EVENTS
        bus.emit(BUS_EVENTS['STORAGE_BATCH_UPLOADED'], {
            'success_count': success_count,
            'uploaded_categories': list(uploaded_categories),
            'timestamp': time.time(),
        })
    except Exception as exc:
        logger.debug("Failed to emit STORAGE_BATCH_UPLOADED bus event: %s", exc)

    return {
        'success': success_count > 0,
        'uploaded': success_count,
        'total': len(files),
        'results': results,
        'background_processing': True,
    }
