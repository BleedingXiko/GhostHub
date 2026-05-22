"""Specter-owned indexing runtime and library scan lifecycle."""

import logging
import os
import time
import traceback

import gevent
from gevent.lock import BoundedSemaphore
from gevent.queue import Empty, JoinableQueue

from app.services.media.indexing_processor import (
    get_large_directory_threshold,
    process_indexing_task,
)
from specter import Service, registry

logger = logging.getLogger(__name__)


class IndexingRuntimeService(Service):
    """Own async indexing orchestration, scan scheduling, and reindex workers."""

    def __init__(self):
        super().__init__(
            'indexing_runtime',
            initial_state={
                'runtime_initialized': False,
                'periodic_scan_enabled': False,
                'scan_interval_seconds': 0,
                'reindex_running': False,
                'queue_size': 0,
                'active_tasks': 0,
                'indexing_paused': False,
            },
        )
        self._runtime_initialized = False
        self._scan_interval_id = None
        self._async_status = {}
        self._async_status_lock = BoundedSemaphore(1)
        self._index_queue = JoinableQueue()
        self._library_scan_running = False
        self._indexing_paused = False
        self._active_tasks = 0

    def on_start(self):
        self.spawn(self._index_worker_loop, label='index-worker')

    def start_async_indexing(
        self,
        category_id,
        category_path,
        category_name,
        *,
        force_refresh=False,
    ):
        """Start async indexing for a category."""
        with self._async_status_lock:
            status = self._async_status.get(category_id)
            if status and status.get('status') == 'running':
                logger.info(
                    "Async indexing already in progress for category '%s'",
                    category_name,
                )
                return dict(status)

            current_time = time.time()
            status_info = {
                'status': 'running',
                'category_id': category_id,
                'category_name': category_name,
                'progress': 0,
                'files': [],
                'timestamp': current_time,
                'total_files': 0,
                'processed_files': 0,
            }
            self._async_status[category_id] = status_info

        self._indexing_paused = False
        self._index_queue.put(
            {
                'category_id': category_id,
                'category_path': category_path,
                'category_name': category_name,
                'force_refresh': force_refresh,
                'timestamp': current_time,
            }
        )
        self.set_state({
            'queue_size': self._index_queue.qsize(),
            'indexing_paused': False,
        })
        logger.info("Queued async indexing task for category '%s'", category_name)
        return dict(status_info)

    def get_async_index_status(self, category_id):
        """Return current async indexing status for a category."""
        with self._async_status_lock:
            status = self._async_status.get(category_id)
            return dict(status) if status else None

    def get_indexing_threshold(self):
        """Return the large-directory threshold used for async indexing."""
        return get_large_directory_threshold()

    def trigger_library_scan(self, *, initial_delay_seconds=60):
        """Trigger a library-wide indexing scan using the current app context."""
        if self._library_scan_running:
            logger.debug("Library scan already running, skipping duplicate trigger")
            return

        self.spawn(
            self._library_scan_task,
            initial_delay_seconds,
            label='library-scan',
        )

    def initialize_runtime(self, *, initial_delay_seconds=60, scan_interval_seconds=0):
        """Initialize indexing scan scheduling once."""
        if self._runtime_initialized:
            return self.get_state()

        self.trigger_library_scan(initial_delay_seconds=initial_delay_seconds)

        interval_seconds = max(0, int(scan_interval_seconds or 0))
        periodic_enabled = interval_seconds > 0
        if periodic_enabled and self._scan_interval_id is None:
            self._scan_interval_id = self.interval(
                lambda: self.trigger_library_scan(initial_delay_seconds=0),
                interval_seconds,
            )

        self._runtime_initialized = True
        self.set_state({
            'runtime_initialized': True,
            'periodic_scan_enabled': periodic_enabled,
            'scan_interval_seconds': interval_seconds,
        })
        return self.get_state()

    def quiesce_indexing(self, *, timeout_seconds=8, clear_queue=True):
        """Pause indexing workers and optionally drain queued tasks."""
        self._indexing_paused = True
        self.set_state({'indexing_paused': True})

        deadline = time.monotonic() + max(0.1, float(timeout_seconds or 8))
        while time.monotonic() < deadline:
            with self._async_status_lock:
                if self._active_tasks <= 0:
                    break
            gevent.sleep(0.05)

        drained = 0
        if clear_queue:
            while True:
                try:
                    self._index_queue.get_nowait()
                    self._index_queue.task_done()
                    drained += 1
                except Empty:
                    break
                except Exception:
                    break

        with self._async_status_lock:
            idle = self._active_tasks <= 0

        self.set_state({
            'queue_size': self._index_queue.qsize(),
            'active_tasks': self._active_tasks,
        })
        return {
            'stopped': idle,
            'drained_tasks': drained,
        }

    def start_background_reindex(
        self,
        categories,
        *,
        active_mounts=None,
        generate_thumbnails=True,
    ):
        """Rebuild indexes for the provided categories in the background."""
        categories = list(categories or [])
        active_mounts = set(active_mounts or [])
        if not categories:
            return False

        self.set_state({'reindex_running': True})
        self.spawn(
            self._background_reindex_worker,
            categories,
            active_mounts,
            bool(generate_thumbnails),
            label='background-reindex',
        )
        return True

    def on_stop(self):
        try:
            self.quiesce_indexing(timeout_seconds=2, clear_queue=True)
        except Exception as exc:
            logger.warning("Indexing runtime shutdown quiesce failed: %s", exc)

    def _background_reindex_worker(self, categories, active_mounts, generate_thumbnails):
        app = self._require_app()

        def is_on_active_mount(path):
            if not path or not active_mounts:
                return True
            for mount in active_mounts:
                if path == mount or path.startswith(mount + os.sep):
                    return True
            return False

        try:
            with app.app_context():
                for category in categories:
                    cat_id = category.get('id')
                    cat_path = category.get('path')
                    cat_name = category.get('name', 'Unknown')
                    if not cat_id or not cat_path or not is_on_active_mount(cat_path):
                        continue

                    process_indexing_task(
                        cat_id,
                        cat_path,
                        cat_name,
                        force_refresh=True,
                        generate_thumbnails=generate_thumbnails,
                        update_status=None,
                        queue_child_category=self.start_async_indexing,
                    )

                logger.info(
                    "Background reindex completed for %s categories",
                    len(categories),
                )

                registry.require('library_events').emit_category_updated(
                    {
                        'reason': 'reindex_complete',
                        'force_refresh': True,
                        'invalidateAll': True,
                    },
                )
        finally:
            self.set_state({'reindex_running': False})

    def _require_app(self):
        manager = registry.require('service_manager')
        if manager is None or getattr(manager, 'app', None) is None:
            raise RuntimeError('Flask app is not available for indexing runtime service')
        return manager.app

    def _library_scan_task(self, initial_delay_seconds):
        if self._library_scan_running:
            return
        self._library_scan_running = True
        try:
            delay = max(0, int(initial_delay_seconds or 0))
            if delay > 0:
                gevent.sleep(delay)

            from app.services.media.category_query_service import get_all_categories_with_details

            logger.info("Starting background library-wide media scan...")
            categories = get_all_categories_with_details(
                use_cache=False,
                show_hidden=True,
            )

            triggered_count = 0
            for category in categories:
                cat_id = category.get('id')
                cat_path = category.get('path')
                cat_name = category.get('name', cat_id)
                if cat_id and cat_path and os.path.exists(cat_path):
                    self.start_async_indexing(cat_id, cat_path, cat_name)
                    triggered_count += 1
                    gevent.sleep(0.2)

            logger.info(
                "Background library-wide scan complete (%s categories triggered)",
                triggered_count,
            )
        except Exception as exc:
            logger.error("Error in background library scan: %s", exc)
            logger.debug(traceback.format_exc())
        finally:
            self._library_scan_running = False

    def _index_worker_loop(self):
        while self.running:
            if self._indexing_paused:
                gevent.sleep(0.05)
                continue

            try:
                task = self._index_queue.get(timeout=0.5)
            except Empty:
                continue

            self.set_state({'queue_size': self._index_queue.qsize()})

            try:
                category_id = task['category_id']
                category_path = task['category_path']
                category_name = task['category_name']
                force_refresh = task['force_refresh']

                with self._async_status_lock:
                    self._active_tasks += 1
                    active_tasks = self._active_tasks
                self.set_state({'active_tasks': active_tasks})

                if not os.path.exists(category_path) or not os.path.isdir(category_path):
                    self._update_status(
                        category_id,
                        status='error',
                        error='Directory not found or not accessible',
                    )
                    continue

                result = process_indexing_task(
                    category_id,
                    category_path,
                    category_name,
                    force_refresh,
                    update_status=self._update_status,
                    queue_child_category=self.start_async_indexing,
                )
                status_preview_files = result.get('files', [])
                processed = result.get('processed', 0)
                total_files = result.get('total_files', processed)
                current_time = result.get('timestamp')
                collection_hash = result.get('hash')

                self._update_status(
                    category_id,
                    status='complete',
                    progress=100,
                    timestamp=current_time,
                    hash=collection_hash,
                    files=status_preview_files,
                    processed_files=processed,
                    total_files=total_files,
                )

                if result.get('index_changed', False):
                    registry.require('library_events').emit_category_updated(
                        {
                            'category_id': category_id,
                            'category_name': category_name,
                            'total_files': total_files,
                            'timestamp': current_time,
                            'reason': 'index_updated',
                            'invalidateCategory': True,
                        },
                    )
            except Exception as exc:
                logger.error("Unexpected error in indexing runtime worker: %s", exc)
                logger.debug(traceback.format_exc())
                category_id = task.get('category_id') if isinstance(task, dict) else None
                if category_id:
                    self._update_status(
                        category_id,
                        status='error',
                        error=str(exc),
                    )
            finally:
                with self._async_status_lock:
                    self._active_tasks = max(0, self._active_tasks - 1)
                    active_tasks = self._active_tasks
                try:
                    self._index_queue.task_done()
                except Exception:
                    pass
                self.set_state({
                    'queue_size': self._index_queue.qsize(),
                    'active_tasks': active_tasks,
                })

    def _update_status(self, category_id, **updates):
        with self._async_status_lock:
            status = self._async_status.get(category_id)
            if status is None:
                return
            files = updates.get('files')
            if files is not None:
                max_files = 2000
                updates['files'] = files[:max_files]
            status.update(updates)
