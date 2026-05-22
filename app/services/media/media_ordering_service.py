"""Server-owned media ordering service for normalized client views."""

import logging
from datetime import datetime, timezone

from app.services.core.runtime_config_service import get_runtime_config_value
from app.services.media import media_catalog_service
from app.services.media import media_index_service
from app.services.media.category_query_service import get_category_by_id
from app.services.media.media_records_service import MediaRecordsService
from app.services.media.sort_service import SortService
from specter import Service

logger = logging.getLogger(__name__)


class MediaOrderingService(Service):
    """Return ordered stable ids and lightweight view metadata."""

    def __init__(self):
        super().__init__('media_ordering')
        self.priority = 50

    def get_order(self, view_type, params, *, show_hidden=False):
        view_type = str(view_type or '').strip()
        if view_type in ('streaming_row', 'streaming_grid', 'subfolder_grid'):
            return self._order_streaming(view_type, params, show_hidden)
        if view_type == 'viewer_category':
            backing_view = 'subfolder_grid' if params.get('subfolder') else 'streaming_grid'
            return self._order_streaming(backing_view, params, show_hidden)
        if view_type == 'gallery_timeline':
            return self._order_gallery_timeline(params, show_hidden)
        if view_type == 'gallery_month':
            return self._order_gallery_month(params, show_hidden)
        if view_type == 'whats_new':
            return self._order_whats_new(params, show_hidden)
        raise ValueError(f"Unsupported media order view: {view_type}")

    def _order_streaming(self, view_type, params, show_hidden):
        category_id = params.get('category_id')
        if not category_id:
            raise ValueError('category_id is required')

        page = self._int_param(params, 'page', 1, minimum=1)
        limit = self._int_param(
            params,
            'limit',
            get_runtime_config_value('DEFAULT_PAGE_SIZE', 50),
            minimum=1,
            maximum=500,
        )
        subfolder = params.get('subfolder')
        sort_by = params.get('sort_by') or 'name'
        sort_order = str(params.get('sort_order') or 'ASC').upper()
        filter_type = params.get('media_filter') or params.get('filter') or params.get('filter_type') or 'all'
        include_total = self._bool_param(params, 'include_total', True)
        force_refresh = self._bool_param(params, 'force_refresh', False)
        hydrate_records = self._bool_param(params, 'hydrate', False)
        shuffle = params.get('shuffle')
        shuffle = None if shuffle is None else self._bool_value(shuffle)

        bootstrap_meta = self._maybe_bootstrap_index(
            category_id,
            page=page,
            limit=limit,
            subfolder=subfolder,
            show_hidden=show_hidden,
            force_refresh=force_refresh,
        )
        if bootstrap_meta:
            return {
                'view': view_type,
                'orderedIds': bootstrap_meta.pop('orderedIds'),
                'hasMore': bootstrap_meta.pop('hasMore'),
                'pageToken': self._page_token(page + 1) if bootstrap_meta.get('has_more') else None,
                'viewMeta': bootstrap_meta,
            }

        effective_shuffle = (
            shuffle
            if shuffle is not None else
            get_runtime_config_value('SHUFFLE_MEDIA', False)
        )
        effective_sort_by = sort_by
        if SortService._is_tv_sort_enabled(sort_by) and SortService._is_tv_category(category_id):
            effective_sort_by = 'tv'

        can_probe_has_more = (
            not include_total and
            not effective_shuffle and
            effective_sort_by != 'shuffle' and
            effective_sort_by != 'tv'
        )

        if effective_shuffle or effective_sort_by == 'shuffle':
            probed_has_more = None
            inline_records = None
            rows = SortService._sort_shuffle(
                category_id,
                subfolder,
                filter_type,
                show_hidden,
                page,
                limit,
            )
            ordered_ids = [self._id_from_enriched(item) for item in rows]
        elif effective_sort_by == 'tv':
            probed_has_more = None
            inline_records = None
            rows = SortService._sort_tv(
                category_id,
                subfolder,
                filter_type,
                show_hidden,
                sort_order,
                page,
                limit,
                force_refresh=force_refresh,
            )
            ordered_ids = [self._id_from_enriched(item) for item in rows]
        else:
            offset = (page - 1) * limit
            rows = media_index_service.get_paginated_media(
                category_id=category_id,
                subfolder=subfolder,
                sort_by=sort_by,
                sort_order=sort_order,
                limit=limit + 1 if can_probe_has_more else limit,
                offset=offset,
                filter_type=filter_type,
                show_hidden=show_hidden,
                deduplicate_by_hash=False,
                columns=None if hydrate_records else ['category_id', 'rel_path'],
            )
            probed_has_more = can_probe_has_more and len(rows) > limit
            if probed_has_more:
                rows = rows[:limit]
            ordered_ids = [self._stable_id(row['category_id'], row['rel_path']) for row in rows]
            inline_records = (
                self._records_from_rows(rows)
                if hydrate_records else
                None
            )

        total = None
        if include_total:
            total = SortService.get_total_count(
                category_id,
                subfolder,
                filter_type,
                show_hidden,
            )
            has_more = (page * limit) < total
        elif can_probe_has_more:
            has_more = bool(probed_has_more)
        else:
            count = media_index_service.get_media_count(
                category_id=category_id,
                subfolder=subfolder,
                filter_type=filter_type,
                show_hidden=show_hidden,
            )
            has_more = (page * limit) < count

        view_meta = {
            'page': page,
            'limit': limit,
            'total': total,
            'subfolders': SortService.get_subfolders(category_id, subfolder, show_hidden)
                if page == 1 else [],
            'asyncIndexing': False,
            'indexingProgress': 100,
        }
        result = {
            'view': view_type,
            'orderedIds': [stable_id for stable_id in ordered_ids if stable_id],
            'hasMore': has_more,
            'pageToken': self._page_token(page + 1) if has_more else None,
            'viewMeta': view_meta,
        }
        if inline_records is not None:
            result['records'] = inline_records
            result['missing'] = []
        return result

    @staticmethod
    def _records_from_rows(rows):
        records = {}
        for row in rows or []:
            record = MediaRecordsService._row_to_record(row)
            record_id = record.get('id')
            if record_id:
                records[record_id] = record
        return records

    def _maybe_bootstrap_index(
        self,
        category_id,
        *,
        page,
        limit,
        subfolder,
        show_hidden,
        force_refresh,
    ):
        status = media_catalog_service.get_async_index_status(category_id)
        has_indexed_media = media_index_service.has_media_index_entries(
            category_id,
            show_hidden=True,
        )
        should_bootstrap = (
            not has_indexed_media or
            (status and status.get('status') == 'error' and not has_indexed_media)
        )
        if should_bootstrap:
            if not status or status.get('status') == 'error':
                category = get_category_by_id(category_id)
                if category:
                    media_catalog_service.start_async_indexing(
                        category_id,
                        category['path'],
                        category.get('name', category_id),
                        force_refresh=force_refresh,
                    )
                    status = media_catalog_service.get_async_index_status(category_id)
            if status and (
                status.get('status') == 'complete' or
                status.get('progress', 0) >= 100
            ):
                return None
            if not status:
                return None
            files = [
                self._stable_id(category_id, file_meta.get('name'))
                for file_meta in status.get('files', [])[:limit]
                if file_meta.get('name')
            ]
            return {
                'orderedIds': files,
                'hasMore': bool(status.get('files')),
                'has_more': bool(status.get('files')),
                'page': page,
                'limit': limit,
                'total': status.get('total_files', 0),
                'subfolders': SortService.get_subfolders(category_id, subfolder, show_hidden)
                    if page == 1 else [],
                'asyncIndexing': True,
                'indexingProgress': status.get('progress', 0),
            }
        if force_refresh and has_indexed_media and (not status or status.get('status') != 'running'):
            category = get_category_by_id(category_id)
            if category:
                media_catalog_service.start_async_indexing(
                    category_id,
                    category['path'],
                    category.get('name', category_id),
                    force_refresh=True,
                )
        return None

    def _order_gallery_timeline(self, params, show_hidden):
        filter_type = params.get('media_filter') or params.get('filter') or params.get('filter_type') or 'all'
        category_id = params.get('category_id')
        category_ids = self._category_ids(params)
        hydrate_records = self._bool_param(params, 'hydrate', False)
        items_per_date = self._int_param(params, 'items_per_date', 9, minimum=1, maximum=500)
        dates_page = self._int_param(params, 'dates_page', 1, minimum=1)
        dates_limit = self._int_param(params, 'dates_limit', 15, minimum=1, maximum=366)
        specific_date = params.get('date')
        date_offset = self._int_param(params, 'date_offset', 0, minimum=0)
        jump_to_date = params.get('jump_to_date')

        if specific_date:
            rows = self._rows_for_date(
                specific_date,
                category_id=category_id,
                category_ids=category_ids,
                filter_type=filter_type,
                limit=items_per_date,
                offset=date_offset,
                show_hidden=show_hidden,
            )
            ordered_ids = [self._stable_id(row['category_id'], row['rel_path']) for row in rows]
            result = {
                'view': 'gallery_timeline',
                'orderedIds': ordered_ids,
                'hasMore': len(rows) >= items_per_date,
                'pageToken': str(date_offset + len(rows)) if len(rows) >= items_per_date else None,
                'viewMeta': {
                    'date': specific_date,
                    'offset': date_offset + len(rows),
                    'dateTotals': {specific_date: date_offset + len(rows)},
                },
            }
            if hydrate_records:
                result['records'] = self._records_from_rows(rows)
                result['missing'] = []
            return result

        date_counts = self._timeline_date_counts(
            category_id=category_id,
            category_ids=category_ids,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
        all_dates = sorted(date_counts.keys(), reverse=True)
        if jump_to_date and jump_to_date in all_dates:
            dates_page = (all_dates.index(jump_to_date) // dates_limit) + 1
        start_idx = (dates_page - 1) * dates_limit
        page_dates = all_dates[start_idx:start_idx + dates_limit]
        ordered_ids = []
        result_rows = []
        date_totals = {}
        for date_key in page_dates:
            rows = self._rows_for_date(
                date_key,
                category_id=category_id,
                category_ids=category_ids,
                filter_type=filter_type,
                limit=items_per_date,
                offset=0,
                show_hidden=show_hidden,
            )
            result_rows.extend(rows)
            ordered_ids.extend(self._stable_id(row['category_id'], row['rel_path']) for row in rows)
            date_totals[date_key] = date_counts.get(date_key, len(rows))

        has_more = (start_idx + dates_limit) < len(all_dates)
        result = {
            'view': 'gallery_timeline',
            'orderedIds': ordered_ids,
            'hasMore': has_more,
            'pageToken': self._page_token(dates_page + 1) if has_more else None,
            'viewMeta': {
                'dateTotals': date_totals,
                'itemsPerDate': items_per_date,
                'datesPage': dates_page,
                'totalDates': len(all_dates),
                'hasMoreDates': has_more,
            },
        }
        if hydrate_records:
            result['records'] = self._records_from_rows(result_rows)
            result['missing'] = []
        return result

    def _order_gallery_month(self, params, show_hidden):
        month_key = params.get('month') or params.get('month_filter')
        if not month_key:
            raise ValueError('month is required')
        filter_type = params.get('media_filter') or params.get('filter') or params.get('filter_type') or 'all'
        category_id = params.get('category_id')
        category_ids = self._category_ids(params)
        hydrate_records = self._bool_param(params, 'hydrate', False)
        items_per_date = self._int_param(params, 'items_per_date', 300, minimum=1, maximum=500)
        dates_page = self._int_param(params, 'dates_page', 1, minimum=1)
        dates_limit = self._int_param(params, 'dates_limit', 31, minimum=1, maximum=31)
        month_page = self._month_timeline_page(
            month_key,
            category_id=category_id,
            category_ids=category_ids,
            filter_type=filter_type,
            items_per_date=items_per_date,
            dates_page=dates_page,
            dates_limit=dates_limit,
            show_hidden=show_hidden,
        )
        rows = month_page.get('rows', [])
        ordered_ids = [self._stable_id(row['category_id'], row['rel_path']) for row in rows]
        has_more = month_page.get('has_more_dates', False)
        result = {
            'view': 'gallery_month',
            'orderedIds': ordered_ids,
            'hasMore': has_more,
            'pageToken': self._page_token(dates_page + 1) if has_more else None,
            'viewMeta': {
                'dateTotals': month_page.get('date_totals', {}),
                'itemsPerDate': items_per_date,
                'datesPage': dates_page,
                'totalDates': month_page.get('total_dates', 0),
                'hasMoreDates': has_more,
                'month': month_key,
            },
        }
        if hydrate_records:
            result['records'] = self._records_from_rows(rows)
            result['missing'] = []
        return result

    def _order_whats_new(self, params, show_hidden):
        filter_type = params.get('media_filter') or params.get('filter') or params.get('filter_type') or 'all'
        hydrate_records = self._bool_param(params, 'hydrate', False)
        limit = self._int_param(params, 'limit', 10, minimum=1, maximum=100)
        rows = media_index_service.get_recent_media(
            limit=limit,
            show_hidden=show_hidden,
            filter_type=filter_type,
        )
        result = {
            'view': 'whats_new',
            'orderedIds': [self._stable_id(row['category_id'], row['rel_path']) for row in rows],
            'hasMore': False,
            'pageToken': None,
            'viewMeta': {
                'limit': limit,
                'mediaFilter': filter_type,
            },
        }
        if hydrate_records:
            result['records'] = self._records_from_rows(rows)
            result['missing'] = []
        return result

    @staticmethod
    def _stable_id(category_id, rel_path):
        if not category_id or not rel_path:
            return None
        return f"{category_id}::{rel_path}"

    @staticmethod
    def _category_ids(params):
        raw = params.get('category_ids')
        if not raw:
            return []
        return [value.strip() for value in str(raw).split(',') if value.strip()]

    def _timeline_date_counts(
        self,
        *,
        category_id=None,
        category_ids=None,
        filter_type='all',
        show_hidden=False,
    ):
        if category_ids:
            counts = {}
            for scoped_id in category_ids:
                scoped_counts = SortService.get_timeline_dates(
                    category_id=scoped_id,
                    filter_type=filter_type,
                    show_hidden=show_hidden,
                )
                for date_key, count in scoped_counts.items():
                    counts[date_key] = counts.get(date_key, 0) + count
            return counts
        return SortService.get_timeline_dates(
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )

    def _rows_for_date(
        self,
        date_key,
        *,
        category_id=None,
        category_ids=None,
        filter_type='all',
        limit=24,
        offset=0,
        show_hidden=False,
    ):
        if category_ids:
            rows = []
            for scoped_id in category_ids:
                rows.extend(media_index_service.get_media_rows_for_date(
                    date_key,
                    category_id=scoped_id,
                    filter_type=filter_type,
                    limit=limit + offset,
                    offset=0,
                    show_hidden=show_hidden,
                ))
            rows.sort(key=lambda row: row.get('mtime') or 0, reverse=True)
            return rows[offset:offset + limit]
        return media_index_service.get_media_rows_for_date(
            date_key,
            category_id=category_id,
            filter_type=filter_type,
            limit=limit,
            offset=offset,
            show_hidden=show_hidden,
        )

    def _month_timeline_page(
        self,
        month_key,
        *,
        category_id=None,
        category_ids=None,
        filter_type='all',
        items_per_date=24,
        dates_page=1,
        dates_limit=31,
        show_hidden=False,
    ):
        if not category_ids:
            return media_index_service.get_month_timeline_page(
                month_key,
                category_id=category_id,
                filter_type=filter_type,
                items_per_date=items_per_date,
                dates_page=dates_page,
                dates_limit=dates_limit,
                show_hidden=show_hidden,
            )

        date_totals = {}
        rows_by_date = {}
        for scoped_id in category_ids:
            for row in media_index_service.get_media_rows_for_month(
                month_key,
                category_id=scoped_id,
                filter_type=filter_type,
                show_hidden=show_hidden,
            ):
                date_key = datetime.fromtimestamp(
                    int(row.get('mtime') or 0),
                    timezone.utc,
                ).strftime('%Y-%m-%d')
                date_totals[date_key] = date_totals.get(date_key, 0) + 1
                rows_by_date.setdefault(date_key, []).append(row)

        all_dates = sorted(date_totals.keys(), reverse=True)
        start_idx = (max(1, int(dates_page or 1)) - 1) * max(1, int(dates_limit or 31))
        safe_dates_limit = max(1, min(int(dates_limit or 31), 31))
        safe_items_per_date = max(1, min(int(items_per_date or 24), 500))
        page_dates = all_dates[start_idx:start_idx + safe_dates_limit]
        rows = []
        for date_key in page_dates:
            date_rows = rows_by_date.get(date_key, [])
            date_rows.sort(key=lambda row: row.get('mtime') or 0, reverse=True)
            for row in date_rows[:safe_items_per_date]:
                item = dict(row)
                item['_date_key'] = date_key
                rows.append(item)

        return {
            'rows': rows,
            'date_totals': {
                date_key: date_totals.get(date_key, 0)
                for date_key in page_dates
            },
            'page_dates': page_dates,
            'total_dates': len(all_dates),
            'has_more_dates': (start_idx + safe_dates_limit) < len(all_dates),
        }

    @staticmethod
    def _id_from_enriched(item):
        return MediaOrderingService._stable_id(
            item.get('categoryId') or item.get('category_id'),
            item.get('relPath') or item.get('name') or item.get('filename') or item.get('rel_path'),
        )

    @staticmethod
    def _int_param(params, key, default, *, minimum=None, maximum=None):
        try:
            value = int(params.get(key, default))
        except (TypeError, ValueError):
            value = default
        if minimum is not None:
            value = max(minimum, value)
        if maximum is not None:
            value = min(maximum, value)
        return value

    @staticmethod
    def _bool_value(value):
        return str(value).lower() in ('1', 'true', 'yes', 'on')

    def _bool_param(self, params, key, default=False):
        if key not in params:
            return default
        return self._bool_value(params.get(key))

    @staticmethod
    def _page_token(page):
        return str(page)
