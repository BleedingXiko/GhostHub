"""
GhostHub Test Configuration
--------------------------
Shared fixtures and configuration for all tests.
Provides isolated test database, Flask app context, and mock utilities.
"""

import os
import sys
import tempfile
import shutil
import time
import pytest
import sqlite3
import gevent
os.environ['GHOSTHUB_TESTING'] = 'true'
from unittest.mock import MagicMock

# Add the project root to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TEST_PROFILE_ID = 'test-profile'


def ensure_test_profile_exists(profile_id=TEST_PROFILE_ID, name='Test Profile'):
    """Create a shared test profile row when a test expects it."""
    from app.services.core.sqlite_runtime_service import get_db

    with get_db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM profiles WHERE id = ? LIMIT 1",
            (profile_id,),
        ).fetchone()
        if existing:
            return

        now = time.time()
        conn.execute(
            """
            INSERT INTO profiles (
                id,
                name,
                avatar_color,
                avatar_icon,
                preferences_json,
                created_at,
                last_active_at
            )
            VALUES (?, ?, NULL, NULL, NULL, ?, ?)
            """,
            (profile_id, name, now, now),
        )


def register_test_storage_drive(path, name='TestDrive', writable=True, device_key=None):
    """Register a filesystem path as a managed storage drive for tests."""
    from app.services.storage.storage_runtime_store import storage_runtime_store

    real_path = os.path.realpath(path)
    try:
        usage = shutil.disk_usage(real_path)
        total = usage.total
        free = usage.free
        used = usage.used
    except OSError:
        total = 0
        free = 0
        used = 0

    drive = {
        'id': device_key or real_path,
        'device_key': device_key or real_path,
        'name': name,
        'path': real_path,
        'total': total,
        'used': used,
        'free': free,
        'percent_used': (used / total * 100) if total else 0.0,
        'writable': writable,
    }

    def _register(draft):
        existing = [
            existing_drive
            for existing_drive in draft.get('drive_cache', [])
            if os.path.realpath(existing_drive.get('path', '')) != real_path
        ]
        existing.append(drive)
        draft['drive_cache'] = existing

    storage_runtime_store.update(_register)
    return drive


@pytest.fixture(autouse=True)
def mock_gevent_spawn(monkeypatch):
    """
    Global fixture to mock gevent.spawn to be synchronous for tests.
    This prevents hangs caused by gevent.spawn and g.join() when no gevent loop is running.
    """

    class MockGreenlet:
        def __init__(self, result=None, exception=None):
            self._result = result
            self._exception = exception
            self.dead = True

        def successful(self):
            return self._exception is None

        def join(self, timeout=None):
            if self._exception:
                raise self._exception
            return self._result

        def get(self, timeout=None):
            if self._exception:
                raise self._exception
            return self._result

        def wait(self, timeout=None):
            return self.get(timeout)

        def start(self):
            pass

        def kill(self, *args, **kwargs):
            pass

        def rawlink(self, callback):
            callback(self)

    def sync_spawn(func, *args, **kwargs):
        # Background workers that loop infinitely should be ignored during tests
        # We check both the function name and any closure variables to catch
        # workers wrapped in Service.spawn's '_runner' closure.
        target_name = getattr(func, "__name__", str(func)).lower()

        # If it's a Service.spawn wrapper, try to find the real callback name
        if target_name == "_runner" and hasattr(func, "__closure__") and func.__closure__:
            for cell in func.__closure__:
                try:
                    cell_contents = cell.cell_contents
                    if callable(cell_contents):
                        target_name = getattr(cell_contents, "__name__", str(cell_contents)).lower()
                        break
                except (ValueError, AttributeError):
                    continue

        skip_names = (
            "worker",
            "monitor",
            "udev",
            "scan",
            "run_with_app_context",
            "callback",
            "loop",
            "timer",
            "heartbeat",
            "cleanup",
            "stale",
            "auto_start",
            "detection",
            "hotplug",
            "periodic",
            "quiesce",
            "background",
        )

        if any(name in target_name for name in skip_names):
            return MockGreenlet()

        try:
            # Execute synchronously for test determinism
            result = func(*args, **kwargs)
            return MockGreenlet(result=result)
        except Exception as e:
            return MockGreenlet(exception=e)

    class MockThreadPool:
        def spawn(self, func, *args, **kwargs):
            return sync_spawn(func, *args, **kwargs)

    class MockHub:
        def __init__(self):
            self.threadpool = MockThreadPool()

        def wait(self, *args, **kwargs):
            pass

    import time
    monkeypatch.setattr(gevent, "spawn", sync_spawn)
    monkeypatch.setattr(gevent, "spawn_later", lambda s, f, *a, **k: sync_spawn(f, *a, **k))
    monkeypatch.setattr(gevent, "sleep", lambda x: time.sleep(0.001) if x > 0 else None)
    monkeypatch.setattr(gevent, "get_hub", lambda: MockHub())
    monkeypatch.setattr(gevent, "joinall", lambda *args, **kwargs: None)
    monkeypatch.setattr(gevent, "wait", lambda *args, **kwargs: None)
    return sync_spawn


@pytest.fixture(scope="session")
def app():
    """Create and configure a test Flask application instance."""
    from app.config import Config, config_by_name

    # Create a temporary directory for test instance
    test_instance_dir = tempfile.mkdtemp(prefix="ghosthub_test_")

    # Store originals
    original_instance_path = Config.INSTANCE_FOLDER_PATH
    original_save_video_progress = Config.SAVE_VIDEO_PROGRESS
    original_debug = Config.DEBUG_MODE

    # Set test configuration values BEFORE importing create_app
    Config.INSTANCE_FOLDER_PATH = test_instance_dir
    Config.SAVE_VIDEO_PROGRESS = True
    Config.ENABLE_SESSION_PROGRESS = True
    Config.ENABLE_SUBTITLES = True
    Config.DEBUG_MODE = True

    # Also update config_by_name entries
    for cfg in config_by_name.values():
        cfg.INSTANCE_FOLDER_PATH = test_instance_dir
        cfg.SAVE_VIDEO_PROGRESS = True
        cfg.DEBUG_MODE = True

    # NOW import create_app
    from app import create_app

    # Create app using 'default' config name
    app = create_app("default")
    app.instance_path = test_instance_dir
    app.config["INSTANCE_FOLDER_PATH"] = test_instance_dir
    app.config["TESTING"] = True
    app.config["WTF_CSRF_ENABLED"] = False
    app.config["SECRET_KEY"] = "test-secret-key"

    yield app

    # Restore original config values
    Config.INSTANCE_FOLDER_PATH = original_instance_path
    Config.SAVE_VIDEO_PROGRESS = original_save_video_progress
    Config.DEBUG_MODE = original_debug

    for cfg in config_by_name.values():
        cfg.INSTANCE_FOLDER_PATH = original_instance_path
        cfg.SAVE_VIDEO_PROGRESS = original_save_video_progress
        cfg.DEBUG_MODE = original_debug

    # Cleanup
    shutil.rmtree(test_instance_dir, ignore_errors=True)


@pytest.fixture(scope="function")
def client(app):
    """Create a test client for making HTTP requests."""
    return app.test_client()


@pytest.fixture(scope="function")
def app_context(app):
    """Push an application context for tests that need it."""
    from app.config import Config

    # No longer needed as mode is implicitly 'video'

    with app.app_context():
        from app.services.core import session_store
        from app.services.core.runtime_config_service import set_runtime_config_value
        from app.services.core.sqlite_runtime_service import close_connection, get_db, get_db_path
        from app.services.storage.storage_runtime_store import storage_runtime_store

        # Reset runtime config to the current Config defaults so individual tests
        # do not leak overrides into later requests.
        for key in dir(Config):
            if not key.isupper():
                continue
            value = getattr(Config, key)
            if key == 'INSTANCE_FOLDER_PATH':
                value = app.instance_path
            app.config[key] = value
            set_runtime_config_value(key, value)

        # Clear persisted runtime data between tests while preserving schema_info.
        close_connection()
        with get_db() as conn:
            print(f"TEST DB PATH: {get_db_path()}", file=sys.stderr)
            for table_name in (
                'video_progress',
                'profiles',
                'categories',
                'hidden_categories',
                'hidden_files',
                'file_path_aliases',
                'media_index',
                'drive_labels',
            ):
                conn.execute(f"DELETE FROM {table_name}")

        # Reset shared connection/session state so cross-test socket metadata
        # cannot affect auth or profile ownership checks.
        session_store.session_store.replace({
            'active_connections': {},
            'sid_to_session': {},
            'blocked_ips': {},
            'admin_session_id': None,
            'admin_lock_path': None,
            'admin_release_timers': {},
        })
        session_store.configure_admin_lock(app.instance_path)

        storage_runtime_store.set({
            'last_mount_hash': None,
            'last_mount_snapshot': None,
            'mount_change_detected': False,
            'drive_cache': [],
            'drive_scan_in_progress': False,
            'monitoring': False,
        })

        # Seed runtime config for media_utils and other services
        set_runtime_config_value('IMAGE_EXTENSIONS', ['.jpg', '.jpeg', '.png', '.gif', '.webp'])
        set_runtime_config_value('VIDEO_EXTENSIONS', ['.mp4', '.mkv', '.avi', '.mov', '.webm'])
        set_runtime_config_value('MEDIA_EXTENSIONS', ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mkv', '.avi', '.mov', '.webm'])
        set_runtime_config_value('MEDIA_TYPES', {
            'image': {'mime_types': {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'}},
            'video': {'mime_types': {'.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm'}}
        })
        
        yield app


class TestDatabaseProxy:
    """
    Proxy that aggregates the distributed DB service modules into one object
    so legacy test_db-dependent tests continue to work after the architecture migration.
    """

    from app.services.core.database_schema_service import SCHEMA_VERSION

    # ── Connection management ────────────────────────────────────────────
    def get_db(self):
        from app.services.core.sqlite_runtime_service import get_db
        return get_db()

    def get_connection(self):
        from app.services.core.sqlite_runtime_service import get_connection
        return get_connection()

    def close_connection(self):
        from app.services.core.sqlite_runtime_service import close_connection
        return close_connection()

    # ── Category persistence ─────────────────────────────────────────────
    def save_category(self, category_id, name, path):
        from app.services.media.category_persistence_service import save_category
        return save_category(category_id, name, path)

    def load_categories(self):
        from app.services.media.category_persistence_service import load_categories
        return load_categories()

    def delete_category(self, category_id):
        from app.services.media.category_persistence_service import delete_category
        return delete_category(category_id)

    def category_exists_by_path(self, path):
        from app.services.media.category_persistence_service import category_exists_by_path
        return category_exists_by_path(path)

    def save_categories_bulk(self, categories):
        from app.services.media.category_persistence_service import save_categories_bulk
        return save_categories_bulk(categories)

    # ── Video progress ───────────────────────────────────────────────────
    def save_video_progress(self, video_path, category_id, video_timestamp,
                            video_duration=None, thumbnail_url=None, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import save_video_progress
        return save_video_progress(video_path, category_id, video_timestamp,
                                   video_duration, thumbnail_url, profile_id=profile_id)

    def get_video_progress(self, video_path, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import get_video_progress
        return get_video_progress(video_path, profile_id=profile_id)

    def get_category_video_progress(self, category_id, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import get_category_video_progress
        return get_category_video_progress(category_id, profile_id=profile_id)

    def get_all_video_progress(self, limit=50, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import get_all_video_progress
        return get_all_video_progress(limit, profile_id=profile_id)

    def delete_all_video_progress(self, profile_id=None):
        from app.services.media.video_progress_service import delete_all_video_progress
        return delete_all_video_progress(profile_id=profile_id or TEST_PROFILE_ID)

    def get_most_recent_video_progress(self, category_id, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import get_most_recent_video_progress
        return get_most_recent_video_progress(category_id, profile_id=profile_id)

    def delete_video_progress(self, video_path, profile_id=TEST_PROFILE_ID):
        from app.services.media.video_progress_service import delete_video_progress
        return delete_video_progress(video_path, profile_id=profile_id)

    # ── Media index ──────────────────────────────────────────────────────
    def upsert_media_index_entry(self, category_id, category_path, rel_path,
                                  size, mtime, file_hash=None, file_type='video'):
        from app.services.media.media_index_service import upsert_media_index_entry
        return upsert_media_index_entry(category_id, category_path, rel_path,
                                        size, mtime, file_hash, file_type)

    def batch_upsert_media_index_entries(self, category_id, category_path, file_entries):
        from app.services.media.media_index_service import batch_upsert_media_index_entries
        return batch_upsert_media_index_entries(category_id, category_path, file_entries)

    def cleanup_stale_media_index_entries(self, limit=5000):
        from app.services.media.media_index_service import cleanup_stale_media_index_entries
        return cleanup_stale_media_index_entries(limit)

    def cleanup_media_index_by_category_path_check(self):
        from app.services.media.media_index_service import cleanup_media_index_by_category_path_check
        return cleanup_media_index_by_category_path_check()

    def search_media_index(self, query, limit=50, show_hidden=False):
        from app.services.media.media_index_service import search_media_index
        return search_media_index(query, limit, show_hidden)

    def search_media_paths_for_folder_matches(self, query, limit=20000,
                                               show_hidden=False, offset=0):
        from app.services.media.media_index_service import search_media_paths_for_folder_matches
        return search_media_paths_for_folder_matches(query, limit, show_hidden, offset)

    def search_media_category_ids(self, query, limit=5000, show_hidden=False, offset=0):
        from app.services.media.media_index_service import search_media_category_ids
        return search_media_category_ids(query, limit, show_hidden, offset)

    def get_indexed_category_ids(self, show_hidden=False, limit=50000, offset=0):
        from app.services.media.media_index_service import get_indexed_category_ids
        return get_indexed_category_ids(show_hidden, limit, offset)


@pytest.fixture(scope="function")
def test_db(app_context, tmp_path):
    """
    Provides a TestDatabaseProxy that routes calls to the distributed DB
    service modules introduced in the Specter architecture migration.
    """
    ensure_test_profile_exists()
    ensure_test_profile_exists('other-profile', 'Other Test Profile')
    yield TestDatabaseProxy()


@pytest.fixture(scope="function")
def mock_media_dir(tmp_path):
    """
    Create a temporary directory with mock media files for testing.
    Returns the path to the directory.
    """
    media_dir = tmp_path / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    # Create mock image files (4 images)
    images = ["photo1.jpg", "photo2.png", "image3.gif", "picture.webp"]
    for img in images:
        (media_dir / img).write_bytes(b"fake image content")

    # Create mock video files (3 videos)
    videos = ["video1.mp4", "movie.mkv", "clip.webm"]
    for vid in videos:
        (media_dir / vid).write_bytes(b"fake video content")

    # Create a subdirectory with more media (these are counted too = 2 more)
    subdir = media_dir / "subalbum"
    subdir.mkdir()
    (subdir / "nested_photo.jpg").write_bytes(b"nested image")
    (subdir / "nested_video.mp4").write_bytes(b"nested video")

    # Create a hidden file (should be ignored by media scanning)
    (media_dir / ".hidden_file.jpg").write_bytes(b"hidden")

    # Total: 4 images + 3 videos + 2 nested = 9 media files (excluding hidden)

    return media_dir


@pytest.fixture(scope="function")
def mock_usb_drive(tmp_path):
    """
    Create a mock USB drive directory structure for testing storage service.
    """
    usb_root = tmp_path / "usb_drive"
    usb_root.mkdir(parents=True, exist_ok=True)

    # Create some folders
    (usb_root / "Movies").mkdir()
    (usb_root / "Photos").mkdir()
    (usb_root / "Music").mkdir()

    # Add some files
    (usb_root / "Movies" / "movie1.mp4").write_bytes(b"x" * 1000)
    (usb_root / "Photos" / "photo1.jpg").write_bytes(b"x" * 500)

    register_test_storage_drive(str(usb_root), name='Mock USB Drive')

    return usb_root


@pytest.fixture
def mock_config(app_context, monkeypatch):
    """
    Fixture to easily mock Config values for individual tests.
    Returns a helper function to set config values.
    Updates both Config class and current_app.config for runtime access.
    """
    from app.config import Config, config_by_name
    from flask import current_app
    from app.services.core.runtime_config_service import set_runtime_config_value
    import sys

    def set_config(key, value):
        # Update the Config class attribute
        monkeypatch.setattr(Config, key, value)
        # Update all config_by_name entries
        for cfg in config_by_name.values():
            monkeypatch.setattr(cfg, key, value)
        # Update the current app's config dict
        app_context.config[key] = value
        if current_app:
            current_app.config[key] = value

        # Keep Specter/runtime-config consumers in sync with test overrides.
        set_runtime_config_value(key, value)

        # Patch Config in modules that might have imported it directly
        # This fixes issues where test_config.py reloads app.config, causing
        # other modules to hold references to the old Config class
        modules_to_patch = [
            "app.services.core.config_service",
        ]

        for module_name in modules_to_patch:
            if module_name in sys.modules:
                module = sys.modules[module_name]
                if hasattr(module, "Config"):
                    monkeypatch.setattr(module.Config, key, value)

    return set_config


@pytest.fixture
def admin_client(app):
    """
    Create a test client with admin session authentication.
    """
    client = app.test_client()

    # Set admin session by simulating admin login
    import uuid

    admin_session_id = str(uuid.uuid4())

    with client.session_transaction() as sess:
        sess["is_admin"] = True
        sess["active_profile_id"] = TEST_PROFILE_ID

    # Set the app's admin session ID via the utility to ensure it's persisted correctly
    with app.app_context():
        from app.utils.auth import set_admin_session_id

        ensure_test_profile_exists()
        set_admin_session_id(admin_session_id)

    # FlaskClient.set_cookie expects server_name first in this environment.
    client.set_cookie("localhost", "session_id", admin_session_id)

    # Clear any SESSION_PASSWORD that might interfere
    app.config["SESSION_PASSWORD"] = ""

    return client


@pytest.fixture(autouse=True)
def clean_admin_lock(app):
    """Ensure no leftover admin lock file exists between tests."""
    from app.utils.auth import set_admin_session_id

    yield
    with app.app_context():
        set_admin_session_id(None)


@pytest.fixture
def sample_category():
    """Return a sample category dictionary for testing."""
    return {
        "id": "test-category-1",
        "name": "Test Category",
        "path": "/test/path/to/media",
    }


@pytest.fixture
def sample_progress_data():
    """Return sample progress data for testing."""
    return {
        "category_id": "test-cat-1",
        "index": 5,
        "total_count": 20,
        "video_timestamp": 120.5,
        "video_duration": 3600.0,
        "thumbnail_url": "/thumbnails/test-cat-1/thumb.jpg",
    }


@pytest.fixture
def mock_file_storage(tmp_path):
    """
    Create a mock Werkzeug FileStorage object for testing file uploads.
    """
    from werkzeug.datastructures import FileStorage
    from io import BytesIO

    def create_file(
        filename="test_file.txt", content=b"test content", content_type="text/plain"
    ):
        stream = BytesIO(content)
        return FileStorage(stream=stream, filename=filename, content_type=content_type)

    return create_file


class MockSocketIO:
    """Mock SocketIO for testing socket events without actual connections."""

    def __init__(self):
        self.emitted = []

    def emit(self, event, data=None, **kwargs):
        self.emitted.append({"event": event, "data": data, "kwargs": kwargs})

    def init_app(self, app):
        pass

    def on(self, event):
        def wrapper(f):
            return f

        return wrapper

    def on_event(self, event, handler):
        pass

    def on_error_default(self, f):
        return f

    def clear(self):
        self.emitted.clear()

    def get_last_emission(self):
        return self.emitted[-1] if self.emitted else None


@pytest.fixture(autouse=True)
def mock_socketio(monkeypatch):
    """Provide a mock SocketIO instance for testing."""
    mock = MockSocketIO()
    monkeypatch.setattr("app.socketio", mock, raising=False)
    return mock


# Utility functions for tests


def create_test_media_file(directory, filename, size_bytes=1024):
    """Helper to create a test media file of specified size."""
    filepath = os.path.join(directory, filename)
    with open(filepath, "wb") as f:
        f.write(b"x" * size_bytes)
    return filepath


def assert_database_has_entry(db, table, conditions):
    """
    Assert that a database table has an entry matching conditions.

    Args:
        db: Database module or connection
        table: Table name
        conditions: Dict of column->value pairs
    """
    with db.get_db() as conn:
        where_clause = " AND ".join([f"{k} = ?" for k in conditions.keys()])
        cursor = conn.execute(
            f"SELECT * FROM {table} WHERE {where_clause}", tuple(conditions.values())
        )
        result = cursor.fetchone()
        assert result is not None, f"No entry found in {table} matching {conditions}"
        return dict(result)
