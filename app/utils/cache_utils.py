"""
Cache Utilities
--------------
Provides caching mechanisms for media files to improve performance.
"""
# app/utils/cache_utils.py

import time
import logging

logger = logging.getLogger(__name__)

# Small file threshold - files smaller than this will be served from memory
SMALL_FILE_THRESHOLD = 8 * 1024 * 1024  # 8MB

# Cache of recently accessed files to speed up repeated access
# Structure: {filepath: (last_access_time, file_data, file_size, mime_type, etag)}
small_file_cache = {}

# Cache of open file descriptors for large files
# Structure: {filepath: (last_access_time, file_descriptor, file_size, mime_type, etag)}
fd_cache = {}

# Maximum number of file descriptors to keep open
MAX_FD_CACHE_SIZE = 30

# Cache expiry time in seconds
CACHE_EXPIRY = 600  # 10 minutes

def clean_caches():
    """Remove expired entries from file caches to prevent memory leaks."""
    current_time = time.time()
    
    # Clean small file cache
    expired_keys = [k for k, (access_time, _, _, _, _) in small_file_cache.items() 
                   if current_time - access_time > CACHE_EXPIRY]
    for k in expired_keys:
        del small_file_cache[k]
    
    # Clean file descriptor cache
    expired_fd_keys = [k for k, (access_time, fd, _, _, _) in fd_cache.items() 
                      if current_time - access_time > CACHE_EXPIRY]
    for k in expired_fd_keys:
        try:
            fd_cache[k][1].close()  # Close the file descriptor
        except Exception as e:
            logger.warning(f"Error closing cached file descriptor for {k}: {e}")
        del fd_cache[k]
    
    # If FD cache is still too large, close the least recently used ones
    if len(fd_cache) > MAX_FD_CACHE_SIZE:
        # Sort by access time (oldest first)
        sorted_items = sorted(fd_cache.items(), key=lambda x: x[1][0])
        # Close oldest file descriptors until we're under the limit
        for k, (_, fd, _, _, _) in sorted_items[:len(fd_cache) - MAX_FD_CACHE_SIZE]:
            try:
                fd.close()
            except Exception as e:
                logger.warning(f"Error closing cached file descriptor for {k}: {e}")
            del fd_cache[k]

def get_from_small_cache(filepath):
    """
    Get a file from the small file cache if it exists.
    
    Args:
        filepath: Path to the file
        
    Returns:
        Tuple of (file_data, file_size, mime_type, etag) or None if not in cache
    """
    if filepath in small_file_cache:
        access_time, file_data, file_size, mime_type, etag = small_file_cache[filepath]
        # Update access time
        small_file_cache[filepath] = (time.time(), file_data, file_size, mime_type, etag)
        logger.info(f"Serving small file from cache: {filepath}")
        return file_data, file_size, mime_type, etag
    return None

def add_to_small_cache(filepath, file_data, file_size, mime_type, etag):
    """
    Add a file to the small file cache.
    
    Args:
        filepath: Path to the file
        file_data: Binary data of the file
        file_size: Size of the file in bytes
        mime_type: MIME type of the file
        etag: ETag for the file
    """
    small_file_cache[filepath] = (time.time(), file_data, file_size, mime_type, etag)
    logger.info(f"Loaded small file into cache: {filepath} ({file_size} bytes)")

def get_from_fd_cache(filepath):
    """
    Get a file descriptor from the FD cache if it exists.
    
    Args:
        filepath: Path to the file
        
    Returns:
        Tuple of (file_descriptor, file_size, mime_type, etag) or None if not in cache
    """
    if filepath in fd_cache:
        access_time, file_obj, file_size, mime_type, etag = fd_cache[filepath]
        # Update access time
        fd_cache[filepath] = (time.time(), file_obj, file_size, mime_type, etag)
        # Seek to beginning of file
        try:
            file_obj.seek(0)
            logger.info(f"Using cached file descriptor for: {filepath}")
            return file_obj, file_size, mime_type, etag
        except Exception as e:
            logger.warning(f"Error seeking cached file descriptor for {filepath}: {e}")
            # Close and remove from cache if seeking fails
            try:
                file_obj.close()
            except:
                pass
            del fd_cache[filepath]
    return None

def add_to_fd_cache(filepath, file_obj, file_size, mime_type, etag):
    """
    Add a file descriptor to the FD cache.
    
    Args:
        filepath: Path to the file
        file_obj: File object
        file_size: Size of the file in bytes
        mime_type: MIME type of the file
        etag: ETag for the file
    """
    # If cache is full, clean it first
    if len(fd_cache) >= MAX_FD_CACHE_SIZE:
        clean_caches()
    
    fd_cache[filepath] = (time.time(), file_obj, file_size, mime_type, etag)
    logger.info(f"Cached file descriptor for: {filepath}")
