"""Category query/listing ownership."""

import logging
import time

from app.services.media import category_persistence_service, media_index_service
from app.services.media.category_cache_service import (
    CATEGORY_CACHE_TTL,
    check_content_changes,
    get_cached_categories,
    has_cached_categories,
    store_cached_categories,
)
from app.services.media.category_discovery_service import (
    discover_auto_categories,
    format_category_display_name,
    resolve_auto_category,
)
from app.services.media.category_enrichment_service import (
    build_manual_categories,
    enrich_categories_with_runtime_data,
)
from app.services.media.category_hierarchy_service import add_missing_parent_categories
from app.services.media.category_visibility_service import filter_hidden_categories
from app.services.media.playlist_service import PlaylistService

logger = logging.getLogger(__name__)


def _apply_drive_labels(categories):
    """Substitute drive labels into auto-category display names.

    Runs on every response (cached or fresh) so the user always sees their
    chosen label regardless of cache state.
    """
    try:
        from app.services.storage.drive_label_service import get_drive_folder_labels
        labels = get_drive_folder_labels()
    except Exception:
        labels = {}
    if not labels:
        return categories

    for cat in categories:
        cat_id = cat.get('id', '')
        if not cat_id.startswith('auto::'):
            continue

        parts = cat_id.split('::')[1:]
        if not parts:
            continue

        name = parts[-1]
        parent_chain = parts[:-1]
        level = len(parts)
        cat['name'] = format_category_display_name(name, parent_chain, level, labels)

    return categories


def get_cached_categories_with_details(show_hidden=False):
    """Return cached category details without forcing filesystem discovery."""
    cached_categories = get_cached_categories(max_age_seconds=CATEGORY_CACHE_TTL)
    if cached_categories is None:
        return []

    enrich_categories_with_runtime_data(cached_categories)
    _apply_drive_labels(cached_categories)
    return filter_hidden_categories(cached_categories, show_hidden)


def get_all_categories_with_details(use_cache=True, show_hidden=False):
    """Get all categories with media count, thumbnail URL, and video flag."""
    current_time = int(time.time())
    if use_cache and has_cached_categories():
        check_content_changes()

    cached_categories = (
        get_cached_categories(max_age_seconds=CATEGORY_CACHE_TTL)
        if use_cache else None
    )
    if cached_categories is not None:
        valid_categories = cached_categories
        enrich_categories_with_runtime_data(valid_categories)
        _apply_drive_labels(valid_categories)
        logger.debug("Using cached categories (%s items)", len(valid_categories))
        return filter_hidden_categories(list(valid_categories), show_hidden)

    logger.info("Building fresh category list")
    manual_categories = category_persistence_service.load_categories()
    all_summaries_map = media_index_service.get_all_category_media_summaries(show_hidden=True)

    try:
        from app.services.storage.drive_label_service import get_drive_folder_labels
        drive_folder_labels = get_drive_folder_labels()
    except Exception:
        drive_folder_labels = None

    auto_categories = discover_auto_categories(all_summaries_map, drive_folder_labels)
    # Always build the cache with the full hierarchy (including parents of
    # hidden categories). Visibility is enforced at output via
    # filter_hidden_categories below; if we baked the caller's show_hidden flag
    # into the cache build, the first show_hidden=False call would permanently
    # omit hidden parents and toggling "reveal hidden" later could not bring
    # them back (filter_hidden_categories can only strip, not synthesize).
    auto_categories = add_missing_parent_categories(auto_categories, True, drive_folder_labels)

    categories = build_manual_categories(manual_categories, all_summaries_map) + auto_categories
    enrich_categories_with_runtime_data(categories)
    store_cached_categories(categories, current_time)
    _apply_drive_labels(categories)
    return filter_hidden_categories(categories, show_hidden)


def get_category_by_id(category_id):
    """Find a category by ID."""
    if category_id == "session-playlist":
        return PlaylistService.get_virtual_category()

    cached_categories = get_cached_categories(max_age_seconds=10 ** 12) or []
    match = next(
        (category for category in cached_categories if category.get("id") == category_id),
        None,
    )
    if match:
        return match

    categories = category_persistence_service.load_categories()
    match = next((category for category in categories if category.get("id") == category_id), None)
    if match:
        return match

    if category_id.startswith("auto::"):
        return resolve_auto_category(category_id)

    return None
