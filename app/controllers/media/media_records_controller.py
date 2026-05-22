"""Media record hydration endpoint controller."""

from flask import request
from werkzeug.exceptions import BadRequest

from app.utils.auth import get_show_hidden_flag
from app.utils.auth import session_or_admin_required
from app.services.media.media_records_service import MAX_RECORD_IDS
from specter import Controller, registry


class MediaRecordsController(Controller):
    """Expose canonical media record hydration."""

    name = 'media_records_controller'
    url_prefix = '/api/media'

    def build_routes(self, router):
        @router.route('/records', methods=['POST'], json_errors='Failed to hydrate media records')
        @session_or_admin_required
        def get_media_records():
            payload = request.get_json(silent=True) or {}
            ids = payload.get('ids') or []
            self._validate_ids(ids)
            return registry.require('media_records').get_records(
                ids,
                show_hidden=get_show_hidden_flag(),
            )

    @staticmethod
    def _validate_ids(ids):
        if not isinstance(ids, list):
            raise BadRequest("'ids' must be a list")
        if not 1 <= len(ids) <= MAX_RECORD_IDS:
            raise BadRequest(f"'ids' must contain 1..{MAX_RECORD_IDS} items")
        if not all(isinstance(stable_id, str) and stable_id.strip() for stable_id in ids):
            raise BadRequest("'ids' must contain non-empty strings")
