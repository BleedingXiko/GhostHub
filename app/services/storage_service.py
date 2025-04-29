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
        # TODO: Implement per-category cleanup for transcoded files based on age/size
        # For now, this is not a priority
        logger.info(f"Age/size-based cleanup for transcoded files in {category_path} is not yet implemented")
        pass
    
    @staticmethod
    def cleanup_orphaned_transcoded_files(category_path):
        """
        Clean up transcoded files whose original media files no longer exist.
        Also updates the index JSON to remove entries for deleted files.
        
        Args:
            category_path: Path to the category directory
            
        Returns:
            tuple: (num_removed_transcoded, num_removed_index_entries)
        """
        if not os.path.exists(category_path) or not os.path.isdir(category_path):
            logger.error(f"Cannot clean up orphaned files: Category path does not exist or is not a directory: {category_path}")
            return 0, 0
            
        # Get paths to transcoded directory and index file
        transcoded_dir = StorageService.get_transcoded_dir(category_path)
        index_path = StorageService.get_index_path(category_path)
        
        # Track counts for reporting
        removed_transcoded = 0
        removed_index_entries = 0
        
        # Get list of original media files in the category
        try:
            original_files = set()
            for filename in os.listdir(category_path):
                if os.path.isfile(os.path.join(category_path, filename)):
                    original_files.add(filename)
            
            logger.info(f"Found {len(original_files)} original media files in {category_path}")
        except Exception as e:
            logger.error(f"Error listing original files in {category_path}: {e}")
            return 0, 0
            
        # Check transcoded directory for orphaned files
        try:
            if os.path.exists(transcoded_dir) and os.path.isdir(transcoded_dir):
                for transcoded_file in os.listdir(transcoded_dir):
                    # Get original filename (remove .mp4 extension and add back original extension)
                    base_name = os.path.splitext(transcoded_file)[0]
                    
                    # Check if any original file with this base name exists
                    original_exists = False
                    for orig_file in original_files:
                        orig_base = os.path.splitext(orig_file)[0]
                        # Use sanitized comparison since transcoded filenames are sanitized
                        safe_orig_base = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in orig_base)
                        safe_orig_base = safe_orig_base[:100]  # Apply same length limit as in get_transcoded_path
                        
                        if safe_orig_base == base_name:
                            original_exists = True
                            break
                    
                    # If original doesn't exist, delete the transcoded file
                    if not original_exists:
                        transcoded_path = os.path.join(transcoded_dir, transcoded_file)
                        try:
                            os.remove(transcoded_path)
                            removed_transcoded += 1
                            logger.info(f"Removed orphaned transcoded file: {transcoded_path}")
                        except Exception as del_err:
                            logger.error(f"Error deleting orphaned transcoded file {transcoded_path}: {del_err}")
        except Exception as e:
            logger.error(f"Error cleaning up transcoded directory {transcoded_dir}: {e}")
            
        # Update index JSON to remove entries for deleted files
        try:
            from app.utils.file_utils import load_index, save_index
            
            index_data = load_index(category_path)
            if index_data and 'files' in index_data:
                original_count = len(index_data['files'])
                
                # Filter out entries for files that no longer exist
                index_data['files'] = [
                    f for f in index_data['files'] 
                    if f.get('name') in original_files
                ]
                
                removed_index_entries = original_count - len(index_data['files'])
                
                if removed_index_entries > 0:
                    # Update timestamp and save the modified index
                    index_data['timestamp'] = time.time()
                    save_success = save_index(category_path, index_data)
                    
                    if save_success:
                        logger.info(f"Updated index JSON, removed {removed_index_entries} entries for deleted files")
                    else:
                        logger.error(f"Failed to save updated index after removing {removed_index_entries} entries")
        except Exception as idx_err:
            logger.error(f"Error updating index JSON for {category_path}: {idx_err}")
            
        return removed_transcoded, removed_index_entries
