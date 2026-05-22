"""Category hierarchy shaping ownership."""

import logging
import os

from app.services.media import media_index_service
from app.services.media.category_discovery_service import ROOT_FOLDERS_TO_HIDE, format_category_display_name
from app.services.media.category_visibility_service import filter_hidden_categories

logger = logging.getLogger(__name__)


def add_missing_parent_categories(categories, show_hidden=False, drive_folder_labels=None):
    """Ensure parent folders appear as categories even if they contain only subfolders."""
    if not categories:
        return categories

    try:
        seed_categories = (
            categories if show_hidden else filter_hidden_categories(categories, show_hidden)
        )
        seed_ids = {category.get("id") for category in seed_categories if category.get("id")}
    except Exception:
        seed_ids = {category.get("id") for category in categories if category.get("id")}

    existing_paths = set()
    for category in categories:
        path = category.get("path")
        if path:
            existing_paths.add(os.path.normpath(path))

    parent_by_path = {}
    new_categories = []

    for category in categories:
        category_id = category.get("id", "")
        category_path = category.get("path")
        if category_id and category_id in seed_ids and category_id.startswith("auto::") and category_path:
            parts = category_id.split("::")[1:]
            if len(parts) > 1:
                for depth in range(1, len(parts)):
                    up_steps = len(parts) - depth
                    ancestor_path = category_path
                    for _ in range(up_steps):
                        ancestor_path = os.path.dirname(ancestor_path)
                    if not ancestor_path or not os.path.isdir(ancestor_path):
                        continue

                    norm_path = os.path.normpath(ancestor_path)
                    if norm_path in existing_paths:
                        parent_entry = parent_by_path.get(norm_path)
                        if parent_entry and category.get("containsVideo"):
                            parent_entry["containsVideo"] = True
                        continue
                    if norm_path in parent_by_path:
                        if category.get("containsVideo"):
                            parent_by_path[norm_path]["containsVideo"] = True
                        continue

                    name = parts[depth - 1]
                    parent_chain = parts[: depth - 1]
                    if depth == 1 and name.lower() in ROOT_FOLDERS_TO_HIDE:
                        continue
                    display_name = format_category_display_name(
                        name, parent_chain, depth, drive_folder_labels,
                    )

                    ancestor_id = "auto::" + "::".join(parts[:depth])
                    new_category = {
                        "id": ancestor_id,
                        "name": display_name,
                        "path": ancestor_path,
                        "mediaCount": 1,
                        "thumbnailUrl": None,
                        "containsVideo": bool(category.get("containsVideo", False)),
                        "auto_detected": True,
                        # Marker for visibility filtering: a synthesized parent is a
                        # pure aggregator (no direct media of its own). It should only
                        # render when at least one descendant survives filtering —
                        # otherwise it becomes a ghost when its only children are hidden.
                        "_synthesized_parent": True,
                    }

                    try:
                        summary = media_index_service.get_category_media_summary(
                            ancestor_id,
                            show_hidden=show_hidden,
                        )
                        count = summary.get("count", 0) if summary else 0
                        if count > 0:
                            new_category["mediaCount"] = count
                            if summary.get("contains_video"):
                                new_category["containsVideo"] = True

                            image_rel = summary.get("image_rel_path")
                            video_rel = summary.get("video_rel_path")
                            if image_rel:
                                from urllib.parse import quote

                                new_category["thumbnailUrl"] = (
                                    f"/media/{ancestor_id}/{quote(image_rel)}"
                                )
                            elif video_rel:
                                from app.utils.media_utils import get_thumbnail_url

                                new_category["thumbnailUrl"] = get_thumbnail_url(
                                    ancestor_id,
                                    video_rel,
                                )
                    except Exception as err:
                        logger.debug(
                            "Parent category summary lookup failed for %s: %s",
                            ancestor_id,
                            err,
                        )

                    new_categories.append(new_category)
                    existing_paths.add(norm_path)
                    parent_by_path[norm_path] = new_category

        new_categories.append(category)
        if category_path:
            existing_paths.add(os.path.normpath(category_path))

    return new_categories
