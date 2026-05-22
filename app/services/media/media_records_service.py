"""Canonical media record hydration service."""

import logging
from urllib.parse import quote

from app.services.core.sqlite_runtime_service import get_db
from app.services.media.media_index_service import _hidden_category_clause
from app.utils.media_utils import get_media_item_thumbnail_url
from specter import Service

logger = logging.getLogger(__name__)

MAX_RECORD_IDS = 200


class MediaRecordsService(Service):
    """Hydrate normalized media records by stable media id."""

    def __init__(self):
        super().__init__('media_records')
        self.priority = 50

    def get_records(self, ids, *, show_hidden=False):
        """Return canonical records keyed by stable id and a missing id list."""
        requested_ids = self._normalize_ids(ids)
        if not requested_ids:
            return {'records': {}, 'missing': []}

        records = {}
        try:
            placeholders = ','.join(['?'] * len(requested_ids))
            query = f"""
                SELECT
                    category_id || '::' || rel_path AS stable_id,
                    category_id,
                    rel_path,
                    name,
                    type,
                    size,
                    mtime,
                    hash,
                    is_hidden
                FROM media_index
                WHERE (category_id || '::' || rel_path) IN ({placeholders})
            """
            params = list(requested_ids)
            if not show_hidden:
                query += " AND is_hidden = 0"
                query += f" AND {_hidden_category_clause()}"

            with get_db() as conn:
                rows = conn.execute(query, params).fetchall()

            for row in rows:
                record = self._row_to_record(row)
                record_id = record.get('id')
                if record_id:
                    records[record_id] = record
        except Exception as exc:
            logger.error("Error hydrating media records: %s", exc)

        missing = [stable_id for stable_id in requested_ids if stable_id not in records]
        return {'records': records, 'missing': missing}

    @staticmethod
    def _normalize_ids(ids):
        if not isinstance(ids, list):
            raise ValueError('ids must be a list')
        if len(ids) > MAX_RECORD_IDS:
            raise ValueError(f'ids cannot contain more than {MAX_RECORD_IDS} items')
        seen = set()
        normalized = []
        for raw_id in ids or []:
            if not isinstance(raw_id, str):
                raise ValueError('ids must contain strings only')
            stable_id = raw_id.strip()
            if not stable_id or stable_id in seen:
                continue
            seen.add(stable_id)
            normalized.append(stable_id)
        return normalized

    @staticmethod
    def _row_to_record(row):
        category_id = row['category_id']
        rel_path = row['rel_path']
        item_type = row['type']
        size = row['size']
        thumbnail_url = get_media_item_thumbnail_url(
            category_id,
            rel_path,
            item_type,
            size,
        )
        record = {
            'id': row['stable_id'] if 'stable_id' in row.keys() else f"{category_id}::{rel_path}",
            'categoryId': category_id,
            'relPath': rel_path,
            'name': row['name'] or rel_path,
            'type': item_type,
            'url': f"/media/{category_id}/{quote(rel_path)}",
            'thumbnailUrl': thumbnail_url,
            'size': size,
            'mtime': row['mtime'],
            'modified': row['mtime'],
            'hash': row['hash'] or '',
            'isHidden': bool(row['is_hidden']),
            'durationMs': None,
        }
        if not thumbnail_url:
            record.pop('thumbnailUrl', None)
        return record
