import logging
import os
import re
import time
import hashlib
import random
from app.services.core.runtime_config_service import get_runtime_config_value
from app.services.media import media_index_service
from app.services.media.hidden_content_service import should_block_category_access
from app.services.media.sort_runtime_store import sort_runtime_store
from app.utils.media_utils import get_media_item_thumbnail_url, get_thumbnail_url
from urllib.parse import quote

logger = logging.getLogger(__name__)

SHUFFLE_FETCH_BATCH_SIZE = 5000
MAX_SHARED_SHUFFLE_CACHE_ENTRIES = 256
_RE_TV_TAG = re.compile(r"\b(tv|anime|series)\b", re.IGNORECASE)
_RE_TV_COMPOSITE = re.compile(
    r"\b(tv|television)\s*(show|shows|series)\b", re.IGNORECASE
)
_RE_S_E = re.compile(
    r"\bs(?:eason)?\s*(\d{1,2})\s*e(?:p(?:isode)?)?\s*(\d{1,3})\b", re.IGNORECASE
)
_RE_X = re.compile(r"\b(\d{1,2})x(\d{1,3})\b", re.IGNORECASE)
_RE_SEASON = re.compile(r"\bseason\s*(\d{1,2})\b", re.IGNORECASE)
_RE_EP = re.compile(r"\b(?:e|ep|episode)\s*(\d{1,3})\b", re.IGNORECASE)
_RE_S_ONLY = re.compile(r"\bs(?:eason)?\s*(\d{1,2})\b", re.IGNORECASE)
_RE_LEADING_NUM = re.compile(r"^\s*(\d{1,3})\b")


def _sort_runtime_access(reader):
    """Read sort runtime state atomically."""
    return sort_runtime_store.access(reader)


def _update_sort_runtime(mutator):
    """Mutate sort runtime state atomically."""
    return sort_runtime_store.update(mutator)


class SortService:
    """Service for handling backend-side sorting and pagination using SQLite index."""

    @staticmethod
    def _build_preview_url(category_id, image_rel=None, video_rel=None):
        """Prefer direct media URLs for images and generated thumbnails for videos."""
        if category_id and image_rel:
            return f"/media/{category_id}/{quote(image_rel)}"
        if category_id and video_rel:
            return get_thumbnail_url(category_id, video_rel)
        return None

    @staticmethod
    def _fetch_all_items(
        category_id, subfolder, filter_type, show_hidden, columns=None
    ):
        rows = []
        offset = 0
        while True:
            batch = media_index_service.get_paginated_media(
                category_id=category_id,
                subfolder=subfolder,
                sort_by="name",
                sort_order="ASC",
                limit=SHUFFLE_FETCH_BATCH_SIZE,
                offset=offset,
                filter_type=filter_type,
                show_hidden=show_hidden,
                deduplicate_by_hash=False,
                columns=columns,
            )
            if not batch:
                break
            rows.extend(batch)
            if len(batch) < SHUFFLE_FETCH_BATCH_SIZE:
                break
            offset += SHUFFLE_FETCH_BATCH_SIZE
        return rows

    @staticmethod
    def _paginate_items(items, page, limit):
        total = len(items)
        start_idx = (page - 1) * limit
        end_idx = min(start_idx + limit, total)
        return items[start_idx:end_idx] if start_idx < total else []

    @staticmethod
    def _build_shared_shuffle_order(
        category_id, subfolder, filter_type, show_hidden, all_items
    ):
        """
        Build/reuse a shared shuffled filename order for all clients.
        Order only changes when the underlying file basis changes.
        """
        filenames = sorted(
            [item.get("rel_path") for item in all_items if item.get("rel_path")],
            key=lambda value: value.lower(),
        )
        if not filenames:
            return []

        basis_hasher = hashlib.sha1()
        for name in filenames:
            basis_hasher.update(name.encode("utf-8", errors="ignore"))
            basis_hasher.update(b"\0")
        basis_hash = basis_hasher.hexdigest()

        cache_key = (
            category_id,
            (subfolder or "").strip("/"),
            filter_type,
            int(bool(show_hidden)),
        )
        order_result = {}

        def mutate(state):
            shared_shuffle_cache = dict(state.get("shared_shuffle_cache", {}))
            cached = shared_shuffle_cache.get(cache_key)
            now = time.time()

            if cached and cached.get("basis_hash") == basis_hash:
                updated_cached = dict(cached)
                updated_cached["last_access"] = now
                shared_shuffle_cache[cache_key] = updated_cached
                state["shared_shuffle_cache"] = shared_shuffle_cache
                order_result["order"] = list(updated_cached.get("order") or [])
                return

            seed_input = (
                f"{category_id}|{cache_key[1]}|{filter_type}|"
                f"{int(bool(show_hidden))}|{basis_hash}"
            )
            seed = int(
                hashlib.sha1(seed_input.encode("utf-8", errors="ignore")).hexdigest()[
                    :16
                ],
                16,
            )
            rng = random.Random(seed)
            order = list(filenames)
            rng.shuffle(order)

            shared_shuffle_cache[cache_key] = {
                "basis_hash": basis_hash,
                "order": list(order),
                "last_access": now,
            }

            if len(shared_shuffle_cache) > MAX_SHARED_SHUFFLE_CACHE_ENTRIES:
                oldest_key = min(
                    shared_shuffle_cache.items(),
                    key=lambda entry: entry[1].get("last_access", 0),
                )[0]
                shared_shuffle_cache.pop(oldest_key, None)

            state["shared_shuffle_cache"] = shared_shuffle_cache
            order_result["order"] = list(order)

        _update_sort_runtime(mutate)
        return order_result["order"]

    @staticmethod
    def _sort_shuffle(
        category_id,
        subfolder,
        filter_type,
        show_hidden,
        page,
        limit,
    ):
        # Optimization: only fetch required columns for shuffle filenames order.
        # Full metadata for the current page is fetched later.
        all_items = SortService._fetch_all_items(
            category_id=category_id,
            subfolder=subfolder,
            filter_type=filter_type,
            show_hidden=show_hidden,
            columns=["rel_path"],
        )

        if not all_items:
            return []

        shuffled_filenames = SortService._build_shared_shuffle_order(
            category_id=category_id,
            subfolder=subfolder,
            filter_type=filter_type,
            show_hidden=show_hidden,
            all_items=all_items,
        )
        paginated_filenames = SortService._paginate_items(
            shuffled_filenames, page, limit
        )
        if not paginated_filenames:
            return []

        # all_items may contain only rel_path (for performance), so load
        # complete metadata for just the page slice before enrichment.
        return SortService.get_media_by_filenames(category_id, paginated_filenames)

    @staticmethod
    def _sort_tv(
        category_id,
        subfolder,
        filter_type,
        show_hidden,
        sort_order,
        page,
        limit,
        force_refresh=False,
    ):
        # TV sort needs rel_path, category_id, and all metadata columns for enrichment.
        all_items = SortService._fetch_all_items(
            category_id=category_id,
            subfolder=subfolder,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
        if not all_items:
            return []

        sorted_items = sorted(all_items, key=SortService._tv_sort_key)
        if str(sort_order).upper() == "DESC":
            sorted_items.reverse()

        paged_items = SortService._paginate_items(sorted_items, page, limit)
        return SortService._enrich_items(paged_items, check_exists=force_refresh)

    @staticmethod
    def _sort_standard(
        category_id,
        subfolder,
        sort_by,
        sort_order,
        page,
        limit,
        filter_type,
        show_hidden,
        force_refresh=False,
    ):
        offset = (page - 1) * limit
        dedup = category_id is None
        items = media_index_service.get_paginated_media(
            category_id=category_id,
            subfolder=subfolder,
            sort_by=sort_by,
            sort_order=sort_order,
            limit=limit,
            offset=offset,
            filter_type=filter_type,
            show_hidden=show_hidden,
            deduplicate_by_hash=dedup,
        )
        return SortService._enrich_items(items, check_exists=force_refresh)

    @staticmethod
    def _is_tv_sort_enabled(sort_by):
        if sort_by != "tv":
            return False
        return get_runtime_config_value("ENABLE_TV_SORTING", True)

    @staticmethod
    def _is_tv_category(category_id):
        if not category_id:
            return False
        from app.services.media.category_query_service import get_category_by_id

        if not get_runtime_config_value("ENABLE_TV_SORTING", True):
            return False
        if not SortService._is_tv_sort_enabled("tv"):
            return False
        cat = get_category_by_id(category_id)
        if not cat:
            return False
        hay_raw = f"{cat.get('name', '')} {cat.get('path', '')}".lower()
        hay = re.sub(r"[^a-z0-9]+", " ", hay_raw).strip()
        if _RE_TV_COMPOSITE.search(hay):
            return True
        if _RE_TV_TAG.search(hay):
            return True
        return False

    @staticmethod
    def _extract_season_episode(rel_path):
        if not rel_path:
            return None, None
        normalized = rel_path.replace("_", " ").replace(".", " ").replace("-", " ")
        normalized = normalized.lower()

        match = _RE_S_E.search(normalized)
        if match:
            return int(match.group(1)), int(match.group(2))

        match = _RE_X.search(normalized)
        if match:
            return int(match.group(1)), int(match.group(2))

        season = None
        episode = None

        match = _RE_SEASON.search(normalized)
        if match:
            season = int(match.group(1))

        match = _RE_EP.search(normalized)
        if match:
            episode = int(match.group(1))

        # Try to detect season from "S1" or "Season 1" when episode is elsewhere
        if season is None:
            match = _RE_S_ONLY.search(normalized)
            if match:
                season = int(match.group(1))

        base = os.path.basename(rel_path).lower().replace("_", " ").replace(".", " ")
        if episode is None:
            match = _RE_EP.search(base)
            if match:
                episode = int(match.group(1))

        if season is None:
            folder_name = (
                os.path.basename(os.path.dirname(rel_path))
                .lower()
                .replace("_", " ")
                .replace(".", " ")
            )
            match = _RE_SEASON.search(folder_name)
            if match:
                season = int(match.group(1))
            else:
                match = _RE_S_ONLY.search(folder_name)
                if match:
                    season = int(match.group(1))

        # Fallback: leading number in filename as episode when season is known
        if season is not None and episode is None:
            match = _RE_LEADING_NUM.search(base)
            if match:
                episode = int(match.group(1))

        if season is None and episode is not None:
            season = 1

        return season, episode

    @staticmethod
    def _tv_sort_key(item):
        rel_path = item.get("rel_path") or item.get("name") or ""
        season, episode = SortService._extract_season_episode(rel_path)
        if season is None and episode is None:
            return (9999, 9999, rel_path.lower())
        if season is None:
            season = 9999
        if episode is None:
            episode = 9999
        return (season, episode, rel_path.lower())

    @staticmethod
    def _enrich_items(items, check_exists=True):
        enriched_items = []
        stale_entries = []
        category_path_cache = {}

        for item in items:
            cat_id = item.get("category_id")
            rel_path = item.get("rel_path")
            if not cat_id or not rel_path:
                logger.debug(
                    f"Skipping malformed media_index row during enrichment: {item}"
                )
                continue

            rel_path = str(rel_path)

            if check_exists:
                if cat_id not in category_path_cache:
                    from app.services.media.category_query_service import get_category_by_id

                    cat = get_category_by_id(cat_id)
                    category_path_cache[cat_id] = cat.get("path") if cat else None

                cat_path = category_path_cache[cat_id]
                if not cat_path:
                    stale_entries.append((cat_id, rel_path))
                    logger.debug(
                        f"Skipping media from unmounted/missing category: {cat_id}/{rel_path}"
                    )
                    continue

                full_path = os.path.join(cat_path, rel_path)
                if not os.path.exists(full_path):
                    stale_entries.append((cat_id, rel_path))
                    logger.debug(f"Skipping stale media entry: {full_path}")
                    continue

            enriched = {
                "name": rel_path,
                "displayName": os.path.basename(rel_path),
                "type": item.get("type", "video"),
                "size": item.get("size", 0),
                "mtime": item.get("mtime", 0),
                "hash": item.get("hash", ""),
                "url": f"/media/{cat_id}/{quote(rel_path)}",
                "categoryId": cat_id,
            }

            thumbnail_url = get_media_item_thumbnail_url(
                cat_id,
                rel_path,
                enriched["type"],
                enriched.get("size", 0),
            )
            if thumbnail_url:
                enriched["thumbnailUrl"] = thumbnail_url

            enriched_items.append(enriched)

        if stale_entries:
            logger.warning(
                f"FOUND {len(stale_entries)} STALE MEDIA ENTRIES - CLEANING UP"
            )
            try:
                for cat_id, rel_path in stale_entries:
                    media_index_service.delete_media_index_entry(cat_id, rel_path)
                logger.info(
                    f"Cleaned up {len(stale_entries)} stale media entries from SortService"
                )
            except Exception as e:
                logger.debug(f"Failed to cleanup stale entries: {e}")

        return enriched_items

    @staticmethod
    def get_total_count(
        category_id=None, subfolder=None, filter_type="all", show_hidden=False
    ):
        """Get total matching items count."""
        # Since this is a lightweight query, callers are responsible for
        # ensuring the category has been indexed before requesting totals.
        return media_index_service.get_media_count(
            category_id,
            subfolder,
            filter_type,
            show_hidden,
        )

    @staticmethod
    def get_subfolders(category_id, subfolder_prefix=None, show_hidden=False):
        """
        Extract immediate subdirectories from the SQLite index for a given path.
        """

        def _category_hierarchy_auto_subfolders(base_auto_id, show_hidden_flag):
            """Derive immediate auto subfolders from persisted category hierarchy metadata."""
            from app.services.media.category_query_service import get_all_categories_with_details

            categories = get_all_categories_with_details(
                use_cache=True, show_hidden=show_hidden_flag
            )
            auto_prefix = base_auto_id + "::"
            subfolder_map = {}

            for category in categories:
                cat_id = category.get("id")
                if not cat_id or not cat_id.startswith(auto_prefix):
                    continue

                suffix = cat_id[len(auto_prefix) :]
                if not suffix:
                    continue

                sub_name = suffix.split("::")[0]
                if not sub_name:
                    continue

                info = subfolder_map.get(sub_name)
                if not info:
                    info = {
                        "name": sub_name,
                        "count": 0,
                        "contains_video": False,
                        "thumbnail_url": None,
                        "first_file": None,
                    }
                    subfolder_map[sub_name] = info

                count = int(category.get("mediaCount", 0) or 0)
                info["count"] += count
                if category.get("containsVideo"):
                    info["contains_video"] = True
                if not info["thumbnail_url"] and category.get("thumbnailUrl"):
                    info["thumbnail_url"] = category.get("thumbnailUrl")

            return sorted(subfolder_map.values(), key=lambda item: item["name"].lower())

        # Auto categories derive subfolders from child category IDs in the index.
        # When a parent auto:: category is indexed, its child categories are
        # automatically queued by the Specter-owned indexing runtime.
        if category_id and str(category_id).startswith("auto::"):
            base_id = str(category_id)
            if subfolder_prefix:
                norm_prefix = subfolder_prefix.replace("\\", "/").strip("/")
                if norm_prefix:
                    base_id = base_id + "::" + "::".join(
                        [p for p in norm_prefix.split("/") if p]
                    )

            summaries = media_index_service.get_subfolder_media_summaries(
                category_id,
                subfolder_prefix=subfolder_prefix,
                show_hidden=show_hidden,
            )
            if not summaries:
                hierarchy_subfolders = _category_hierarchy_auto_subfolders(
                    base_id,
                    show_hidden,
                )
                if hierarchy_subfolders:
                    return hierarchy_subfolders
                return []

            subfolders = []
            for summary in summaries:
                sub_name = summary.get("name")
                if not sub_name:
                    continue

                derived_id = summary.get("derived_category_id")
                if not show_hidden and should_block_category_access(
                    derived_id, show_hidden
                ):
                    continue

                count = int(summary.get("count", 0) or 0)
                if count <= 0:
                    continue

                thumbnail_url = None
                contains_video = bool(summary.get("contains_video", False))
                image_cat_id = summary.get("image_category_id")
                image_rel = summary.get("image_rel_path")
                video_cat_id = summary.get("video_category_id")
                video_rel = summary.get("video_rel_path")
                if image_cat_id and image_rel:
                    thumbnail_url = SortService._build_preview_url(
                        image_cat_id,
                        image_rel=image_rel,
                    )
                if video_cat_id and video_rel:
                    contains_video = True
                    if not thumbnail_url:
                        thumbnail_url = SortService._build_preview_url(
                            video_cat_id,
                            video_rel=video_rel,
                        )

                subfolders.append(
                    {
                        "name": sub_name,
                        "count": count,
                        "contains_video": contains_video,
                        "thumbnail_url": thumbnail_url,
                        "first_file": image_rel or video_rel,
                    }
                )

            if subfolders:
                return subfolders

            hierarchy_subfolders = _category_hierarchy_auto_subfolders(
                base_id,
                show_hidden,
            )
            if hierarchy_subfolders:
                return hierarchy_subfolders

            return []

        # Normalize prefix
        prefix = ""
        if subfolder_prefix:
            prefix = subfolder_prefix.replace("\\", "/").strip("/")
            if prefix:
                prefix += "/"

        summaries = media_index_service.get_subfolder_media_summaries(
            category_id,
            subfolder_prefix=subfolder_prefix,
            show_hidden=show_hidden,
        )
        subfolders = []
        for summary in summaries:
            image_rel = summary.get("image_rel_path")
            video_rel = summary.get("video_rel_path")
            thumbnail_url = None
            contains_video = bool(summary.get("contains_video", False))

            if image_rel:
                thumbnail_url = SortService._build_preview_url(
                    category_id,
                    image_rel=image_rel,
                )
            if video_rel and not thumbnail_url:
                thumbnail_url = SortService._build_preview_url(
                    category_id,
                    video_rel=video_rel,
                )

            subfolders.append(
                {
                    "name": summary.get("name"),
                    "count": summary.get("count", 0),
                    "contains_video": contains_video,
                    "thumbnail_url": thumbnail_url,
                    "first_file": image_rel or video_rel,
                }
            )

        return subfolders

    @staticmethod
    def get_media_by_filenames(category_id, filenames):
        """
        Fetch enriched metadata for a specific list of filenames in a category.
        Used for shuffling and playlists.
        """
        if not filenames:
            return []

        items = media_index_service.get_media_rows_by_filenames(category_id, filenames)
        return SortService._enrich_items_by_filenames(category_id, filenames, items)

    @staticmethod
    def _enrich_items_by_filenames(category_id, filenames, items_by_rel_path):
        """Build API media payloads in the same order as filenames."""
        enriched_items = []
        for name in filenames:
            item = items_by_rel_path.get(name)
            if not item:
                continue

            item_type = item.get("type", "video")

            enriched = {
                "name": name,
                "displayName": os.path.basename(name),
                "type": item_type,
                "size": item.get("size", 0),
                "mtime": item.get("mtime", 0),
                "hash": item.get("hash", ""),
                "url": f"/media/{category_id}/{quote(name)}",
                "categoryId": category_id,
            }
            thumbnail_url = get_media_item_thumbnail_url(
                category_id,
                name,
                item_type,
                item.get("size", 0),
            )
            if thumbnail_url:
                enriched["thumbnailUrl"] = thumbnail_url
            enriched_items.append(enriched)
        return enriched_items

    @staticmethod
    def get_timeline_dates(category_id=None, filter_type="all", show_hidden=False):
        """
        Get all unique dates and their item counts for the timeline.
        Returns a dictionary: { 'YYYY-MM-DD': count }
        """
        return media_index_service.get_timeline_date_counts(
            category_id=category_id,
            filter_type=filter_type,
            show_hidden=show_hidden,
        )
