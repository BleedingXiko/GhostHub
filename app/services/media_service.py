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
from app.utils.media_utils import is_media_file, get_media_type, get_thumbnail_url, process_category_thumbnails
from app.services.category_service import CategoryService
from app.services.indexing_service import IndexingService
from app.utils.file_utils import load_index, save_index, is_large_directory

logger = logging.getLogger(__name__)

# Session tracking: {category_id: {session_id: {"seen": set(), "order": [], "last_access": timestamp}}}
seen_files_tracker = {}
last_session_cleanup = time.time()

# Sync mode file order: {category_id: sorted_files_list}
sync_mode_order = {}

# Constants for memory management
MAX_SESSIONS_PER_CATEGORY = 50  # Maximum number of sessions to track per category
SESSION_EXPIRY = 3600  # Session data expires after 1 hour of inactivity

# Use IndexingService.LARGE_DIRECTORY_THRESHOLD instead of defining it here

class MediaService:
    """Service for managing media files, listings, and viewing sessions."""

    @staticmethod
    def _load_or_rebuild_index(category_path, category_name, category_id, force_refresh, cache_expiry):
        """
        Loads a media index from cache or rebuilds it from the directory.
        Handles index validation, saving, and triggers async indexing or sync thumbnail processing.
        Returns all_files_metadata list or None if path is invalid.
        """
        current_time = time.time()
        all_files_metadata = None

        # 1. Try loading the index
        index_data = load_index(category_path) if not force_refresh else None

        # 2. Validate the loaded index
        if index_data and 'timestamp' in index_data and 'files' in index_data:
            if current_time - index_data['timestamp'] <= cache_expiry:
                all_files_metadata = index_data['files']
                logger.info(f"Using valid index file for '{category_name}' ({len(all_files_metadata)} files)")
            else:
                logger.info(f"Index file expired for '{category_name}'")
                index_data = None  # Treat expired index as invalid

        # 3. If index is invalid, missing, or force_refresh is true, scan directory and rebuild index
        if all_files_metadata is None:
            if force_refresh:
                logger.info(f"Forcing index refresh for '{category_name}'")
            elif index_data:
                logger.info(f"Rebuilding expired index for '{category_name}'")
            else:
                logger.info(f"Index not found or invalid, building index for '{category_name}'")

            if not os.path.exists(category_path):
                logger.error(f"Category path does not exist: {category_path}")
                return None # Indicates error to caller
            if not os.path.isdir(category_path):
                logger.error(f"Category path is not a directory: {category_path}")
                return None # Indicates error to caller

            try:
                logger.info(f"Scanning all files for '{category_name}' to create index")
                current_files_metadata = []
                for filename in os.listdir(category_path):
                    if is_media_file(filename):
                        try:
                            filepath = os.path.join(category_path, filename)
                            stats = os.stat(filepath)
                            current_files_metadata.append({
                                'name': filename,
                                'size': stats.st_size,
                                'mtime': stats.st_mtime
                            })
                        except FileNotFoundError:
                            logger.warning(f"File disappeared during indexing: {filepath}")
                        except Exception as stat_error:
                            logger.warning(f"Could not get stats for file {filepath}: {stat_error}")
                
                all_files_metadata = current_files_metadata # Assign scanned files
                
                new_index_data = {'timestamp': time.time(), 'files': all_files_metadata}
                try:
                    index_saved = save_index(category_path, new_index_data)
                    if index_saved:
                        logger.info(f"Successfully saved index for '{category_name}' with {len(all_files_metadata)} files")
                    else:
                        logger.error(f"Failed to save index for '{category_name}'")
                except Exception as save_error:
                    logger.error(f"Error saving index for '{category_name}': {save_error}")
                
                if is_large_directory(category_path, IndexingService.LARGE_DIRECTORY_THRESHOLD):
                    logger.info(f"Large directory detected for '{category_name}', starting async indexing")
                    IndexingService.start_async_indexing(
                        category_id, 
                        category_path, 
                        category_name,
                        force_refresh # Pass force_refresh to async task as well
                    )
                else:
                    try:
                        image_count, video_count, thumbnails_generated = process_category_thumbnails(
                            category_path, all_files_metadata, force_refresh
                        )
                        logger.info(f"Processed thumbnails synchronously for '{category_name}': {thumbnails_generated} generated/updated "
                                   f"({video_count} videos, {image_count} images)")
                    except Exception as thumb_error:
                        logger.error(f"Error processing thumbnails synchronously for '{category_name}': {thumb_error}")
                        logger.debug(traceback.format_exc())
            except PermissionError:
                logger.error(f"Permission denied accessing directory: {category_path}")
                return None # Indicates error to caller
            except Exception as e:
                logger.error(f"Error scanning directory or building index for {category_path}: {str(e)}")
                logger.debug(traceback.format_exc())
                return None # Indicates error to caller
        
        return all_files_metadata

    @staticmethod
    def _determine_file_order(all_files_metadata, category_id, session_id, shuffle_preference, force_refresh, category_name):
        """
        Determines the order of media files based on shuffle preference, sync state, and session data.
        Returns a list of filenames in the determined order.
        """
        from .sync_service import SyncService # Local import due to potential circularity
        global seen_files_tracker, sync_mode_order

        all_filenames = [f_meta['name'] for f_meta in all_files_metadata]
        total_files_in_directory = len(all_filenames)

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
            seen_files_tracker[category_id][session_id]["last_access"] = current_time

        session_data = seen_files_tracker[category_id][session_id]
        
        # Check if we should use the sync session order
        sync_active_order = None
        if SyncService.is_sync_enabled():
            sync_active_order = SyncService.get_sync_order(category_id)
            if sync_active_order:
                logger.info(f"Using active sync session order for category {category_id} with {len(sync_active_order)} items")
                # Clear session-specific shuffle data when using an active sync order
                if session_data["order"] or session_data["seen"]:
                    session_data["order"] = []
                    session_data["seen"].clear()
                    logger.debug(f"Cleared session shuffle data for session {session_id} in category {category_id} due to active sync.")
                return sync_active_order # Return the active sync order directly

        # If not in active sync or no specific sync order, proceed with shuffle/sort logic
        if shuffle_preference:
            ordered_files_from_session = session_data["order"]
            seen_files_from_session = session_data["seen"]
            if not ordered_files_from_session or force_refresh or len(seen_files_from_session) >= total_files_in_directory:
                if len(seen_files_from_session) >= total_files_in_directory:
                    logger.info(f"All files seen for session {session_id} in '{category_name}', reshuffling.")
                    seen_files_from_session.clear()

                files_to_shuffle = all_filenames.copy()
                random.shuffle(files_to_shuffle)
                session_data["order"] = files_to_shuffle
                logger.info(f"Generated new shuffled order ({len(files_to_shuffle)} files) for session {session_id} in '{category_name}'")
            return session_data["order"]
        else: # Not shuffling (e.g., default for sync mode if no active sync order, or if shuffle=False passed)
            if force_refresh or category_id not in sync_mode_order:
                sync_mode_order[category_id] = sorted(all_filenames)
                log_message = "Refreshed" if force_refresh else "Generated"
                logger.info(f"{log_message} consistent sorted order for non-shuffle/sync mode in category '{category_name}' ({len(sync_mode_order[category_id])} files)")
            
            # Clear session-specific shuffle data if we are falling back to sorted order
            if session_data["order"] or session_data["seen"]:
                 session_data["order"] = []
                 session_data["seen"].clear()
                 logger.debug(f"Cleared session shuffle data for session {session_id} in category {category_id} due to non-shuffle mode.")
            return sync_mode_order[category_id]

    @staticmethod
    def _prepare_paginated_response_data(paginated_filenames, category_id, all_files_metadata_lookup):
        """
        Prepares the detailed media information for a list of paginated filenames.
        """
        from urllib.parse import quote # Local import due to potential circularity
        paginated_media_info = []
        for filename in paginated_filenames:
            try:
                file_meta = all_files_metadata_lookup.get(filename)
                if not file_meta:
                    logger.warning(f"Metadata not found in index for file: {filename}. Skipping.")
                    continue

                file_type = get_media_type(filename)
                info = {
                    'name': filename,
                    'type': file_type,
                    'size': file_meta.get('size', 0),
                    'url': f'/media/{category_id}/{quote(filename)}'
                }
                if file_type == 'video':
                    info['thumbnailUrl'] = get_thumbnail_url(category_id, filename)
                paginated_media_info.append(info)
            except Exception as file_proc_error:
                logger.error(f"Error preparing response data for file '{filename}' in category '{category_id}': {file_proc_error}")
                paginated_media_info.append({
                    'name': filename, 'type': 'error', 'size': 0, 'url': None,
                    'error': f"Failed to process file: {str(file_proc_error)}"
                })
        return paginated_media_info

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
    def get_session_order(category_id, session_id):
        """
        Get the current media order for a specific session in a category.
        Returns the order list if found, None otherwise.
        """
        global seen_files_tracker
        if category_id in seen_files_tracker and session_id in seen_files_tracker[category_id]:
            return seen_files_tracker[category_id][session_id].get('order')
        return None

    @staticmethod
    def list_media_files(category_id, page=1, limit=None, force_refresh=False, shuffle=True):
        """
        Get paginated media files for a category with optional shuffling.
        
        Returns (media_list, pagination_info, error_message) tuple.
        """
        from .sync_service import SyncService
        MediaService.clean_sessions()

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
        category_name = category['name']
        cache_expiry = current_app.config.get('CACHE_EXPIRY', 300)

        all_files_metadata = MediaService._load_or_rebuild_index(
            category_path, category_name, category_id, force_refresh, cache_expiry
        )

        if all_files_metadata is None: # Error occurred in _load_or_rebuild_index
            # Specific error messages are logged in the helper
            return None, None, f"Failed to load or build index for category '{category_name}'."

        if not all_files_metadata: # No files found
            logger.info(f"No media files found in category '{category_name}'")
            return [], {'page': page, 'limit': limit, 'total': 0, 'hasMore': False}, None
        
        total_files_in_directory = len(all_files_metadata)
        logger.info(f"Total files indexed for '{category_name}': {total_files_in_directory}")

        session_id = request.cookies.get('session_id')
        if not session_id:
            session_id = str(uuid.uuid4()) # Temporary ID if cookie not present
            logger.warning("Session ID cookie not found, generated temporary ID for ordering.")

        files_to_paginate = MediaService._determine_file_order(
            all_files_metadata, category_id, session_id, shuffle, force_refresh, category_name
        )
        
        # --- Pagination ---
        start_index = (page - 1) * limit
        # Handle invalid page number (page beyond available files)
        if start_index >= len(files_to_paginate) and len(files_to_paginate) > 0:
            logger.warning(f"Requested page {page} exceeds available files ({len(files_to_paginate)}). Returning last page.")
            total_pages = (len(files_to_paginate) + limit - 1) // limit
            page = total_pages # Go to the last valid page
            start_index = (page - 1) * limit
        
        end_index = min(start_index + limit, len(files_to_paginate))
        paginated_filenames = files_to_paginate[start_index:end_index] if start_index < len(files_to_paginate) else []

        # Mark files in the current page as seen (only if shuffling and not in active sync)
        # The _determine_file_order handles sync_active_order, so if shuffle is true here, it's not overridden by active sync.
        if shuffle: 
            session_data = seen_files_tracker.get(category_id, {}).get(session_id)
            if session_data:
                for filename in paginated_filenames:
                    session_data["seen"].add(filename)
        
        # --- Prepare Response Data ---
        all_files_metadata_lookup = {f_meta['name']: f_meta for f_meta in all_files_metadata}
        paginated_media_info = MediaService._prepare_paginated_response_data(
            paginated_filenames, category_id, all_files_metadata_lookup
        )

        pagination_details = {
            'page': page,
            'limit': limit,
            'total': total_files_in_directory,
            'hasMore': (page * limit) < len(files_to_paginate)
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
    def start_async_indexing(category_id, category_path, category_name, force_refresh=False):
        """
        Start asynchronous indexing of a category directory.
        Delegates to IndexingService.
        
        Args:
            category_id (str): The category ID.
            category_path (str): The path to the category directory.
            category_name (str): The name of the category (for logging).
            force_refresh (bool): Whether to force a refresh of the index.
            
        Returns:
            dict: Initial status information.
        """
        return IndexingService.start_async_indexing(
            category_id, 
            category_path, 
            category_name, 
            force_refresh
        )
    
    @staticmethod
    def get_async_index_status(category_id):
        """
        Get the current status of async indexing for a category.
        Delegates to IndexingService.
        
        Args:
            category_id (str): The category ID.
            
        Returns:
            dict: Status information or None if no indexing has been started.
        """
        return IndexingService.get_async_index_status(category_id)
    
    
    @staticmethod
    def list_media_files_async(category_id, page=1, limit=None, force_refresh=False, shuffle=True):
        """
        Get paginated media files for a category with async indexing for large directories.
        This is a wrapper around list_media_files that uses async indexing for large directories.
        
        Returns (media_list, pagination_info, error_message, is_async) tuple.
        """
        # Get category info
        category = CategoryService.get_category_by_id(category_id)
        if not category:
            return None, None, "Category not found.", False
        
        category_path = category['path']
        
        # First check if a valid index file already exists
        index_data = load_index(category_path)
        cache_expiry = current_app.config.get('CACHE_EXPIRY', 300)
        current_time = time.time()
        
        # Check if the index file is valid
        has_valid_index = (index_data and 'timestamp' in index_data and 'files' in index_data and 
                          current_time - index_data['timestamp'] <= cache_expiry)
        
        # If we have a valid index file, use it directly without async indexing
        # Even if force_refresh is True, we can still use the index file and avoid async indexing
        if has_valid_index:
            logger.info(f"Using existing valid index file for '{category['name']}' without async indexing (force_refresh: {force_refresh})")
            return MediaService.list_media_files(category_id, page, limit, force_refresh, shuffle) + (False,)
        
        # Check if this is a large directory that should use async indexing
        if is_large_directory(category_path, IndexingService.LARGE_DIRECTORY_THRESHOLD):
            logger.info(f"Large directory detected for '{category['name']}', using async indexing")
            
            # Check if async indexing is already in progress or complete
            status = IndexingService.get_async_index_status(category_id)
            
            if not status or status['status'] == 'error' or force_refresh:
                # Start or restart async indexing
                status = MediaService.start_async_indexing(
                    category_id, 
                    category_path, 
                    category['name'],
                    force_refresh
                )
            
            # If indexing is complete, use the cached results
            if status['status'] == 'complete':
                logger.info(f"Using completed async index for '{category['name']}'")
                # Use regular method with the cached index
                return MediaService.list_media_files(category_id, page, limit, False, shuffle) + (False,)
            
            # If indexing is still running, return partial results if available
            if status['files']:
                # Create a partial response with available files
                available_files = status['files']
                total_files = status['total_files'] or len(available_files)
                
                # Apply pagination to available files
                limit = limit or current_app.config['DEFAULT_PAGE_SIZE']
                start_index = (page - 1) * limit
                end_index = min(start_index + limit, len(available_files))
                
                paginated_files = available_files[start_index:end_index] if start_index < len(available_files) else []
                
                # Convert to media info format
                paginated_media_info = []
                from urllib.parse import quote
                
                for file_meta in paginated_files:
                    filename = file_meta['name']
                    file_type = get_media_type(filename)
                    info = {
                        'name': filename,
                        'type': file_type,
                        'size': file_meta.get('size', 0),
                        'url': f'/media/{category_id}/{quote(filename)}'
                    }
                    
                    # Add thumbnail URL for video files
                    if file_type == 'video':
                        info['thumbnailUrl'] = get_thumbnail_url(category_id, filename)
                    paginated_media_info.append(info)
                
                # Create pagination details
                pagination_details = {
                    'page': page,
                    'limit': limit,
                    'total': total_files,
                    'hasMore': (page * limit) < len(available_files) or status['progress'] < 100,
                    'indexing_progress': status['progress']  # Add progress info
                }
                
                return paginated_media_info, pagination_details, None, True
            
            # No files available yet, return empty list with indexing status
            # Set hasMore to True since indexing is still in progress
            pagination_details = {
                'page': page,
                'limit': limit or current_app.config['DEFAULT_PAGE_SIZE'],
                'total': status['total_files'] or 0,
                'hasMore': True,  # Always true while indexing is in progress
                'indexing_progress': status['progress']
            }
            
            return [], pagination_details, None, True
        
        # Not a large directory, use regular method
        return MediaService.list_media_files(category_id, page, limit, force_refresh, shuffle) + (False,)


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
