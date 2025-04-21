"""
Media Service
------------
Manages media file listings, caching, and session-based file tracking.
Supports both shuffled and synchronized viewing modes.
"""
# app/services/media_service.py
import os
import time
import random
import uuid
import logging
import traceback
from flask import current_app, session, request
from app.utils.media_utils import is_media_file, get_media_type
from app.services.category_service import CategoryService

logger = logging.getLogger(__name__)

# In-memory cache for directory listings: {category_id: (timestamp, files_list)}
media_file_cache = {}
last_cache_cleanup = time.time()

# Session tracking: {category_id: {session_id: {"seen": set(), "order": [], "last_access": timestamp}}}
seen_files_tracker = {}
last_session_cleanup = time.time()

# Sync mode file order: {category_id: sorted_files_list}
sync_mode_order = {}

# Constants for memory management
MAX_CACHE_ENTRIES = 100  # Maximum number of categories to cache
MAX_SESSIONS_PER_CATEGORY = 50  # Maximum number of sessions to track per category
SESSION_EXPIRY = 3600  # Session data expires after 1 hour of inactivity

class MediaService:
    """Service for managing media files, listings, and viewing sessions."""

    @staticmethod
    def clean_cache():
        """Remove expired cache entries and enforce size limits."""
        global last_cache_cleanup
        global media_file_cache

        current_time = time.time()
        # Clean up cache more frequently if it grows large, otherwise less often
        cleanup_interval = 60 if len(media_file_cache) < 50 else 30
        if current_time - last_cache_cleanup > cleanup_interval:
            # 1. Remove expired entries
            cache_expiry = current_app.config.get('CACHE_EXPIRY', 300)  # Default 5 minutes
            cleanup_keys = [
                key for key, (timestamp, _) in media_file_cache.items()
                if current_time - timestamp > cache_expiry
            ]

            if cleanup_keys:
                for key in cleanup_keys:
                    del media_file_cache[key]
                logger.info(f"Cache cleanup: removed {len(cleanup_keys)} expired entries.")
            else:
                logger.debug("Cache cleanup: No expired entries found.")

            # 2. Enforce maximum cache size by removing oldest entries if needed
            if len(media_file_cache) > MAX_CACHE_ENTRIES:
                # Sort by timestamp (oldest first)
                sorted_entries = sorted(
                    media_file_cache.items(),
                    key=lambda item: item[1][0]  # Sort by timestamp
                )
                # Remove oldest entries to get back to the limit
                entries_to_remove = len(media_file_cache) - MAX_CACHE_ENTRIES
                for key, _ in sorted_entries[:entries_to_remove]:
                    del media_file_cache[key]
                logger.info(f"Cache size limit enforced: removed {entries_to_remove} oldest entries.")

            last_cache_cleanup = current_time
            
            # Also clean up sessions while we're at it
            MediaService.clean_sessions()

    @staticmethod
    def clean_sessions():
        """Remove inactive sessions and enforce session limits."""
        global last_session_cleanup
        global seen_files_tracker
        
        current_time = time.time()
        # Only run session cleanup periodically
        cleanup_interval = 300  # 5 minutes
        if current_time - last_session_cleanup <= cleanup_interval:
            return
            
        logger.info("Starting session tracker cleanup...")
        session_expiry = current_app.config.get('SESSION_EXPIRY', SESSION_EXPIRY)
        categories_cleaned = 0
        sessions_removed = 0
        
        # For each category
        for category_id in list(seen_files_tracker.keys()):
            category_sessions = seen_files_tracker[category_id]
            
            # 1. Remove expired sessions (not accessed recently)
            expired_sessions = [
                session_id for session_id, data in category_sessions.items()
                if current_time - data.get("last_access", 0) > session_expiry
            ]
            
            for session_id in expired_sessions:
                del category_sessions[session_id]
                sessions_removed += 1
            
            # 2. Enforce maximum sessions per category by removing oldest
            if len(category_sessions) > MAX_SESSIONS_PER_CATEGORY:
                # Sort by last access time (oldest first)
                sorted_sessions = sorted(
                    category_sessions.items(),
                    key=lambda item: item[1].get("last_access", 0)
                )
                # Remove oldest sessions to get back to the limit
                sessions_to_remove = len(category_sessions) - MAX_SESSIONS_PER_CATEGORY
                for session_id, _ in sorted_sessions[:sessions_to_remove]:
                    del category_sessions[session_id]
                    sessions_removed += 1
            
            # 3. Remove empty category entries
            if not category_sessions:
                del seen_files_tracker[category_id]
                categories_cleaned += 1
        
        logger.info(f"Session cleanup complete: removed {sessions_removed} inactive sessions and {categories_cleaned} empty categories.")
        last_session_cleanup = current_time

    @staticmethod
    def list_media_files(category_id, page=1, limit=None, force_refresh=False, shuffle=True):
        """
        Get paginated media files for a category with optional shuffling.
        
        Returns (media_list, pagination_info, error_message) tuple.
        """
        MediaService.clean_cache() # Perform cache cleanup

        limit = limit or current_app.config['DEFAULT_PAGE_SIZE']
        if page < 1:
            return None, None, "Page number must be 1 or greater."
        if not (1 <= limit <= 100): # Example limit range
            return None, None, "Limit must be between 1 and 100."

        category = CategoryService.get_category_by_id(category_id)
        if not category:
            logger.warning(f"Category not found when listing media: {category_id}")
            return None, None, "Category not found."

        category_path = category['path']
        cache_key = category_id
        current_time = time.time()

        # --- File Listing & Caching ---
        all_files = None
        cache_valid = False
        if not force_refresh and cache_key in media_file_cache:
            cache_time, cached_files = media_file_cache[cache_key]
            if current_time - cache_time <= current_app.config['CACHE_EXPIRY']:
                all_files = cached_files
                cache_valid = True
                logger.info(f"Using cached file list for '{category['name']}' ({len(all_files)} files)")
            else:
                logger.info(f"Cache expired for '{category['name']}'")

        if all_files is None:
            if force_refresh:
                logger.info(f"Forcing cache refresh for '{category['name']}'")
            else:
                logger.info(f"Building file list for '{category['name']}'")

            if not os.path.exists(category_path):
                logger.error(f"Category path does not exist: {category_path}")
                return None, None, f"Category path does not exist: {category_path}"
            if not os.path.isdir(category_path):
                logger.error(f"Category path is not a directory: {category_path}")
                return None, None, f"Category path is not a directory: {category_path}"

            try:
                all_files = [f for f in os.listdir(category_path) if is_media_file(f)]
                media_file_cache[cache_key] = (current_time, all_files)
                logger.info(f"Cached {len(all_files)} files for '{category['name']}'")
                cache_valid = True # Cache is now valid
            except PermissionError:
                logger.error(f"Permission denied accessing directory: {category_path}")
                return None, None, f"Permission denied accessing directory: {category_path}"
            except Exception as e:
                logger.error(f"Error listing directory {category_path}: {str(e)}")
                logger.debug(traceback.format_exc())
                return None, None, f"Error listing directory: {str(e)}"

        total_files_in_directory = len(all_files)
        if total_files_in_directory == 0:
             logger.info(f"No media files found in category '{category['name']}'")
             return [], {'page': page, 'limit': limit, 'total': 0, 'hasMore': False}, None


        # --- Session Tracking & Shuffling ---
        session_id = request.cookies.get('session_id')
        if not session_id:
            # This should ideally be set by a middleware or @app.after_request
            # For now, generate one if missing, but this isn't persistent across requests without setting cookie
            session_id = str(uuid.uuid4())
            logger.warning("Session ID cookie not found, generated temporary ID.")

        current_time = time.time()
        if category_id not in seen_files_tracker:
            seen_files_tracker[category_id] = {}
        if session_id not in seen_files_tracker[category_id]:
            seen_files_tracker[category_id][session_id] = {
                "seen": set(), 
                "order": [],
                "last_access": current_time
            }
        else:
            # Update last access time
            seen_files_tracker[category_id][session_id]["last_access"] = current_time

        session_data = seen_files_tracker[category_id][session_id]
        seen_files = session_data["seen"]
        ordered_files = session_data["order"]

        # Determine file order (shuffled or sorted)
        # Sync mode check should happen in the route handler before calling this service
        should_shuffle = shuffle # Assume shuffle unless overridden by sync mode in route

        if should_shuffle:
            # Regenerate order if it's empty, forced, or all files seen
            if not ordered_files or force_refresh or len(seen_files) >= total_files_in_directory:
                if len(seen_files) >= total_files_in_directory:
                    logger.info(f"All files seen for session {session_id} in '{category['name']}', reshuffling.")
                    seen_files.clear() # Reset seen files

                files_to_shuffle = all_files.copy()
                random.shuffle(files_to_shuffle)
                ordered_files = files_to_shuffle
                session_data["order"] = ordered_files
                logger.info(f"Generated new shuffled order ({len(ordered_files)} files) for session {session_id} in '{category['name']}'")
            files_to_paginate = ordered_files
        else: # Logic for shuffle=False (Sync Mode)
            global sync_mode_order
            
            # Check if a consistent order needs to be generated or refreshed
            # Regenerate if forced OR if the order doesn't exist for this category yet.
            # We rely on `all_files` being up-to-date from the cache/listing logic above.
            if force_refresh or category_id not in sync_mode_order:
                # Create and store the definitive sorted order for this sync session
                sync_mode_order[category_id] = sorted(all_files)
                log_message = "Refreshed" if force_refresh else "Generated"
                logger.info(f"{log_message} consistent sorted order for sync mode in category '{category['name']}' ({len(sync_mode_order[category_id])} files)")
            
            # Always use the stored consistent order for pagination in sync mode
            files_to_paginate = sync_mode_order[category_id]
            logger.info(f"Using consistent sync mode order for category '{category['name']}' ({len(files_to_paginate)} files)")
            
            # Ensure session-specific shuffle data is cleared when using sync order
            if session_data["order"] or session_data["seen"]:
                 session_data["order"] = []
                 session_data["seen"].clear()
                 logger.debug(f"Cleared session shuffle data for session {session_id} in category {category_id} due to sync mode.")

        # --- Pagination ---
        start_index = (page - 1) * limit
        end_index = min(start_index + limit, len(files_to_paginate))

        # Handle invalid page number (page beyond available files)
        if start_index >= len(files_to_paginate) and len(files_to_paginate) > 0:
            logger.warning(f"Requested page {page} exceeds available files ({len(files_to_paginate)}). Returning last page.")
            total_pages = (len(files_to_paginate) + limit - 1) // limit
            page = total_pages # Go to the last valid page
            start_index = (page - 1) * limit
            end_index = min(start_index + limit, len(files_to_paginate))

        paginated_filenames = files_to_paginate[start_index:end_index] if start_index < len(files_to_paginate) else []

        # Mark files in the current page as seen (only if shuffling)
        if should_shuffle:
            for filename in paginated_filenames:
                seen_files.add(filename)

        # --- Prepare Response Data ---
        paginated_media_info = []
        from urllib.parse import quote # Local import to avoid circular dependency if moved
        for filename in paginated_filenames:
            try:
                file_path = os.path.join(category_path, filename)
                file_size = 0
                # Check existence and readability before getting size
                if os.path.exists(file_path) and os.access(file_path, os.R_OK):
                    try:
                        file_size = os.path.getsize(file_path)
                    except OSError as size_error:
                        logger.warning(f"Could not get size for {file_path}: {size_error}")
                else:
                     logger.warning(f"File not found or not readable for size check: {file_path}")


                file_type = get_media_type(filename)
                info = {
                    'name': filename,
                    'type': file_type,
                    'size': file_size,
                    'url': f'/media/{category_id}/{quote(filename)}' # URL encode filename
                }
                paginated_media_info.append(info)
            except Exception as file_proc_error:
                logger.error(f"Error processing file '{filename}' in category '{category['name']}': {file_proc_error}")
                # Optionally add an error placeholder to the list
                paginated_media_info.append({
                    'name': filename,
                    'type': 'error',
                    'size': 0,
                    'url': None,
                    'error': f"Failed to process file: {str(file_proc_error)}"
                })

        pagination_details = {
            'page': page,
            'limit': limit,
            'total': total_files_in_directory, # Total files in the directory
            'hasMore': (page * limit) < len(files_to_paginate) # Based on the ordered list length
        }

        return paginated_media_info, pagination_details, None

    @staticmethod
    def get_media_filepath(category_id, filename):
        """
        Get validated filesystem path for a media file with security checks.
        
        Returns (filepath, error_message) tuple.
        """
        category = CategoryService.get_category_by_id(category_id)
        if not category:
            return None, "Category not found."

        if not filename:
            return None, "Filename cannot be empty."

        # Basic security check: prevent directory traversal
        if '..' in filename or filename.startswith('/'):
             logger.warning(f"Potential directory traversal attempt blocked: {filename}")
             return None, "Invalid filename."

        # Construct the full path
        # Ensure the category path itself is treated as absolute or relative to a known root
        # Assuming category['path'] is a reliable absolute or relative path
        try:
            # Normalize the path to handle different OS separators and redundant parts
            full_path = os.path.normpath(os.path.join(category['path'], filename))
        except Exception as path_error:
             logger.error(f"Error constructing path for category {category_id}, filename {filename}: {path_error}")
             return None, "Error constructing file path."


        # Security check: Ensure the final path is still within the intended category directory
        # This is crucial if category['path'] could be manipulated
        # Realpath resolves symlinks, normpath cleans the path string
        try:
            base_dir = os.path.realpath(category['path'])
            target_file = os.path.realpath(full_path)
            if not target_file.startswith(base_dir):
                logger.error(f"Security Alert: Path traversal detected! Attempted access outside base directory. Base: '{base_dir}', Target: '{target_file}'")
                return None, "Access denied."
        except Exception as security_check_error:
             logger.error(f"Error during security path validation: {security_check_error}")
             return None, "File path validation failed."


        # Final checks: existence and file type
        if not os.path.exists(target_file):
            logger.warning(f"Media file not found at path: {target_file}")
            return None, "File not found."
        if not os.path.isfile(target_file):
            logger.warning(f"Path exists but is not a file: {target_file}")
            return None, "Path is not a file."
        if not os.access(target_file, os.R_OK):
            logger.warning(f"File exists but is not readable: {target_file}")
            return None, "File not readable."

        logger.info(f"Validated media file path: {target_file}")
        return target_file, None

    @staticmethod
    def clear_session_tracker(category_id=None, session_id=None):
        """Clear session tracking data for specified or all sessions/categories."""
        global seen_files_tracker, sync_mode_order
        if category_id and session_id:
            if category_id in seen_files_tracker and session_id in seen_files_tracker[category_id]:
                del seen_files_tracker[category_id][session_id]
                logger.info(f"Cleared tracker for session {session_id} in category {category_id}")
        elif category_id:
            # Clear trackers for the category
            if category_id in seen_files_tracker:
                del seen_files_tracker[category_id]
                logger.info(f"Cleared tracker for all sessions in category {category_id}")
            
            # Also clear sync mode order for the category
            if category_id in sync_mode_order:
                del sync_mode_order[category_id]
                logger.info(f"Cleared sync mode order for category {category_id}")
        elif session_id:
            for cat_id in list(seen_files_tracker.keys()):
                if session_id in seen_files_tracker[cat_id]:
                    del seen_files_tracker[cat_id][session_id]
            logger.info(f"Cleared tracker for session {session_id} across all categories")
        else:
            # Clear all trackers and sync mode orders
            seen_files_tracker.clear()
            sync_mode_order.clear()
            logger.info("Cleared entire seen files tracker and sync mode orders.")
