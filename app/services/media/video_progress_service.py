"""Domain service for profile-scoped video progress persistence and stale-path aliases."""

import logging
import os
import sqlite3
import time

from app.services.core.runtime_config_service import get_runtime_config_value
from app.services.core.sqlite_runtime_service import get_db

logger = logging.getLogger(__name__)


def _is_progress_enabled():
    """Check if progress saving is enabled globally."""
    return get_runtime_config_value('SAVE_VIDEO_PROGRESS', False)


def _profile_exists(conn, profile_id):
    """Return True when the target profile still exists."""
    if not profile_id:
        return False

    row = conn.execute(
        "SELECT 1 FROM profiles WHERE id = ? LIMIT 1",
        (str(profile_id),),
    ).fetchone()
    return row is not None


def save_video_progress(
    video_path,
    category_id,
    video_timestamp,
    video_duration=None,
    thumbnail_url=None,
    profile_id=None,
):
    """
    Save playback progress for a specific video/profile pair.
    Returns ``(success, message)``.
    """
    if not _is_progress_enabled():
        return False, "Progress saving is disabled."
    if not profile_id:
        return False, "Active profile is required."

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                logger.info("Rejected progress save for deleted profile %s", profile_id)
                return False, "Active profile is invalid."

            existing = conn.execute(
                """
                SELECT video_duration, thumbnail_url, category_id
                FROM video_progress
                WHERE video_path = ? AND profile_id = ?
                """,
                (str(video_path), str(profile_id)),
            ).fetchone()
            if existing:
                if video_duration is None or video_duration <= 0:
                    video_duration = existing['video_duration']
                if not thumbnail_url:
                    thumbnail_url = existing['thumbnail_url']
                if not category_id:
                    category_id = existing['category_id']

            conn.execute(
                """
                INSERT OR REPLACE INTO video_progress
                (
                    video_path,
                    profile_id,
                    category_id,
                    video_timestamp,
                    video_duration,
                    thumbnail_url,
                    last_watched,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(video_path),
                    str(profile_id),
                    str(category_id) if category_id else None,
                    float(video_timestamp)
                    if video_timestamp is not None and video_timestamp >= 0
                    else None,
                    float(video_duration)
                    if video_duration is not None and video_duration > 0
                    else None,
                    str(thumbnail_url) if thumbnail_url else None,
                    time.time(),
                    time.time(),
                ),
            )

        logger.debug(
            "save_video_progress success: %s @ %ss for profile %s",
            video_path,
            video_timestamp,
            profile_id,
        )
        return True, "Video progress saved successfully."
    except sqlite3.Error as exc:
        logger.error("Error saving video progress: %s", exc)
        return False, f"Failed to save video progress: {str(exc)}"


def get_video_progress(video_path, profile_id=None):
    """Return progress for a specific video/profile pair or ``None``."""
    if not _is_progress_enabled() or not profile_id:
        return None

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                return None

            row = conn.execute(
                """
                SELECT video_timestamp, video_duration, thumbnail_url, last_watched
                FROM video_progress
                WHERE video_path = ? AND profile_id = ?
                """,
                (str(video_path), str(profile_id)),
            ).fetchone()

            if not row:
                return None

            result = {}
            if row['video_timestamp'] is not None:
                result['video_timestamp'] = row['video_timestamp']
            if row['video_duration'] is not None:
                result['video_duration'] = row['video_duration']
            if row['thumbnail_url'] is not None:
                result['thumbnail_url'] = row['thumbnail_url']
            if row['last_watched'] is not None:
                result['last_watched'] = row['last_watched']

            return result if result else None
    except sqlite3.Error as exc:
        logger.error("Error getting video progress: %s", exc)
        return None


def get_category_video_progress(category_id, profile_id=None):
    """Return all per-video progress rows for a category/profile pair."""
    if not _is_progress_enabled() or not profile_id:
        return {}

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                return {}

            cursor = conn.execute(
                """
                SELECT video_path, video_timestamp, video_duration, thumbnail_url
                FROM video_progress
                WHERE category_id = ? AND profile_id = ?
                LIMIT 10000
                """,
                (str(category_id), str(profile_id)),
            )

            return {
                row['video_path']: {
                    'video_timestamp': row['video_timestamp'],
                    'video_duration': row['video_duration'],
                    'thumbnail_url': row['thumbnail_url'],
                }
                for row in cursor.fetchall()
                if row['video_timestamp'] is not None
            }
    except sqlite3.Error as exc:
        logger.error("Error getting category video progress: %s", exc)
        return {}


def get_video_progress_batch(category_ids, profile_id=None):
    """Return per-category progress entries in one query for a profile."""
    if not category_ids or not profile_id:
        return {}

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                return {}

            placeholders = ','.join('?' * len(category_ids))
            cursor = conn.execute(
                f"""
                SELECT video_path, category_id, video_timestamp, video_duration, thumbnail_url
                FROM video_progress
                WHERE category_id IN ({placeholders})
                  AND profile_id = ?
                  AND video_timestamp IS NOT NULL
                """,
                [*category_ids, str(profile_id)],
            )

            result = {cat_id: {} for cat_id in category_ids}
            for row in cursor.fetchall():
                cat_id = row['category_id']
                if cat_id in result:
                    result[cat_id][row['video_path']] = {
                        'video_timestamp': row['video_timestamp'],
                        'video_duration': row['video_duration'],
                        'thumbnail_url': row['thumbnail_url'],
                    }

            return result
    except sqlite3.Error as exc:
        logger.error("Error getting batch video progress: %s", exc)
        return {}


def delete_all_video_progress(profile_id=None):
    """Delete video progress rows, scoped to a profile when provided."""
    try:
        with get_db() as conn:
            if profile_id:
                progress_cursor = conn.execute(
                    "SELECT COUNT(*) FROM video_progress WHERE profile_id = ?",
                    (str(profile_id),),
                )
            else:
                progress_cursor = conn.execute("SELECT COUNT(*) FROM video_progress")
            count = progress_cursor.fetchone()[0]

            alias_cursor = conn.execute("SELECT COUNT(*) FROM file_path_aliases")
            alias_count = alias_cursor.fetchone()[0]

            if profile_id:
                conn.execute(
                    "DELETE FROM video_progress WHERE profile_id = ?",
                    (str(profile_id),),
                )
                deleted_alias_count = 0
            else:
                conn.execute("DELETE FROM video_progress")
                conn.execute("DELETE FROM file_path_aliases")
                deleted_alias_count = alias_count

        logger.info(
            "Deleted %s video progress entries and %s file path aliases",
            count,
            deleted_alias_count,
        )
        return {
            'success': True,
            'count': count,
            'alias_count': deleted_alias_count,
        }
    except sqlite3.Error as exc:
        logger.error("Error deleting all video progress: %s", exc)
        return {'success': False, 'error': str(exc), 'count': 0, 'alias_count': 0}


def get_all_video_progress(limit=50, profile_id=None):
    """Return recent continue-watching rows for a profile."""
    logger.debug("get_all_video_progress called, limit=%s, profile_id=%s", limit, profile_id)
    if not profile_id:
        return []

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                return []

            cursor = conn.execute(
                """
                SELECT video_path, category_id, video_timestamp, video_duration, thumbnail_url, last_watched
                FROM video_progress
                WHERE profile_id = ? AND video_timestamp IS NOT NULL AND video_timestamp >= 0
                ORDER BY last_watched DESC
                LIMIT ?
                """,
                (str(profile_id), limit),
            )

            results = [
                {
                    'video_path': row['video_path'],
                    'video_url': row['video_path'],
                    'category_id': row['category_id'],
                    'video_timestamp': row['video_timestamp'],
                    'video_duration': row['video_duration'],
                    'thumbnail_url': row['thumbnail_url'],
                    'last_watched': row['last_watched'],
                }
                for row in cursor.fetchall()
            ]

            logger.debug("get_all_video_progress returning %s videos", len(results))
            return results
    except sqlite3.Error as exc:
        logger.error("Error getting all video progress: %s", exc)
        return []


def update_video_progress_path(old_path, new_path):
    """Update stored progress and thumbnail metadata after a media rename."""
    try:
        from app.utils.media_utils import get_thumbnail_url

        new_thumb_url = None
        with get_db() as conn:
            row = conn.execute(
                "SELECT category_id FROM video_progress WHERE video_path = ? LIMIT 1",
                (str(old_path),),
            ).fetchone()

            if row:
                category_id = row['category_id']
                if category_id:
                    new_thumb_url = get_thumbnail_url(
                        category_id,
                        os.path.basename(new_path),
                    )

            if new_thumb_url:
                cursor = conn.execute(
                    """
                    UPDATE video_progress
                    SET video_path = ?, thumbnail_url = ?, updated_at = ?
                    WHERE video_path = ?
                    """,
                    (str(new_path), new_thumb_url, time.time(), str(old_path)),
                )
            else:
                cursor = conn.execute(
                    """
                    UPDATE video_progress
                    SET video_path = ?, updated_at = ?
                    WHERE video_path = ?
                    """,
                    (str(new_path), time.time(), str(old_path)),
                )

            if cursor.rowcount > 0:
                logger.info("Updated video progress path: %s -> %s", old_path, new_path)
                return True
            return False
    except sqlite3.Error as exc:
        logger.error("Error updating video progress path: %s", exc)
        return False


def delete_video_progress(video_path, profile_id=None):
    """Delete a specific video's progress entry."""
    try:
        with get_db() as conn:
            if profile_id:
                cursor = conn.execute(
                    """
                    DELETE FROM video_progress
                    WHERE video_path = ? AND profile_id = ?
                    """,
                    (str(video_path), str(profile_id)),
                )
            else:
                cursor = conn.execute(
                    "DELETE FROM video_progress WHERE video_path = ?",
                    (str(video_path),),
                )

            if cursor.rowcount > 0:
                logger.info(
                    "Deleted video progress for %s (profile=%s)",
                    video_path,
                    profile_id,
                )
                return True
            return False
    except sqlite3.Error as exc:
        logger.error("Error deleting video progress for %s: %s", video_path, exc)
        return False


def _normalize_alias_path(path):
    """Normalize alias paths for media URLs or filesystem paths."""
    if not path:
        return path

    path_str = str(path)
    if path_str.startswith('/media/'):
        import posixpath
        return posixpath.normpath(path_str)
    return os.path.normpath(path_str)


def add_file_path_alias(old_path, new_path):
    """Track stale-path mappings for returning clients."""
    try:
        old_path = _normalize_alias_path(old_path)
        new_path = _normalize_alias_path(new_path)

        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT OR REPLACE INTO file_path_aliases (old_path, new_path, renamed_at)
                VALUES (?, ?, ?)
                """,
                (old_path, new_path, time.time()),
            )

            if cursor.rowcount > 0:
                logger.debug("Added file path alias: %s -> %s", old_path, new_path)
                return True
            return False
    except sqlite3.Error as exc:
        logger.error("Error adding file path alias: %s", exc)
        return False


def resolve_file_alias(path):
    """Resolve a stale media path through the alias table."""
    try:
        normalized_path = _normalize_alias_path(path)

        with get_db() as conn:
            row = conn.execute(
                "SELECT new_path FROM file_path_aliases WHERE old_path = ? LIMIT 1",
                (normalized_path,),
            ).fetchone()

            if row:
                resolved = row['new_path']
                logger.debug("Resolved path alias: %s -> %s", normalized_path, resolved)
                return resolved

            return path
    except sqlite3.Error as exc:
        logger.error("Error resolving file path alias: %s", exc)
        return path


def cleanup_old_file_aliases(days=30):
    """Delete alias rows older than ``days``."""
    try:
        cutoff_time = time.time() - (days * 86400)

        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM file_path_aliases WHERE renamed_at < ?",
                (cutoff_time,),
            )

            deleted_count = cursor.rowcount
            if deleted_count > 0:
                logger.info(
                    "Cleaned up %s old file path aliases (>%s days)",
                    deleted_count,
                    days,
                )
            return deleted_count
    except sqlite3.Error as exc:
        logger.error("Error cleaning up old file path aliases: %s", exc)
        return 0


def get_most_recent_video_progress(category_id, profile_id=None):
    """Return the most recently watched progress row for a category/profile pair."""
    if not _is_progress_enabled() or not profile_id:
        return None

    try:
        with get_db() as conn:
            if not _profile_exists(conn, profile_id):
                return None

            row = conn.execute(
                """
                SELECT video_timestamp, video_duration, thumbnail_url, last_watched
                FROM video_progress
                WHERE category_id = ? AND profile_id = ? AND video_timestamp IS NOT NULL
                ORDER BY last_watched DESC
                LIMIT 1
                """,
                (str(category_id), str(profile_id)),
            ).fetchone()

            if not row:
                return None

            return {
                'video_timestamp': row['video_timestamp'],
                'video_duration': row['video_duration'],
                'thumbnail_url': row['thumbnail_url'],
                'last_watched': row['last_watched'],
            }
    except sqlite3.Error as exc:
        logger.error("Error getting most recent video progress: %s", exc)
        return None
