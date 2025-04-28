# app/services/storage_service.py
import os
import logging
import shutil
from flask import current_app

logger = logging.getLogger(__name__)

class StorageService:
    """
    Service for managing media file storage.
    Handles paths for thumbnails, transcoded videos, and other application-generated media.
    All generated files are stored in a .ghosthub directory within each category path.
    """
    
    # Base directory name for GhostHub generated files within user media folders
    GHOSTHUB_SUBDIR = '.ghosthub'
    THUMBNAILS_SUBDIR = 'thumbnails'
    TRANSCODED_SUBDIR = 'transcoded'
    INDEX_FILENAME = '.index.json'
    
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
    def get_ghosthub_dir(category_path):
        """Get path to .ghosthub directory within a category path."""
        if not category_path:
            logger.error("Cannot get GhostHub directory without category_path.")
            raise ValueError("category_path is required")
        
        path = os.path.join(category_path, StorageService.GHOSTHUB_SUBDIR)
        return StorageService.ensure_dir_exists(path)
    
    @staticmethod
    def get_transcoded_dir(category_path):
        """Get path to transcoded media storage for a category."""
        ghosthub_dir = StorageService.get_ghosthub_dir(category_path)
        path = os.path.join(ghosthub_dir, StorageService.TRANSCODED_SUBDIR)
        return StorageService.ensure_dir_exists(path)
    
    @staticmethod
    def get_thumbnail_dir(category_path):
        """Get path to thumbnail storage for a category."""
        ghosthub_dir = StorageService.get_ghosthub_dir(category_path)
        path = os.path.join(ghosthub_dir, StorageService.THUMBNAILS_SUBDIR)
        return StorageService.ensure_dir_exists(path)
    
    @staticmethod
    def get_index_path(category_path):
        """Get path to index file for a category."""
        ghosthub_dir = StorageService.get_ghosthub_dir(category_path)
        return os.path.join(ghosthub_dir, StorageService.INDEX_FILENAME)
    
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
    def get_transcoded_path(category_path, filename):
        """Get full path for a transcoded video file with a sanitized name."""
        # Standardize to MP4 format regardless of source
        base_name, _ = os.path.splitext(filename)
        # Sanitize the base name before adding the new extension
        safe_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in base_name)
        max_len = 100
        safe_base = safe_base[:max_len]
        transcoded_filename = f"{safe_base}.mp4" # Always use .mp4 extension
        
        return os.path.join(
            StorageService.get_transcoded_dir(category_path),
            transcoded_filename
        )
    
    @staticmethod
    def get_thumbnail_path(category_path, filename):
        """Get full path for a thumbnail file."""
        # Standardize thumbnail naming
        thumbnail_filename = f"{filename}.jpg"
        return os.path.join(
            StorageService.get_thumbnail_dir(category_path),
            thumbnail_filename
        )
    
    @staticmethod
    def get_thumbnail_url(category_id, filename, category_path=None):
        """
        Generate URL for a thumbnail.
        
        Args:
            category_id: Category identifier for URL path.
            filename: Original filename (for naming the thumbnail).
            category_path: Path to the category directory (not used in URL generation).
        
        Returns:
            URL string for the thumbnail.
        """
        # The URL structure remains the same, but the route handler now looks in .ghosthub/thumbnails
        # The route handler uses category_id to get category_path, then looks in the new location
        thumbnail_filename = f"{filename}.jpg"
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
    def cleanup_unused_files(category_path, max_age_days=30, max_size_mb=1000):
        """
        Clean up unused transcoded files for a specific category.
        
        Args:
            category_path: Path to the category directory
            max_age_days: Maximum age of files to keep (in days)
            max_size_mb: Maximum storage to use for this category (in MB)
        """
        # TODO: Implement per-category cleanup for transcoded files
        # For now, this is a not prioity
        logger.info(f"Cleanup for transcoded files in {category_path} is not yet implemented")
        pass
