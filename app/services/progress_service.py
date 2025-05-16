# app/services/progress_service.py
import os
import json
import logging
from app.config import Config

logger = logging.getLogger(__name__)

PROGRESS_FILE_NAME = 'user_playback_progress.json'
PROGRESS_FILE_PATH = os.path.join(Config.INSTANCE_FOLDER_PATH, PROGRESS_FILE_NAME)

def _ensure_instance_folder():
    """Ensures the instance folder exists."""
    if not os.path.exists(Config.INSTANCE_FOLDER_PATH):
        try:
            os.makedirs(Config.INSTANCE_FOLDER_PATH)
            logger.info(f"Created instance folder: {Config.INSTANCE_FOLDER_PATH}")
        except OSError as e:
            logger.error(f"Error creating instance folder {Config.INSTANCE_FOLDER_PATH}: {e}")
            return False
    return True

def load_progress():
    """Loads the playback progress from the JSON file."""
    if not _ensure_instance_folder():
        return {}
    if not os.path.exists(PROGRESS_FILE_PATH):
        return {}
    try:
        with open(PROGRESS_FILE_PATH, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        logger.warning(f"Error loading progress file {PROGRESS_FILE_PATH} or file not found: {e}. Returning empty progress.")
        return {}
    except Exception as e:
        logger.error(f"Unexpected error loading progress file {PROGRESS_FILE_PATH}: {e}")
        return {}

def save_progress(category_id, index):
    """Saves the current index for a given category."""
    if not hasattr(Config, 'SAVE_CURRENT_INDEX') or not Config.SAVE_CURRENT_INDEX:
        return False, "Saving current index is disabled in configuration."

    if not _ensure_instance_folder():
        return False, "Failed to ensure instance folder exists."

    current_progress = load_progress()
    current_progress[str(category_id)] = int(index)
    try:
        with open(PROGRESS_FILE_PATH, 'w') as f:
            json.dump(current_progress, f, indent=2)
        logger.info(f"Saved progress for category {category_id} at index {index} to {PROGRESS_FILE_PATH}")
        return True, "Progress saved successfully."
    except Exception as e:
        logger.error(f"Error saving progress to {PROGRESS_FILE_PATH}: {e}")
        return False, f"Failed to save progress: {str(e)}"

def get_saved_index(category_id):
    """Retrieves the saved index for a given category."""
    if not hasattr(Config, 'SAVE_CURRENT_INDEX') or not Config.SAVE_CURRENT_INDEX:
        return None
        
    progress = load_progress()
    return progress.get(str(category_id))

def delete_all_progress():
    """Deletes all saved progress data."""
    if not _ensure_instance_folder():
        return False, "Failed to ensure instance folder exists for deletion."
        
    if os.path.exists(PROGRESS_FILE_PATH):
        try:
            os.remove(PROGRESS_FILE_PATH)
            logger.info(f"Deleted all progress data from {PROGRESS_FILE_PATH}")
            return True, "All saved progress has been deleted."
        except Exception as e:
            logger.error(f"Error deleting progress file {PROGRESS_FILE_PATH}: {e}")
            return False, f"Failed to delete progress data: {str(e)}"
    return True, "No progress data to delete."
