"""Media domain controller built on Specter."""

import logging
import os
import traceback

from flask import jsonify, request

from app.services.media.category_query_service import (
    get_cached_categories_with_details,
)
from app.services.media.category_discovery_service import (
    format_category_display_name,
    get_visible_auto_parent_chain,
)
from app.services.media import media_index_service
from app.services.media import category_persistence_service
from app.services.media.media_records_service import MediaRecordsService
from app.services.media.playlist_service import PlaylistService
from specter import Controller, Field, Schema, expect_json
from app.utils.auth import admin_required, get_show_hidden_flag

logger = logging.getLogger(__name__)


class MediaController(Controller):
    """Own media search, playlist, and media listing endpoints."""

    name = 'media'
    url_prefix = '/api'

    schemas = {
        'playlist_item': Schema('media.playlist_item', {
            'url': Field(str, required=True),
        }),
        'playlist_remove': Schema('media.playlist_remove', {
            'url': Field(str, required=True),
        }, strict=True),
    }

    def build_routes(self, router):
        @router.route('/search', methods=['GET'])
        def search_media():
            """Search for media files using the backend search index."""
            try:
                query = request.args.get('q', '').strip().lower()
                if not query or len(query) < 2:
                    return jsonify({
                        'error': 'Search query must be at least 2 characters',
                    }), 400
                limit = request.args.get('limit', 100, type=int)
                limit = max(1, min(limit, 250))
                folders_limit = request.args.get('folders_limit', 100, type=int)
                folders_limit = max(1, min(folders_limit, 250))
                parent_limit = request.args.get('parent_limit', 50, type=int)
                parent_limit = max(1, min(parent_limit, 100))

                show_hidden = get_show_hidden_flag()

                import gevent

                search_results = media_index_service.search_media_index(
                    query,
                    limit=limit,
                    show_hidden=show_hidden,
                )

                folder_match_rows = []
                folder_batch_size = 2000
                folder_offset = 0
                while True:
                    batch = media_index_service.search_media_paths_for_folder_matches(
                        query,
                        limit=folder_batch_size,
                        show_hidden=show_hidden,
                        offset=folder_offset,
                    )
                    folder_match_rows.extend(batch)
                    if len(batch) < folder_batch_size:
                        break
                    folder_offset += folder_batch_size
                    gevent.sleep(0)

                results_by_category = {}
                matched_categories = []
                matched_parent_folders = []
                parent_folder_map = {}
                matched_category_ids = set()
                breadcrumb_separator = ' › '

                def _parse_breadcrumb_parts(raw_breadcrumb):
                    normalized = str(raw_breadcrumb or '')
                    normalized = normalized.replace('›', '>')
                    normalized = normalized.replace('â€º', '>')
                    return [
                        part.strip()
                        for part in normalized.split('>')
                        if part and part.strip()
                    ]

                def _add_parent_folder(part, context_parts, category_id):
                    if not part or not category_id:
                        return
                    part_lower = part.lower()
                    if part_lower == 'usb':
                        return

                    cleaned_context = [
                        value for value in context_parts
                        if value and value.lower() not in ('usb',)
                    ]
                    context = breadcrumb_separator.join(cleaned_context) if cleaned_context else ''
                    map_key = (part_lower, context.lower())
                    if map_key not in parent_folder_map:
                        parent_folder_map[map_key] = {
                            'name': part,
                            'context': context,
                            'category_ids': [],
                        }

                    if category_id not in parent_folder_map[map_key]['category_ids']:
                        parent_folder_map[map_key]['category_ids'].append(category_id)

                def _build_auto_display_name(category_id):
                    if not category_id or not str(category_id).startswith('auto::'):
                        return None, []

                    id_parts = [part for part in str(category_id).split('::')[1:] if part]
                    if not id_parts:
                        return None, []

                    leaf = id_parts[-1]
                    parent_chain = id_parts[:-1]
                    visible_parent_chain = get_visible_auto_parent_chain(parent_chain)
                    display_name = format_category_display_name(
                        leaf,
                        parent_chain,
                        len(id_parts),
                    )
                    parent_parts = list(reversed(visible_parent_chain))
                    return display_name, parent_parts

                all_categories = get_cached_categories_with_details(
                    show_hidden=show_hidden,
                )
                if not all_categories:
                    all_categories = category_persistence_service.load_categories()

                known_ids = {
                    category.get('id')
                    for category in all_categories
                    if category.get('id')
                }

                category_batch_size = 2000
                category_offset = 0
                while True:
                    batch = media_index_service.get_indexed_category_ids(
                        show_hidden=show_hidden,
                        limit=category_batch_size,
                        offset=category_offset,
                    )
                    if not batch:
                        break
                    for category_id in batch:
                        if not category_id or category_id in known_ids:
                            continue
                        inferred_name = None
                        if str(category_id).startswith('auto::'):
                            inferred_name, _ = _build_auto_display_name(category_id)
                        all_categories.append({
                            'id': category_id,
                            'name': inferred_name or str(category_id),
                            'auto_detected': bool(str(category_id).startswith('auto::')),
                        })
                        known_ids.add(category_id)
                    if len(batch) < category_batch_size:
                        break
                    category_offset += category_batch_size
                    gevent.sleep(0)

                category_lookup = {
                    category.get('id'): category
                    for category in all_categories
                    if category.get('id')
                }

                for category in all_categories:
                    category_name = category.get('name', '')
                    category_id = category.get('id')
                    if not category_id:
                        continue

                    leaf_name = (
                        category_name.split('(')[0].strip().lower()
                        if '(' in category_name else category_name.lower()
                    )
                    if query in leaf_name and category_id not in matched_category_ids:
                        matched_categories.append(category)
                        matched_category_ids.add(category_id)

                    if '(' in category_name:
                        breadcrumb = category_name.split('(', 1)[1].rstrip(')')
                        parts = _parse_breadcrumb_parts(breadcrumb)
                        for index, part in enumerate(parts):
                            _add_parent_folder(part, parts[index + 1:], category_id)

                auto_batch_size = 2000
                auto_offset = 0
                while True:
                    auto_category_rows = media_index_service.search_media_category_ids(
                        query,
                        limit=auto_batch_size,
                        show_hidden=show_hidden,
                        offset=auto_offset,
                    )
                    if not auto_category_rows:
                        break
                    auto_offset += auto_batch_size
                    if len(auto_category_rows) == auto_batch_size:
                        gevent.sleep(0)

                    for row in auto_category_rows:
                        category_id = row.get('category_id')
                        if not category_id or not str(category_id).startswith('auto::'):
                            continue

                        if category_id not in category_lookup:
                            inferred_name, _ = _build_auto_display_name(category_id)
                            if inferred_name:
                                inferred_category = {
                                    'id': category_id,
                                    'name': inferred_name,
                                }
                                category_lookup[category_id] = inferred_category

                                inferred_leaf = inferred_name.split('(')[0].strip().lower()
                                if query in inferred_leaf and category_id not in matched_category_ids:
                                    matched_categories.append(inferred_category)
                                    matched_category_ids.add(category_id)

                        _, parent_parts = _build_auto_display_name(category_id)
                        for index, part in enumerate(parent_parts):
                            _add_parent_folder(
                                part,
                                parent_parts[index + 1:],
                                category_id,
                            )

                    if len(auto_category_rows) < auto_batch_size:
                        break

                for (part_lower, _context), info in parent_folder_map.items():
                    if query in part_lower:
                        display_name = info['name']
                        if info['context']:
                            display_name = f"{info['name']} ({info['context']})"
                        matched_parent_folders.append({
                            'name': display_name,
                            'category_count': len(info['category_ids']),
                            'category_ids': info['category_ids'],
                            'exact_match': (part_lower == query),
                        })
                matched_parent_folders.sort(
                    key=lambda item: (
                        not item.get('exact_match', False),
                        item['name'],
                    ),
                )

                category_folders = {}
                for item in search_results:
                    category_id = item['category_id']
                    if category_id not in results_by_category:
                        category_info = category_lookup.get(category_id)
                        results_by_category[category_id] = {
                            'category_id': category_id,
                            'category_name': category_info['name'] if category_info else 'Unknown',
                            'matches': [],
                            'total_matches': 0,
                        }

                    rel_path = item['rel_path']
                    stable_id = self._stable_media_id(category_id, rel_path)
                    if stable_id:
                        results_by_category[category_id]['matches'].append(stable_id)
                    results_by_category[category_id]['total_matches'] += 1

                for item in folder_match_rows:
                    category_id = item['category_id']
                    rel_path = item.get('rel_path', '')
                    parent_path = item.get('parent_path', '')
                    source_path = parent_path or rel_path
                    if not source_path:
                        continue

                    path_parts = source_path.split('/')
                    max_depth = len(path_parts) if parent_path else max(0, len(path_parts) - 1)
                    for index in range(max_depth):
                        part = path_parts[index]
                        if query in part.lower():
                            folder_rel_path = '/'.join(path_parts[:index + 1])
                            folder_key = (category_id, folder_rel_path)
                            if folder_key not in category_folders:
                                category_info = category_lookup.get(category_id)
                                category_folders[folder_key] = {
                                    'id': f"{category_id}:{folder_rel_path}",
                                    'name': part,
                                    'rel_path': folder_rel_path,
                                    'category_id': category_id,
                                    'category_name': category_info['name'] if category_info else 'Unknown',
                                    'file_count': 0,
                                    'depth': index,
                                    'exact_match': (part.lower() == query),
                                }
                            elif part.lower() == query:
                                category_folders[folder_key]['exact_match'] = True
                            category_folders[folder_key]['file_count'] += 1

                matched_folders = sorted(
                    category_folders.values(),
                    key=lambda item: (
                        not item.get('exact_match', False),
                        item['depth'],
                        item['name'].lower(),
                        item['rel_path'].lower(),
                    ),
                )
                folders_truncated = len(matched_folders) > folders_limit
                parent_folders_truncated = len(matched_parent_folders) > parent_limit

                ordered_ids = [
                    self._stable_media_id(item.get('category_id'), item.get('rel_path'))
                    for item in search_results
                ]
                ordered_ids = [stable_id for stable_id in ordered_ids if stable_id]
                records = {}
                for row in search_results:
                    record = MediaRecordsService._row_to_record(self._record_row(row))
                    record_id = record.get('id')
                    if record_id:
                        records[record_id] = record

                truncated = (
                    len(search_results) >= limit or
                    folders_truncated or
                    parent_folders_truncated
                )
                view_key = f"search::query={query}::limit={limit}"
                return jsonify({
                    'viewKey': view_key,
                    'viewType': 'search',
                    'orderedIds': ordered_ids,
                    'status': 'ready',
                    'hasMore': len(search_results) >= limit,
                    'pageToken': None,
                    'error': None,
                    'records': records,
                    'missing': [],
                    'viewMeta': {
                        'query': query,
                        'matched_categories': matched_categories,
                        'matched_folders': matched_folders[:folders_limit],
                        'matched_parent_folders': matched_parent_folders[:parent_limit],
                        'result_groups': list(results_by_category.values()),
                        'total_categories': len(results_by_category),
                        'total_results': len(search_results),
                        'total_matched_folders': len(matched_folders),
                        'total_matched_parent_folders': len(matched_parent_folders),
                        'folders_truncated': folders_truncated,
                        'parent_folders_truncated': parent_folders_truncated,
                        'truncated': truncated,
                    },
                })
            except Exception as exc:
                logger.error("Error in search_media endpoint: %s", exc)
                logger.debug(traceback.format_exc())
                return jsonify({'error': 'Failed to search media'}), 500

        @router.route('/session/playlist/add', methods=['POST'])
        def add_to_session_playlist():
            """Add a media item to the shared session playlist."""
            try:
                item = expect_json()
                payload = self.schema('playlist_item').validate(item)
                if not payload.ok:
                    return jsonify({'error': 'Invalid media item'}), 400

                success, message = PlaylistService.add_item(item)
                if success:
                    return jsonify({'success': True, 'message': message})
                return jsonify({'success': False, 'message': message}), 400
            except Exception as exc:
                logger.error("Error adding to playlist: %s", exc)
                return jsonify({'error': str(exc)}), 500

        @router.route('/session/playlist/remove', methods=['POST'])
        def remove_from_session_playlist():
            """Remove a media item from the shared session playlist."""
            try:
                payload = self.schema('playlist_remove').require(expect_json())
                success, message = PlaylistService.remove_item(payload['url'])
                if success:
                    return jsonify({'success': True, 'message': message})
                return jsonify({'success': False, 'message': message}), 400
            except Exception as exc:
                logger.error("Error removing from playlist: %s", exc)
                return jsonify({'error': str(exc)}), 500

        @router.route('/session/playlist/clear', methods=['POST'])
        @admin_required
        def clear_session_playlist():
            """Clear the shared session playlist. Admin only."""
            try:
                PlaylistService.clear_playlist()
                return jsonify({'success': True, 'message': 'Playlist cleared'})
            except Exception as exc:
                return jsonify({'error': str(exc)}), 500

    @staticmethod
    def _stable_media_id(category_id, rel_path):
        if not category_id or not rel_path:
            return None
        return f"{category_id}::{rel_path}"

    @staticmethod
    def _record_row(row):
        return {
            'stable_id': MediaController._stable_media_id(
                row.get('category_id'),
                row.get('rel_path'),
            ),
            'category_id': row.get('category_id'),
            'rel_path': row.get('rel_path'),
            'name': row.get('name') or os.path.basename(str(row.get('rel_path') or '')),
            'type': row.get('type') or 'unknown',
            'size': row.get('size') or 0,
            'mtime': row.get('mtime') or 0,
            'hash': row.get('hash') or '',
            'is_hidden': row.get('is_hidden') or 0,
        }
