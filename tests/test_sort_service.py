"""
Tests for SortService - backend sorting and pagination logic
"""

import pytest
from unittest.mock import patch, MagicMock
import os


class TestExtractSeasonEpisode:
    """Tests for _extract_season_episode function"""

    def test_extracts_s_e_format(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode(
            "series/Season 1/episode 5.mp4"
        )
        assert season == 1
        assert episode == 5

    def test_extracts_s05e08_format(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("Show.S05E08.Title.mkv")
        assert season == 5
        assert episode == 8

    def test_extracts_1x10_format(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("Anime 1x10 episode.mkv")
        assert season == 1
        assert episode == 10

    def test_extracts_season_from_folder(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("Season 3/video.mp4")
        assert season == 3
        assert episode is None

    def test_handles_none_input(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode(None)
        assert season is None
        assert episode is None

    def test_handles_empty_string(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("")
        assert season is None
        assert episode is None

    def test_extracts_leading_number_as_episode(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("Season 1/7 title.mp4")
        assert season == 1
        assert episode == 7

    def test_falls_back_to_episode_1_for_seasonless_episodes(self, app_context):
        from app.services.media.sort_service import SortService

        season, episode = SortService._extract_season_episode("standalone ep 5.mkv")
        assert season == 1
        assert episode == 5


class TestTvSortKey:
    """Tests for _tv_sort_key function"""

    def test_sorts_standard_episodes_correctly(self, app_context):
        from app.services.media.sort_service import SortService

        items = [
            {"rel_path": "Season 1/S01E03.mp4"},
            {"rel_path": "Season 1/S01E01.mp4"},
            {"rel_path": "Season 1/S01E02.mp4"},
        ]
        sorted_items = sorted(items, key=SortService._tv_sort_key)
        assert sorted_items[0]["rel_path"] == "Season 1/S01E01.mp4"
        assert sorted_items[1]["rel_path"] == "Season 1/S01E02.mp4"
        assert sorted_items[2]["rel_path"] == "Season 1/S01E03.mp4"

    def test_sorts_across_seasons(self, app_context):
        from app.services.media.sort_service import SortService

        items = [
            {"rel_path": "Season 2/S02E01.mp4"},
            {"rel_path": "Season 1/S01E10.mp4"},
        ]
        sorted_items = sorted(items, key=SortService._tv_sort_key)
        assert sorted_items[0]["rel_path"] == "Season 1/S01E10.mp4"
        assert sorted_items[1]["rel_path"] == "Season 2/S02E01.mp4"

    def test_unknown_seasons_sorted_last(self, app_context):
        from app.services.media.sort_service import SortService

        items = [
            {"rel_path": "movie.mkv"},
            {"rel_path": "Season 1/S01E01.mp4"},
        ]
        sorted_items = sorted(items, key=SortService._tv_sort_key)
        assert sorted_items[0]["rel_path"] == "Season 1/S01E01.mp4"
        assert sorted_items[1]["rel_path"] == "movie.mkv"


class TestPaginateItems:
    """Tests for _paginate_items function"""

    def test_returns_correct_page_slice(self, app_context):
        from app.services.media.sort_service import SortService

        items = list(range(100))
        result = SortService._paginate_items(items, page=2, limit=10)
        assert len(result) == 10
        assert result[0] == 10
        assert result[-1] == 19

    def test_handles_last_page_correctly(self, app_context):
        from app.services.media.sort_service import SortService

        items = list(range(25))
        result = SortService._paginate_items(items, page=3, limit=10)
        assert len(result) == 5
        assert result[0] == 20
        assert result[-1] == 24

    def test_handles_page_beyond_range(self, app_context):
        from app.services.media.sort_service import SortService

        items = list(range(10))
        result = SortService._paginate_items(items, page=5, limit=10)
        assert result == []

    def test_handles_empty_list(self, app_context):
        from app.services.media.sort_service import SortService

        result = SortService._paginate_items([], page=1, limit=10)
        assert result == []


class TestIsTvCategory:
    """Tests for _is_tv_category function"""

    def test_detects_tv_in_name(self, app_context, app):
        from app.services.media.sort_service import SortService

        with patch(
            "app.services.media.category_query_service.get_category_by_id",
            return_value={"name": "TV Shows", "path": "/tv"},
        ):
            result = SortService._is_tv_category(1)
            assert result is True

    def test_detects_anime_in_name(self, app_context, app):
        from app.services.media.sort_service import SortService

        with patch(
            "app.services.media.category_query_service.get_category_by_id",
            return_value={"name": "Anime", "path": "/anime"},
        ):
            result = SortService._is_tv_category(2)
            assert result is True


    def test_rejects_non_tv_category(self, app_context, app):
        from app.services.media.sort_service import SortService

        with patch(
            "app.services.media.category_query_service.get_category_by_id",
            return_value={"name": "Vacation Photos", "path": "/photos"},
        ):
            result = SortService._is_tv_category(3)
            assert result is False

    def test_handles_none_category(self, app_context):
        from app.services.media.sort_service import SortService

        result = SortService._is_tv_category(None)
        assert result is False

    def test_respects_config_disabled(self, app_context, mock_config):
        from app.services.media.sort_service import SortService

        mock_config("ENABLE_TV_SORTING", False)
        with patch(
            "app.services.media.category_query_service.get_category_by_id",
            return_value={"name": "TV Shows", "path": "/tv"},
        ):
            result = SortService._is_tv_category(1)
            assert result is False


class TestIsTvSortEnabled:
    """Tests for _is_tv_sort_enabled function"""

    def test_returns_true_for_tv_sort(self, app_context, mock_config):
        from app.services.media.sort_service import SortService

        mock_config("ENABLE_TV_SORTING", True)
        result = SortService._is_tv_sort_enabled("tv")
        assert result is True

    def test_returns_false_for_non_tv_sort(self, app_context):
        from app.services.media.sort_service import SortService

        result = SortService._is_tv_sort_enabled("name")
        assert result is False

    def test_respects_config_disabled(self, app_context, mock_config):
        from app.services.media.sort_service import SortService

        mock_config("ENABLE_TV_SORTING", False)
        result = SortService._is_tv_sort_enabled("tv")
        assert result is False


class TestGetTotalCount:
    """Tests for get_total_count function"""

    def test_returns_count_from_db(self, app_context):
        from app.services.media.sort_service import SortService

        with patch(
            "app.services.media.media_index_service.get_media_count", return_value=42
        ):
            result = SortService.get_total_count(category_id=1, filter_type="all")
            assert result == 42

    def test_handles_no_category(self, app_context):
        from app.services.media.sort_service import SortService

        with patch(
            "app.services.media.media_index_service.get_media_count", return_value=100
        ):
            result = SortService.get_total_count()
            assert result == 100



class TestSortOrderReversal:
    """Tests for sort order handling"""

    def test_desc_order_reverses_sorted_list(self, app_context):
        from app.services.media.sort_service import SortService

        items = [
            {"rel_path": "Season 1/S01E03.mp4"},
            {"rel_path": "Season 1/S01E01.mp4"},
            {"rel_path": "Season 1/S01E02.mp4"},
        ]
        sorted_items = sorted(items, key=SortService._tv_sort_key)
        reversed_items = list(reversed(sorted_items))
        assert reversed_items[0]["rel_path"] == "Season 1/S01E03.mp4"


class TestShuffleCompatibility:
    """Regression tests for shuffle order compatibility."""

    def test_media_ordering_prefers_shuffle_over_auto_tv_sort(self, app_context, mock_config):
        from app.services.media.media_ordering_service import MediaOrderingService
        from app.services.media.sort_service import SortService

        mock_config("SHUFFLE_MEDIA", True)
        mock_config("ENABLE_TV_SORTING", True)

        with patch(
            "app.services.media.media_catalog_service.ensure_category_indexed",
            return_value=None,
        ), patch.object(
            SortService,
            "_is_tv_category",
            return_value=True,
        ), patch.object(
            SortService,
            "_sort_shuffle",
            return_value=[{"categoryId": "auto::ghost::sda2::anime", "name": "shuffle-hit.mp4"}],
        ) as mock_shuffle, patch.object(
            SortService,
            "_sort_tv",
            return_value=[{"categoryId": "auto::ghost::sda2::anime", "name": "tv-hit.mp4"}],
        ) as mock_tv:
            result = MediaOrderingService().get_order(
                "streaming_row",
                {
                    "category_id": "auto::ghost::sda2::anime",
                    "sort_by": "name",
                    "page": 1,
                    "limit": 50,
                    "include_total": "false",
                },
                show_hidden=False,
            )

        assert result["orderedIds"] == ["auto::ghost::sda2::anime::shuffle-hit.mp4"]
        assert mock_shuffle.called
        assert not mock_tv.called


    def test_shared_shuffle_order_changes_when_file_basis_changes(self, app_context):
        from app.services.media.sort_service import SortService
        # ... remaining shuffle tests ...

    def test_sort_shuffle_fetches_page_metadata_when_all_items_are_rel_path_only(self, app_context):
        from app.services.media.sort_service import SortService

        rel_path_only_rows = [
            {"rel_path": "movie-a.mp4"},
            {"rel_path": "movie-b.mp4"},
            {"rel_path": "movie-c.mp4"},
        ]
        page_rows = [{"name": "movie-b.mp4"}]

        with patch.object(
            SortService,
            "_fetch_all_items",
            return_value=rel_path_only_rows,
        ), patch.object(
            SortService,
            "_build_shared_shuffle_order",
            return_value=["movie-c.mp4", "movie-b.mp4", "movie-a.mp4"],
        ), patch.object(
            SortService,
            "get_media_by_filenames",
            return_value=page_rows,
        ) as mock_get_page_rows:
            result = SortService._sort_shuffle(
                category_id="auto::ghost::sda2::Movies::Action",
                subfolder=None,
                filter_type="all",
                show_hidden=False,
                page=1,
                limit=1,
            )

        assert result == page_rows
        mock_get_page_rows.assert_called_once_with(
            "auto::ghost::sda2::Movies::Action",
            ["movie-c.mp4"],
        )


class TestAutoSubfolderFallback:
    """Tests for auto-category subfolder fallback when index is cold."""

    def test_get_subfolders_uses_indexed_auto_aggregation(self, app_context):
        from app.services.media.sort_service import SortService

        indexed_rows = [
            {
                "sub_name": "ShowA",
                "count": 12,
                "video_count": 10,
                "image_pick": "poster.jpg\x1fauto::ghost::sda2::TV::ShowA\x1fPoster.jpg",
                "video_pick": "episode01.mkv\x1fauto::ghost::sda2::TV::ShowA\x1fEpisode01.mkv",
            },
            {
                "sub_name": "ShowB",
                "count": 7,
                "video_count": 7,
                "image_pick": None,
                "video_pick": "episode01.mkv\x1fauto::ghost::sda2::TV::ShowB\x1fEpisode01.mkv",
            },
        ]

        fake_conn = MagicMock()
        fake_conn.execute.return_value.fetchall.return_value = indexed_rows
        fake_db_ctx = MagicMock()
        fake_db_ctx.__enter__.return_value = fake_conn
        fake_db_ctx.__exit__.return_value = None

        with patch(
            "app.services.media.media_index_service.get_db",
            return_value=fake_db_ctx,
        ), patch(
            "app.services.media.media_catalog_service.ensure_category_indexed",
            return_value=None,
        ), patch(
            "app.services.media.sort_service.should_block_category_access",
            return_value=False,
        ), patch(
            "app.services.media.sort_service.get_thumbnail_url",
            side_effect=lambda cat, rel: f"/thumbnails/{cat}/{rel}.jpg",
        ):

            subfolders = SortService.get_subfolders("auto::ghost::sda2::TV")

        names = [sf["name"] for sf in subfolders]
        assert names == ["ShowA", "ShowB"]
        assert subfolders[0]["count"] == 12
        assert subfolders[0]["thumbnail_url"] == "/media/auto::ghost::sda2::TV::ShowA/Poster.jpg"
        assert subfolders[0]["first_file"] == "Poster.jpg"
        assert subfolders[1]["contains_video"] is True
        assert subfolders[1]["first_file"] == "Episode01.mkv"

    def test_get_subfolders_falls_back_to_category_hierarchy(self, app_context):
        from app.services.media.sort_service import SortService

        fake_conn = MagicMock()
        fake_conn.execute.return_value.fetchall.return_value = []
        fake_db_ctx = MagicMock()
        fake_db_ctx.__enter__.return_value = fake_conn
        fake_db_ctx.__exit__.return_value = None

        categories = [
            {
                "id": "auto::ghost::sda2::TV::ShowA",
                "mediaCount": 12,
                "containsVideo": True,
                "thumbnailUrl": "/media/auto::ghost::sda2::TV::ShowA/ep1.jpg",
            },
            {
                "id": "auto::ghost::sda2::TV::ShowB",
                "mediaCount": 7,
                "containsVideo": True,
                "thumbnailUrl": "/media/auto::ghost::sda2::TV::ShowB/ep1.jpg",
            },
        ]

        with patch(
            "app.services.media.media_index_service.get_db",
            return_value=fake_db_ctx,
        ), patch(
            "app.services.media.media_catalog_service.ensure_category_indexed",
            return_value=None,
        ), patch(
            "app.services.media.category_query_service.get_all_categories_with_details",
            return_value=categories,
        ):
            subfolders = SortService.get_subfolders("auto::ghost::sda2::TV")

        names = [sf["name"] for sf in subfolders]
        assert names == ["ShowA", "ShowB"]
        assert subfolders[0]["count"] == 12
        assert subfolders[1]["count"] == 7

    def test_get_subfolders_does_not_fallback_to_filesystem_when_hierarchy_is_empty(self, app_context):
        from app.services.media.sort_service import SortService

        fake_conn = MagicMock()
        fake_conn.execute.return_value.fetchall.return_value = []
        fake_db_ctx = MagicMock()
        fake_db_ctx.__enter__.return_value = fake_conn
        fake_db_ctx.__exit__.return_value = None

        show_a = MagicMock()
        show_a.name = "ShowA"
        show_a.path = "/media/ghost/sda2/TV/ShowA"
        show_a.is_dir.return_value = True

        show_b = MagicMock()
        show_b.name = "ShowB"
        show_b.path = "/media/ghost/sda2/TV/ShowB"
        show_b.is_dir.return_value = True

        scandir_ctx = MagicMock()
        scandir_ctx.__enter__.return_value = [show_a, show_b]
        scandir_ctx.__exit__.return_value = None

        with patch(
            "app.services.media.media_index_service.get_db",
            return_value=fake_db_ctx,
        ), patch(
            "app.services.media.media_catalog_service.ensure_category_indexed",
            return_value=None,
        ), patch(
            "app.services.media.category_query_service.get_all_categories_with_details",
            return_value=[],
        ), patch(
            "app.services.media.category_query_service.get_category_by_id",
            return_value={"id": "auto::ghost::sda2::TV", "path": "/media/ghost/sda2/TV"},
        ), patch(
            "app.services.media.sort_service.os.path.isdir",
            return_value=True,
        ), patch(
            "app.services.media.sort_service.os.scandir",
            return_value=scandir_ctx,
        ) as mock_scandir, patch(
            "app.services.media.media_index_service.get_category_media_summary",
            return_value={"count": 0, "contains_video": False, "image_rel_path": None, "video_rel_path": None},
        ), patch(
            "app.services.media.sort_service.should_block_category_access",
            return_value=False,
        ), patch(
            "app.utils.media_utils.find_thumbnail",
            side_effect=[
                (5, "/thumbnails/auto::ghost::sda2::TV::ShowA/a.jpg", True),
                (3, "/thumbnails/auto::ghost::sda2::TV::ShowB/b.jpg", True),
            ],
        ):

            subfolders = SortService.get_subfolders("auto::ghost::sda2::TV")

        assert subfolders == []
        mock_scandir.assert_not_called()
