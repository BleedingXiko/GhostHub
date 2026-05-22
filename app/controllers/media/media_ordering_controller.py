"""Media ordering endpoint controller."""

import gevent
from flask import request
from werkzeug.exceptions import BadRequest

from app.utils.auth import get_show_hidden_flag
from app.utils.auth import session_or_admin_required
from specter import Controller, registry

CANON_VIEW_TYPES = {
    'streaming_row',
    'streaming_grid',
    'subfolder_grid',
    'gallery_timeline',
    'gallery_month',
    'whats_new',
    'viewer_category',
    'viewer_local',
}
ORDERABLE_VIEW_TYPES = CANON_VIEW_TYPES - {'viewer_local'}
FILTER_VALUES = {'all', 'image', 'video'}
SORT_BY_VALUES = {'name', 'mtime', 'size', 'shuffle', 'tv'}
SORT_ORDER_VALUES = {'ASC', 'DESC'}
MAX_BATCH_ORDER_REQUESTS = 50
ALLOWED_PARAMS = {
    'view',
    'category_id',
    'category_ids',
    'subfolder',
    'media_filter',
    'filter',
    'filter_type',
    'sort_by',
    'sort_order',
    'page',
    'limit',
    'include_total',
    'hydrate',
    'force_refresh',
    'shuffle',
    'pageToken',
    'items_per_date',
    'dates_page',
    'dates_limit',
    'date',
    'date_offset',
    'jump_to_date',
    'month',
    'month_filter',
}


class MediaOrderingController(Controller):
    """Expose media ordering windows for all client views."""

    name = 'media_ordering_controller'
    url_prefix = '/api/media'

    def build_routes(self, router):
        @router.route('/order', methods=['GET'], json_errors='Failed to order media')
        @session_or_admin_required
        def get_order_route():
            view_type = request.args.get('view', '')
            params = dict(request.args.items())
            self._validate_order_request(view_type, params)
            return self._get_order_result(
                view_type,
                params,
                show_hidden=get_show_hidden_flag(),
            )

        @router.route('/orders', methods=['POST'], json_errors='Failed to order media batch')
        @session_or_admin_required
        def get_orders_route():
            payload = request.get_json(silent=True) or {}
            requests_payload = payload.get('requests')
            if not isinstance(requests_payload, list):
                raise BadRequest("'requests' must be a list")
            if len(requests_payload) > MAX_BATCH_ORDER_REQUESTS:
                raise BadRequest(
                    f"'requests' cannot contain more than {MAX_BATCH_ORDER_REQUESTS} entries"
                )

            show_hidden = get_show_hidden_flag()
            normalized_requests = [
                self._safe_normalize_batch_request(entry)
                for entry in requests_payload
            ]
            results = [{} for _ in normalized_requests]

            def fetch_one(index, normalized):
                view_type, params, view_key, normalize_error = normalized
                if normalize_error:
                    results[index] = self._error_batch_result(
                        view_type,
                        view_key,
                        normalize_error,
                    )
                    return
                try:
                    result = self._get_order_result(
                        view_type,
                        params,
                        show_hidden=show_hidden,
                    )
                    results[index] = {
                        **result,
                        'viewKey': view_key,
                        'status': result.get('status') or 'ready',
                    }
                except Exception as exc:
                    results[index] = self._error_batch_result(view_type, view_key, str(exc))

            jobs = [
                gevent.spawn(fetch_one, index, normalized)
                for index, normalized in enumerate(normalized_requests)
            ]
            gevent.joinall(jobs)
            return {'results': results}

    def _get_order_result(self, view_type, params, *, show_hidden):
        result = registry.require('media_ordering').get_order(
            view_type,
            params,
            show_hidden=show_hidden,
        )
        if self._bool_arg(params.get('hydrate')) and 'records' not in result:
            hydrated = registry.require('media_records').get_records(
                result.get('orderedIds') or [],
                show_hidden=show_hidden,
            )
            result = {
                **result,
                'records': hydrated.get('records') or {},
                'missing': hydrated.get('missing') or [],
            }
        return result

    def _normalize_batch_request(self, entry):
        if not isinstance(entry, dict):
            raise BadRequest('Each media order request must be an object')
        view_key = entry.get('viewKey')
        view_type = str(entry.get('view') or '').strip()
        params = {key: value for key, value in entry.items() if key != 'viewKey'}
        params['view'] = view_type
        self._validate_order_request(view_type, params)
        return view_type, params, view_key

    def _safe_normalize_batch_request(self, entry):
        view_key = entry.get('viewKey') if isinstance(entry, dict) else None
        view_type = str(entry.get('view') or '').strip() if isinstance(entry, dict) else ''
        try:
            normalized_view_type, params, normalized_view_key = self._normalize_batch_request(entry)
            return normalized_view_type, params, normalized_view_key, None
        except Exception as exc:
            return view_type, {}, view_key, str(exc)

    @staticmethod
    def _error_batch_result(view_type, view_key, error):
        return {
            'view': view_type,
            'viewKey': view_key,
            'orderedIds': [],
            'records': {},
            'missing': [],
            'hasMore': False,
            'pageToken': None,
            'viewMeta': {},
            'status': 'error',
            'error': error,
        }

    @staticmethod
    def _validate_order_request(view_type, params):
        if view_type not in ORDERABLE_VIEW_TYPES:
            raise BadRequest(f"Unsupported media order view: {view_type}")

        unknown_params = set(params) - ALLOWED_PARAMS
        if unknown_params:
            raise BadRequest(f"Unsupported media order parameter: {sorted(unknown_params)[0]}")

        for key in ('category_id', 'subfolder'):
            value = params.get(key)
            if value is not None and not isinstance(value, str):
                raise BadRequest(f"'{key}' must be a string")

        filter_value = params.get('media_filter') or params.get('filter') or params.get('filter_type')
        if filter_value and filter_value not in FILTER_VALUES:
            raise BadRequest("'media_filter' must be one of: all, image, video")

        sort_by = params.get('sort_by')
        if sort_by and sort_by not in SORT_BY_VALUES:
            raise BadRequest("'sort_by' is not supported")

        sort_order = params.get('sort_order')
        if sort_order and sort_order.upper() not in SORT_ORDER_VALUES:
            raise BadRequest("'sort_order' must be ASC or DESC")

    @staticmethod
    def _bool_arg(value):
        return str(value or '').strip().lower() in {'1', 'true', 'yes', 'on'}
