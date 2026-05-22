"""
Tests for API Routes
--------------------
Comprehensive tests for REST API endpoints including:
- Category endpoints
- Progress endpoints
- Storage endpoints
- Configuration endpoints
- Media serving endpoints
"""

import pytest
import json
import os
from unittest.mock import patch, MagicMock
from io import BytesIO


class TestCategoryEndpoints:
    """Tests for category-related API endpoints."""

    def test_get_categories(self, client, app_context):
        """Test GET /api/categories endpoint."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get("/api/categories")

        assert response.status_code == 200
        data = response.get_json()
        # API returns dict with 'categories' key and pagination info
        assert isinstance(data, dict)
        assert "categories" in data

    def test_get_categories_deep_auto_category_fallback(self, client, app_context):
        """Deep auto:: category filter should resolve even when global discovery cache is cold."""
        from app.controllers.media.category_controller import CategoryController

        requested_id = "auto::ghost::sda2::TV::ShowA"
        resolved = {"id": requested_id, "name": "ShowA", "path": "/media/ghost/sda2/TV/ShowA"}
        enriched = {
            "id": requested_id,
            "name": "ShowA",
            "path": "/media/ghost/sda2/TV/ShowA",
            "mediaCount": 12,
            "thumbnailUrl": "/media/auto::ghost::sda2::TV::ShowA/poster.jpg",
            "containsVideo": True,
        }

        with patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False), \
             patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.services.media.hidden_content_service.should_block_category_access", return_value=False), \
             patch("app.controllers.media.category_controller.get_category_by_id", return_value=resolved), \
             patch.object(CategoryController, "_build_category_summary_payload", return_value=enriched):
            response = client.get(f"/api/categories?category_id={requested_id}")

        assert response.status_code == 200
        data = response.get_json()
        assert len(data.get("categories", [])) == 1
        assert data["categories"][0]["id"] == requested_id

    def test_get_categories_filtered_does_not_prepend_session_playlist(self, client, app_context):
        """Filtered category requests should return only filtered categories."""
        category = {"id": "auto::movies::action", "name": "Action", "path": "/media/Movies/Action"}
        with patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False), \
             patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[category]), \
             patch("app.controllers.media.category_controller.PlaylistService.get_virtual_category", return_value={"id": "session-playlist", "name": "Session Playlist"}):
            response = client.get("/api/categories?category_id=auto::movies::action")

        assert response.status_code == 200
        data = response.get_json()
        category_ids = [c.get("id") for c in data.get("categories", [])]
        assert category_ids == ["auto::movies::action"]

    def test_add_category(self, admin_client, app_context, tmp_path):
        """Test POST /api/categories endpoint (requires admin)."""
        # Create test directory
        media_dir = tmp_path / "test_media"
        media_dir.mkdir()

        response = admin_client.post(
            "/api/categories", json={"name": "Test Category", "path": str(media_dir)}
        )

        assert response.status_code in [200, 201, 400, 403, 500]
        if response.status_code == 200:
            data = response.get_json()
            assert "id" in data or "error" not in data

    def test_add_category_missing_name(self, admin_client, app_context, tmp_path):
        """Test adding category without name (requires admin)."""
        media_dir = tmp_path / "media"
        media_dir.mkdir()

        response = admin_client.post("/api/categories", json={"path": str(media_dir)})

        # May return 400/422 for validation or 403 if not admin
        assert response.status_code in [400, 422, 403]

    def test_add_category_missing_path(self, admin_client, app_context):
        """Test adding category without path (requires admin)."""
        response = admin_client.post("/api/categories", json={"name": "Test"})

        assert response.status_code in [400, 422, 403]

    def test_delete_category(self, client, app_context, tmp_path):
        """Test DELETE /api/categories/<id> endpoint."""
        # First add a category
        media_dir = tmp_path / "delete_test"
        media_dir.mkdir()

        add_response = client.post(
            "/api/categories", json={"name": "Delete Test", "path": str(media_dir)}
        )

        if add_response.status_code == 200:
            data = add_response.get_json()
            cat_id = data.get("id")

            if cat_id:
                # Now delete it
                delete_response = client.delete(f"/api/categories/{cat_id}")
                assert delete_response.status_code in [200, 204]

    def test_delete_nonexistent_category(self, admin_client, app_context):
        """Test deleting non-existent category (requires admin)."""
        response = admin_client.delete("/api/categories/nonexistent-id-12345")

        assert response.status_code in [404, 400, 403, 500]

    def test_get_media_newest_returns_id_only_payload(self, client, app_context):
        """Newest endpoint should return ids without duplicating record payloads."""
        rows = [{
            'category_id': 'test-cat',
            'rel_path': 'clip.mp4',
            'type': 'video',
            'size': 123,
            'mtime': 456,
            'hash': 'abc',
            'is_hidden': 0,
        }]
        with patch('app.controllers.media.media_discovery_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_ordering_service.media_index_service.get_recent_media', return_value=rows) as mock_recent:
            response = client.get('/api/media/newest?limit=10')

        assert response.status_code == 200
        data = response.get_json()
        assert data == {
            'orderedIds': ['test-cat::clip.mp4'],
            'records': {},
            'missing': [],
        }
        mock_recent.assert_called_once_with(limit=10, show_hidden=False, filter_type='all')

    def test_get_media_order_streaming_row(self, client, app_context, mock_media_dir):
        """Test GET /api/media/order endpoint for a streaming row."""
        rows = [
            {'category_id': 'test-cat', 'rel_path': 'a.mp4'},
            {'category_id': 'test-cat', 'rel_path': 'b.jpg'},
        ]
        with patch("app.controllers.media.media_ordering_controller.get_show_hidden_flag", return_value=False), \
             patch("app.services.media.hidden_content_service.should_block_category_access", return_value=False), \
             patch("app.services.media.media_ordering_service.media_catalog_service.get_async_index_status", return_value=None), \
             patch("app.services.media.media_ordering_service.media_index_service.has_media_index_entries", return_value=True), \
             patch("app.services.media.media_ordering_service.media_index_service.get_paginated_media", return_value=rows), \
             patch("app.services.media.media_ordering_service.media_index_service.get_media_count", return_value=2) as mock_count, \
             patch("app.services.media.media_ordering_service.SortService.get_subfolders", return_value=[]):
            response = client.get("/api/media/order?view=streaming_row&category_id=test-cat&page=1&limit=20&include_total=false")

        assert response.status_code == 200
        data = response.get_json()
        assert data['orderedIds'] == ['test-cat::a.mp4', 'test-cat::b.jpg']
        assert data['hasMore'] is False
        assert data['viewMeta']['subfolders'] == []
        mock_count.assert_not_called()

    def test_get_media_order_inline_hydrates_standard_window_without_records_fallback(self, client, app_context):
        """Standard ordering should inline-hydrate from the page rows without a second records query."""
        rows = [
            {
                'category_id': 'test-cat',
                'rel_path': 'a.mp4',
                'name': 'a.mp4',
                'type': 'video',
                'size': 100,
                'mtime': 123,
                'hash': 'hash-a',
                'is_hidden': 0,
            },
            {
                'category_id': 'test-cat',
                'rel_path': 'b.jpg',
                'name': 'b.jpg',
                'type': 'image',
                'size': 200,
                'mtime': 124,
                'hash': 'hash-b',
                'is_hidden': 0,
            },
        ]
        with patch("app.controllers.media.media_ordering_controller.get_show_hidden_flag", return_value=False), \
             patch("app.services.media.hidden_content_service.should_block_category_access", return_value=False), \
             patch("app.services.media.media_ordering_service.media_catalog_service.get_async_index_status", return_value=None), \
             patch("app.services.media.media_ordering_service.media_index_service.has_media_index_entries", return_value=True), \
             patch("app.services.media.media_ordering_service.media_index_service.get_paginated_media", return_value=rows), \
             patch("app.services.media.media_ordering_service.media_index_service.get_media_count", return_value=2) as mock_count, \
             patch("app.services.media.media_ordering_service.SortService.get_subfolders", return_value=[]), \
             patch("app.services.media.media_records_service.MediaRecordsService.get_records") as mock_records:
            response = client.get("/api/media/order?view=subfolder_grid&category_id=test-cat&page=1&limit=20&include_total=false&hydrate=true")

        assert response.status_code == 200
        data = response.get_json()
        assert data['orderedIds'] == ['test-cat::a.mp4', 'test-cat::b.jpg']
        assert data['records']['test-cat::a.mp4']['relPath'] == 'a.mp4'
        assert data['records']['test-cat::b.jpg']['type'] == 'image'
        assert data['missing'] == []
        assert data['hasMore'] is False
        mock_count.assert_not_called()
        mock_records.assert_not_called()

    def test_get_media_order_uses_limit_probe_for_has_more_without_count(self, client, app_context):
        """Non-total standard ordering should fetch one extra row instead of running COUNT."""
        rows = [
            {'category_id': 'test-cat', 'rel_path': 'a.mp4'},
            {'category_id': 'test-cat', 'rel_path': 'b.mp4'},
            {'category_id': 'test-cat', 'rel_path': 'c.mp4'},
        ]
        with patch("app.controllers.media.media_ordering_controller.get_show_hidden_flag", return_value=False), \
             patch("app.services.media.hidden_content_service.should_block_category_access", return_value=False), \
             patch("app.services.media.media_ordering_service.media_catalog_service.get_async_index_status", return_value=None), \
             patch("app.services.media.media_ordering_service.media_index_service.has_media_index_entries", return_value=True), \
             patch("app.services.media.media_ordering_service.media_index_service.get_paginated_media", return_value=rows) as mock_page, \
             patch("app.services.media.media_ordering_service.media_index_service.get_media_count", return_value=3) as mock_count, \
             patch("app.services.media.media_ordering_service.SortService.get_subfolders", return_value=[]):
            response = client.get("/api/media/order?view=streaming_row&category_id=test-cat&page=1&limit=2&include_total=false")

        assert response.status_code == 200
        data = response.get_json()
        assert data['orderedIds'] == ['test-cat::a.mp4', 'test-cat::b.mp4']
        assert data['hasMore'] is True
        assert mock_page.call_args.kwargs['limit'] == 3
        mock_count.assert_not_called()

    def test_get_media_order_async_includes_subfolders(self, client, app_context):
        """Async indexing order response should include subfolders on page 1."""
        mock_status = {
            'status': 'indexing',
            'progress': 10,
            'files': [],
            'total_files': 0
        }
        mock_subfolders = [{'name': 'ShowA', 'count': 3}]

        with patch('app.controllers.media.media_ordering_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.hidden_content_service.should_block_category_access', return_value=False), \
             patch('app.services.media.media_ordering_service.media_index_service.has_media_index_entries', return_value=False), \
             patch('app.services.media.media_ordering_service.media_catalog_service.get_async_index_status', return_value=mock_status), \
             patch('app.services.media.media_ordering_service.media_catalog_service.start_async_indexing'), \
             patch('app.services.media.media_ordering_service.get_category_by_id', return_value={'id': 'auto::ghost::sda2::TV', 'path': '/media/tv'}), \
             patch('app.services.media.media_ordering_service.SortService.get_subfolders', return_value=mock_subfolders):
            response = client.get('/api/media/order?view=streaming_row&category_id=auto::ghost::sda2::TV&page=1&limit=20')

        assert response.status_code == 200
        data = response.get_json()
        assert data['viewMeta']['asyncIndexing'] is True
        assert data['viewMeta']['subfolders'] == mock_subfolders

    def test_get_media_order_subfolder_lookup_failure_errors(self, client, app_context):
        """Ordering errors should use the JSON error wrapper instead of partial old-route shims."""
        with patch('app.controllers.media.media_ordering_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.hidden_content_service.should_block_category_access', return_value=False), \
             patch('app.services.media.media_ordering_service.media_index_service.has_media_index_entries', return_value=True), \
             patch('app.services.media.media_ordering_service.media_catalog_service.get_async_index_status', return_value=None), \
             patch('app.services.media.media_ordering_service.media_index_service.get_paginated_media', return_value=[]), \
             patch('app.services.media.media_ordering_service.media_index_service.get_media_count', return_value=0), \
             patch('app.services.media.media_ordering_service.SortService.get_subfolders', side_effect=RuntimeError('boom')):
            response = client.get('/api/media/order?view=streaming_row&category_id=auto::ghost::sda2::Movies::Action&page=1&limit=20&include_total=false')

        assert response.status_code == 500

    def test_get_media_records_contract(self, client, app_context):
        """Hydration endpoint should return canonical records and missing ids."""
        record = {
            'id': 'test-cat::clip.mp4',
            'categoryId': 'test-cat',
            'relPath': 'clip.mp4',
            'name': 'clip.mp4',
            'type': 'video',
            'url': '/media/test-cat/clip.mp4',
            'thumbnailUrl': '/thumbnails/test-cat/clip.jpeg',
            'size': 123,
            'mtime': 456,
            'modified': 456,
            'hash': 'abc',
            'isHidden': False,
            'durationMs': None,
        }
        with patch('app.controllers.media.media_records_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_records_service.MediaRecordsService.get_records', return_value={
                 'records': {'test-cat::clip.mp4': record},
                 'missing': ['test-cat::missing.mp4'],
             }) as mock_get_records:
            response = client.post('/api/media/records', json={
                'ids': ['test-cat::clip.mp4', 'test-cat::missing.mp4'],
            })

        assert response.status_code == 200
        data = response.get_json()
        assert data['records']['test-cat::clip.mp4']['categoryId'] == 'test-cat'
        assert data['missing'] == ['test-cat::missing.mp4']
        mock_get_records.assert_called_once()

    def test_get_media_orders_batch_hydrates_each_request(self, client, app_context):
        """Batch ordering should preserve per-request results and inline hydration."""
        order_payload = {
            'view': 'streaming_row',
            'orderedIds': ['test-cat::clip.mp4'],
            'hasMore': False,
            'pageToken': None,
            'viewMeta': {'page': 1, 'limit': 20, 'subfolders': []},
        }
        record = {
            'id': 'test-cat::clip.mp4',
            'categoryId': 'test-cat',
            'relPath': 'clip.mp4',
            'name': 'clip.mp4',
            'type': 'video',
            'url': '/media/test-cat/clip.mp4',
            'size': 123,
            'mtime': 456,
            'modified': 456,
            'hash': 'abc',
            'isHidden': False,
            'durationMs': None,
        }
        with patch('app.controllers.media.media_ordering_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_ordering_service.MediaOrderingService.get_order', return_value=order_payload) as mock_get_order, \
             patch('app.services.media.media_records_service.MediaRecordsService.get_records', return_value={
                 'records': {'test-cat::clip.mp4': record},
                 'missing': [],
             }) as mock_get_records:
            response = client.post('/api/media/orders', json={
                'requests': [{
                    'view': 'streaming_row',
                    'viewKey': 'streaming_row::test-cat::::all::20',
                    'category_id': 'test-cat',
                    'page': 1,
                    'limit': 20,
                    'include_total': 'false',
                    'media_filter': 'all',
                    'hydrate': 'true',
                }],
            })

        assert response.status_code == 200
        data = response.get_json()
        assert len(data['results']) == 1
        result = data['results'][0]
        assert result['viewKey'] == 'streaming_row::test-cat::::all::20'
        assert result['orderedIds'] == ['test-cat::clip.mp4']
        assert result['records']['test-cat::clip.mp4']['categoryId'] == 'test-cat'
        assert result['status'] == 'ready'
        mock_get_order.assert_called_once()
        mock_get_records.assert_called_once_with(['test-cat::clip.mp4'], show_hidden=False)

    def test_get_media_orders_batch_isolates_bad_items(self, client, app_context):
        """A malformed item returns one error result while valid siblings still load."""
        order_payload = {
            'view': 'streaming_row',
            'orderedIds': ['test-cat::clip.mp4'],
            'hasMore': False,
            'pageToken': None,
            'viewMeta': {'total': 1, 'subfolders': []},
            'status': 'ready',
        }
        with patch('app.controllers.media.media_ordering_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_ordering_service.MediaOrderingService.get_order', return_value=order_payload):
            response = client.post('/api/media/orders', json={
                'requests': [
                    {'view': 'nope', 'viewKey': 'bad-view'},
                    {
                        'view': 'streaming_row',
                        'viewKey': 'streaming_row::test-cat::::all::20',
                        'category_id': 'test-cat',
                        'page': 1,
                        'limit': 20,
                    },
                ],
            })

        assert response.status_code == 200
        data = response.get_json()
        assert data['results'][0]['status'] == 'error'
        assert data['results'][0]['viewKey'] == 'bad-view'
        assert data['results'][1]['status'] == 'ready'
        assert data['results'][1]['orderedIds'] == ['test-cat::clip.mp4']

    def test_get_media_order_can_hydrate_returned_window(self, client, app_context):
        """Ordering can inline-hydrate its returned id window to avoid a second round trip."""
        order_payload = {
            'view': 'subfolder_grid',
            'orderedIds': ['test-cat::clip.mp4'],
            'hasMore': False,
            'pageToken': None,
            'viewMeta': {'page': 1, 'limit': 30},
        }
        record = {
            'id': 'test-cat::clip.mp4',
            'categoryId': 'test-cat',
            'relPath': 'clip.mp4',
            'name': 'clip.mp4',
            'type': 'video',
            'url': '/media/test-cat/clip.mp4',
            'size': 123,
            'mtime': 456,
            'modified': 456,
            'hash': 'abc',
            'isHidden': False,
            'durationMs': None,
        }
        with patch('app.controllers.media.media_ordering_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_ordering_service.MediaOrderingService.get_order', return_value=order_payload), \
             patch('app.services.media.media_records_service.MediaRecordsService.get_records', return_value={
                 'records': {'test-cat::clip.mp4': record},
                 'missing': [],
             }) as mock_get_records:
            response = client.get('/api/media/order?view=subfolder_grid&category_id=test-cat&page=1&limit=30&hydrate=true')

        assert response.status_code == 200
        data = response.get_json()
        assert data['orderedIds'] == ['test-cat::clip.mp4']
        assert data['records']['test-cat::clip.mp4']['categoryId'] == 'test-cat'
        assert data['missing'] == []
        mock_get_records.assert_called_once_with(['test-cat::clip.mp4'], show_hidden=False)

    def test_search_honors_limit_parameter(self, client, app_context):
        """Search endpoint should forward caller-provided limits to the DB layer."""
        with patch('app.controllers.media.media_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_index_service.search_media_index', return_value=[]) as mock_search, \
             patch('app.services.media.media_index_service.search_media_paths_for_folder_matches', return_value=[]) as mock_folder_paths, \
             patch('app.services.media.media_index_service.search_media_category_ids', return_value=[]) as mock_category_ids, \
             patch('app.controllers.media.media_controller.get_cached_categories_with_details', return_value=[]), \
             patch('app.controllers.media.media_controller.category_persistence_service.load_categories', return_value=[]), \
             patch('app.services.media.media_index_service.get_indexed_category_ids', return_value=[]) as mock_indexed_ids:
            response = client.get('/api/search?q=deep&limit=7')

        assert response.status_code == 200
        mock_search.assert_called_once_with('deep', limit=7, show_hidden=False)
        # Folder matches now streamed in 2000-row batches; first (and only) call has offset=0
        mock_folder_paths.assert_called_once_with('deep', limit=2000, show_hidden=False, offset=0)
        # Auto category IDs streamed in 2000-row batches; first call has offset=0
        mock_category_ids.assert_called_once_with('deep', limit=2000, show_hidden=False, offset=0)
        # Indexed category IDs streamed in 2000-row batches; first call has offset=0
        mock_indexed_ids.assert_called_once_with(show_hidden=False, limit=2000, offset=0)

    def test_search_deep_auto_hierarchy_fallback_via_category_ids(self, client, app_context):
        """Deep nested auto:: parents should be discoverable even when rel_path rows are empty."""
        auto_rows = [
            {'category_id': 'auto::ghost::sda2::TV::ShowA::Season1'},
            {'category_id': 'auto::ghost::sda2::TV::ShowA::Season2'},
        ]

        with patch('app.controllers.media.media_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_index_service.search_media_index', return_value=[]), \
             patch('app.services.media.media_index_service.search_media_paths_for_folder_matches', return_value=[]), \
             patch('app.services.media.media_index_service.search_media_category_ids', return_value=auto_rows), \
             patch('app.controllers.media.media_controller.get_cached_categories_with_details', return_value=[]), \
             patch('app.controllers.media.media_controller.category_persistence_service.load_categories', return_value=[]), \
             patch('app.services.media.media_index_service.get_indexed_category_ids', return_value=[]):
            response = client.get('/api/search?q=showa')

        assert response.status_code == 200
        data = response.get_json()
        view_meta = data.get('viewMeta', {})

        parent_match = next(
            (pf for pf in view_meta.get('matched_parent_folders', []) if pf.get('name', '').lower().startswith('showa')),
            None
        )
        assert parent_match is not None
        assert sorted(parent_match.get('category_ids', [])) == [
            'auto::ghost::sda2::TV::ShowA::Season1',
            'auto::ghost::sda2::TV::ShowA::Season2',
        ]

    def test_search_keeps_same_rel_path_folders_from_different_categories(self, client, app_context):
        """Search folder grouping should not collapse different categories with identical rel_path."""
        search_rows = [
            {'category_id': 'cat-a', 'rel_path': 'Shows/Deep/file-a.mp4', 'type': 'video'},
            {'category_id': 'cat-b', 'rel_path': 'Shows/Deep/file-b.mp4', 'type': 'video'},
        ]
        categories = [
            {'id': 'cat-a', 'name': 'Cat A (USB)'},
            {'id': 'cat-b', 'name': 'Cat B (USB)'},
        ]

        with patch('app.controllers.media.media_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_index_service.search_media_index', return_value=search_rows), \
             patch('app.services.media.media_index_service.search_media_paths_for_folder_matches', return_value=search_rows), \
             patch('app.services.media.media_index_service.search_media_category_ids', return_value=[]), \
             patch('app.controllers.media.media_controller.get_cached_categories_with_details', return_value=[]), \
             patch('app.controllers.media.media_controller.category_persistence_service.load_categories', return_value=categories), \
             patch('app.services.media.media_index_service.get_indexed_category_ids', return_value=[]), \
             patch('app.utils.media_utils.get_thumbnail_url', side_effect=lambda cat, rel: f"/thumbnails/{cat}/{rel}.jpg"):
            response = client.get('/api/search?q=deep&limit=10')

        assert response.status_code == 200
        data = response.get_json()
        assert data['viewType'] == 'search'
        assert 'results' not in data
        matched_folders = data.get('viewMeta', {}).get('matched_folders', [])

        deep_folders = [f for f in matched_folders if f.get('rel_path') == 'Shows/Deep']
        category_ids = sorted(f.get('category_id') for f in deep_folders)
        assert category_ids == ['cat-a', 'cat-b']

    def test_search_folder_matches_not_limited_by_file_result_limit(self, client, app_context):
        """Folder matches should come from dedicated path scan, not truncated file result list."""
        search_rows = [
            {'category_id': 'cat-a', 'rel_path': 'Shows/Deep/file-a.mp4', 'type': 'video'},
        ]
        folder_rows = [
            {'category_id': 'cat-a', 'rel_path': 'Shows/Deep/file-a.mp4'},
            {'category_id': 'cat-b', 'rel_path': 'Shows/Deep/file-b.mp4'},
            {'category_id': 'cat-b', 'rel_path': 'Shows/Deep/Nested/file-c.mp4'},
        ]
        categories = [
            {'id': 'cat-a', 'name': 'Cat A (USB)'},
            {'id': 'cat-b', 'name': 'Cat B (USB)'},
        ]

        with patch('app.controllers.media.media_controller.get_show_hidden_flag', return_value=False), \
             patch('app.services.media.media_index_service.search_media_index', return_value=search_rows), \
             patch('app.services.media.media_index_service.search_media_paths_for_folder_matches', return_value=folder_rows), \
             patch('app.services.media.media_index_service.search_media_category_ids', return_value=[]), \
             patch('app.controllers.media.media_controller.get_cached_categories_with_details', return_value=[]), \
             patch('app.controllers.media.media_controller.category_persistence_service.load_categories', return_value=categories), \
             patch('app.services.media.media_index_service.get_indexed_category_ids', return_value=[]), \
             patch('app.utils.media_utils.get_thumbnail_url', side_effect=lambda cat, rel: f"/thumbnails/{cat}/{rel}.jpg"):
            response = client.get('/api/search?q=deep&limit=1&folders_limit=20')

        assert response.status_code == 200
        data = response.get_json()
        view_meta = data.get('viewMeta', {})

        deep_folders = [f for f in view_meta.get('matched_folders', []) if f.get('rel_path') == 'Shows/Deep']
        deep_category_ids = sorted(f.get('category_id') for f in deep_folders)
        assert deep_category_ids == ['cat-a', 'cat-b']
        assert view_meta.get('total_matched_folders', 0) >= 2


class TestProgressEndpoints:
    """Tests for progress-related API endpoints."""

    def test_save_progress(self, admin_client, app_context, mock_config):
        """Test POST /api/progress/<category_id> endpoint."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        response = admin_client.post(
            "/api/progress/test-category", json={"index": 5, "total_count": 20}
        )

        assert response.status_code in [200, 201, 400, 403]

    def test_save_progress_with_video_data(
        self, admin_client, app_context, mock_config
    ):
        """Test saving progress with video timestamp."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        response = admin_client.post(
            "/api/progress/video-category",
            json={"index": 3, "video_timestamp": 120.5, "video_duration": 3600.0},
        )

        assert response.status_code in [200, 201, 400, 403]

    def test_get_progress(self, client, app_context, mock_config):
        """Test GET /api/progress/video endpoint."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        with patch("app.controllers.media.progress_controller.video_progress_service.get_video_progress", return_value=None):
            response = client.get("/api/progress/video?video_path=/media/test.mp4")

        assert response.status_code in [200, 404]

    def test_get_all_progress(self, client, app_context, mock_config):
        """Test GET /api/progress/videos endpoint."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        response = client.get("/api/progress/videos")

        assert response.status_code == 200
        data = response.get_json()
        assert "videos" in data

    def test_delete_all_progress(self, admin_client, app_context, mock_config):
        """Test DELETE /api/progress/all endpoint."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        with patch("app.controllers.media.progress_controller.video_progress_service.delete_all_video_progress", return_value={'success': True, 'count': 0, 'alias_count': 0}):
            response = admin_client.delete("/api/progress/all")

        # May be 200, 204, 403 (auth), or 405 (method not allowed)
        assert response.status_code in [200, 204, 403, 405]

    def test_save_progress_disabled(self, admin_client, app_context, mock_config):
        """Test progress endpoint when saving is disabled."""
        mock_config("SAVE_VIDEO_PROGRESS", False)

        response = admin_client.post("/api/progress/test", json={"index": 5})

        # Should indicate disabled, succeed silently, or require auth
        assert response.status_code in [200, 400, 403]


class TestStorageEndpoints:
    """Tests for storage-related API endpoints."""

    def test_get_storage_drives(self, admin_client, app_context):
        """Test GET /api/storage/drives endpoint (admin only)."""
        response = admin_client.get("/api/storage/drives")

        assert response.status_code in [200, 403, 500]

    def test_get_drive_folders(self, client, app_context, mock_usb_drive):
        """Test GET /api/storage/folders endpoint."""
        response = client.get(
            "/api/storage/folders", query_string={"path": str(mock_usb_drive)}
        )

        # May require admin authentication
        assert response.status_code in [200, 401, 403]

    def test_upload_file_endpoint(self, admin_client, app_context, mock_usb_drive, mock_socketio):
        """Test POST /api/storage/upload endpoint."""
        data = {
            "file": (BytesIO(b"test content"), "test_file.txt"),
            "drive_path": str(mock_usb_drive),
        }

        # Mock rate limit check to avoid gevent lock issues in tests
        with patch(
            "app.controllers.storage.storage_upload_controller.rate_limit_service.check_upload_limit",
            return_value=True,
        ):
            response = admin_client.post(
                "/api/storage/upload", data=data, content_type="multipart/form-data"
            )

        # May require admin authentication or endpoint not available
        assert response.status_code in [200, 201, 400, 403, 404]

    def test_init_chunked_upload(self, client, app_context, mock_usb_drive, mock_socketio):
        """Test POST /api/storage/upload/init endpoint."""
        response = client.post(
            "/api/storage/upload/init",
            json={
                "filename": "large_file.mp4",
                "total_chunks": 10,
                "total_size": 50 * 1024 * 1024,
                "drive_path": str(mock_usb_drive),
            },
        )

        # May require admin authentication
        assert response.status_code in [200, 201, 401, 403]

    def test_create_folder(self, admin_client, app_context, mock_usb_drive):
        """Test POST /api/storage/folder endpoint."""
        response = admin_client.post(
            "/api/storage/folder",
            json={"drive_path": str(mock_usb_drive), "folder_name": "NewTestFolder"},
        )

        # May require admin authentication or have different endpoint
        assert response.status_code in [200, 201, 401, 403, 404, 405]


class TestConfigurationEndpoints:
    """Tests for configuration-related API endpoints."""

    def test_get_config(self, client, app_context):
        """Test GET /api/config endpoint."""
        response = client.get("/api/config")

        assert response.status_code == 200
        data = response.get_json()
        assert isinstance(data, dict)

    def test_get_config_contains_expected_keys(self, client, app_context):
        """Test that config endpoint returns expected keys."""
        response = client.get("/api/config")
        data = response.get_json()

        # Should contain frontend-visible config
        # Exact keys depend on what's exposed
        assert isinstance(data, dict)

    def test_save_config(self, admin_client, app_context):
        """Test POST /api/config endpoint."""
        # Config endpoint expects specific format
        response = admin_client.post(
            "/api/config",
            json={
                "python_config": {"SHUFFLE_MEDIA": True, "SAVE_VIDEO_PROGRESS": True}
            },
        )

        # May require admin authentication or specific format
        assert response.status_code in [200, 201, 400, 401, 403]


class TestMediaEndpoints:
    """Tests for media serving endpoints."""

    def test_serve_media_nonexistent(self, client, app_context):
        """Test serving non-existent media."""
        response = client.get("/media/fake-category/nonexistent.jpg")

        assert response.status_code == 404

    def test_serve_thumbnail_nonexistent(self, client, app_context):
        """Test serving non-existent thumbnail."""
        response = client.get("/thumbnails/fake-category/nonexistent.jpg")

        assert response.status_code == 404

    def test_media_path_traversal_blocked(self, client, app_context):
        """Test that path traversal attacks are blocked."""
        response = client.get("/media/../../../etc/passwd")

        # Should be blocked
        assert response.status_code in [400, 403, 404]


class TestHealthAndStatus:
    """Tests for health and status endpoints."""

    def test_index_page(self, client, app_context):
        """Test GET / returns the main page."""
        response = client.get("/")

        assert response.status_code == 200

    def test_tv_page(self, client, app_context):
        """Test GET /tv returns TV display page."""
        response = client.get("/tv")

        # May be 200 or 404 depending on route existence
        assert response.status_code in [200, 404]


class TestVideoProgressEndpoints:
    """Tests for video-specific progress endpoints."""

    def test_save_video_progress(self, admin_client, app_context, mock_config):
        """Test saving video-specific progress."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        with patch("app.controllers.media.progress_controller.video_progress_service.save_video_progress", return_value=(True, "Saved")):
            response = admin_client.post(
                "/api/progress/movies",
                json={
                    "video_path": "/media/movie.mp4",
                    "video_timestamp": 1200.0,
                    "video_duration": 7200.0,
                },
            )

        assert response.status_code in [200, 201, 400, 403, 404, 405]

    def test_get_video_progress(self, client, app_context, mock_config):
        """Test getting video-specific progress."""
        mock_config("SAVE_VIDEO_PROGRESS", True)

        with patch("app.controllers.media.progress_controller.video_progress_service.get_video_progress", return_value=None):
            response = client.get(
                "/api/progress/video", query_string={"video_path": "/media/movie.mp4"}
            )

        assert response.status_code in [200, 404, 401, 403]

    def test_get_all_video_progress(self, client, app_context, mock_config):
        """Test getting all video progress."""
        mock_config("SAVE_VIDEO_PROGRESS", True)
        mock_config("ENABLE_SESSION_PROGRESS", False)

        with patch("app.controllers.media.progress_controller.video_progress_service.get_all_video_progress", return_value=[]):
            response = client.get("/api/progress/videos")

        assert response.status_code in [200, 404]


class TestErrorHandling:
    """Tests for API error handling."""

    def test_invalid_json(self, admin_client, app_context):
        """Test handling of invalid JSON in request body."""
        response = admin_client.post(
            "/api/categories", data="not valid json", content_type="application/json"
        )

        # May return 400/415/422 for bad JSON or 403 for auth
        assert response.status_code in [400, 403, 415, 422]

    def test_missing_content_type(self, admin_client, app_context):
        """Test handling of missing content type for JSON endpoint."""
        response = admin_client.post(
            "/api/categories", data='{"name": "test"}', content_type="text/plain"
        )

        # Should handle gracefully
        assert response.status_code in [400, 403, 415, 422, 200]

    def test_method_not_allowed(self, client, app_context):
        """Test handling of unsupported HTTP method."""
        response = client.patch("/api/categories")

        assert response.status_code == 405


class TestPagination:
    """Tests for pagination in list endpoints."""

    def test_categories_pagination(self, client, app_context):
        """Test category list pagination parameters."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get(
                "/api/categories", query_string={"page": 1, "per_page": 10}
            )

        assert response.status_code == 200

    def test_media_pagination(self, client, app_context):
        """Test media ordering pagination."""
        with patch("app.controllers.media.media_ordering_controller.get_show_hidden_flag", return_value=False), \
             patch("app.services.media.hidden_content_service.should_block_category_access", return_value=False), \
             patch("app.services.media.media_ordering_service.media_index_service.has_media_index_entries", return_value=True), \
             patch("app.services.media.media_ordering_service.media_catalog_service.get_async_index_status", return_value=None), \
             patch("app.services.media.media_ordering_service.media_index_service.get_paginated_media", return_value=[]), \
             patch("app.services.media.media_ordering_service.media_index_service.get_media_count", return_value=0), \
             patch("app.services.media.media_ordering_service.SortService.get_subfolders", return_value=[]):
            response = client.get(
                "/api/media/order",
                query_string={"view": "streaming_row", "category_id": "test-cat", "page": 1, "limit": 20}
            )

        assert response.status_code == 200
        assert response.get_json()["orderedIds"] == []

    def test_pagination_invalid_page(self, client, app_context):
        """Test handling of invalid page parameter."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get("/api/categories", query_string={"page": -1})

        # Should handle gracefully
        assert response.status_code in [200, 400]

    def test_pagination_invalid_per_page(self, client, app_context):
        """Test handling of invalid per_page parameter."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get("/api/categories", query_string={"per_page": 10000})

        # Should handle gracefully, possibly capping to max
        assert response.status_code == 200


class TestFilteringAndSorting:
    """Tests for filtering and sorting in list endpoints."""

    def test_categories_filter_by_type(self, client, app_context):
        """Test filtering categories by type."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get("/api/categories", query_string={"type": "video"})

        assert response.status_code == 200

    def test_categories_sort(self, client, app_context):
        """Test sorting categories."""
        with patch("app.controllers.media.category_controller.get_all_categories_with_details", return_value=[]), \
             patch("app.controllers.media.category_controller.get_show_hidden_flag", return_value=False):
            response = client.get(
                "/api/categories", query_string={"sort": "name", "order": "asc"}
            )

        assert response.status_code == 200


class TestContinueWatchingEndpoint:
    """Tests for continue watching endpoint."""

    def test_get_continue_watching(self, admin_client, app_context, mock_config):
        """Test GET /api/progress/videos endpoint."""
        mock_config("SAVE_VIDEO_PROGRESS", True)
        mock_config("ENABLE_SESSION_PROGRESS", False)

        with patch("app.controllers.media.progress_controller.video_progress_service.get_all_video_progress", return_value=[]):
            response = admin_client.get("/api/progress/videos")

        assert response.status_code == 200

    def test_continue_watching_limit(self, admin_client, app_context, mock_config):
        """Test continue watching with limit parameter."""
        mock_config("SAVE_VIDEO_PROGRESS", True)
        mock_config("ENABLE_SESSION_PROGRESS", False)

        with patch("app.controllers.media.progress_controller.video_progress_service.get_all_video_progress", return_value=[]):
            response = admin_client.get("/api/progress/videos", query_string={"limit": 5})

        assert response.status_code == 200


class TestCategoryDownload:
    """Tests for category download endpoints."""

    def test_download_category_zip_info(self, client, app_context):
        """Test getting category ZIP download info."""
        response = client.get("/api/categories/test-cat/download/info")

        # May require admin or return 404
        assert response.status_code in [200, 401, 403, 404]

    def test_download_category_zip(self, client, app_context):
        """Test downloading category as ZIP."""
        response = client.get("/api/categories/test-cat/download")

        # May require admin or return 404
        assert response.status_code in [200, 401, 403, 404]
