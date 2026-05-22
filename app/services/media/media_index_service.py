"""Media index domain service."""

import logging
import os
import time
from datetime import datetime, timedelta, timezone

from app.services.core.sqlite_runtime_service import get_db
from app.services.core.runtime_config_service import get_runtime_root_path

logger = logging.getLogger(__name__)

_timeline_counts_cache = {}


def _hidden_category_clause(column_name="media_index.category_id"):
    """Return a descendant-aware SQL clause excluding hidden categories."""
    return (
        "NOT EXISTS ("
        "SELECT 1 FROM hidden_categories hc "
        f"WHERE {column_name} = hc.category_id "
        f"OR {column_name} LIKE hc.category_id || '::%' "
        f"OR (hc.category_id LIKE 'auto%' AND {column_name} LIKE hc.category_id || '-%')"
        ")"
    )

def _clear_timeline_counts_cache():
    _timeline_counts_cache.clear()

def _media_index_where_clauses(category_id=None, filter_type='all', show_hidden=False):
    """Build common media_index WHERE clauses and parameters."""
    where_clauses = []
    params = []

    if category_id:
        where_clauses.append("category_id = ?")
        params.append(category_id)

    if filter_type != 'all':
        where_clauses.append("type = ?")
        params.append(filter_type)

    if not show_hidden:
        where_clauses.append("is_hidden = 0")
        where_clauses.append(_hidden_category_clause())

    return where_clauses, params

def _date_key_from_epoch(mtime):
    """Return SQLite date(mtime, 'unixepoch') equivalent in UTC."""
    return datetime.fromtimestamp(int(mtime or 0), timezone.utc).strftime('%Y-%m-%d')

def _epoch_range_for_date_key(date_key):
    start = datetime.strptime(date_key, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())

def _epoch_range_for_month_key(month_key):
    start = datetime.strptime(month_key, '%Y-%m').replace(tzinfo=timezone.utc)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return int(start.timestamp()), int(end.timestamp())

def _build_month_range_query(
    month_key,
    *,
    category_id=None,
    filter_type='all',
    show_hidden=False,
    select_sql='*',
):
    """Build an mtime-range query scoped to one calendar month."""
    start_epoch, end_epoch = _epoch_range_for_month_key(month_key)
    query = f"SELECT {select_sql} FROM media_index WHERE mtime >= ? AND mtime < ?"
    params = [start_epoch, end_epoch]
    where_clauses, where_params = _media_index_where_clauses(
        category_id=category_id,
        filter_type=filter_type,
        show_hidden=show_hidden,
    )
    if where_clauses:
        query += " AND " + " AND ".join(where_clauses)
        params.extend(where_params)
    return query, params

def update_media_index_batch(category_id, files_metadata, version_hash=None):
    """
    Perform high-performance batch update of the media index for a category.
    This replaces existing records for the category with fresh ones.

    Args:
        category_id (str): The category ID.
        files_metadata (list): List of dicts with name, size, mtime, hash, type.
        version_hash (str): Optional collection hash for the category.

    Returns:
        (success, count) tuple.
    """
    if not files_metadata:
        # If no files, just clear the index for this category
        delete_media_index_by_category(category_id)
        if version_hash:
            update_category_version_hash(category_id, version_hash)
        return True, 0

    try:
        from app.services.media.hidden_content_service import (
            get_hidden_files_set,
            should_block_category_access,
        )

        current_time = time.time()
        # Pre-fetch hidden files (absolute paths) for comparison
        hidden_files_set = get_hidden_files_set()

        # If cache is in OVERFLOW mode, we'll do a batch check later for the whole chunk
        is_overflow = hidden_files_set == "OVERFLOW"
        active_hidden_paths = set()

        # Get category path to build absolute paths
        from app.services.media.category_query_service import get_category_by_id
        cat_info = get_category_by_id(category_id)
        cat_path = cat_info['path'] if cat_info else None

        # If in overflow, pre-fetch hidden status for all files in this metadata batch
        if is_overflow and cat_path:
            try:
                # Build absolute paths for comparison
                all_abs_paths = [os.path.normpath(os.path.join(cat_path, fm.get('name', ''))) for fm in files_metadata if fm.get('name')]
                if all_abs_paths:
                    # SQLite variable limit check (usually 999)
                    # We'll chunk this if it's large, though usually files_metadata is already chunked.
                    for i in range(0, len(all_abs_paths), 500):
                        chunk = all_abs_paths[i:i+500]
                        placeholders = ', '.join(['?'] * len(chunk))
                        with get_db() as conn:
                            cursor = conn.execute(f"SELECT file_path FROM hidden_files WHERE file_path IN ({placeholders})", chunk)
                            for row in cursor:
                                active_hidden_paths.add(os.path.normcase(os.path.normpath(row['file_path'])))
            except Exception as e:
                logger.error(f"Error pre-fetching hidden files in overflow mode: {e}")

        # Prepare data for batch insert
        data = []
        for fm in files_metadata:
            rel_path = fm.get('name')
            if not rel_path:
                continue

            # Normalize and extract parent path
            rel_path = rel_path.replace('\\', '/')
            parent_path = os.path.dirname(rel_path).replace('\\', '/')

            # Simple unique ID: category_id + hash of rel_path
            import hashlib
            path_hash = hashlib.md5(rel_path.encode('utf-8')).hexdigest()[:16]
            entry_id = f"{category_id}:{path_hash}"

            # Check hidden status using absolute path comparison
            is_hid = 0
            if should_block_category_access(category_id, show_hidden=False):
                 is_hid = 1
            elif cat_path:
                abs_path = os.path.normpath(os.path.join(cat_path, rel_path))
                norm_abs_path = os.path.normcase(abs_path)
                # Use normcase for robust case-insensitive comparison on Windows
                if is_overflow:
                    if norm_abs_path in active_hidden_paths:
                        is_hid = 1
                elif norm_abs_path in hidden_files_set:
                    is_hid = 1

            data.append((
                entry_id,
                category_id,
                rel_path,
                parent_path,
                os.path.basename(rel_path),
                fm.get('size', 0),
                fm.get('mtime', 0),
                fm.get('hash', ''),
                fm.get('type', 'video'),
                is_hid,
                current_time,
                current_time
            ))

        with get_db() as conn:
            # We use a transaction to ensure atomicity and speed
            conn.execute("BEGIN")
            try:
                # 1. Clear existing records for this category
                conn.execute("DELETE FROM media_index WHERE category_id = ?", (category_id,))

                # 2. Bulk insert new records
                conn.executemany("""
                    INSERT INTO media_index
                    (id, category_id, rel_path, parent_path, name, size, mtime, hash, type, is_hidden, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, data)

                # 3. Update version hash if provided
                if version_hash:
                    conn.execute("UPDATE categories SET version_hash = ? WHERE id = ?", (version_hash, category_id))

                conn.execute("COMMIT")
                _clear_timeline_counts_cache()
                logger.info(f"Updated media_index for {category_id} with {len(data)} files")
                return True, len(data)
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    except Exception as e:
        logger.error(f"Error updating media_index batch for {category_id}: {e}")
        return False, 0

def delete_media_index_by_category(category_id):
    """Delete all index records for a specific category."""
    try:
        with get_db() as conn:
            cursor = conn.execute("DELETE FROM media_index WHERE category_id = ?", (category_id,))
            conn.execute("UPDATE categories SET version_hash = NULL WHERE id = ?", (category_id,))
            _clear_timeline_counts_cache()
            logger.info(f"Deleted {cursor.rowcount} media_index records for category {category_id}")
            return True
    except Exception as e:
        logger.error(f"Error deleting media_index for {category_id}: {e}")
        return False

def delete_media_index_entry(category_id, rel_path):
    """Delete a specific file from the media index."""
    try:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM media_index WHERE category_id = ? AND rel_path = ?",
                (category_id, rel_path)
            )
            if cursor.rowcount > 0:
                _clear_timeline_counts_cache()
                logger.debug(f"Removed {rel_path} from media_index in category {category_id}")
                return True
            return False
    except Exception as e:
        logger.error(f"Error removing {rel_path} from media_index: {e}")
        return False


def delete_media_index_entries_batch(stale_entries):
    """
    Delete multiple entries from the media index in a single transaction.

    Args:
        stale_entries (list): List of (category_id, rel_path) tuples.
    """
    if not stale_entries:
        return 0

    try:
        with get_db() as conn:
            # executemany automatically handles the transaction if isolation_level is None
            cursor = conn.executemany(
                "DELETE FROM media_index WHERE category_id = ? AND rel_path = ?",
                stale_entries
            )
            count = cursor.rowcount
            if count > 0:
                _clear_timeline_counts_cache()
                logger.info(f"Batch deleted {count} stale entries from media_index")
            return count
    except Exception as e:
        logger.error(f"Error in batch media_index deletion: {e}")
        return 0


def upsert_media_index_entry(category_id, category_path, rel_path, size, mtime, file_hash=None, file_type='video'):
    """
    Insert or update a single media_index entry for a file.

    Args:
        category_id (str): Category ID for the file.
        category_path (str): Absolute path to the category folder.
        rel_path (str): Relative path within the category.
        size (int): File size in bytes.
        mtime (float): File modification time.
        file_hash (str): Optional precomputed file hash.
        file_type (str): Media type ('video' or 'image').

    Returns:
        bool: True on success, False on failure.
    """
    try:
        from app.services.media.hidden_content_service import (
            is_file_hidden,
            should_block_category_access,
        )

        if not category_id or not rel_path:
            return False

        rel_path = rel_path.replace('\\', '/')
        parent_path = os.path.dirname(rel_path).replace('\\', '/')

        if file_hash is None:
            from app.utils.hash_utils import generate_file_hash
            file_hash = generate_file_hash(rel_path, size, mtime)

        import hashlib
        path_hash = hashlib.md5(rel_path.encode('utf-8')).hexdigest()[:16]
        entry_id = f"{category_id}:{path_hash}"

        is_hid = 0
        try:
            if category_path:
                abs_path = os.path.normpath(os.path.join(category_path, rel_path))
                if is_file_hidden(abs_path) or should_block_category_access(
                    category_id,
                    show_hidden=False,
                ):
                    is_hid = 1
        except Exception:
            is_hid = 0

        current_time = time.time()

        with get_db() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO media_index
                (id, category_id, rel_path, parent_path, name, size, mtime, hash, type, is_hidden, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                entry_id,
                category_id,
                rel_path,
                parent_path,
                os.path.basename(rel_path),
                int(size),
                float(mtime),
                file_hash,
                file_type,
                is_hid,
                current_time,
                current_time
            ))

        _clear_timeline_counts_cache()
        return True
    except Exception as e:
        logger.error(f"Error upserting media_index entry for {rel_path}: {e}")
        return False


def batch_upsert_media_index_entries(category_id, category_path, file_entries):
    """
    Insert or update multiple media_index entries in a single DB operation.

    Args:
        category_id: Category ID for all entries.
        category_path: Absolute category path.
        file_entries: List of dicts with keys:
            - name (rel_path)
            - size
            - mtime
            - hash (optional)
            - type (optional, 'video' or 'image')

    Returns:
        Tuple[bool, int]: (success, rows_written)
    """
    try:
        from app.services.media.hidden_content_service import (
            is_file_hidden,
            should_block_category_access,
        )

        if not category_id or not file_entries:
            return True, 0

        import hashlib
        from app.utils.hash_utils import generate_file_hash

        rows = []
        now = time.time()
        category_hidden = should_block_category_access(category_id, show_hidden=False)

        for entry in file_entries:
            if isinstance(entry, dict):
                rel_path = str(entry.get('name', '')).replace('\\', '/')
            elif isinstance(entry, str):
                rel_path = entry.replace('\\', '/')
            else:
                continue

            if not rel_path:
                continue

            size = int(entry.get('size', 0))
            mtime = float(entry.get('mtime', 0))
            file_hash = entry.get('hash') or generate_file_hash(rel_path, size, mtime)
            file_type = entry.get('type', 'video')
            parent_path = os.path.dirname(rel_path).replace('\\', '/')
            path_hash = hashlib.md5(rel_path.encode('utf-8')).hexdigest()[:16]
            entry_id = f"{category_id}:{path_hash}"

            is_hid = 1 if category_hidden else 0
            if not is_hid and category_path:
                try:
                    abs_path = os.path.normpath(os.path.join(category_path, rel_path))
                    if is_file_hidden(abs_path):
                        is_hid = 1
                except Exception:
                    is_hid = 0

            rows.append((
                entry_id,
                category_id,
                rel_path,
                parent_path,
                os.path.basename(rel_path),
                size,
                mtime,
                file_hash,
                file_type,
                is_hid,
                now,
                now,
            ))

        if not rows:
            return True, 0

        with get_db() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO media_index
                (id, category_id, rel_path, parent_path, name, size, mtime, hash, type, is_hidden, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

        _clear_timeline_counts_cache()
        return True, len(rows)
    except Exception as e:
        logger.error(f"Error batch upserting media_index entries for {category_id}: {e}")
        return False, 0

def clear_all_media_index():
    """Clear ALL media index records - used when clearing all saved data."""
    try:
        with get_db() as conn:
            cursor = conn.execute("SELECT COUNT(*) as count FROM media_index")
            count = cursor.fetchone()['count']
            
            conn.execute("DELETE FROM media_index")
            conn.execute("UPDATE categories SET version_hash = NULL")
            conn.execute("DELETE FROM schema_info WHERE key LIKE 'category_version_hash:%'")
            
            logger.info(f"Cleared all media_index records ({count} entries)")
            return True, count
    except Exception as e:
        logger.error(f"Error clearing media_index: {e}")
        return False, 0

def get_paginated_media(category_id=None, subfolder='', sort_by='name', sort_order='ASC',
                         limit=100, offset=0, filter_type='all', show_hidden=False,
                         deduplicate_by_hash=False, columns=None):
    """
    Query the media index with advanced filtering and sorting.
    Optimized for Scalable Indexing Layer.
    """
    try:
        from app.services.media.hidden_content_service import should_block_category_access

        params = []
        where_clauses = []

        # Default columns if not specified
        if columns is None:
            col_select = "*"
        else:
            # Basic whitelist for security
            valid_cols = {'id', 'category_id', 'rel_path', 'parent_path', 'name', 'size', 'mtime', 'hash', 'type', 'is_hidden', 'created_at', 'updated_at'}
            safe_cols = [c for c in columns if c in valid_cols]
            col_select = ", ".join(safe_cols) if safe_cols else "*"

        # Base query selection
        if deduplicate_by_hash:
            # When deduplicating, we pick the first occurrence in the group.
            # Using GROUP BY hash with MAX(mtime) ensures we get the latest version if duplicates exist.
            query_parts = [f"SELECT {col_select}, MAX(mtime) as group_mtime FROM media_index"]
        else:
            query_parts = [f"SELECT {col_select} FROM media_index"]

        # 1. Category and Subfolder Filter
        if category_id:
            where_clauses.append("category_id = ?")
            params.append(category_id)

        if subfolder == '__all__':
            pass
        elif subfolder and str(subfolder).lower() != 'none':
            # Include files from this subfolder and all descendants.
            norm_subfolder = str(subfolder).replace('\\', '/').strip('/')
            where_clauses.append("(parent_path = ? OR parent_path LIKE ?)")
            params.append(norm_subfolder)
            params.append(f"{norm_subfolder}/%")
        elif subfolder == '' or (subfolder and str(subfolder).lower() == 'none'):
            # Root of category only
            where_clauses.append("parent_path = ''")

        # 2. Type Filter
        if filter_type != 'all':
            # Map 'videos' -> 'video', 'photos' -> 'image'
            t_map = {'videos': 'video', 'photos': 'image'}
            where_clauses.append("type = ?")
            params.append(t_map.get(filter_type, filter_type))

        # 3. Hidden Content Filtering (Optimized)
        if not show_hidden:
            # Filter hidden files directly
            where_clauses.append("is_hidden = 0")

            if category_id:
                # Optimized check for single category: if it's hidden, return nothing
                if should_block_category_access(category_id, show_hidden=False):
                    return []
            else:
                where_clauses.append(_hidden_category_clause())

        if where_clauses:
            query_parts.append("WHERE " + " AND ".join(where_clauses))

        # 4. Deduplication
        if deduplicate_by_hash:
            query_parts.append("GROUP BY hash")

        # 5. Sorting
        valid_sort_cols = {'name': 'name', 'mtime': 'mtime', 'size': 'size'}
        sort_col = valid_sort_cols.get(sort_by, 'name')
        # Whitelist sort_order to prevent SQL injection
        sort_dir = 'ASC' if sort_order.upper() != 'DESC' else 'DESC'

        # Use the group_mtime if deduplicating and sorting by mtime
        if deduplicate_by_hash and sort_col == 'mtime':
            query_parts.append(f"ORDER BY group_mtime {sort_dir}")
        elif sort_col == 'name':
            # COLLATE NOCASE for alphabetical sorting
            query_parts.append(f"ORDER BY name COLLATE NOCASE {sort_dir}")
        else:
            query_parts.append(f"ORDER BY {sort_col} {sort_dir}")

        # 6. Pagination
        query_parts.append("LIMIT ? OFFSET ?")
        params.extend([limit, offset])

        query = " ".join(query_parts)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    except Exception as e:
        logger.error(f"Error in get_paginated_media: {e}")
        return []

def get_media_count(category_id=None, subfolder=None, filter_type='all', show_hidden=False,
                    deduplicate_by_hash=False):
    """Get total count of matching media items (consistent with get_paginated_media)."""
    try:
        from app.services.media.hidden_content_service import should_block_category_access

        if deduplicate_by_hash:
            query_parts = ["SELECT COUNT(DISTINCT hash) as count FROM media_index"]
        else:
            query_parts = ["SELECT COUNT(*) as count FROM media_index"]
        
        params = []
        where_clauses = []

        if category_id:
            where_clauses.append("category_id = ?")
            params.append(category_id)

        if subfolder == '__all__':
            pass
        elif subfolder and str(subfolder).lower() != 'none':
            # Keep count semantics aligned with get_paginated_media for folder navigation.
            norm_subfolder = str(subfolder).replace('\\', '/').strip('/')
            where_clauses.append("(parent_path = ? OR parent_path LIKE ?)")
            params.append(norm_subfolder)
            params.append(f"{norm_subfolder}/%")
        elif subfolder == '' or (subfolder and str(subfolder).lower() == 'none'):
            # Root of category only
            where_clauses.append("parent_path = ''")

        if filter_type != 'all':
            t_map = {'videos': 'video', 'photos': 'image'}
            where_clauses.append("type = ?")
            params.append(t_map.get(filter_type, filter_type))

        if not show_hidden:
            where_clauses.append("is_hidden = 0")
            if category_id:
                if should_block_category_access(category_id, show_hidden=False):
                    return 0
            else:
                where_clauses.append(_hidden_category_clause())

        if where_clauses:
            query_parts.append("WHERE " + " AND ".join(where_clauses))

        query = " ".join(query_parts)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            row = cursor.fetchone()
            return row['count'] if row else 0
    except Exception as e:
        logger.error(f"Error in get_media_count: {e}")
        return 0


def has_media_index_entries(category_id, show_hidden=True):
    """
    Fast existence check for indexed media in a category.
    Uses LIMIT 1 to avoid COUNT(*) on hot paths.
    """
    if not category_id:
        return False

    try:
        from app.services.media.hidden_content_service import should_block_category_access

        query_parts = ["SELECT 1 FROM media_index WHERE category_id = ?"]
        params = [category_id]

        if not show_hidden:
            query_parts.append("AND is_hidden = 0")
            if should_block_category_access(category_id, show_hidden=False):
                return False

        query_parts.append("LIMIT 1")
        query = " ".join(query_parts)

        with get_db() as conn:
            row = conn.execute(query, params).fetchone()
            return row is not None
    except Exception as e:
        logger.error(f"Error in has_media_index_entries({category_id}): {e}")
        return False


def get_media_metadata_batch(category_id, rel_paths):
    """
    Fetch metadata (size, mtime, hash) for a batch of relative paths.
    """
    if not rel_paths:
        return {}

    try:
        # SQLite limit for variables is usually 999, so we chunk if needed,
        # but the indexing processor/runtime already chunks requests first.
        placeholders = ', '.join(['?'] * len(rel_paths))
        query = f"SELECT rel_path, size, mtime, hash, type FROM media_index WHERE category_id = ? AND rel_path IN ({placeholders})"
        params = [category_id] + list(rel_paths)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return {row['rel_path']: dict(row) for row in cursor}
    except Exception as e:
        logger.error(f"Error in get_media_metadata_batch: {e}")
        return {}


def get_all_rel_paths(category_id):
    """
    Get all relative paths for a category as a set.
    Used for efficient deletion detection.
    """
    try:
        with get_db() as conn:
            cursor = conn.execute("SELECT rel_path FROM media_index WHERE category_id = ?", (category_id,))
            return {row['rel_path'] for row in cursor}
    except Exception as e:
        logger.error(f"Error in get_all_rel_paths: {e}")
        return set()


def get_rel_paths_batch(category_id, limit=5000, offset=0):
    """
    Get a paged batch of relative paths for a category.
    Used for low-memory stale entry detection in large libraries.
    """
    try:
        safe_limit = max(1, min(int(limit or 5000), 50000))
        safe_offset = max(0, int(offset or 0))
        with get_db() as conn:
            cursor = conn.execute(
                """
                SELECT rel_path
                FROM media_index
                WHERE category_id = ?
                ORDER BY rel_path
                LIMIT ? OFFSET ?
                """,
                (category_id, safe_limit, safe_offset),
            )
            return [row["rel_path"] for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error in get_rel_paths_batch: {e}")
        return []


def get_all_category_media_summaries(show_hidden=False):
    """
    Fetch media summaries for all categories in a single query.
    Returns dict {category_id: {count, contains_video, image_rel_path, video_rel_path}}
    """
    try:
        where = "1=1"
        if not show_hidden:
            where = f"is_hidden = 0 AND {_hidden_category_clause()}"

        with get_db() as conn:
            # We use MIN(rel_path) as a representative path.
            # This is MUCH faster than individual queries per category.
            cursor = conn.execute(f"""
                SELECT
                    category_id,
                    COUNT(*) as count,
                    SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) as video_count,
                    MIN(CASE WHEN type = 'image' THEN rel_path END) as image_rel_path,
                    MIN(CASE WHEN type = 'video' THEN rel_path END) as video_rel_path
                FROM media_index
                WHERE {where}
                GROUP BY category_id
            """)

            result = {}
            for row in cursor:
                result[row['category_id']] = {
                    'count': row['count'],
                    'contains_video': row['video_count'] > 0,
                    'image_rel_path': row['image_rel_path'],
                    'video_rel_path': row['video_rel_path']
                }
            return result
    except Exception as e:
        logger.error(f"Error getting all media summaries: {e}")
        return {}


def _build_category_summary_scope(category_id, show_hidden=False, include_descendants=False):
    """Build a reusable SQL scope for category summary queries."""
    if include_descendants:
        where = "(category_id = ? OR category_id LIKE ?)"
        params = [category_id, f"{category_id}::%"]
    else:
        where = "category_id = ?"
        params = [category_id]

    if not show_hidden:
        where += " AND is_hidden = 0"
        where += f" AND {_hidden_category_clause()}"

    return where, params


def get_category_media_summary(
    category_id,
    show_hidden=False,
    include_descendants=False,
):
    """
    Get media summary for a category using the SQLite index.
    Returns dict with count, contains_video, image/video rel paths, and source category IDs.
    """
    try:
        where, params = _build_category_summary_scope(
            category_id,
            show_hidden=show_hidden,
            include_descendants=include_descendants,
        )

        with get_db() as conn:
            count_row = conn.execute(
                f"SELECT COUNT(*) as count FROM media_index WHERE {where}",
                params
            ).fetchone()
            count = count_row['count'] if count_row else 0

            if count == 0:
                return {
                    'count': 0,
                    'contains_video': False,
                    'image_rel_path': None,
                    'video_rel_path': None,
                    'image_category_id': None,
                    'video_category_id': None,
                }

            image_row = conn.execute(
                f"""
                SELECT category_id, rel_path FROM media_index
                WHERE {where} AND type = 'image'
                ORDER BY name COLLATE NOCASE ASC
                LIMIT 1
                """,
                params
            ).fetchone()
            video_row = conn.execute(
                f"""
                SELECT category_id, rel_path FROM media_index
                WHERE {where} AND type = 'video'
                ORDER BY name COLLATE NOCASE ASC
                LIMIT 1
                """,
                params
            ).fetchone()

            image_rel = image_row['rel_path'] if image_row else None
            video_rel = video_row['rel_path'] if video_row else None

            return {
                'count': count,
                'contains_video': video_rel is not None,
                'image_rel_path': image_rel,
                'video_rel_path': video_rel,
                'image_category_id': image_row['category_id'] if image_row else None,
                'video_category_id': video_row['category_id'] if video_row else None,
            }
    except Exception as e:
        logger.error(f"Error getting category media summary for {category_id}: {e}")
        return {
            'count': 0,
            'contains_video': False,
            'image_rel_path': None,
            'video_rel_path': None,
            'image_category_id': None,
            'video_category_id': None,
        }


def get_subfolder_media_summaries(category_id, subfolder_prefix=None, show_hidden=False):
    """
    Return immediate subfolder summaries for a category.

    For `auto::` categories, summaries are derived from descendant category IDs.
    For standard categories, summaries are derived from the rel_path hierarchy.
    """
    if not category_id:
        return []

    try:
        if str(category_id).startswith('auto::'):
            base_id = str(category_id)
            if subfolder_prefix:
                norm_prefix = str(subfolder_prefix).replace('\\', '/').strip('/')
                if norm_prefix:
                    base_id = base_id + "::" + "::".join(
                        [part for part in norm_prefix.split('/') if part]
                    )

            auto_prefix = base_id + "::"
            start_index = len(auto_prefix) + 1  # SQLite substr is 1-based
            query = """
                WITH scoped AS (
                    SELECT
                        CASE
                            WHEN instr(substr(category_id, ?), '::') > 0
                            THEN substr(
                                substr(category_id, ?),
                                1,
                                instr(substr(category_id, ?), '::') - 1
                            )
                            ELSE substr(category_id, ?)
                        END AS sub_name,
                        category_id,
                        rel_path,
                        name,
                        type
                    FROM media_index
                    WHERE category_id LIKE ?
            """
            params = [
                start_index,
                start_index,
                start_index,
                start_index,
                f"{auto_prefix}%",
            ]

            if not show_hidden:
                query += " AND is_hidden = 0"
                query += f" AND {_hidden_category_clause()}"

            query += """
                )
                SELECT
                    sub_name,
                    COUNT(*) AS count,
                    SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) AS video_count,
                    MIN(
                        CASE
                            WHEN type = 'image'
                            THEN lower(name) || char(31) || category_id || char(31) || rel_path
                            ELSE NULL
                        END
                    ) AS image_pick,
                    MIN(
                        CASE
                            WHEN type = 'video'
                            THEN lower(name) || char(31) || category_id || char(31) || rel_path
                            ELSE NULL
                        END
                    ) AS video_pick
                FROM scoped
                WHERE sub_name IS NOT NULL AND sub_name != ''
                GROUP BY sub_name
                ORDER BY sub_name COLLATE NOCASE ASC
            """

            with get_db() as conn:
                rows = conn.execute(query, params).fetchall()

            summaries = []
            for row in rows:
                sub_name = row['sub_name']
                if not sub_name:
                    continue

                image_category_id = None
                image_rel_path = None
                if row['image_pick']:
                    parts = str(row['image_pick']).split('\x1f', 2)
                    if len(parts) == 3:
                        image_category_id = parts[1]
                        image_rel_path = parts[2]

                video_category_id = None
                video_rel_path = None
                if row['video_pick']:
                    parts = str(row['video_pick']).split('\x1f', 2)
                    if len(parts) == 3:
                        video_category_id = parts[1]
                        video_rel_path = parts[2]

                summaries.append({
                    'name': sub_name,
                    'count': int(row['count'] or 0),
                    'contains_video': bool(row['video_count'] or 0),
                    'image_category_id': image_category_id,
                    'image_rel_path': image_rel_path,
                    'video_category_id': video_category_id,
                    'video_rel_path': video_rel_path,
                    'derived_category_id': f"{base_id}::{sub_name}",
                })

            return summaries

        prefix = ''
        if subfolder_prefix:
            prefix = str(subfolder_prefix).replace('\\', '/').strip('/')
            if prefix:
                prefix += '/'

        prefix_len = len(prefix)
        start_index = prefix_len + 1  # SQLite substr is 1-based
        query = """
            SELECT
                CASE
                    WHEN instr(substr(rel_path, ?), '/') > 0
                    THEN substr(rel_path, ?, instr(substr(rel_path, ?), '/') - 1)
                    ELSE NULL
                END AS sub_name,
                COUNT(*) AS count,
                SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) AS video_count,
                MIN(CASE WHEN type = 'image' THEN rel_path END) AS image_rel,
                MIN(CASE WHEN type = 'video' THEN rel_path END) AS video_rel
            FROM media_index
            WHERE category_id = ? AND rel_path LIKE ?
        """
        params = [start_index, start_index, start_index, category_id, f"{prefix}%"]

        if not show_hidden:
            query += " AND is_hidden = 0"
            query += f" AND {_hidden_category_clause()}"

        query += """
            AND instr(substr(rel_path, ?), '/') > 0
            GROUP BY sub_name
            HAVING sub_name IS NOT NULL
            ORDER BY sub_name COLLATE NOCASE ASC
        """
        params.append(start_index)

        with get_db() as conn:
            rows = conn.execute(query, params).fetchall()

        return [
            {
                'name': row['sub_name'],
                'count': int(row['count'] or 0),
                'contains_video': bool(row['video_count'] or 0),
                'image_category_id': category_id,
                'image_rel_path': row['image_rel'],
                'video_category_id': category_id,
                'video_rel_path': row['video_rel'],
                'derived_category_id': None,
            }
            for row in rows
            if row['sub_name']
        ]
    except Exception as e:
        logger.error(f"Error getting subfolder media summaries for {category_id}: {e}")
        return []


def get_media_rows_by_filenames(category_id, filenames):
    """Return media-index rows for a filename set, keyed by rel_path."""
    try:
        if not category_id or not filenames:
            return {}

        placeholders = ",".join("?" * len(filenames))
        query = (
            f"SELECT * FROM media_index WHERE category_id = ? AND rel_path IN ({placeholders})"
        )
        params = [category_id] + list(filenames)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return {row['rel_path']: dict(row) for row in cursor.fetchall()}
    except Exception as e:
        logger.error(f"Error getting media rows by filenames for {category_id}: {e}")
        return {}


def get_timeline_date_counts(category_id=None, filter_type='all', show_hidden=False):
    """Return timeline date counts keyed by `YYYY-MM-DD`."""
    try:
        where_clauses, params = _media_index_where_clauses(
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
        where_sql = ""
        if where_clauses:
            where_sql = " WHERE " + " AND ".join(where_clauses)

        summary_query = (
            "SELECT MAX(mtime) AS latest_mtime, COUNT(*) AS total_count "
            f"FROM media_index{where_sql}"
        )
        rows_query = f"SELECT mtime FROM media_index{where_sql} ORDER BY mtime DESC"

        with get_db() as conn:
            summary = conn.execute(summary_query, params).fetchone()
            latest_mtime = summary['latest_mtime'] if summary else None
            total_count = int(summary['total_count'] or 0) if summary else 0
            if total_count <= 0 or latest_mtime is None:
                return {}

            cache_key = (
                category_id,
                filter_type,
                bool(show_hidden),
                int(latest_mtime),
                total_count,
            )
            cached = _timeline_counts_cache.get(cache_key)
            if cached is not None:
                return dict(cached)

            counts = {}
            cursor = conn.execute(rows_query, params)
            for row in cursor.fetchall():
                date_key = _date_key_from_epoch(row['mtime'])
                counts[date_key] = counts.get(date_key, 0) + 1

            if len(_timeline_counts_cache) > 64:
                _timeline_counts_cache.clear()
            _timeline_counts_cache[cache_key] = dict(counts)
            return counts
    except Exception as e:
        logger.error(f"Error getting timeline date counts: {e}")
        return {}


def get_media_rows_for_date(
    date_key,
    category_id=None,
    filter_type='all',
    limit=24,
    offset=0,
    show_hidden=False,
):
    """Return raw media-index rows for a specific timeline date."""
    try:
        start_epoch, end_epoch = _epoch_range_for_date_key(date_key)
        query = "SELECT * FROM media_index WHERE mtime >= ? AND mtime < ?"
        params = [start_epoch, end_epoch]
        where_clauses, where_params = _media_index_where_clauses(
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
        if where_clauses:
            query += " AND " + " AND ".join(where_clauses)
            params.extend(where_params)
        query += " ORDER BY mtime DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error getting media rows for date {date_key}: {e}")
        return []

def get_media_rows_for_month(
    month_key,
    category_id=None,
    filter_type='all',
    show_hidden=False,
):
    """Return raw media-index rows for a timeline month using an mtime range."""
    try:
        query, params = _build_month_range_query(
            month_key,
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
        query += " ORDER BY mtime DESC"

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error getting media rows for month {month_key}: {e}")
        return []

def get_month_timeline_page(
    month_key,
    category_id=None,
    filter_type='all',
    items_per_date=24,
    dates_page=1,
    dates_limit=31,
    show_hidden=False,
):
    """Return month-scoped timeline rows and date totals without scanning all dates."""
    try:
        safe_items_per_date = max(1, min(int(items_per_date or 24), 500))
        safe_dates_limit = max(1, min(int(dates_limit or 31), 31))
        safe_dates_page = max(1, int(dates_page or 1))

        counts_query, counts_params = _build_month_range_query(
            month_key,
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
            select_sql='mtime',
        )
        counts_query += " ORDER BY mtime DESC"

        with get_db() as conn:
            date_totals = {}
            for row in conn.execute(counts_query, counts_params):
                date_key = _date_key_from_epoch(row['mtime'])
                date_totals[date_key] = date_totals.get(date_key, 0) + 1

            all_dates = sorted(date_totals.keys(), reverse=True)
            total_dates = len(all_dates)
            start_idx = (safe_dates_page - 1) * safe_dates_limit
            page_dates = all_dates[start_idx:start_idx + safe_dates_limit]
            page_date_set = set(page_dates)
            selected_counts = {date_key: 0 for date_key in page_dates}
            selected_rows = []

            if page_dates:
                rows_query, rows_params = _build_month_range_query(
                    month_key,
                    category_id=category_id,
                    filter_type=filter_type,
                    show_hidden=show_hidden,
                )
                rows_query += " ORDER BY mtime DESC"
                for row in conn.execute(rows_query, rows_params):
                    date_key = _date_key_from_epoch(row['mtime'])
                    if date_key not in page_date_set:
                        continue
                    if selected_counts[date_key] >= safe_items_per_date:
                        continue
                    item = dict(row)
                    item['_date_key'] = date_key
                    selected_rows.append(item)
                    selected_counts[date_key] += 1

            return {
                'rows': selected_rows,
                'date_totals': {
                    date_key: date_totals.get(date_key, 0)
                    for date_key in page_dates
                },
                'page_dates': page_dates,
                'total_dates': total_dates,
                'has_more_dates': (start_idx + safe_dates_limit) < total_dates,
            }
    except Exception as e:
        logger.error(f"Error getting month timeline page for {month_key}: {e}")
        return {
            'rows': [],
            'date_totals': {},
            'page_dates': [],
            'total_dates': 0,
            'has_more_dates': False,
        }

def search_media_index(search_query, limit=50, show_hidden=False):
    """Search for media items across the index."""
    try:
        query_term = str(search_query or '').strip()
        if not query_term:
            return []

        safe_limit = max(1, min(int(limit or 50), 5000))
        like_any = f"%{query_term}%"
        like_prefix = f"{query_term}%"

        query_parts = [
            """
            SELECT
                id,
                category_id,
                rel_path,
                parent_path,
                name,
                size,
                mtime,
                hash,
                type,
                is_hidden,
                created_at,
                updated_at
            FROM media_index
            WHERE (name LIKE ? OR rel_path LIKE ?)
            """
        ]
        params = [like_any, like_any]

        if not show_hidden:
            query_parts.append("AND is_hidden = 0")
            query_parts.append(f"AND {_hidden_category_clause()}")

        query_parts.append(
            """
            ORDER BY
                CASE
                    WHEN name LIKE ? THEN 0
                    WHEN rel_path LIKE ? THEN 1
                    ELSE 2
                END,
                mtime DESC,
                name COLLATE NOCASE ASC
            LIMIT ?
            """
        )
        params.extend([like_prefix, like_prefix, safe_limit])

        query = " ".join(query_parts)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error searching media_index: {e}")
        return []


def search_media_paths_for_folder_matches(search_query, limit=20000, show_hidden=False, offset=0):
    """
    Return lightweight media path rows for folder-match extraction.
    Optimized to use GROUP BY parent_path to find unique folders efficiently.
    Supports OFFSET for paginated streaming — no cap on total results.
    """
    try:
        query_term = str(search_query or '').strip()
        if not query_term:
            return []

        safe_limit = max(1, int(limit or 20000))
        safe_offset = max(0, int(offset or 0))
        like_any = f"%{query_term}%"

        # Group by parent_path and return a deterministic sample rel_path per folder.
        query_parts = [
            """
            SELECT
                category_id,
                parent_path,
                MIN(rel_path) AS rel_path
            FROM media_index
            WHERE (parent_path LIKE ? OR name LIKE ?)
            """
        ]
        params = [like_any, like_any]

        if not show_hidden:
            query_parts.append("AND is_hidden = 0")
            query_parts.append(f"AND {_hidden_category_clause()}")

        query_parts.append("GROUP BY category_id, parent_path")

        # Prefer exact/prefix path matches, then stable alphabetical ordering.
        query_parts.append(
            """
            ORDER BY
                CASE
                    WHEN parent_path = ? THEN 0
                    WHEN parent_path LIKE ? THEN 1
                    ELSE 2
                END,
                parent_path COLLATE NOCASE ASC
            LIMIT ?
            """
        )
        normalized_term = query_term.replace('\\', '/').strip('/')
        params.extend([normalized_term, f"{normalized_term}/%", safe_limit])
        if safe_offset > 0:
            query_parts.append("OFFSET ?")
            params.append(safe_offset)

        query = " ".join(query_parts)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error searching media paths for folder matches: {e}")
        return []


def search_media_category_ids(search_query, limit=5000, show_hidden=False, offset=0):
    """
    Return distinct category IDs that match a search query.

    This is used as a fallback for deep auto:: hierarchies where folder names may
    not appear in rel_path (because files are indexed relative to deep categories).
    Supports OFFSET for paginated streaming — no cap on total results.
    """
    try:
        query_term = str(search_query or '').strip()
        if not query_term:
            return []

        safe_limit = max(1, int(limit or 5000))
        safe_offset = max(0, int(offset or 0))
        like_any = f"%{query_term}%"

        query_parts = [
            """
            SELECT
                category_id,
                COUNT(*) AS file_count,
                MAX(mtime) AS last_mtime
            FROM media_index
            WHERE category_id LIKE ?
            """
        ]
        params = [like_any]

        if not show_hidden:
            query_parts.append("AND is_hidden = 0")
            query_parts.append(f"AND {_hidden_category_clause()}")

        query_parts.append("GROUP BY category_id")
        query_parts.append("ORDER BY last_mtime DESC")
        query_parts.append("LIMIT ?")
        params.append(safe_limit)
        if safe_offset > 0:
            query_parts.append("OFFSET ?")
            params.append(safe_offset)

        query = " ".join(query_parts)

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error searching media category IDs: {e}")
        return []


def get_indexed_category_ids(show_hidden=False, limit=50000, offset=0):
    """
    Return distinct category IDs present in media_index.

    Supports OFFSET for paginated streaming — callers can page through the full
    result set in batches without holding all IDs in memory at once.

    Used by lightweight search/category views that should avoid filesystem scans.
    """
    try:
        safe_limit = max(1, int(limit or 50000))
        safe_offset = max(0, int(offset or 0))
        query_parts = ["SELECT DISTINCT category_id FROM media_index"]
        params = []

        if not show_hidden:
            query_parts.append("WHERE is_hidden = 0")
            query_parts.append(f"AND {_hidden_category_clause()}")

        query_parts.append("ORDER BY category_id COLLATE NOCASE ASC")
        query_parts.append("LIMIT ?")
        params.append(safe_limit)
        if safe_offset > 0:
            query_parts.append("OFFSET ?")
            params.append(safe_offset)

        query = " ".join(query_parts)
        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [row['category_id'] for row in cursor.fetchall() if row and row['category_id']]
    except Exception as e:
        logger.error(f"Error getting indexed category IDs: {e}")
        return []

def get_library_version_hash():
    """Calculate a global hash representing the state of the entire indexed library."""
    try:
        with get_db() as conn:
            # We use the max updated_at and a hash of all category hashes
            cursor = conn.execute("SELECT MAX(updated_at), GROUP_CONCAT(hash) FROM (SELECT category_id, hash, MAX(updated_at) as updated_at FROM media_index GROUP BY category_id ORDER BY category_id)")
            row = cursor.fetchone()
            if row and row[1]:
                import hashlib
                data = f"{row[0]}|{row[1]}"
                return hashlib.sha256(data.encode('utf-8')).hexdigest()
            return "empty"
    except Exception:
        return "error"

def cleanup_orphaned_media_index(valid_category_ids):
    """
    Remove media_index records for categories that no longer exist.

    Args:
        valid_category_ids (list): List of currently active category IDs.
    """
    logger.info(f"cleanup_orphaned_media_index called with {len(valid_category_ids)} valid categories")
    
    if not valid_category_ids:
        logger.info("No valid category IDs provided, skipping cleanup")
        return

    try:
        with get_db() as conn:
            # First count how many entries will be deleted
            placeholders = ','.join('?' * len(valid_category_ids))
            cursor = conn.execute(
                f"SELECT COUNT(*) as count FROM media_index WHERE category_id NOT IN ({placeholders})",
                valid_category_ids
            )
            to_delete = cursor.fetchone()['count']
            logger.info(f"Found {to_delete} orphaned media_index entries to delete")
            
            # Now delete them
            cursor = conn.execute(
                f"DELETE FROM media_index WHERE category_id NOT IN ({placeholders})",
                valid_category_ids
            )
            if cursor.rowcount > 0:
                logger.info(f"Cleaned up {cursor.rowcount} orphaned media_index records")
            else:
                logger.info("No orphaned media_index records found")
    except Exception as e:
        logger.error(f"Error cleaning up orphaned media_index: {e}", exc_info=True)


def cleanup_media_index_for_unmounted_paths(valid_mount_paths):
    """
    Remove media_index entries for categories on unmounted drives.
    This is more thorough than cleanup_orphaned_media_index as it checks mount validity.
    
    Args:
        valid_mount_paths: Set of currently mounted paths (e.g., {'/media/ghost/USB1', '/media/usb/Drive2'})
    """
    if not valid_mount_paths:
        return
    
    try:
        import os
        
        with get_db() as conn:
            # Get all category paths from categories table
            cursor = conn.execute("SELECT id, path FROM categories")
            categories = cursor.fetchall()
            
            unmounted_category_ids = []
            
            for cat in categories:
                cat_id = cat['id']
                cat_path = cat['path']
                
                # Check if this category's path is under a valid mount
                is_mounted = False
                cat_path_normalized = os.path.normpath(cat_path)
                
                for mount_path in valid_mount_paths:
                    mount_normalized = os.path.normpath(mount_path)
                    if cat_path_normalized.startswith(mount_normalized + os.sep) or cat_path_normalized == mount_normalized:
                        is_mounted = True
                        break
                
                if not is_mounted:
                    unmounted_category_ids.append(cat_id)
            
            if unmounted_category_ids:
                # Delete media_index entries for unmounted categories
                placeholders = ','.join('?' * len(unmounted_category_ids))
                cursor = conn.execute(
                    f"DELETE FROM media_index WHERE category_id IN ({placeholders})",
                    unmounted_category_ids
                )
                media_deleted = cursor.rowcount
                
                # Also delete the categories themselves since drive is unmounted
                cursor = conn.execute(
                    f"DELETE FROM categories WHERE id IN ({placeholders})",
                    unmounted_category_ids
                )
                cats_deleted = cursor.rowcount
                
                logger.info(f"Cleaned up {media_deleted} media_index entries and {cats_deleted} categories for unmounted drives")
                
    except Exception as e:
        logger.error(f"Error cleaning up media for unmounted paths: {e}")


def cleanup_media_index_by_category_path_check():
    """
    Aggressive cleanup: Check every media_index entry's category path and delete if path doesn't exist.
    This handles auto-detected categories that aren't in the categories table.
    
    Returns:
        Number of entries deleted
    """
    try:
        import os
        
        with get_db() as conn:
            # Get all unique category IDs from media_index
            cursor = conn.execute("SELECT DISTINCT category_id FROM media_index")
            all_category_ids = [row['category_id'] for row in cursor.fetchall()]
            
            if not all_category_ids:
                return 0
            
            logger.info(f"Checking {len(all_category_ids)} categories in media_index for path validity")
            
            # For each category ID, try to resolve its path
            invalid_category_ids = []
            
            for cat_id in all_category_ids:
                # Resolve category path from ID (similar to category_service.get_category_by_id)
                cat_path = _resolve_category_path_from_id(cat_id)

                # Conservative cleanup ONLY for manual categories: unresolved auto category paths
                # SHOULD be deleted because they are generated dynamically from standard roots.
                # If they can't be resolved from any root, the USB drive is unplugged.
                if not cat_path:
                    if cat_id.startswith('auto::'):
                        logger.debug(f"Auto category {cat_id} could not be resolved (likely unplugged drive). Marking for deletion.")
                        invalid_category_ids.append(cat_id)
                    else:
                        logger.debug(f"Skipping unresolved custom category during aggressive cleanup: {cat_id}")
                    continue

                if not os.path.exists(cat_path):
                    invalid_category_ids.append(cat_id)
                    logger.debug(f"Category {cat_id} has invalid path: {cat_path}")
            
            if invalid_category_ids:
                # Delete all media_index entries for these invalid categories
                placeholders = ','.join('?' * len(invalid_category_ids))
                cursor = conn.execute(
                    f"DELETE FROM media_index WHERE category_id IN ({placeholders})",
                    invalid_category_ids
                )
                deleted = cursor.rowcount
                logger.warning(f"DELETED {deleted} media_index entries for {len(invalid_category_ids)} unmounted categories: {invalid_category_ids[:5]}...")
                return deleted
            else:
                logger.info("All media_index entries have valid category paths")
                return 0
                
    except Exception as e:
        logger.error(f"Error in aggressive media_index cleanup: {e}")
        return 0


def cleanup_stale_media_index_entries(limit=5000):
    """
    Validate media_index entries against filesystem and delete stale rows.

    This performs a bounded pass each run to avoid heavy startup/runtime cost.

    Args:
        limit (int): Maximum number of rows to validate per invocation.

    Returns:
        int: Number of stale rows deleted.
    """
    try:
        limit = max(1, int(limit))
        deleted = 0

        with get_db() as conn:
            # Build category path map for manual categories once.
            cat_rows = conn.execute("SELECT id, path FROM categories").fetchall()
            category_paths = {
                row['id']: row['path']
                for row in cat_rows
                if row and row['id'] and row['path']
            }

            rows = conn.execute(
                "SELECT id, category_id, rel_path FROM media_index ORDER BY updated_at ASC LIMIT ?",
                (limit,)
            ).fetchall()

            if not rows:
                return 0

            resolved_base_cache = {}
            stale_ids = []

            for row in rows:
                entry_id = row['id']
                category_id = row['category_id']
                rel_path = row['rel_path'] or ''
                if not entry_id or not category_id:
                    continue

                base_path = resolved_base_cache.get(category_id)
                if base_path is None:
                    base_path = category_paths.get(category_id)
                    if not base_path:
                        base_path = _resolve_category_path_from_id(category_id)
                    resolved_base_cache[category_id] = base_path

                # Conservative cleanup ONLY for manual categories: unresolved auto category paths
                # MUST be deleted because they cannot be resolved without their USB drive.
                if not base_path:
                    if category_id.startswith('auto::'):
                        stale_ids.append(entry_id)
                    continue

                if not os.path.exists(base_path):
                    stale_ids.append(entry_id)
                    continue

                full_path = os.path.normpath(os.path.join(base_path, rel_path))
                if not os.path.exists(full_path):
                    stale_ids.append(entry_id)

            if stale_ids:
                # Delete in chunks to keep SQL parameter list bounded.
                chunk_size = 500
                for i in range(0, len(stale_ids), chunk_size):
                    chunk = stale_ids[i:i + chunk_size]
                    placeholders = ','.join('?' * len(chunk))
                    cursor = conn.execute(
                        f"DELETE FROM media_index WHERE id IN ({placeholders})",
                        chunk
                    )
                    deleted += cursor.rowcount

        if deleted > 0:
            logger.info(f"Deleted {deleted} stale media_index entries (validation pass limit={limit})")
        return deleted
    except Exception as e:
        logger.error(f"Error cleaning stale media_index entries: {e}")
        return 0


def _resolve_category_path_from_id(category_id):
    """
    Resolve a category ID to its filesystem path.
    This mirrors the logic in category_service.get_category_by_id.
    
    Args:
        category_id: Category ID like 'auto::ghost::USB::Movies'
        
    Returns:
        Full path or None if not found
    """
    import os
    
    if not category_id or not category_id.startswith('auto::'):
        return None
    
    # Parse ID: auto::parent1::parent2::name
    parts = category_id[6:].split('::')  # Skip 'auto::' prefix
    if not parts:
        return None
    
    # Prefer persisted categories table path if present
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT path FROM categories WHERE id = ? LIMIT 1",
                (category_id,)
            ).fetchone()
            if row and row['path'] and os.path.exists(row['path']):
                return row['path']
    except Exception:
        pass

    # Build relative path
    relative_path = '/'.join(parts)

    # Build candidate roots conservatively.
    # Dynamic mounts are best-effort and must NEVER break worker boot.
    usb_roots = []
    try:
        from app.services.storage.storage_drive_service import get_current_mount_paths

        mounts = get_current_mount_paths() or set()
        for mount_path in mounts:
            if mount_path and mount_path not in usb_roots:
                usb_roots.append(mount_path)
    except Exception as mount_err:
        logger.debug(f"Dynamic mount resolution unavailable in _resolve_category_path_from_id: {mount_err}")

    # Common Linux roots and local dev media path fallback.
    for root in ['/media/ghost', '/media/usb', '/media', '/mnt']:
        if root not in usb_roots:
            usb_roots.append(root)
    try:
        local_media = os.path.abspath(os.path.join(get_runtime_root_path(), '..', 'media'))
        if local_media not in usb_roots:
            usb_roots.append(local_media)
    except Exception:
        pass

    for root in usb_roots:
        full_path = os.path.normpath(os.path.join(root, relative_path))
        if os.path.exists(full_path):
            return full_path
    
    return None


def resolve_category_path_from_id(category_id):
    """Public domain seam for resolving a category ID to a filesystem path."""
    return _resolve_category_path_from_id(category_id)


def delete_media_index_for_category(category_id):
    """
    Delete all media_index entries for a specific category.
    Called when a category's drive is unmounted.
    
    Args:
        category_id: The category ID to delete entries for
        
    Returns:
        Number of entries deleted
    """
    try:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM media_index WHERE category_id = ?",
                (category_id,)
            )
            return cursor.rowcount
    except Exception as e:
        logger.error(f"Error deleting media_index for category {category_id}: {e}")
        return 0


def delete_media_index_by_path_prefix(path_prefix):
    """
    Delete media_index entries for categories whose paths start with the given prefix.
    Used when a USB drive is unmounted to immediately clean up stale entries.
    
    Args:
        path_prefix: The mount path prefix (e.g., '/media/ghost/USB_DRIVE')
        
    Returns:
        Number of entries deleted
    """
    try:
        import os
        normalized_prefix = os.path.normpath(path_prefix)
        
        with get_db() as conn:
            # Find all category IDs that have paths starting with this prefix
            cursor = conn.execute(
                "SELECT id FROM categories WHERE path LIKE ?",
                (normalized_prefix + '%',)
            )
            category_ids = [row['id'] for row in cursor.fetchall()]
            
            # Also find auto:: categories using the storage path/category logic
            try:
                from app.services.storage.storage_path_service import _get_category_id_from_path
                prefix_cat_id = _get_category_id_from_path(normalized_prefix)
                if prefix_cat_id:
                    cursor = conn.execute(
                        "SELECT DISTINCT category_id FROM media_index WHERE category_id LIKE ?",
                        (prefix_cat_id + '%',)
                    )
                    auto_ids = [row['category_id'] for row in cursor.fetchall() if row and row['category_id']]
                    category_ids.extend(auto_ids)
            except Exception as inner_e:
                logger.debug(f"Could not fetch auto category IDs for path prefix: {inner_e}")
            
            category_ids = list(set(category_ids))
            
            if category_ids:
                # Delete media_index entries for these categories
                placeholders = ','.join('?' * len(category_ids))
                cursor = conn.execute(
                    f"DELETE FROM media_index WHERE category_id IN ({placeholders})",
                    category_ids
                )
                deleted = cursor.rowcount
                logger.info(f"Deleted {deleted} media_index entries for {len(category_ids)} categories under {path_prefix}")
                return deleted
            return 0
    except Exception as e:
        logger.error(f"Error deleting media_index by path prefix {path_prefix}: {e}")
        return 0


def get_all_category_ids_from_media_index():
    """
    Get all unique category IDs that have entries in media_index.
    
    Returns:
        List of category IDs
    """
    try:
        with get_db() as conn:
            cursor = conn.execute("SELECT DISTINCT category_id FROM media_index")
            return [row['category_id'] for row in cursor.fetchall()]
    except Exception as e:
        logger.error(f"Error getting category IDs from media_index: {e}")
        return []


def get_category_version_hash(category_id):
    """Get the current version hash for a category from SQLite."""
    try:
        with get_db() as conn:
            cursor = conn.execute("SELECT version_hash FROM categories WHERE id = ?", (category_id,))
            row = cursor.fetchone()
            if row and row['version_hash']:
                return row['version_hash']

            cursor = conn.execute(
                "SELECT value FROM schema_info WHERE key = ?",
                (f"category_version_hash:{category_id}",)
            )
            row = cursor.fetchone()
            return row['value'] if row else None
    except Exception:
        return None

def update_category_version_hash(category_id, version_hash):
    """Update the version hash for a category in SQLite."""
    try:
        with get_db() as conn:
            cursor = conn.execute(
                "UPDATE categories SET version_hash = ? WHERE id = ?",
                (version_hash, category_id)
            )
            if cursor.rowcount == 0:
                conn.execute(
                    "INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)",
                    (f"category_version_hash:{category_id}", version_hash)
                )
            return True
    except Exception as e:
        logger.error(f"Error updating version_hash for {category_id}: {e}")
        return False


def recalculate_category_version_hash(category_id):
    """Recalculate and persist the version hash for a category based on media_index."""
    try:
        from app.utils.hash_utils import generate_collection_hash
        with get_db() as conn:
            rows = conn.execute(
                "SELECT hash FROM media_index WHERE category_id = ?",
                (category_id,)
            ).fetchall()
            hashes = [row['hash'] for row in rows if row and row.get('hash')]
            new_hash = generate_collection_hash(hashes)
            update_category_version_hash(category_id, new_hash)
            return new_hash
    except Exception as e:
        logger.error(f"Error recalculating version_hash for {category_id}: {e}")
        return None


def bump_category_version_hash(category_id):
    """Force a version_hash change (e.g., when visibility changes but file content does not)."""
    try:
        from app.utils.hash_utils import generate_dict_hash
        new_hash = generate_dict_hash({'category_id': str(category_id), 'time': time.time()})
        update_category_version_hash(category_id, new_hash)
        return new_hash
    except Exception as e:
        logger.error(f"Error bumping version_hash for {category_id}: {e}")
        return None

def get_recent_media(limit=10, show_hidden=False, filter_type='all'):
    """
    Get the most recent media files across all categories from the media_index.
    Much faster than scanning filesystem - uses SQLite index on mtime.
    
    Args:
        limit: Maximum number of items to return
        show_hidden: Whether to include hidden files/categories
        filter_type: 'all', 'video', or 'image'
    
    Returns:
        List of dicts with category_id, rel_path, name, size, mtime, type, etc.
    """
    try:
        query_parts = ["SELECT * FROM media_index"]
        where_clauses = []
        params = []
        
        # Filter hidden content
        if not show_hidden:
            where_clauses.append("is_hidden = 0")
            where_clauses.append(_hidden_category_clause())
        
        # Filter by type
        if filter_type != 'all':
            where_clauses.append("type = ?")
            params.append(filter_type)
        
        if where_clauses:
            query_parts.append("WHERE " + " AND ".join(where_clauses))
        
        # Order by mtime DESC (newest first) and limit
        query_parts.append("ORDER BY mtime DESC LIMIT ?")
        params.append(limit)
        
        query = " ".join(query_parts)
        
        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
            
    except Exception as e:
        logger.error(f"Error getting recent media: {e}")
        return []
