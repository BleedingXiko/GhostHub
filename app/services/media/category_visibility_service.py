"""Category visibility filtering ownership."""

import logging

from app.services.media.hidden_content_service import should_block_category_access

logger = logging.getLogger(__name__)


def filter_hidden_categories(categories, show_hidden=False):
    """Filter out hidden categories unless show_hidden is True."""
    if show_hidden:
        return categories

    filtered = []
    for category in categories:
        category_id = category.get("id", "")
        if should_block_category_access(category_id, show_hidden=False):
            continue
        filtered.append(category)

    # Second pass: drop synthesized parent aggregators whose entire descendant
    # subtree was filtered out above. Without this, a parent like "auto::Movies"
    # remains visible after its only child "auto::Movies::Hidden" is hidden,
    # because the parent itself is not in the hidden_categories table.
    # Process deepest-first so chains of synthesized parents collapse together.
    keep_ids = {c.get("id", "") for c in filtered}
    by_depth_desc = sorted(
        filtered,
        key=lambda c: len(c.get("id", "").split("::")),
        reverse=True,
    )
    for category in by_depth_desc:
        if not category.get("_synthesized_parent"):
            continue
        cid = category.get("id", "")
        prefix = cid + "::"
        has_visible_descendant = any(
            other_id != cid and other_id.startswith(prefix)
            for other_id in keep_ids
        )
        if not has_visible_descendant:
            keep_ids.discard(cid)

    final = [c for c in filtered if c.get("id", "") in keep_ids]

    logger.debug(
        "Filtered %s hidden categories (including children and ghost parents)",
        len(categories) - len(final),
    )
    return final
