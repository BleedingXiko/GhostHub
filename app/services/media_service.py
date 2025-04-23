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
import threading
from queue import Queue, Empty
from flask import current_app, session, request
from app.utils.media_utils import is_media_file, get_media_type
from app.services.category_service import CategoryService
from app.utils.file_utils import load_index, save_index, is_large_directory # Added index utils

logger = logging.getLogger(__name__)

# Session tracking: {category_id: {session_id: {"seen": set(), "order": [], "last_access": timestamp}}}
seen_files_tracker = {}
last_session_cleanup = time.time()

# Sync mode file order: {category_id: sorted_files_list}
sync_mode_order = {}

# Async indexing tracking: {category_id: {"status": "running|complete", "progress": 0-100, "files": [], "timestamp": time}}
async_index_status = {}

# Thread-safe queue for background indexing tasks
index_task_queue = Queue()

# Flag to track if the background indexing thread is running
background_thread_running = False

# Constants for memory management
MAX_SESSIONS_PER_CATEGORY = 50  # Maximum number of sessions to track per category
SESSION_EXPIRY = 3600  # Session data expires after 1 hour of inactivity
LARGE_DIRECTORY_THRESHOLD = 50  # Number of files that triggers async indexing (reduced from 500 for better performance)

class MediaService:
    """Service for managing media files, listings, and viewing sessions."""

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
        # MediaService.clean_cache() # Removed old cache cleanup call
        MediaService.clean_sessions() # Keep session cleanup

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
        current_time = time.time()
        cache_expiry = current_app.config.get('CACHE_EXPIRY', 300) # Use same expiry for index

        # --- File Listing using Index Cache ---
        all_files_metadata = None # Will store list of dicts: {'name': ..., 'size': ..., 'mtime': ...}

        # 1. Try loading the index
        index_data = load_index(category_path) if not force_refresh else None

        # 2. Validate the loaded index
        if index_data and 'timestamp' in index_data and 'files' in index_data:
            if current_time - index_data['timestamp'] <= cache_expiry:
                all_files_metadata = index_data['files']
                logger.info(f"Using valid index file for '{category['name']}' ({len(all_files_metadata)} files)")
            else:
                logger.info(f"Index file expired for '{category['name']}'")
                index_data = None # Treat expired index as invalid

        # 3. If index is invalid, missing, or force_refresh is true, scan directory and rebuild index
        if all_files_metadata is None:
            if force_refresh:
                logger.info(f"Forcing index refresh for '{category['name']}'")
            elif index_data:
                 logger.info(f"Rebuilding expired index for '{category['name']}'")
            else:
                logger.info(f"Index not found or invalid, building index for '{category['name']}'")

            if not os.path.exists(category_path):
                logger.error(f"Category path does not exist: {category_path}")
                return None, None, f"Category path does not exist: {category_path}"
            if not os.path.isdir(category_path):
                logger.error(f"Category path is not a directory: {category_path}")
                return None, None, f"Category path is not a directory: {category_path}"

            try:
                # Always scan all files and create the index
                logger.info(f"Scanning all files for '{category['name']}' to create index")
                all_files_metadata = []
                for filename in os.listdir(category_path):
                    if is_media_file(filename):
                        try:
                            filepath = os.path.join(category_path, filename)
                            stats = os.stat(filepath)
                            all_files_metadata.append({
                                'name': filename,
                                'size': stats.st_size,
                                'mtime': stats.st_mtime
                            })
                        except FileNotFoundError:
                             logger.warning(f"File disappeared during indexing: {filepath}")
                        except Exception as stat_error:
                             logger.warning(f"Could not get stats for file {filepath}: {stat_error}")
                
                # Always save the index file - use a direct approach
                new_index_data = {'timestamp': current_time, 'files': all_files_metadata}
                
                # Save the index using the utility function
                try:
                    index_saved = save_index(category_path, new_index_data)
                    if index_saved:
                        logger.info(f"Successfully saved index for '{category['name']}' with {len(all_files_metadata)} files")
                    else:
                        logger.error(f"Failed to save index for '{category['name']}'")
                except Exception as save_error:
                    logger.error(f"Error saving index for '{category['name']}': {save_error}")
                
                # Check if this is a large directory that should use async indexing
                if is_large_directory(category_path, LARGE_DIRECTORY_THRESHOLD):
                    logger.info(f"Large directory detected for '{category['name']}', starting async indexing")
                    # Start async indexing in the background
                    MediaService.start_async_indexing(
                        category_id, 
                        category_path, 
                        category['name'],
                        force_refresh
                    )

            except PermissionError:
                logger.error(f"Permission denied accessing directory: {category_path}")
                return None, None, f"Permission denied accessing directory: {category_path}"
            except Exception as e:
                logger.error(f"Error scanning directory or building index for {category_path}: {str(e)}")
                logger.debug(traceback.format_exc())
                return None, None, f"Error scanning directory: {str(e)}"

        # Extract just the filenames for subsequent logic (shuffling, pagination)
        # Ensure metadata list is not None before proceeding
        if all_files_metadata is None:
             logger.error(f"Failed to load or build index for category '{category['name']}'. Cannot proceed.")
             return None, None, "Failed to load or build media index."

        all_files = [f_meta['name'] for f_meta in all_files_metadata]
        total_files_in_directory = len(all_files)
        logger.info(f"Total files indexed for '{category['name']}': {total_files_in_directory}")

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

        # Create a lookup for metadata from the index for efficiency
        metadata_lookup = {f_meta['name']: f_meta for f_meta in all_files_metadata}

        for filename in paginated_filenames:
            try:
                # Get metadata from lookup
                file_meta = metadata_lookup.get(filename)
                if not file_meta:
                     logger.warning(f"Metadata not found in index for file: {filename}. Skipping.")
                     continue # Skip if metadata is missing for some reason

                file_type = get_media_type(filename)
                info = {
                    'name': filename,
                    'type': file_type,
                    'size': file_meta.get('size', 0), # Use size from index
                    'url': f'/media/{category_id}/{quote(filename)}' # URL encode filename
                    # 'mtime': file_meta.get('mtime') # Optionally include mtime
                }
                paginated_media_info.append(info)
            except Exception as file_proc_error:
                logger.error(f"Error preparing response data for file '{filename}' in category '{category['name']}': {file_proc_error}")
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
    def start_async_indexing(category_id, category_path, category_name, force_refresh=False):
        """
        Start asynchronous indexing of a category directory.
        
        Args:
            category_id (str): The category ID.
            category_path (str): The path to the category directory.
            category_name (str): The name of the category (for logging).
            force_refresh (bool): Whether to force a refresh of the index.
            
        Returns:
            dict: Initial status information.
        """
        global async_index_status, background_thread_running, index_task_queue
        
        # Check if indexing is already in progress for this category
        if category_id in async_index_status and async_index_status[category_id]['status'] == 'running':
            logger.info(f"Async indexing already in progress for category '{category_name}'")
            return async_index_status[category_id]
        
        # Initialize status
        current_time = time.time()
        status_info = {
            'status': 'running',
            'progress': 0,
            'files': [],  # Will be populated incrementally
            'timestamp': current_time,
            'total_files': 0,  # Will be updated as we discover files
            'processed_files': 0
        }
        async_index_status[category_id] = status_info
        
        # Add task to queue
        index_task_queue.put({
            'category_id': category_id,
            'category_path': category_path,
            'category_name': category_name,
            'force_refresh': force_refresh,
            'timestamp': current_time
        })
        
        # Start background thread if not already running
        if not background_thread_running:
            MediaService._start_background_indexer()
        
        logger.info(f"Queued async indexing task for category '{category_name}'")
        return status_info
    
    @staticmethod
    def get_async_index_status(category_id):
        """
        Get the current status of async indexing for a category.
        
        Args:
            category_id (str): The category ID.
            
        Returns:
            dict: Status information or None if no indexing has been started.
        """
        global async_index_status
        return async_index_status.get(category_id)
    
    @staticmethod
    def _background_indexer_worker():
        """
        Background worker that processes indexing tasks from the queue.
        This method runs in a separate thread with its own Flask application context.
        It processes tasks from the index_task_queue and updates the async_index_status.
        """
        global background_thread_running, index_task_queue, async_index_status
        
        background_thread_running = True
        logger.info("Background indexer thread started")
        
        try:
            while True:
                try:
                    # Get task with timeout to allow for graceful shutdown
                    task = index_task_queue.get(timeout=5)
                    
                    category_id = task['category_id']
                    category_path = task['category_path']
                    category_name = task['category_name']
                    force_refresh = task['force_refresh']
                    
                    logger.info(f"Processing async indexing task for '{category_name}'")
                    
                    try:
                        # Check if directory exists and is accessible
                        if not os.path.exists(category_path) or not os.path.isdir(category_path):
                            logger.error(f"Category path does not exist or is not a directory: {category_path}")
                            async_index_status[category_id]['status'] = 'error'
                            async_index_status[category_id]['error'] = "Directory not found or not accessible"
                            index_task_queue.task_done()  # Mark task as done
                            continue
                        
                        # Try to load existing index if not forcing refresh
                        all_files_metadata = []
                        if not force_refresh:
                            try:
                                index_data = load_index(category_path)
                                if index_data and 'timestamp' in index_data and 'files' in index_data:
                                    cache_expiry = 300  # Default to 5 minutes if config not available
                                    if time.time() - index_data['timestamp'] <= cache_expiry:
                                        logger.info(f"Using existing index for async indexing of '{category_name}'")
                                        async_index_status[category_id]['status'] = 'complete'
                                        async_index_status[category_id]['files'] = index_data['files']
                                        async_index_status[category_id]['progress'] = 100
                                        async_index_status[category_id]['total_files'] = len(index_data['files'])
                                        async_index_status[category_id]['processed_files'] = len(index_data['files'])
                                        index_task_queue.task_done()  # Mark task as done
                                        continue
                            except Exception as load_error:
                                logger.error(f"Error loading index in background worker: {load_error}")
                                # Continue with rebuilding the index
                        
                        # Get total file count for progress tracking (approximate)
                        total_files = 0
                        try:
                            total_files = sum(1 for f in os.listdir(category_path) if is_media_file(f))
                            async_index_status[category_id]['total_files'] = total_files
                            logger.info(f"Found {total_files} media files in '{category_name}' for indexing")
                        except Exception as count_error:
                            logger.error(f"Error counting files in {category_path}: {count_error}")
                            # Continue with unknown total
                        
                        # Process files in chunks
                        processed = 0
                        chunk_size = 10  # Process files in smaller chunks for more frequent updates
                        
                        # Create a list to store metadata
                        all_files_metadata = []
                        
                        # Process each file in the directory
                        for filename in os.listdir(category_path):
                            if is_media_file(filename):
                                try:
                                    filepath = os.path.join(category_path, filename)
                                    stats = os.stat(filepath)
                                    file_meta = {
                                        'name': filename,
                                        'size': stats.st_size,
                                        'mtime': stats.st_mtime
                                    }
                                    all_files_metadata.append(file_meta)
                                    
                                    # Update status
                                    processed += 1
                                    async_index_status[category_id]['processed_files'] = processed
                                    
                                    # Update progress percentage
                                    if total_files > 0:
                                        progress = min(int((processed / total_files) * 100), 99)  # Cap at 99% until complete
                                    else:
                                        progress = 50  # Unknown total, show 50%
                                    
                                    async_index_status[category_id]['progress'] = progress
                                    
                                    # Update files list in chunks to avoid excessive memory usage
                                    if processed % chunk_size == 0:
                                        async_index_status[category_id]['files'] = all_files_metadata.copy()
                                        logger.info(f"Processed {processed} files for '{category_name}' ({progress}%)")
                                    
                                except FileNotFoundError:
                                    logger.warning(f"File disappeared during async indexing: {filename}")
                                except Exception as file_error:
                                    logger.warning(f"Error processing file {filename} during async indexing: {file_error}")
                        
                        # Always update the files list at the end
                        async_index_status[category_id]['files'] = all_files_metadata
                        logger.info(f"Finished processing all {processed} files for '{category_name}'")
                        
                        # Save the complete index
                        current_time = time.time()
                        new_index_data = {'timestamp': current_time, 'files': all_files_metadata}
                        
                        # Save the index using the utility function
                        save_success = False
                        try:
                            save_success = save_index(category_path, new_index_data)
                            if save_success:
                                logger.info(f"Successfully saved index in background worker for '{category_name}'")
                            else:
                                logger.error(f"Failed to save index in background worker for '{category_name}'")
                        except Exception as save_error:
                            logger.error(f"Error saving index in background worker: {save_error}")
                        
                        # Update final status
                        async_index_status[category_id]['status'] = 'complete'
                        async_index_status[category_id]['progress'] = 100
                        async_index_status[category_id]['timestamp'] = current_time
                        
                        logger.info(f"Completed async indexing for '{category_name}': {processed} files indexed, index saved: {save_success}")
                        
                    except Exception as task_error:
                        logger.error(f"Error during async indexing of '{category_name}': {task_error}")
                        logger.debug(traceback.format_exc())
                        async_index_status[category_id]['status'] = 'error'
                        async_index_status[category_id]['error'] = str(task_error)
                    
                    # Mark task as done
                    index_task_queue.task_done()
                    
                except Empty:
                    # No tasks in queue, check if we should exit
                    if index_task_queue.empty():
                        logger.debug("No indexing tasks in queue, background thread will exit")
                        break
                
                except Exception as e:
                    logger.error(f"Unexpected error in background indexer: {e}")
                    logger.debug(traceback.format_exc())
                    # Continue processing other tasks
        
        finally:
            background_thread_running = False
            logger.info("Background indexer thread stopped")
    
    @staticmethod
    def _start_background_indexer():
        """Start the background indexer thread."""
        global background_thread_running
        
        if not background_thread_running:
            try:
                logger.info("Starting background indexer thread...")
                
                # Get the current Flask app instance
                from flask import current_app
                app = current_app._get_current_object()
                
                # Create a function that will run in the thread with the app context
                def run_with_app_context():
                    with app.app_context():
                        logger.info("Background indexer thread started with app context")
                        MediaService._background_indexer_worker()
                
                # Start the thread with the wrapper function
                indexer_thread = threading.Thread(
                    target=run_with_app_context,
                    daemon=True  # Make thread a daemon so it exits when main thread exits
                )
                indexer_thread.start()
                logger.info("Successfully started background indexer thread")
                
                # Verify the thread is running
                if indexer_thread.is_alive():
                    logger.info("Background indexer thread is alive")
                else:
                    logger.error("Background indexer thread failed to start")
            except Exception as e:
                logger.error(f"Error starting background indexer thread: {e}")
                logger.debug(traceback.format_exc())
                background_thread_running = False
    
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
        if is_large_directory(category_path, LARGE_DIRECTORY_THRESHOLD):
            logger.info(f"Large directory detected for '{category['name']}', using async indexing")
            
            # Check if async indexing is already in progress or complete
            status = MediaService.get_async_index_status(category_id)
            
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
