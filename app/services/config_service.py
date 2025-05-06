# app/services/config_service.py
import os
import json
import logging
import traceback
from app.config import Config

logger = logging.getLogger(__name__)

CONFIG_FILE_PATH = os.path.join(Config.INSTANCE_FOLDER_PATH, 'ghosthub_config.json')

def get_default_config():
    """Returns the default configuration structure."""
    return {
        "python_config": {
            "CACHE_EXPIRY": 300,
            "DEFAULT_PAGE_SIZE": 10,
            "SESSION_EXPIRY": 3600,
            "SHUFFLE_MEDIA": True,
            "WS_RECONNECT_ATTEMPTS": 10,
            "WS_RECONNECT_DELAY": 1000,
            "WS_RECONNECT_FACTOR": 1.5,
            "MEMORY_CLEANUP_INTERVAL": 60000,
            "MAX_CACHE_SIZE": 50
        },
        "javascript_config": {
            "main": {
                "socket_reconnectionAttempts": 5,
                "socket_reconnectionDelay": 2000,
                "phase2_init_delay": 250,
                "phase3_init_delay": 500
            },
            "core_app": {
                "media_per_page_desktop": 5,
                "media_per_page_mobile": 3,
                "load_more_threshold_desktop": 3,
                "load_more_threshold_mobile": 2,
                "render_window_size": 0,
                "mobile_cleanup_interval": 60000,
                "mobile_fetch_timeout": 15000,
                "fullscreen_check_interval": 2000
            },
            "sync_manager": {
                "socket_reconnectionAttempts": 10,
                "socket_reconnectionDelay": 1000,
                "socket_reconnectionDelayMax": 5000,
                "socket_timeout": 20000,
                "socket_pingTimeout": 120000,
                "socket_pingInterval": 10000,
                "heartbeatInterval": 30000,
                "manual_maxReconnectAttempts": 10,
                "manual_reconnectDelayBase": 1000,
                "manual_reconnectFactor": 1.5,
                "manual_reconnect_delay_max_mobile": 10000,
                "manual_reconnect_delay_max_desktop": 30000,
                "manual_reconnect_trigger_delay": 2000,
                "connect_error_force_ui_timeout": 5000
            }
        }
    }

def load_config():
    """Loads the configuration from the JSON file, or returns defaults if not found/invalid."""
    try:
        if os.path.exists(CONFIG_FILE_PATH):
            with open(CONFIG_FILE_PATH, 'r') as f:
                config_data = json.load(f)
            
            # Ensure all sections and sub-sections are present, falling back to defaults
            default_config = get_default_config()
            
            # Ensure python_config section and its keys
            loaded_python_config = config_data.get("python_config", {})
            final_python_config = default_config["python_config"].copy()
            final_python_config.update(loaded_python_config) # User values override defaults
            config_data["python_config"] = final_python_config

            # Ensure javascript_config section and its sub-sections and keys
            loaded_javascript_config = config_data.get("javascript_config", {})
            final_javascript_config = default_config["javascript_config"].copy() # Start with default structure

            for js_section_key, js_section_defaults in default_config["javascript_config"].items():
                loaded_js_section = loaded_javascript_config.get(js_section_key, {})
                final_js_section = js_section_defaults.copy()
                final_js_section.update(loaded_js_section) # User values override defaults
                final_javascript_config[js_section_key] = final_js_section
            config_data["javascript_config"] = final_javascript_config

            return config_data, None
        else:
            logger.info(f"Config file not found at {CONFIG_FILE_PATH}. Returning default configuration.")
            return get_default_config(), None
    except json.JSONDecodeError as e:
        logger.error(f"Error decoding JSON from config file {CONFIG_FILE_PATH}: {str(e)}")
        logger.debug(traceback.format_exc())
        return get_default_config(), f"Error decoding configuration file: {str(e)}. Using defaults."
    except Exception as e:
        logger.error(f"Error reading config file {CONFIG_FILE_PATH}: {str(e)}")
        logger.debug(traceback.format_exc())
        return get_default_config(), f"Failed to retrieve configuration: {str(e)}. Using defaults."

def save_config(new_config_data):
    """Saves the provided configuration data to the JSON file."""
    try:
        if not new_config_data:
            return False, "No configuration data provided"

        # Basic validation: Check for top-level keys
        if "python_config" not in new_config_data or "javascript_config" not in new_config_data:
            return False, 'Invalid configuration structure. Missing "python_config" or "javascript_config".'

        # Ensure instance folder exists
        if not os.path.exists(Config.INSTANCE_FOLDER_PATH):
            try:
                os.makedirs(Config.INSTANCE_FOLDER_PATH)
                logger.info(f"Created instance folder: {Config.INSTANCE_FOLDER_PATH}")
            except OSError as e:
                logger.error(f"Error creating instance folder {Config.INSTANCE_FOLDER_PATH} for config: {e}")
                return False, f'Failed to create instance folder: {str(e)}'
        
        with open(CONFIG_FILE_PATH, 'w') as f:
            json.dump(new_config_data, f, indent=2)
        
        return True, "Configuration saved successfully. Some changes may require an application restart to take effect."
    except Exception as e:
        logger.error(f"Error saving config file {CONFIG_FILE_PATH}: {str(e)}")
        logger.debug(traceback.format_exc())
        return False, f'Failed to save configuration: {str(e)}'
