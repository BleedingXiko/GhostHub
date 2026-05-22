"""Media indexing implementation helpers used by the Specter runtime."""

import gc
import hashlib
import logging
import os
import sqlite3
import time
import traceback

import gevent

from app.services.media import media_index_service
from app.utils.hash_utils import generate_file_hash
from app.utils.media_utils import get_media_type, is_media_file

logger = logging.getLogger(__name__)

DEFAULT_LARGE_DIRECTORY_THRESHOLD = 0
MAX_ASYNC_STATUS_FILES = 2000
DB_WRITE_RETRY_ATTEMPTS = 4
DB_WRITE_RETRY_BASE_DELAY_SECONDS = 0.05
STALE_DELETION_SET_DIFF_THRESHOLD = 50000
STALE_DELETION_DB_BATCH_SIZE = 5000
SKIPPED_DIRECTORY_NAMES = {
    ".ghosthub",
    ".ghosthub_uploads",
    "$recycle.bin",
    "system volume information",
    "recycler",
}


def _is_retryable_db_error(err):
    """Return True when a DB error is likely transient (lock/busy contention)."""
    if err is None:
        return False
    if isinstance(err, sqlite3.OperationalError):
        msg = str(err).lower()
        return ("locked" in msg) or ("busy" in msg)
    msg = str(err).lower()
    return (
        ("database is locked" in msg)
        or ("database table is locked" in msg)
        or ("busy" in msg)
    )


def _retry_delay_seconds(attempt_index):
    """Exponential-ish backoff capped for appliance responsiveness."""
    return min(
        0.5, DB_WRITE_RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt_index - 1))
    )


def get_large_directory_threshold():
    """Get the async-index threshold based on hardware tier."""
    from app.services.core.runtime_config_service import get_runtime_config_value

    if not get_runtime_config_value('AUTO_OPTIMIZE_FOR_HARDWARE', True):
        return DEFAULT_LARGE_DIRECTORY_THRESHOLD

    from app.services.system.system_stats_service import get_hardware_tier

    tier = get_hardware_tier()
    if tier == "PRO":
        return 0
    if tier == "STANDARD":
        return 0
    return DEFAULT_LARGE_DIRECTORY_THRESHOLD


def get_indexing_chunk_size():
    """Get dynamic chunk size for background indexing based on hardware tier."""
    from app.services.core.runtime_config_service import get_runtime_config_value

    base_chunk = max(5, int(get_runtime_config_value('INDEXING_CHUNK_SIZE_BASE', 25)))
    standard_chunk = max(
        base_chunk, int(get_runtime_config_value('INDEXING_CHUNK_SIZE_STANDARD', 75))
    )
    pro_chunk = max(
        standard_chunk, int(get_runtime_config_value('INDEXING_CHUNK_SIZE_PRO', 150))
    )

    if not get_runtime_config_value('AUTO_OPTIMIZE_FOR_HARDWARE', True):
        return base_chunk

    from app.services.system.system_stats_service import get_hardware_tier

    tier = get_hardware_tier()
    if tier == "PRO":
        return pro_chunk
    if tier == "STANDARD":
        return standard_chunk
    return base_chunk


def _is_skipped_directory_name(name):
    """Return True for hidden/system directories ignored by media indexing."""
    if not name:
        return True
    return name.startswith(".") or name.lower() in SKIPPED_DIRECTORY_NAMES


def _indexed_metadata_is_stale(existing, entry, *, force_refresh=False):
    """Return True when an indexed row should be rewritten from current stat data."""
    if force_refresh or existing is None:
        return True

    existing_hash = existing.get("hash", "")
    existing_size = existing.get("size")
    existing_mtime = existing.get("mtime")
    current_size = entry.get("size")
    current_mtime = entry.get("mtime")
    entry_type = entry.get("type")

    if existing_hash == "":
        return True
    if existing_mtime != current_mtime:
        return True
    if existing_size != current_size:
        return True

    if entry_type == "image":
        try:
            existing_size_int = int(existing_size)
            current_size_int = int(current_size or 0)
        except (TypeError, ValueError):
            return True
        if existing_size_int <= 0 and current_size_int > 0:
            return True
        if existing_size_int < 1024 and current_size_int > existing_size_int:
            return True

    return False


def process_indexing_task(
    category_id,
    category_path,
    category_name,
    force_refresh,
    *,
    generate_thumbnails=True,
    update_status=None,
    queue_child_category=None,
):
    """Process a single indexing task with incremental updates."""

    def _update(**updates):
        if update_status:
            update_status(category_id, **updates)

    processed = 0
    chunk_size = get_indexing_chunk_size()
    status_preview_files = []
    collection_hasher = hashlib.sha256()
    changed_files_metadata = []
    index_changed = bool(force_refresh)
    deleted_rel_paths = set()
    total_files = 0

    def _upsert_chunk_with_retries(chunk_changed):
        last_error = None
        for attempt in range(1, DB_WRITE_RETRY_ATTEMPTS + 1):
            try:
                upsert_ok, _upsert_count = media_index_service.batch_upsert_media_index_entries(
                    category_id=category_id,
                    category_path=category_path,
                    file_entries=chunk_changed,
                )
                if upsert_ok:
                    return True
                last_error = RuntimeError(
                    "batch_upsert_media_index_entries returned unsuccessful status"
                )
            except Exception as exc:
                last_error = exc

            if attempt < DB_WRITE_RETRY_ATTEMPTS and _is_retryable_db_error(last_error):
                gevent.sleep(_retry_delay_seconds(attempt))
                continue
            break

        if last_error:
            logger.warning(
                "Chunked batch upsert failed after %s attempts for '%s': %s",
                DB_WRITE_RETRY_ATTEMPTS,
                category_name,
                last_error,
            )
        return False

    def _upsert_row_with_retries(file_meta):
        last_error = None
        for attempt in range(1, DB_WRITE_RETRY_ATTEMPTS + 1):
            try:
                ok = media_index_service.upsert_media_index_entry(
                    category_id=category_id,
                    category_path=category_path,
                    rel_path=file_meta.get("name", ""),
                    size=file_meta.get("size", 0),
                    mtime=file_meta.get("mtime", 0),
                    file_hash=file_meta.get("hash", ""),
                    file_type=file_meta.get("type", "video"),
                )
                if ok:
                    return True
                last_error = RuntimeError("upsert_media_index_entry returned False")
            except Exception as exc:
                last_error = exc

            if attempt < DB_WRITE_RETRY_ATTEMPTS and _is_retryable_db_error(last_error):
                gevent.sleep(_retry_delay_seconds(attempt))
                continue
            break

        if last_error:
            logger.warning(
                "DB upsert failed for %s: %s",
                file_meta.get("name", ""),
                last_error,
            )
        return False

    try:
        recursive_scan = not str(category_id).startswith("auto::")
        fs_rel_paths_seen = set()

        def _iter_media_chunks():
            chunk = []
            if recursive_scan:
                for root, dirs, files in os.walk(category_path):
                    dirs[:] = [
                        d
                        for d in dirs
                        if not _is_skipped_directory_name(d)
                    ]
                    for filename in sorted(files):
                        if is_media_file(filename):
                            full_path = os.path.join(root, filename)
                            rel_path = os.path.relpath(full_path, category_path).replace(
                                "\\",
                                "/",
                            )
                            chunk.append(rel_path)
                            if len(chunk) >= chunk_size:
                                yield chunk
                                chunk = []
                                gevent.sleep(0)
            else:
                entries = []
                with os.scandir(category_path) as it:
                    for entry in it:
                        if entry.name.startswith(".") or not entry.is_file(
                            follow_symlinks=False
                        ):
                            continue
                        if is_media_file(entry.name):
                            entries.append(entry.name)
                entries.sort()
                for index in range(0, len(entries), chunk_size):
                    yield entries[index : index + chunk_size]
            if chunk:
                yield chunk

        if recursive_scan:
            for _root, dirs, files in os.walk(category_path):
                dirs[:] = [
                    d
                    for d in dirs
                    if not _is_skipped_directory_name(d)
                ]
                total_files += sum(1 for filename in files if is_media_file(filename))
                gevent.sleep(0)
        else:
            try:
                with os.scandir(category_path) as it:
                    total_files = sum(
                        1
                        for entry in it
                        if not entry.name.startswith(".")
                        and entry.is_file(follow_symlinks=False)
                        and is_media_file(entry.name)
                    )
            except Exception:
                total_files = 0

        _update(total_files=total_files)
        logger.info(
            "Found %s media files in '%s' for indexing (recursive)",
            total_files,
            category_name,
        )

        db_failures = 0
        chunks_processed = 0
        for chunk_paths in _iter_media_chunks():
            fs_rel_paths_seen.update(chunk_paths)

            try:
                existing_chunk_map = media_index_service.get_media_metadata_batch(
                    category_id,
                    chunk_paths,
                )
            except Exception as exc:
                logger.warning(
                    "Error fetching metadata batch for '%s': %s",
                    category_name,
                    exc,
                )
                existing_chunk_map = {}

            chunk_entries = []
            chunk_changed = []

            for rel_path in chunk_paths:
                full_path = os.path.join(category_path, rel_path)
                try:
                    stats = os.stat(full_path)
                    chunk_entries.append(
                        {
                            "name": rel_path,
                            "size": stats.st_size,
                            "mtime": stats.st_mtime,
                            "type": get_media_type(rel_path),
                        }
                    )
                except FileNotFoundError:
                    continue
                except Exception as stat_error:
                    logger.warning("Error stat'ing file %s: %s", full_path, stat_error)

            for entry in chunk_entries:
                rel_path = entry.get("name")
                if not rel_path:
                    continue

                existing = existing_chunk_map.get(rel_path)
                # Robustness: ensure existing is a dict to avoid 'str' object has no attribute 'get'
                if existing is not None and not isinstance(existing, dict):
                    logger.warning(
                        "Unexpected metadata format for %s (got %s, expected dict). Treating as missing.",
                        rel_path,
                        type(existing).__name__,
                    )
                    existing = None

                existing_hash = existing.get("hash", "") if existing else ""
                existing_size = existing.get("size") if existing else None
                existing_mtime = existing.get("mtime") if existing else None

                is_modified = _indexed_metadata_is_stale(
                    existing,
                    entry,
                    force_refresh=force_refresh,
                )

                if is_modified:
                    file_hash = generate_file_hash(
                        rel_path,
                        entry.get("size", 0),
                        entry.get("mtime", 0),
                    )
                    entry["hash"] = file_hash
                    chunk_changed.append(entry)
                    index_changed = True
                    changed_files_metadata.append(
                        {
                            "name": entry["name"],
                            "type": entry["type"],
                            "size": entry["size"],
                            "mtime": entry["mtime"],
                        }
                    )
                else:
                    entry["hash"] = existing_hash

                collection_hasher.update(entry["hash"].encode("utf-8"))
                if len(status_preview_files) < MAX_ASYNC_STATUS_FILES:
                    status_preview_files.append(entry)

                processed += 1
                progress = min(int((processed / total_files) * 100), 99) if total_files > 0 else 50

                if processed == total_files or processed % max(chunk_size, 25) == 0:
                    _update(processed_files=processed, progress=progress)

                if processed % chunk_size == 0:
                    logger.info(
                        "Processed %s/%s files for '%s' (%s%%)",
                        processed,
                        total_files,
                        category_name,
                        progress,
                    )

            if chunk_changed:
                batch_ok = _upsert_chunk_with_retries(chunk_changed)
                if not batch_ok:
                    for file_meta in chunk_changed:
                        if not _upsert_row_with_retries(file_meta):
                            db_failures += 1

            del chunk_entries
            del chunk_changed
            chunks_processed += 1
            if chunks_processed % 10 == 0:
                gc.collect()

        try:
            if len(fs_rel_paths_seen) <= STALE_DELETION_SET_DIFF_THRESHOLD:
                db_rel_paths = media_index_service.get_all_rel_paths(category_id)
                deleted_rel_paths = db_rel_paths - fs_rel_paths_seen
                del db_rel_paths
                gc.collect()
            else:
                logger.info(
                    "Using low-memory stale detection for '%s' (%s files, threshold=%s)",
                    category_name,
                    len(fs_rel_paths_seen),
                    STALE_DELETION_SET_DIFF_THRESHOLD,
                )
                deleted_rel_paths = set()
                offset = 0
                while True:
                    batch = media_index_service.get_rel_paths_batch(
                        category_id,
                        limit=STALE_DELETION_DB_BATCH_SIZE,
                        offset=offset,
                    )
                    if not batch:
                        break

                    for rel_path in batch:
                        full_path = os.path.join(category_path, rel_path)
                        if not os.path.exists(full_path):
                            deleted_rel_paths.add(rel_path)

                    offset += len(batch)
        except Exception as exc:
            logger.error("Error identifying deletions for '%s': %s", category_name, exc)
            deleted_rel_paths = set()

        if deleted_rel_paths:
            index_changed = True
            for rel_path in deleted_rel_paths:
                try:
                    media_index_service.delete_media_index_entry(category_id, rel_path)
                except Exception as db_err:
                    db_failures += 1
                    logger.warning("DB delete failed for %s: %s", rel_path, db_err)

        if db_failures > 0:
            logger.error(
                "Indexing '%s': %s DB operations failed",
                category_name,
                db_failures,
            )

    except Exception as walk_error:
        logger.error("Error walking directory %s: %s", category_path, walk_error)
        logger.debug(traceback.format_exc())

    _update(
        files=status_preview_files,
        processed_files=processed,
        progress=99 if processed else 0,
    )
    logger.info("Finished processing all %s files for '%s'", processed, category_name)

    if generate_thumbnails:
        try:
            from app.services.media.thumbnail_processing_service import (
                process_category_thumbnails_smart,
            )

            if changed_files_metadata:
                thumb_stats = process_category_thumbnails_smart(
                    category_path,
                    [],
                    category_id,
                    force_refresh,
                    files_to_process=changed_files_metadata,
                    wait_for_slot=bool(force_refresh),
                    max_wait_seconds=None if force_refresh else 300,
                )
            elif force_refresh:
                thumbnail_candidates = []
                for rel_path in fs_rel_paths_seen:
                    full_path = os.path.join(category_path, rel_path)
                    try:
                        file_size = os.path.getsize(full_path)
                    except OSError:
                        file_size = 0
                    thumbnail_candidates.append(
                        {
                            "name": rel_path,
                            "size": file_size,
                            "type": get_media_type(rel_path),
                        }
                    )
                thumb_stats = process_category_thumbnails_smart(
                    category_path,
                    [],
                    category_id,
                    force_refresh,
                    files_to_process=thumbnail_candidates,
                    wait_for_slot=True,
                    max_wait_seconds=None,
                )
            else:
                thumb_stats = {"queued": 0, "existing": 0, "skipped": 0, "checked": 0}
            if thumb_stats["queued"] > 0:
                logger.info(
                    "Smart thumbnail generation for '%s': %s queued (%s existing, %s cooldown-skipped)",
                    category_name,
                    thumb_stats["queued"],
                    thumb_stats["existing"],
                    thumb_stats["skipped"],
                )
        except Exception as thumb_error:
            logger.warning(
                "Thumbnail generation error for '%s': %s",
                category_name,
                thumb_error,
            )
            logger.debug(traceback.format_exc())

    current_time = time.time()
    collection_hash = collection_hasher.hexdigest()
    media_index_service.update_category_version_hash(category_id, collection_hash)

    if (
        queue_child_category is not None
        and str(category_id).startswith("auto::")
        and os.path.isdir(category_path)
    ):
        try:
            scanned_dirs = 0
            for entry in os.scandir(category_path):
                if not entry.is_dir(follow_symlinks=False):
                    continue
                if _is_skipped_directory_name(entry.name):
                    continue

                child_id = f"{category_id}::{entry.name}"
                logger.debug("Queueing child category '%s' for indexing", entry.name)
                queue_child_category(
                    child_id,
                    entry.path,
                    entry.name,
                    force_refresh=False,
                )
                scanned_dirs += 1
                if scanned_dirs % max(1, chunk_size) == 0:
                    gevent.sleep(0)
        except Exception as child_err:
            logger.debug(
                "Could not queue child categories for '%s': %s",
                category_name,
                child_err,
            )

    return {
        "files": status_preview_files,
        "processed": processed,
        "total_files": total_files,
        "hash": collection_hash,
        "timestamp": current_time,
        "index_changed": index_changed,
    }
