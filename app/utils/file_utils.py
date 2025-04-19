# app/utils/file_utils.py
import os
import json
import time
import logging
import traceback
from flask import current_app

logger = logging.getLogger(__name__)

def get_categories_filepath():
    """Constructs the absolute path to the categories JSON file."""
    # Use instance_path which is correctly set by the app factory
    return os.path.join(current_app.instance_path, os.path.basename(current_app.config['CATEGORIES_FILE']))

def init_categories_file():
    """Initialize the categories file if it doesn't exist."""
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
    Load categories from the JSON file.

    Returns:
        list: List of category dictionaries, or an empty list on error.
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
    Save categories to the JSON file.

    Args:
        categories (list): List of category dictionaries

    Returns:
        bool: True if successful, False otherwise
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
    """Backs up a potentially corrupted file."""
    if os.path.exists(filepath):
        backup_file = f"{filepath}.bak.{int(time.time())}"
        try:
            os.rename(filepath, backup_file)
            logger.info(f"Backed up corrupted file to {backup_file}")
        except Exception as e:
            logger.error(f"Failed to backup corrupted file {filepath}: {str(e)}")

# Add other file-related utilities here if needed
