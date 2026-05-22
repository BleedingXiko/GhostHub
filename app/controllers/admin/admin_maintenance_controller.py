"""Admin maintenance controller built on Specter."""

import logging
import os
import re
import shutil
import stat

import gevent

from app.services.media.category_query_service import get_all_categories_with_details
from specter import Controller, registry
from app.utils.auth import admin_required

logger = logging.getLogger(__name__)


class AdminMaintenanceController(Controller):
    """Own admin data-clear and media reindex endpoints."""

    name = 'admin_maintenance'
    url_prefix = '/api/admin'

    def build_routes(self, router):
        @router.route('/data/clear-all', methods=['POST'])
        @admin_required
        def clear_all_user_data():
            """Clear all persisted user/runtime data."""
            return self.clear_all_user_data()

        @router.route('/reindex-media', methods=['POST'])
        @admin_required
        def reindex_media():
            """Reindex media metadata without clearing generated caches."""
            return self.reindex_media()

        @router.route('/regenerate-thumbnails', methods=['POST'])
        @admin_required
        def regenerate_thumbnails():
            """Clear thumbnail cache and requeue thumbnail generation."""
            return self.regenerate_thumbnails()

        @router.route('/clear-generated-cache', methods=['POST'])
        @admin_required
        def clear_generated_cache():
            """Clear generated .ghosthub cache data without reindexing."""
            return self.clear_generated_cache()

    def clear_all_user_data(self):
        """Clear server-level admin data (not profile-owned data like progress)."""
        try:
            cleared = {
                'subtitles': 0,
                'hidden_categories': 0,
                'hidden_files': 0,
                'media_index': 0,
            }

            from app.services import subtitle_service
            cache_dir = subtitle_service.get_subtitle_cache_dir()
            if os.path.exists(cache_dir):
                count = 0
                for filename in os.listdir(cache_dir):
                    if filename.endswith('.vtt'):
                        try:
                            os.remove(os.path.join(cache_dir, filename))
                            count += 1
                        except OSError:
                            pass
                cleared['subtitles'] = count

            from app.services.media.media_index_service import clear_all_media_index
            from app.services.media.hidden_content_service import (
                unhide_all_categories,
                unhide_all_files,
            )
            from app.services.media.category_cache_service import invalidate_cache

            cat_success, cat_message = unhide_all_categories()
            if cat_success:
                match = re.search(r"\((\d+) total\)", cat_message)
                if match:
                    cleared['hidden_categories'] = int(match.group(1))

            file_success, file_message = unhide_all_files()
            if file_success:
                match = re.search(r"\((\d+) total\)", file_message)
                if match:
                    cleared['hidden_files'] = int(match.group(1))

            try:
                success, index_count = clear_all_media_index()
                if success:
                    cleared['media_index'] = index_count
            except Exception as exc:
                logger.warning("Could not clear media indexes: %s", exc)

            invalidate_cache()

            return {
                'success': True,
                'message': (
                    f"Cleared {cleared['subtitles']} subtitles, "
                    f"{cleared['hidden_categories']} hidden categories, "
                    f"{cleared['hidden_files']} hidden files, and "
                    f"{cleared['media_index']} media index records."
                ),
                'cleared': cleared,
            }
        except Exception as exc:
            logger.error("Error clearing user data: %s", exc)
            return {'success': False, 'error': str(exc)}, 500

    def reindex_media(self):
        """Reindex media metadata without clearing thumbnails or .ghosthub."""
        try:
            from app.services.media.category_cache_service import invalidate_cache
            from app.services.media.media_index_service import (
                delete_media_index_by_category,
            )

            logger.info("Admin initiated media reindex")

            try:
                indexer_state = registry.require('indexing_runtime').quiesce_indexing(
                    timeout_seconds=8,
                    clear_queue=True,
                )
                logger.info(
                    "Reindex quiesce complete: indexer_stopped=%s, indexer_queue_drained=%s",
                    indexer_state.get('stopped', False),
                    indexer_state.get('drained_tasks', 0),
                )
            except Exception as exc:
                logger.error("Quiesce step failed during reindex: %s", exc)
                return {
                    'success': False,
                    'error': 'Failed to pause background workers before reindex',
                }, 500

            if not indexer_state.get('stopped', False):
                logger.error(
                    "Reindex aborted: background indexer did not stop within timeout"
                )
                return {
                    'success': False,
                    'error': (
                        "Background indexer is still running; retry reindex in a few seconds"
                    ),
                }, 409

            categories, active_mounts, skipped_unmounted = self._get_active_categories_and_mounts()

            active_cleared = 0
            for category in categories:
                cat_id = category.get('id')
                cat_path = category.get('path')
                if not cat_id or not cat_path or not self._is_on_active_mount(cat_path, active_mounts):
                    continue
                if delete_media_index_by_category(cat_id):
                    active_cleared += 1

            logger.info("Cleared media_index records for %s active categories", active_cleared)

            invalidate_cache()
            logger.info("Cache invalidated - starting background metadata reindex")
            registry.require('library_runtime').start_background_reindex(
                categories,
                active_mounts=active_mounts,
                generate_thumbnails=False,
            )

            message_parts = [
                f"Cleared media indexes for {active_cleared} active categor(ies)"
            ]
            if skipped_unmounted > 0:
                message_parts.append(f"Skipped {skipped_unmounted} unmounted drive(s)")
            message_parts.append(
                "Fresh media indexing started in background"
            )
            message_parts.append(
                "Existing thumbnails and generated cache were left untouched"
            )

            response_data = {
                'success': True,
                'message': ". ".join(message_parts),
                'deleted_count': 0,
                'partial_count': 0,
                'skipped_locked_files': 0,
                'error_count': 0,
            }
            return response_data
        except Exception as exc:
            logger.error("Error during media reindex: %s", exc)
            return {'success': False, 'error': str(exc)}, 500

    def regenerate_thumbnails(self):
        """Clear thumbnail cache and requeue thumbnail generation from indexed media."""
        try:
            from app.utils.file_utils import GHOSTHUB_DIR_NAME
            from app.utils.media_utils import THUMBNAIL_DIR_NAME

            logger.info("Admin initiated thumbnail regeneration")

            try:
                thumbnail_runtime = registry.require('thumbnail_runtime')
                runtime_state = thumbnail_runtime.quiesce_thumbnail_runtime(
                    timeout_seconds=8,
                    clear_queue=True,
                )
                logger.info(
                    "Thumbnail regeneration quiesce complete: idle=%s, drained_tasks=%s",
                    runtime_state.get('idle', False),
                    runtime_state.get('drained_tasks', 0),
                )
            except Exception as exc:
                logger.error("Thumbnail quiesce failed during regeneration: %s", exc)
                return {
                    'success': False,
                    'error': 'Failed to pause thumbnail workers before regeneration',
                }, 500

            categories, active_mounts, skipped_unmounted = self._get_active_categories_and_mounts()
            deleted_count = 0
            partial_count = 0
            skipped_locked_files = 0
            warnings = []

            try:
                for category in categories:
                    cat_path = category.get('path', '')
                    cat_name = category.get('name', 'Unknown')
                    if not cat_path or not self._is_on_active_mount(cat_path, active_mounts):
                        continue

                    success, exists = self._with_timeout(
                        os.path.exists,
                        args=(cat_path,),
                        timeout_seconds=3.0,
                        default=False,
                    )
                    if not success or not exists:
                        continue

                    thumbnail_path = os.path.join(
                        cat_path,
                        GHOSTHUB_DIR_NAME,
                        THUMBNAIL_DIR_NAME,
                    )
                    success, thumb_exists = self._with_timeout(
                        os.path.exists,
                        args=(thumbnail_path,),
                        timeout_seconds=3.0,
                        default=False,
                    )
                    if success and thumb_exists:
                        purge = self._purge_ghosthub_dir(thumbnail_path, io_timeout=3.0)
                        if purge['fully_removed']:
                            deleted_count += 1
                        else:
                            partial_count += 1
                            skipped_locked_files += len(purge['locked_or_failed'])
                            warnings.append(
                                f"{cat_name}: skipped {len(purge['locked_or_failed'])} locked/in-use item(s)"
                            )
            finally:
                thumbnail_runtime.ensure_workers()

            self.spawn(
                self._background_regenerate_thumbnails,
                categories,
                active_mounts,
                label='admin-regenerate-thumbnails',
            )

            message_parts = [f"Cleared {deleted_count} thumbnail cache folder(s)"]
            if partial_count > 0:
                message_parts.append(
                    f"Partially cleaned {partial_count} folder(s); skipped {skipped_locked_files} locked/in-use file(s)"
                )
            if skipped_unmounted > 0:
                message_parts.append(f"Skipped {skipped_unmounted} unmounted drive(s)")
            message_parts.append(
                "Thumbnail generation restarted in background using the current media index"
            )

            response_data = {
                'success': True,
                'message': ". ".join(message_parts),
                'deleted_count': deleted_count,
                'partial_count': partial_count,
                'skipped_locked_files': skipped_locked_files,
                'error_count': 0,
            }
            if warnings:
                response_data['warnings'] = warnings[:50]
            return response_data
        except Exception as exc:
            logger.error("Error regenerating thumbnails: %s", exc)
            return {'success': False, 'error': str(exc)}, 500

    def clear_generated_cache(self):
        """Clear .ghosthub generated cache data without touching media indexes."""
        try:
            from app.utils.file_utils import GHOSTHUB_DIR_NAME

            logger.info("Admin initiated full generated-cache clear")

            try:
                thumbnail_runtime = registry.require('thumbnail_runtime')
                runtime_state = thumbnail_runtime.quiesce_thumbnail_runtime(
                    timeout_seconds=8,
                    clear_queue=True,
                )
                logger.info(
                    "Generated-cache clear quiesce complete: idle=%s, drained_tasks=%s",
                    runtime_state.get('idle', False),
                    runtime_state.get('drained_tasks', 0),
                )
            except Exception as exc:
                logger.error("Thumbnail quiesce failed during cache clear: %s", exc)
                return {
                    'success': False,
                    'error': 'Failed to pause thumbnail workers before clearing generated cache',
                }, 500

            categories, active_mounts, skipped_unmounted = self._get_active_categories_and_mounts()
            deleted_count = 0
            partial_count = 0
            skipped_locked_files = 0
            warnings = []

            try:
                for category in categories:
                    cat_path = category.get('path', '')
                    cat_name = category.get('name', 'Unknown')
                    if not cat_path or not self._is_on_active_mount(cat_path, active_mounts):
                        continue

                    success, exists = self._with_timeout(
                        os.path.exists,
                        args=(cat_path,),
                        timeout_seconds=3.0,
                        default=False,
                    )
                    if not success or not exists:
                        continue

                    ghosthub_path = os.path.join(cat_path, GHOSTHUB_DIR_NAME)
                    success, gh_exists = self._with_timeout(
                        os.path.exists,
                        args=(ghosthub_path,),
                        timeout_seconds=3.0,
                        default=False,
                    )
                    if success and gh_exists:
                        purge = self._purge_ghosthub_dir(ghosthub_path, io_timeout=3.0)
                        if purge['fully_removed']:
                            deleted_count += 1
                        else:
                            partial_count += 1
                            skipped_locked_files += len(purge['locked_or_failed'])
                            warnings.append(
                                f"{cat_name}: skipped {len(purge['locked_or_failed'])} locked/in-use item(s)"
                            )
            finally:
                thumbnail_runtime.ensure_workers()

            message_parts = [f"Cleared {deleted_count} .ghosthub folder(s)"]
            if partial_count > 0:
                message_parts.append(
                    f"Partially cleaned {partial_count} folder(s); skipped {skipped_locked_files} locked/in-use file(s)"
                )
            if skipped_unmounted > 0:
                message_parts.append(f"Skipped {skipped_unmounted} unmounted drive(s)")
            message_parts.append("Media indexes were left untouched")

            response_data = {
                'success': True,
                'message': ". ".join(message_parts),
                'deleted_count': deleted_count,
                'partial_count': partial_count,
                'skipped_locked_files': skipped_locked_files,
                'error_count': 0,
            }
            if warnings:
                response_data['warnings'] = warnings[:50]
            return response_data
        except Exception as exc:
            logger.error("Error clearing generated cache: %s", exc)
            return {'success': False, 'error': str(exc)}, 500

    def _background_regenerate_thumbnails(self, categories, active_mounts):
        """Requeue thumbnails from the current media index after cache clearing."""
        try:
            thumbnail_runtime = registry.require('thumbnail_runtime')
            for category in categories:
                cat_id = category.get('id')
                cat_path = category.get('path')
                if (
                    not cat_id
                    or not cat_path
                    or not self._is_on_active_mount(cat_path, active_mounts)
                ):
                    continue
                try:
                    thumbnail_runtime.regenerate_category_from_index(
                        cat_path,
                        cat_id,
                        force_refresh=True,
                    )
                except Exception as exc:
                    logger.warning(
                        "Thumbnail regeneration failed for %s: %s",
                        cat_id,
                        exc,
                    )
        except Exception as exc:
            logger.error("Background thumbnail regeneration failed: %s", exc)

    def _get_active_categories_and_mounts(self):
        from app.services.storage.storage_drive_service import get_current_mount_paths

        categories = get_all_categories_with_details(
            use_cache=False,
            show_hidden=True,
        )
        try:
            active_mounts = get_current_mount_paths()
        except Exception:
            active_mounts = set()

        skipped_unmounted = 0
        for category in categories:
            cat_path = category.get('path')
            if cat_path and not self._is_on_active_mount(cat_path, active_mounts):
                skipped_unmounted += 1

        return categories, active_mounts, skipped_unmounted

    def _is_on_active_mount(self, path, active_mounts):
        if not path or not active_mounts:
            return True
        for mount in active_mounts:
            if path.startswith(mount + os.sep) or path == mount:
                return True
        return False

    def _with_timeout(self, func, args=(), kwargs=None, timeout_seconds=5.0, default=None):
        if kwargs is None:
            kwargs = {}

        try:
            result_container = {'done': False, 'value': default, 'error': None}

            def runner():
                try:
                    result_container['value'] = func(*args, **kwargs)
                    result_container['done'] = True
                except Exception as exc:
                    result_container['error'] = exc

            greenlet = self.spawn(runner)
            if greenlet is None:
                return False, RuntimeError("Failed to spawn greenlet")

            greenlet.join(timeout=timeout_seconds)
            if greenlet.successful() and result_container['done']:
                return True, result_container['value']
            if result_container['error']:
                return False, result_container['error']
            try:
                greenlet.kill()
            except Exception:
                pass
            return False, TimeoutError(f"Operation timed out after {timeout_seconds}s")
        except Exception:
            try:
                return True, func(*args, **kwargs)
            except Exception as exc:
                return False, exc

    def _safe_remove_with_retries(self, target_path, remove_func, retries=5):
        last_error = None
        for attempt in range(retries):
            try:
                try:
                    os.chmod(target_path, stat.S_IWRITE | stat.S_IREAD)
                except Exception:
                    pass
                remove_func(target_path)
                return True, None
            except FileNotFoundError:
                return True, None
            except Exception as exc:
                last_error = exc
                gevent.sleep(0.08 * (attempt + 1))
        return False, str(last_error) if last_error else "unknown remove error"

    def _purge_ghosthub_dir(self, ghosthub_path, io_timeout=3.0):
        result = {
            'fully_removed': False,
            'removed_files': 0,
            'removed_dirs': 0,
            'locked_or_failed': [],
        }

        if not ghosthub_path:
            result['fully_removed'] = True
            return result

        success, exists = self._with_timeout(
            os.path.exists,
            args=(ghosthub_path,),
            timeout_seconds=io_timeout,
            default=False,
        )
        if not success:
            result['locked_or_failed'].append(
                f"{ghosthub_path}: timeout checking existence"
            )
            return result
        if not exists:
            result['fully_removed'] = True
            return result

        success, is_file = self._with_timeout(
            os.path.isfile,
            args=(ghosthub_path,),
            timeout_seconds=io_timeout,
            default=False,
        )
        if not success:
            result['locked_or_failed'].append(f"{ghosthub_path}: timeout checking if file")
            return result

        if is_file:
            ok, err = self._safe_remove_with_retries(ghosthub_path, os.remove)
            if ok:
                result['removed_files'] += 1
                result['fully_removed'] = True
            else:
                result['locked_or_failed'].append(f"{ghosthub_path}: {err}")
            return result

        def _walk_with_timeout():
            try:
                return list(os.walk(ghosthub_path, topdown=False))
            except Exception as exc:
                return exc

        success, walk_result = self._with_timeout(
            _walk_with_timeout,
            timeout_seconds=io_timeout * 3,
        )
        if not success:
            result['locked_or_failed'].append(
                f"{ghosthub_path}: timeout during directory walk"
            )
            return result
        if isinstance(walk_result, Exception):
            result['locked_or_failed'].append(f"{ghosthub_path}: {walk_result}")
            return result

        for root, dirs, files in walk_result:
            for filename in files:
                fp = os.path.join(root, filename)
                ok, err = self._safe_remove_with_retries(fp, os.remove)
                if ok:
                    result['removed_files'] += 1
                else:
                    result['locked_or_failed'].append(f"{fp}: {err}")
            gevent.sleep(0)

            for dirname in dirs:
                dp = os.path.join(root, dirname)
                ok, err = self._safe_remove_with_retries(dp, os.rmdir)
                if ok:
                    result['removed_dirs'] += 1
                else:
                    result['locked_or_failed'].append(f"{dp}: {err}")

        ok, err = self._safe_remove_with_retries(ghosthub_path, os.rmdir)
        if ok:
            result['removed_dirs'] += 1
            result['fully_removed'] = True
            return result

        local_failures = []

        def _onerror(func, path, exc_info):
            ok_inner, err_inner = self._safe_remove_with_retries(path, func)
            if not ok_inner:
                local_failures.append(f"{path}: {err_inner}")

        def _rmtree_with_timeout():
            try:
                shutil.rmtree(ghosthub_path, onerror=_onerror)
                return None
            except Exception as exc:
                return exc

        success, rmtree_err = self._with_timeout(
            _rmtree_with_timeout,
            timeout_seconds=io_timeout * 2,
        )
        if not success:
            local_failures.append(f"{ghosthub_path}: timeout during rmtree")
        elif rmtree_err:
            local_failures.append(f"{ghosthub_path}: {rmtree_err}")

        success, still_exists = self._with_timeout(
            os.path.exists,
            args=(ghosthub_path,),
            timeout_seconds=io_timeout,
            default=True,
        )
        if success and not still_exists:
            result['fully_removed'] = True
        else:
            if err:
                result['locked_or_failed'].append(f"{ghosthub_path}: {err}")
        if local_failures:
            result['locked_or_failed'].extend(local_failures)
        return result
