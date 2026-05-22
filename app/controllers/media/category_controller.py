"""Category domain controller built on Specter."""

import logging
import math
import traceback

from flask import jsonify, request

from app.services.media.category_cache_service import get_cache_timestamp
from app.services.media.category_query_service import (
    get_all_categories_with_details,
    get_category_by_id,
)
from app.services.media.category_service import CategoryService
from app.services.media import media_catalog_service
from app.services.media.playlist_service import PlaylistService
from specter import Controller, Field, Schema, expect_json, registry
from app.utils.auth import admin_required, get_show_hidden_flag

logger = logging.getLogger(__name__)


class CategoryController(Controller):
    """Own category listing and category lifecycle endpoints."""

    name = 'category'
    url_prefix = '/api'

    schemas = {
        'add_category': Schema('category.add_category', {
            'name': Field(str, required=True),
            'path': Field(str, required=True),
        }, strict=True),
    }

    def build_routes(self, router):
        @router.route('/categories', methods=['GET'])
        def list_categories():
            """Get categories with optional pagination and filtering."""
            try:
                page = request.args.get('page', 1, type=int)
                limit = request.args.get('limit', 0, type=int)
                media_filter = request.args.get('filter', 'all', type=str).lower()
                force_refresh = request.args.get('force_refresh', 'false').lower() == 'true'
                category_id_filter = request.args.get('category_id')

                show_hidden = get_show_hidden_flag()
                categories = get_all_categories_with_details(
                    use_cache=not force_refresh,
                    show_hidden=show_hidden,
                )

                parent_name_filter = request.args.get('parent_name')
                category_ids_filter = request.args.get('category_ids')
                has_explicit_filter = bool(
                    category_id_filter or category_ids_filter or parent_name_filter
                )

                categories_ts = get_cache_timestamp()
                etag = (
                    f"cats-{categories_ts}-{page}-{limit}-{media_filter}-{show_hidden}-"
                    f"{category_id_filter or ''}-{category_ids_filter or ''}-"
                    f"{parent_name_filter or ''}"
                )
                if request.headers.get('If-None-Match') == f'"{etag}"' and not force_refresh:
                    return '', 304

                if category_id_filter:
                    categories = [
                        category for category in categories
                        if category.get('id') == category_id_filter
                    ]
                    if not categories:
                        try:
                            from app.services.media.hidden_content_service import (
                                should_block_category_access,
                            )
                            if should_block_category_access(category_id_filter, show_hidden):
                                categories = []
                            else:
                                resolved = get_category_by_id(category_id_filter)
                                # A synthesized parent absent from the filtered
                                # list is a ghost (its descendants are all
                                # hidden). Never resurrect it — that would
                                # bypass the visibility filter and the pill
                                # would still show after reveal-off.
                                if (
                                    resolved
                                    and not show_hidden
                                    and resolved.get('_synthesized_parent')
                                ):
                                    categories = []
                                elif resolved:
                                    categories = [
                                        self._build_category_summary_payload(
                                            resolved,
                                            show_hidden=show_hidden,
                                        )
                                    ]
                        except Exception:
                            resolved = get_category_by_id(category_id_filter)
                            if (
                                resolved
                                and not show_hidden
                                and resolved.get('_synthesized_parent')
                            ):
                                categories = []
                            elif resolved:
                                categories = [
                                    self._build_category_summary_payload(
                                        resolved,
                                        show_hidden=show_hidden,
                                    )
                                ]
                elif category_ids_filter:
                    id_set = {item.strip() for item in category_ids_filter.split(',')}
                    categories = [
                        category for category in categories
                        if category.get('id') in id_set
                    ]
                elif parent_name_filter:
                    parent_name = parent_name_filter.lower()
                    filtered = []
                    for category in categories:
                        name = category.get('name', '')
                        if '(' not in name:
                            continue
                        breadcrumb = name.split('(', 1)[1].rstrip(')')
                        parts = [part.strip().lower() for part in breadcrumb.split('›')]
                        if parent_name in parts:
                            filtered.append(category)
                    categories = filtered

                if media_filter != 'all':
                    if media_filter == 'video':
                        categories = [
                            category for category in categories
                            if category.get('containsVideo', False)
                        ]
                    elif media_filter == 'image':
                        categories = [
                            category for category in categories
                            if (
                                not category.get('containsVideo', False) and
                                category.get('mediaCount', 0) > 0
                            )
                        ]

                virtual_playlist = PlaylistService.get_virtual_category()
                if virtual_playlist and not has_explicit_filter:
                    categories = [virtual_playlist] + categories

                total = len(categories)
                if limit > 0:
                    start = (page - 1) * limit
                    end = start + limit
                    categories = categories[start:end]

                total_pages = math.ceil(total / limit) if limit > 0 else 1

                response = jsonify({
                    'categories': categories,
                    'pagination': {
                        'page': page,
                        'limit': limit,
                        'total': total,
                        'totalPages': total_pages,
                        'hasMore': limit > 0 and (page * limit) < total,
                    },
                })
                response.headers['ETag'] = f'"{etag}"'
                response.headers['Cache-Control'] = 'no-cache'
                return response
            except Exception as exc:
                logger.error("Error in list_categories endpoint: %s", exc)
                logger.debug(traceback.format_exc())
                return jsonify({'error': 'Failed to retrieve categories'}), 500

        @router.route('/categories', methods=['POST'])
        @admin_required
        def add_category():
            """Create a new media category. Requires admin."""
            payload = self.schema('add_category').require(expect_json())
            name = payload['name']
            path = payload['path']

            try:
                new_category, error = CategoryService.add_category(name, path)
                if new_category and 'id' in new_category:
                    media_catalog_service.start_async_indexing(
                        new_category['id'],
                        new_category['path'],
                        new_category['name'],
                    )

                if error:
                    status_code = 400 if (
                        "exists" in error or "not a directory" in error
                    ) else 500
                    return jsonify({'error': error}), status_code
                return jsonify(new_category), 201
            except Exception as exc:
                logger.error(
                    "Unexpected error adding category: Name='%s', Path='%s': %s",
                    name,
                    path,
                    exc,
                )
                logger.debug(traceback.format_exc())
                return jsonify({
                    'error': 'An unexpected error occurred while adding the category',
                }), 500

        @router.route('/categories/<category_id>', methods=['DELETE'])
        @admin_required
        def delete_category(category_id):
            """Delete category and clear associated caches. Requires admin."""
            try:
                success, error = CategoryService.delete_category(category_id)
                if not success:
                    status_code = 404 if error == "Category not found" else 500
                    return jsonify({'error': error}), status_code

                return '', 204
            except Exception as exc:
                logger.error(
                    "Unexpected error deleting category ID %s: %s",
                    category_id,
                    exc,
                )
                logger.debug(traceback.format_exc())
                return jsonify({
                    'error': 'An unexpected error occurred while deleting the category',
                }), 500

        @router.route('/categories/<category_id>/thumbnail-status', methods=['GET'])
        def get_thumbnail_status(category_id):
            """Get thumbnail generation status for a category."""
            try:
                status = registry.require('thumbnail_runtime').get_thumbnail_status(category_id)
                return jsonify(status)
            except Exception as exc:
                logger.error(
                    "Error getting thumbnail status for %s: %s",
                    category_id,
                    exc,
                )
                return jsonify({'status': 'error', 'message': str(exc)}), 500

    def _build_category_summary_payload(self, category, show_hidden=False):
        """Build a single-category payload, including deep auto:: fallback."""
        from app.services.media import media_index_service
        from app.utils.media_utils import get_thumbnail_url

        payload = {
            'id': category.get('id'),
            'name': category.get('name'),
            'path': category.get('path'),
            'mediaCount': int(category.get('mediaCount', 0) or 0),
            'thumbnailUrl': category.get('thumbnailUrl'),
            'containsVideo': bool(category.get('containsVideo', False)),
            'auto_detected': bool(
                category.get('auto_detected', False) or
                str(category.get('id', '')).startswith('auto::')
            ),
        }

        category_id = payload.get('id')
        if not category_id:
            return payload

        try:
            summary = media_index_service.get_category_media_summary(
                category_id,
                show_hidden=show_hidden,
                include_descendants=str(category_id).startswith('auto::'),
            )
            count = int(summary.get('count', 0) or 0) if summary else 0
            payload['mediaCount'] = count
            payload['containsVideo'] = bool(summary.get('contains_video', False)) if summary else False
            if not payload.get('thumbnailUrl') and count > 0 and summary:
                image_rel = summary.get('image_rel_path')
                video_rel = summary.get('video_rel_path')
                image_category_id = summary.get('image_category_id') or category_id
                video_category_id = summary.get('video_category_id') or category_id
                if image_rel:
                    payload['thumbnailUrl'] = get_thumbnail_url(image_category_id, image_rel)
                elif video_rel:
                    payload['thumbnailUrl'] = get_thumbnail_url(video_category_id, video_rel)
        except Exception as exc:
            logger.debug(
                "Could not enrich category summary for %s: %s",
                category_id,
                exc,
            )

        return payload
