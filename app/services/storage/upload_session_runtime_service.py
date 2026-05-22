"""Chunked upload session lifecycle for storage uploads. Built on Specter."""

import hashlib
import logging
import os
import shutil
import time
from typing import Dict, Optional, Tuple

import gevent
from werkzeug.utils import secure_filename

from app.services.core.runtime_config_service import get_runtime_config_value
from app.services.storage.storage_cleanup_service import cleanup_recycle_bins
from app.services.storage.storage_drive_service import get_storage_drives
from app.services.storage.storage_io_service import (
    format_bytes,
    get_file_io_pool,
    is_path_within,
    is_path_writable,
)
from app.services.storage.storage_path_service import (
    _auto_hide_if_parent_hidden,
    _get_category_id_from_path,
    get_unique_filename,
)
from app.services.system.system_stats_service import get_hardware_tier, get_memory_info
from specter import Service, registry

logger = logging.getLogger(__name__)

CHUNK_UPLOAD_TIMEOUT = 3600
CLEANUP_INTERVAL = 3600


class UploadSessionRuntimeService(Service):
    """Runtime service managing active chunked upload sessions."""

    name = 'upload_session_runtime'

    def __init__(self):
        super().__init__('upload_session_runtime', {
            'runtime_initialized': False,
            'cleanup_interval_seconds': 0,
        })
        self._cleanup_interval_id = None

    @property
    def store(self):
        return registry.require('upload_sessions')

    @property
    def active_uploads(self):
        """Return the shared active uploads mapping from the runtime store."""
        uploads = self.store.get('active_uploads')
        if uploads is None:
            uploads = {}
            self.store.set({'active_uploads': uploads})
        return uploads

    @property
    def upload_lock(self):
        """Return the gevent-safe lock guarding active upload state."""
        lock = self.store.get('upload_lock')
        if lock is None:
            from gevent.lock import BoundedSemaphore
            lock = BoundedSemaphore(1)
            self.store.set({'upload_lock': lock})
        return lock

    def initialize_runtime(self, *, cleanup_interval_seconds=CLEANUP_INTERVAL):
        """Start the worker-owned cleanup scheduler once."""
        if self.state.get('runtime_initialized'):
            return self.get_state()

        interval_seconds = max(1, int(cleanup_interval_seconds or CLEANUP_INTERVAL))
        self.cleanup_stale_uploads()
        self._cleanup_interval_id = self.interval(
            self.cleanup_stale_uploads,
            interval_seconds,
        )
        logger.info(
            "Upload cleanup scheduler started (runs every %ss)",
            interval_seconds,
        )
        self.set_state({
            'runtime_initialized': True,
            'cleanup_interval_seconds': interval_seconds,
        })
        return self.get_state()

    def teardown_runtime(self):
        """Stop the worker-owned cleanup scheduler."""
        if not self.state.get('runtime_initialized') and not self._cleanup_interval_id:
            return self.get_state()

        if self._cleanup_interval_id:
            self.cancel_interval(self._cleanup_interval_id)
            self._cleanup_interval_id = None
        self.set_state({
            'runtime_initialized': False,
            'cleanup_interval_seconds': 0,
        })
        logger.info("Upload cleanup scheduler stopped")
        return self.get_state()

    def on_stop(self):
        """Stop any worker-owned cleanup scheduling before service teardown."""
        self.teardown_runtime()

    def get_ram_staging_path(self) -> Optional[str]:
        """Get the RAM-backed staging path when it is safe to use."""
        if not get_runtime_config_value('AUTO_OPTIMIZE_FOR_HARDWARE'):
            return None

        ram_path = '/dev/shm/ghosthub_uploads'
        if not os.path.exists('/dev/shm') or not os.access('/dev/shm', os.W_OK):
            return None

        mem = get_memory_info()
        if not mem:
            return None

        tier = get_hardware_tier()
        available_ram_mb = mem.get('available_mb', 0)
        if tier == 'PRO':
            budget_mb = 4096
        elif tier == 'STANDARD':
            budget_mb = 1024
        else:
            budget_mb = 256

        safe_budget_mb = min(budget_mb, available_ram_mb // 2)
        if safe_budget_mb <= 0:
            return None

        try:
            os.makedirs(ram_path, exist_ok=True)
            return ram_path
        except Exception:
            return None

    def init_chunked_upload(
        self,
        filename: str,
        total_chunks: int,
        total_size: int,
        drive_path: str,
        subfolder: str = '',
        relative_path: str = '',
        chunk_size: int = 2 * 1024 * 1024,
        custom_filename: str = '',
    ) -> Tuple[bool, str, Optional[str]]:
        """Initialize a chunked upload session."""
        try:
            from app.services.storage.storage_drive_service import is_managed_storage_path

            if not is_managed_storage_path(drive_path, require_writable=True):
                return False, "Access denied", None
            if not os.path.exists(drive_path):
                return False, "Drive not found", None
            if not is_path_writable(drive_path):
                return False, "Drive is not writable", None

            stat = shutil.disk_usage(drive_path)
            if stat.free < total_size:
                return (
                    False,
                    f"Not enough space. Need {format_bytes(total_size)}, "
                    f"have {format_bytes(stat.free)}",
                    None,
                )

            upload_id = hashlib.md5(
                f"{filename}{time.time()}{os.urandom(8).hex()}".encode()
            ).hexdigest()[:16]

            from app.services.storage import storage_path_service

            target_dir = storage_path_service.build_storage_target_dir(
                drive_path,
                subfolder=subfolder,
                relative_path=relative_path,
            )

            os.makedirs(target_dir, exist_ok=True)

            safe_filename = secure_filename(custom_filename or filename)
            if not safe_filename:
                return False, "Invalid filename", None

            safe_filename = get_unique_filename(target_dir, safe_filename)
            target_path = os.path.join(target_dir, safe_filename)

            ram_staging = self.get_ram_staging_path()
            use_ram = False
            if ram_staging:
                mem = get_memory_info()
                tier = get_hardware_tier()
                available_ram_mb = mem.get('available_mb', 0) if mem else 0
                if tier == 'PRO':
                    budget_mb = 4096
                elif tier == 'STANDARD':
                    budget_mb = 1024
                else:
                    budget_mb = 256
                if (total_size / (1024 * 1024)) < min(budget_mb, available_ram_mb // 2):
                    use_ram = True

            if use_ram:
                temp_dir = ram_staging
                temp_path = os.path.join(temp_dir, f"{upload_id}.tmp")
                logger.info(
                    "Using RAM staging for upload %s (%s)",
                    upload_id,
                    format_bytes(total_size),
                )
            else:
                temp_dir = os.path.join(drive_path, '.ghosthub_uploads')
                temp_path = os.path.join(temp_dir, f"{upload_id}.tmp")

            os.makedirs(temp_dir, exist_ok=True)

            with self.upload_lock:
                self.active_uploads[upload_id] = {
                    'temp_path': temp_path,
                    'target_path': target_path,
                    'filename': safe_filename,
                    'drive_path': drive_path,
                    'total_chunks': total_chunks,
                    'total_size': total_size,
                    'chunk_size': chunk_size,
                    'received_chunks': set(),
                    'bytes_received': 0,
                    'last_activity': time.time(),
                }

            open(temp_path, 'wb').close()
            logger.info(
                "Initialized chunked upload %s: %s (%s chunks, %s)",
                upload_id,
                filename,
                total_chunks,
                format_bytes(total_size),
            )
            return True, "Upload initialized", upload_id
        except Exception as exc:
            logger.error("Error initializing chunked upload: %s", exc)
            return False, str(exc), None

    def upload_chunk(
        self,
        upload_id: str,
        chunk_index: int,
        chunk_data,
        chunk_size: Optional[int] = None,
    ) -> Tuple[bool, str, Optional[Dict]]:
        """Receive and store a single chunk for an active upload."""
        try:
            with self.upload_lock:
                if upload_id not in self.active_uploads:
                    return False, "Upload session not found or expired", None

                upload = self.active_uploads[upload_id]
                if chunk_index in upload['received_chunks']:
                    progress = len(upload['received_chunks']) / upload['total_chunks'] * 100
                    return True, "Chunk already received", {
                        'progress': progress,
                        'chunks_received': len(upload['received_chunks']),
                        'total_chunks': upload['total_chunks'],
                        'complete': len(upload['received_chunks']) == upload['total_chunks'],
                    }

                upload['last_activity'] = time.time()
                temp_path = upload['temp_path']
                expected_chunk_size = upload['chunk_size']

            actual_chunk_size = chunk_size if chunk_size is not None else len(chunk_data)
            offset = chunk_index * expected_chunk_size

            def _write_chunk_async():
                if hasattr(chunk_data, 'read'):
                    if hasattr(chunk_data, 'seek'):
                        chunk_data.seek(0)
                    data_to_write = chunk_data.read()
                else:
                    data_to_write = chunk_data

                with open(temp_path, 'r+b') as handle:
                    handle.seek(offset)
                    handle.write(data_to_write)
                    handle.flush()

            get_file_io_pool().spawn(_write_chunk_async).get()
            gevent.sleep(0)

            with self.upload_lock:
                upload['received_chunks'].add(chunk_index)
                upload['bytes_received'] += actual_chunk_size
                chunks_done = len(upload['received_chunks'])
                total = upload['total_chunks']
                progress = chunks_done / total * 100
                is_complete = chunks_done == total

            status = {
                'progress': progress,
                'chunks_received': chunks_done,
                'total_chunks': total,
                'complete': is_complete,
            }

            if is_complete:
                success, message = self.finalize_chunked_upload(upload_id)
                if not success:
                    return False, message, status
                with self.upload_lock:
                    if upload_id in self.active_uploads:
                        status['final_path'] = self.active_uploads[upload_id].get('target_path')

            return True, "Chunk received", status
        except Exception as exc:
            logger.error("Error receiving chunk %s for %s: %s", chunk_index, upload_id, exc)
            return False, str(exc), None

    def finalize_chunked_upload(self, upload_id: str) -> Tuple[bool, str]:
        """Finalize a completed chunked upload by moving it into place."""
        try:
            with self.upload_lock:
                if upload_id not in self.active_uploads:
                    return False, "Upload session not found"
                upload = self.active_uploads[upload_id]
                temp_path = upload['temp_path']
                target_path = upload['target_path']
                filename = upload['filename']
                drive_path = upload.get('drive_path', '')

            def _move_file_async():
                shutil.move(temp_path, target_path)
                actual_size = os.path.getsize(target_path)
                logger.info(
                    "Finalized chunked upload %s: %s (%s)",
                    upload_id,
                    filename,
                    format_bytes(actual_size),
                )
                return actual_size

            get_file_io_pool().spawn(_move_file_async).get()
            gevent.sleep(0)
            _auto_hide_if_parent_hidden(target_path, drive_path)

            with self.upload_lock:
                if upload_id in self.active_uploads:
                    del self.active_uploads[upload_id]

            category_dir = os.path.dirname(target_path)
            category_id = None

            try:
                from specter import bus
                from app.constants import BUS_EVENTS

                category_id = _get_category_id_from_path(category_dir)
                from app.services.storage.storage_path_service import get_media_url_from_path
                media_url = get_media_url_from_path(target_path)
                bus.emit(BUS_EVENTS['STORAGE_FILE_UPLOADED'], {
                    'target_dir': category_dir,
                    'target_path': target_path,
                    'filename': filename,
                    'category_id': category_id,
                    'media_url': media_url,
                    'timestamp': time.time(),
                })
                
                bus.emit(BUS_EVENTS['STORAGE_BATCH_UPLOADED'], {
                    'success_count': 1,
                    'uploaded_categories': [category_dir],
                    'timestamp': time.time(),
                })
                logger.info("Emitted bus events for chunked upload complete: %s", filename)
            except Exception as exc:
                logger.error("Failed to emit upload completion bus events: %s", exc)
                import traceback
                logger.error(traceback.format_exc())

            return True, f"Upload complete: {filename}"
        except Exception as exc:
            logger.error("Error finalizing upload %s: %s", upload_id, exc)
            return False, str(exc)

    def cancel_chunked_upload(self, upload_id: str) -> Tuple[bool, str]:
        """Cancel an in-progress chunked upload and clean up temp files."""
        try:
            with self.upload_lock:
                if upload_id not in self.active_uploads:
                    return False, "Upload session not found"
                upload = self.active_uploads.pop(upload_id)

            if os.path.exists(upload['temp_path']):
                os.remove(upload['temp_path'])

            logger.info("Cancelled chunked upload %s", upload_id)
            return True, "Upload cancelled"
        except Exception as exc:
            logger.error("Error cancelling upload %s: %s", upload_id, exc)
            return False, str(exc)

    def get_upload_status(self, upload_id: str) -> Optional[Dict]:
        """Get the current status of a chunked upload."""
        with self.upload_lock:
            if upload_id not in self.active_uploads:
                return None
            upload = self.active_uploads[upload_id]
            return {
                'filename': upload['filename'],
                'progress': len(upload['received_chunks']) / upload['total_chunks'] * 100,
                'chunks_received': len(upload['received_chunks']),
                'total_chunks': upload['total_chunks'],
                'bytes_received': upload['bytes_received'],
                'total_size': upload['total_size'],
            }

    def cleanup_ram_staging(self):
        """Clean up orphaned upload files in RAM staging."""
        ram_path = '/dev/shm/ghosthub_uploads'
        if not os.path.exists(ram_path):
            return

        try:
            for item in os.listdir(ram_path):
                item_path = os.path.join(ram_path, item)
                if os.path.islink(item_path):
                    continue
                if not is_path_within(ram_path, item_path):
                    continue
                if os.path.isfile(item_path) and item.endswith('.tmp'):
                    with self.upload_lock:
                        is_active = any(
                            upload.get('temp_path') == item_path
                            for upload in self.active_uploads.values()
                        )
                    if not is_active:
                        os.remove(item_path)
                        logger.info("Cleaned up orphaned RAM staging file: %s", item)
        except Exception as exc:
            logger.error("Error cleaning up RAM staging: %s", exc)

    def cleanup_disk_staging(self):
        """Clean up orphaned upload files in per-drive staging directories."""
        try:
            drives = get_storage_drives()
            for drive in drives:
                if not drive.get('writable', False):
                    continue

                upload_dir = os.path.join(drive['path'], '.ghosthub_uploads')
                if not os.path.exists(upload_dir):
                    continue

                try:
                    for item in os.listdir(upload_dir):
                        item_path = os.path.join(upload_dir, item)
                        if os.path.islink(item_path):
                            continue
                        if not is_path_within(upload_dir, item_path):
                            continue
                        if os.path.isfile(item_path) and item.endswith('.tmp'):
                            with self.upload_lock:
                                is_active = any(
                                    upload.get('temp_path') == item_path
                                    for upload in self.active_uploads.values()
                                )
                            if not is_active:
                                try:
                                    os.remove(item_path)
                                    logger.info("Cleaned up orphaned temp file: %s", item_path)
                                except OSError as exc:
                                    logger.debug("Could not remove %s: %s", item_path, exc)
                except (PermissionError, OSError) as exc:
                    logger.debug("Could not scan %s: %s", upload_dir, exc)
        except Exception as exc:
            logger.error("Error cleaning up disk staging: %s", exc)

    def cleanup_stale_uploads(self):
        """Clean up uploads that have been inactive for too long."""
        current_time = time.time()
        stale_ids = []

        with self.upload_lock:
            for upload_id, upload in self.active_uploads.items():
                if current_time - upload['last_activity'] > CHUNK_UPLOAD_TIMEOUT:
                    stale_ids.append(upload_id)

        for upload_id in stale_ids:
            self.cancel_chunked_upload(upload_id)
            logger.info("Cleaned up stale upload: %s", upload_id)

        self.cleanup_ram_staging()
        self.cleanup_disk_staging()
        cleanup_recycle_bins()
