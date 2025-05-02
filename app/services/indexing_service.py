"""
Indexing Service
--------------
Handles asynchronous indexing of media directories.
"""
# app/services/indexing_service.py
import os
import time
import logging
import traceback
import threading
from queue import Queue, Empty
from flask import current_app
from app.utils.media_utils import is_media_file, process_category_thumbnails
from app.utils.file_utils import load_index, save_index, is_large_directory

logger = logging.getLogger(__name__)

# Async indexing tracking: {category_id: {"status": "running|complete", "progress": 0-100, "files": [], "timestamp": time}}
async_index_status = {}

# Thread-safe queue for background indexing tasks
index_task_queue = Queue()

# Flag to track if the background indexing thread is running
background_thread_running = False

# Constants for indexing
LARGE_DIRECTORY_THRESHOLD = 50  # Number of files that triggers async indexing

# Make the constant accessible as a class attribute

class IndexingService:
    """Service for asynchronous indexing of media directories."""
    
    # Make the constant accessible as a class attribute
    LARGE_DIRECTORY_THRESHOLD = LARGE_DIRECTORY_THRESHOLD
    
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
            IndexingService._start_background_indexer()
        
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
                        
                        # Process thumbnails for all videos and one image (for category preview)
                        try:
                            image_count, video_count, thumbnails_generated = process_category_thumbnails(
                                category_path, all_files_metadata, force_refresh
                            )
                            logger.info(f"Processed thumbnails for '{category_name}': {thumbnails_generated} generated/updated "
                                       f"({video_count} videos, {image_count} images)")
                        except Exception as thumb_error:
                            logger.error(f"Error processing thumbnails for '{category_name}': {thumb_error}")
                            logger.debug(traceback.format_exc())
                            # Continue with saving the index even if thumbnail processing fails
                        
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
                        IndexingService._background_indexer_worker()
                
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
