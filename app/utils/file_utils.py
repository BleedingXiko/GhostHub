"""
File Utilities
-------------
Utilities for managing category configuration files.
"""
# app/utils/file_utils.py
import os
import json
import time
import logging
import traceback
from flask import current_app

logger = logging.getLogger(__name__)

INDEX_FILENAME = "ghosthub_index.json"  # Removed the leading dot

def get_categories_filepath():
    """Get absolute path to the categories JSON file."""
    # Use instance_path which is correctly set by the app factory
    return os.path.join(current_app.instance_path, os.path.basename(current_app.config['CATEGORIES_FILE']))

def init_categories_file():
    """Create empty categories file if it doesn't exist."""
    filepath = get_categories_filepath()
    if not os.path.exists(filepath):
        try:
            # Ensure the directory exists (instance folder should already be created by app factory)
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            with open(filepath, 'w') as f:
                json.dump([], f)
            logger.info(f"Created empty categories file: {filepath}")
        except Exception as e:
            logger.error(f"Failed to create categories file at {filepath}: {str(e)}")
            # Depending on the desired behavior, you might want to raise the exception
            # raise # Uncomment to propagate the error

def load_categories():
    """
    Load categories from JSON file with error handling.
    
    Returns list of categories or empty list on error.
    """
    filepath = get_categories_filepath()
    try:
        with open(filepath, 'r') as f:
            categories = json.load(f)
            logger.info(f"Successfully loaded {len(categories)} categories from {filepath}")
            return categories
    except FileNotFoundError:
        logger.warning(f"Categories file not found: {filepath}. Initializing.")
        init_categories_file()
        return []
    except json.JSONDecodeError:
        logger.error(f"Invalid JSON in categories file: {filepath}. Backing up and re-initializing.")
        backup_corrupted_file(filepath)
        init_categories_file()
        return []
    except Exception as e:
        logger.error(f"Error loading categories from {filepath}: {str(e)}")
        logger.debug(traceback.format_exc())
        return [] # Return empty list on other errors

def save_categories(categories):
    """
    Save categories to JSON file.
    
    Returns True if successful, False otherwise.
    """
    filepath = get_categories_filepath()
    try:
        # Ensure the directory exists
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w') as f:
            json.dump(categories, f, indent=2)
        logger.info(f"Successfully saved {len(categories)} categories to {filepath}")
        return True
    except Exception as e:
        logger.error(f"Error saving categories to {filepath}: {str(e)}")
        logger.debug(traceback.format_exc())
        return False

def backup_corrupted_file(filepath):
    """Create timestamped backup of corrupted file."""
    if os.path.exists(filepath):
        backup_file = f"{filepath}.bak.{int(time.time())}"
        try:
            os.rename(filepath, backup_file)
            logger.info(f"Backed up corrupted file to {backup_file}")
        except Exception as e:
            logger.error(f"Failed to backup corrupted file {filepath}: {str(e)}")

def get_index_filepath(category_path):
    """Get the absolute path to the index file for a given category path."""
    return os.path.join(category_path, INDEX_FILENAME)

def load_index(category_path):
    """
    Load the media index from the JSON file for a category.

    Returns:
        dict: The loaded index data (including timestamp and files) or None on error.
    """
    filepath = get_index_filepath(category_path)
    try:
        if not os.path.exists(filepath):
            logger.info(f"Index file not found: {filepath}")
            return None
        with open(filepath, 'r') as f:
            index_data = json.load(f)
            file_count = len(index_data.get('files', []))
            logger.info(f"Successfully loaded index from {filepath} with {file_count} files")
            return index_data
    except json.JSONDecodeError:
        logger.error(f"Invalid JSON in index file: {filepath}. Backing up and treating as missing.")
        backup_corrupted_file(filepath)
        return None
    except Exception as e:
        logger.error(f"Error loading index from {filepath}: {str(e)}")
        logger.debug(traceback.format_exc())
        return None

def save_index(category_path, index_data):
    """
    Save the media index to the JSON file for a category.

    Args:
        category_path (str): The path to the category directory.
        index_data (dict): The index data to save (should include timestamp and files list).

    Returns:
        bool: True if successful, False otherwise.
    """
    # Use a direct path to the index file in the category directory
    filepath = os.path.join(category_path, INDEX_FILENAME)
    
    try:
        file_count = len(index_data.get('files', []))
        
        # Log more details about the file we're trying to save
        logger.info(f"Attempting to save index directly to {filepath} with {file_count} files")
        
        # Write the file with explicit encoding - use a simpler approach
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(index_data, f)
        
        # Verify the file was created
        if os.path.exists(filepath):
            file_size = os.path.getsize(filepath)
            logger.info(f"Successfully saved index to {filepath} with {file_count} files (size: {file_size} bytes)")
            return True
        else:
            logger.error(f"File was not created: {filepath}")
            return False
    except Exception as e:
        logger.error(f"Error saving index to {filepath}: {str(e)}")
        logger.debug(traceback.format_exc())
        return False

def is_large_directory(category_path, threshold=50):
    """
    Check if a directory contains more than the threshold number of media files.
    This is a quick check to determine if async indexing should be used.
    
    Args:
        category_path (str): The path to the category directory.
        threshold (int): The number of files threshold.
        
    Returns:
        bool: True if the directory contains more than threshold media files, False otherwise.
    """
    try:
        # First check if a valid index file exists
        index_data = load_index(category_path)
        if index_data and 'files' in index_data:
            file_count = len(index_data['files'])
            logger.debug(f"Using index file to determine directory size: {file_count} files in {category_path}")
            return file_count > threshold
        
        # If no valid index, count files directly
        # Import here to avoid circular import
        from app.utils.media_utils import is_media_file
        
        try:
            # First try a simple directory listing
            files = os.listdir(category_path)
            media_files = [f for f in files if is_media_file(f)]
            file_count = len(media_files)
            logger.debug(f"Found {file_count} media files in {category_path}")
            return file_count > threshold
        except Exception as list_error:
            logger.error(f"Error listing directory {category_path}: {list_error}")
            return False
    except Exception as e:
        logger.error(f"Error checking directory size for {category_path}: {str(e)}")
        return False  # Default to False on error

# Additional file utilities can be added here
