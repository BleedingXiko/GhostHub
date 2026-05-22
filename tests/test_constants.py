"""
Tests for Application Constants
-------------------------------
Contract tests. The JS client and Python server share these event names.
If any event string changes without simultaneous client update,
real-time features (sync, chat, TV casting) silently break.
"""
import pytest
from app.constants import (
    SYNC_ROOM,
    CHAT_ROOM,
    SOCKET_EVENTS,
    MEDIA_TYPES,
    DEFAULT_SETTINGS,
    TV_EVENTS,
    ERROR_MESSAGES,
)


class TestRoomConstants:
    """Room names must be stable — they're hardcoded in the JS client."""

    def test_sync_room_value(self):
        assert SYNC_ROOM == "sync_room"

    def test_chat_room_value(self):
        assert CHAT_ROOM == "chat_room"


class TestSocketEvents:
    """Every socket event is a contract with the frontend.
    Changing a value here breaks real-time features."""

    # ── Connection Events ────────────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("CONNECT", "connect"),
        ("DISCONNECT", "disconnect"),
        ("HEARTBEAT", "heartbeat"),
        ("HEARTBEAT_RESPONSE", "heartbeat_response"),
        ("CONNECTION_STATUS", "connection_status"),
    ])
    def test_connection_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    # ── Sync Events ──────────────────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("JOIN_SYNC", "join_sync"),
        ("LEAVE_SYNC", "leave_sync"),
        ("SYNC_STATE", "sync_state"),
        ("SYNC_UPDATE", "sync_update"),
        ("SYNC_ERROR", "sync_error"),
        ("USER_JOINED", "user_joined"),
        ("USER_LEFT", "user_left"),
        ("PLAYBACK_SYNC", "playback_sync"),
    ])
    def test_sync_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    # ── Chat Events ──────────────────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("JOIN_CHAT", "join_chat"),
        ("REJOIN_CHAT", "rejoin_chat"),
        ("LEAVE_CHAT", "leave_chat"),
        ("CHAT_MESSAGE", "chat_message"),
        ("CHAT_NOTIFICATION", "chat_notification"),
        ("CHAT_ERROR", "chat_error"),
        ("COMMAND", "command"),
    ])
    def test_chat_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    # ── State Events ─────────────────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("UPDATE_MY_STATE", "update_my_state"),
        ("REQUEST_VIEW_INFO", "request_view_info"),
        ("VIEW_INFO_RESPONSE", "view_info_response"),
    ])
    def test_state_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    # ── Admin Events ─────────────────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("ADMIN_KICK_USER", "admin_kick_user"),
        ("YOU_HAVE_BEEN_KICKED", "you_have_been_kicked"),
        ("ADMIN_KICK_CONFIRMATION", "admin_kick_confirmation"),
        ("ADMIN_STATUS_UPDATE", "admin_status_update"),
        ("PROFILE_SELECTED", "profile_selected"),
        ("PROFILES_CHANGED", "profiles_changed"),
    ])
    def test_admin_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    # ── Storage/Content Events ───────────────────────────────────────────
    @pytest.mark.parametrize("key,value", [
        ("USB_MOUNTS_CHANGED", "usb_mounts_changed"),
    ])
    def test_storage_events(self, key, value):
        assert SOCKET_EVENTS[key] == value

    def test_no_duplicate_event_values(self):
        """No two events should share the same string value.
        Duplicate values would cause handler collision."""
        values = list(SOCKET_EVENTS.values())
        assert len(values) == len(set(values)), (
            f"Duplicate event values found: "
            f"{[v for v in values if values.count(v) > 1]}"
        )


class TestTVEvents:
    """TV casting events — if any of these drift, TV playback breaks silently."""

    @pytest.mark.parametrize("key,value", [
        ("TV_CONNECTED", "tv_connected"),
        ("TV_STATUS_UPDATE", "tv_status_update"),
        ("REQUEST_TV_STATUS", "request_tv_status"),
        ("CAST_MEDIA_TO_TV", "cast_media_to_tv"),
        ("DISPLAY_MEDIA_ON_TV", "display_media_on_tv"),
        ("TV_ERROR", "tv_error"),
        ("CAST_SUCCESS", "cast_success"),
        ("TV_PLAYBACK_CONTROL", "tv_playback_control"),
        ("TV_PLAYBACK_STATE", "tv_playback_state"),
        ("TV_REPORT_STATE", "tv_report_state"),
        ("TV_REQUEST_STATE", "tv_request_state"),
        ("TV_STOP_CASTING", "tv_stop_casting"),
        ("GUEST_CAST_PROGRESS", "guest_cast_progress"),
    ])
    def test_tv_event_values(self, key, value):
        assert TV_EVENTS[key] == value

    @pytest.mark.parametrize("key,value", [
        ("KIOSK_BOOTING", "kiosk_booting"),
        ("KIOSK_BOOT_COMPLETE", "kiosk_boot_complete"),
        ("KIOSK_BOOT_TIMEOUT", "kiosk_boot_timeout"),
    ])
    def test_kiosk_events(self, key, value):
        assert TV_EVENTS[key] == value

    def test_no_duplicate_tv_event_values(self):
        values = list(TV_EVENTS.values())
        assert len(values) == len(set(values))


class TestMediaTypes:
    """Media type constants used for routing file handling logic."""

    def test_image_type(self):
        assert MEDIA_TYPES["IMAGE"] == "image"

    def test_video_type(self):
        assert MEDIA_TYPES["VIDEO"] == "video"

    def test_only_two_types(self):
        assert len(MEDIA_TYPES) == 2





class TestDefaultSettings:
    """Default settings must be sensible for Pi deployment."""

    def test_page_size_reasonable(self):
        assert 1 <= DEFAULT_SETTINGS["PAGE_SIZE"] <= 100

    def test_cache_expiry_reasonable(self):
        """Cache should expire between 1 minute and 1 hour."""
        assert 60 <= DEFAULT_SETTINGS["CACHE_EXPIRY"] <= 3600

    def test_session_expiry_is_one_week(self):
        assert DEFAULT_SETTINGS["SESSION_EXPIRY"] == 604800

    def test_port_is_5000(self):
        assert DEFAULT_SETTINGS["PORT"] == 5000


class TestErrorMessages:
    """Error messages returned to users must be defined."""

    def test_required_error_messages_exist(self):
        required = [
            "CATEGORY_NOT_FOUND",
            "MEDIA_NOT_FOUND",
            "INVALID_REQUEST",
            "UNAUTHORIZED",
        ]
        for key in required:
            assert key in ERROR_MESSAGES
            assert len(ERROR_MESSAGES[key]) > 0
