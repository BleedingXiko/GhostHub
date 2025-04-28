# app/services/storage_service.py
import os
import logging
import shutil
from flask import current_app

logger = logging.getLogger(__name__)

class StorageService:
    """
    Central service for managing media file storage in the application instance folder.
    Handles paths for thumbnails, transcoded videos, and other application-generated media.
    """
    
    # Storage directories in instance folder
    MEDIA_DIR = 'media'
    THUMBNAILS_DIR = os.path.join(MEDIA_DIR, 'thumbnails')
    TRANSCODED_DIR = os.path.join(MEDIA_DIR, 'transcoded')
    
    @staticmethod
    def get_instance_path():
        """Get path to Flask instance folder."""
        return current_app.instance_path
    
    @staticmethod
    def ensure_dir_exists(path):
        """Ensure directory exists, creating it if needed."""
        if not os.path.exists(path):
            try:
                os.makedirs(path, exist_ok=True)
                logger.debug(f"Created directory: {path}")
            except OSError as e:
                logger.error(f"Failed to create directory {path}: {e}")
                # Re-raise or handle appropriately depending on desired behavior
                raise
        return path
    
    @staticmethod
    def get_media_path(subdir=None):
        """Get path to media storage with optional subdirectory."""
        base_path = os.path.join(StorageService.get_instance_path(), StorageService.MEDIA_DIR)
        
        if subdir:
            path = os.path.join(base_path, subdir)
            return StorageService.ensure_dir_exists(path)
        
        return StorageService.ensure_dir_exists(base_path)
    
    @staticmethod
    def get_thumbnail_dir(category_id):
        """Get path to thumbnail storage for a category."""
        path = os.path.join(
            StorageService.get_instance_path(),
            StorageService.THUMBNAILS_DIR,
            category_id
        )
        return StorageService.ensure_dir_exists(path)
    
    @staticmethod
    def get_transcoded_dir(category_id):
        """Get path to transcoded media storage for a category."""
        path = os.path.join(
            StorageService.get_instance_path(),
            StorageService.TRANSCODED_DIR,
            category_id
        )
        return StorageService.ensure_dir_exists(path)
    
    @staticmethod
    def get_thumbnail_path(category_id, filename):
        """Get full path for a thumbnail file."""
        # Standardize thumbnail naming
        thumbnail_filename = f"{filename}.jpg"
        return os.path.join(
            StorageService.get_thumbnail_dir(category_id),
            thumbnail_filename
        )
    
    @staticmethod
    def _sanitize_filename(filename):
        """Replace potentially problematic characters in a filename."""
        # Replace spaces, parentheses, ampersands, etc. with underscores
        # Keep the original extension separate
        base_name, ext = os.path.splitext(filename)
        safe_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in base_name)
        # Limit length to avoid issues with long paths
        max_len = 100 
        safe_base = safe_base[:max_len]
        return f"{safe_base}{ext}"

    @staticmethod
    def get_transcoded_path(category_id, filename):
        """Get full path for a transcoded video file with a sanitized name."""
        # Standardize to MP4 format regardless of source
        base_name, _ = os.path.splitext(filename)
        # Sanitize the base name before adding the new extension
        safe_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in base_name)
        max_len = 100
        safe_base = safe_base[:max_len]
        transcoded_filename = f"{safe_base}.mp4" # Always use .mp4 extension
        
        return os.path.join(
            StorageService.get_transcoded_dir(category_id),
            transcoded_filename
        )
    
    @staticmethod
    def get_thumbnail_url(category_id, filename):
        """Generate URL for a thumbnail."""
        thumbnail_filename = f"{filename}.jpg"
        # URL encode the filename parts if necessary, especially if category_id or filename can contain special chars
        from urllib.parse import quote
        return f"/media/thumbnails/{quote(category_id)}/{quote(thumbnail_filename)}"
    
    @staticmethod
    def get_file_size(filepath):
        """Get size of a file in bytes."""
        try:
            return os.path.getsize(filepath)
        except (FileNotFoundError, PermissionError) as e:
            logger.warning(f"Cannot get size of {filepath}: {str(e)}")
            return 0
    
    @staticmethod
    def cleanup_unused_files(max_age_days=30, max_size_mb=1000):
        """Clean up unused transcoded files."""
        # Implementation for storage management
        # Would track file access times and delete least recently used files
        # when storage limit is exceeded
        # Placeholder for now
        logger.info("Running cleanup for unused transcoded files (placeholder)")
        pass
