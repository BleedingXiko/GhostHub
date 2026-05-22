# app/services/config_service.py
import os
import json
import logging
import traceback
from copy import deepcopy

from app.services.core.runtime_config_service import get_runtime_config_value

logger = logging.getLogger(__name__)

# Path to the main JSON configuration file stored in the instance folder.
# Use absolute path to prevent nested folder issues
_instance_folder = os.path.abspath(get_runtime_config_value('INSTANCE_FOLDER_PATH'))
CONFIG_FILE_PATH = os.path.join(_instance_folder, 'ghosthub_config.json')
THEME_COLOR_KEYS = ('primary', 'accent', 'background', 'surface', 'text')


def _sanitize_theme_colors(colors):
    """Return a theme color dict in the current five-color contract."""
    if not isinstance(colors, dict):
        return colors
    return {key: colors[key] for key in THEME_COLOR_KEYS if key in colors}


def _sanitize_ui_theme_payload(config_data):
    """Normalize persisted UI theme data to the current theme contract."""
    ui_config = config_data.get('javascript_config', {}).get('ui')
    if not isinstance(ui_config, dict):
        return config_data

    custom_themes = ui_config.get('customThemes')
    if isinstance(custom_themes, list):
        sanitized_themes = []
        for theme in custom_themes:
            if not isinstance(theme, dict):
                sanitized_themes.append(theme)
                continue
            next_theme = theme.copy()
            if 'colors' in next_theme:
                next_theme['colors'] = _sanitize_theme_colors(next_theme['colors'])
            sanitized_themes.append(next_theme)
        ui_config['customThemes'] = sanitized_themes

    if isinstance(ui_config.get('customThemeColors'), dict):
        ui_config['customThemeColors'] = _sanitize_theme_colors(ui_config['customThemeColors'])

    return config_data

def get_default_config():
    """Returns the default configuration structure."""
    return {
        "python_config": {
            "CACHE_EXPIRY": 300,
            "DEFAULT_PAGE_SIZE": 10,
            "SESSION_EXPIRY": 604800,  # 7 days (matches app/config.py)
            "SHUFFLE_MEDIA": False,  # Better default: chronological order
            "WS_RECONNECT_ATTEMPTS": 10,
            "WS_RECONNECT_DELAY": 1000,
            "WS_RECONNECT_FACTOR": 1.5,
            "MEMORY_CLEANUP_INTERVAL": 60000,
            "MAX_CACHE_SIZE": 50,
            "SAVE_VIDEO_PROGRESS": True,  # Better default: save user's place
            "SAVE_PROGRESS_FOR_HIDDEN_FILES": True,  # Save progress for hidden files
            "ENABLE_SUBTITLES": True,  # Better default: subtitles available by default
            "ENABLE_TV_SORTING": True,  # Smart TV/anime season/episode sorting
            "ENABLE_CEC_WAKE": True,
            "VIDEO_END_BEHAVIOR": "loop",  # What to do when video ends: "stop", "loop", or "play_next"
            "DEBUG_MODE": False,
            "SESSION_PASSWORD": "",
            "ADMIN_PASSWORD": "admin",
            "UPLOAD_RATE_LIMIT_PER_CLIENT": 500.0,
            "UPLOAD_RATE_LIMIT_GLOBAL": 1000.0,
            "DOWNLOAD_RATE_LIMIT_PER_CLIENT": 50.0,
            "DOWNLOAD_RATE_LIMIT_GLOBAL": 100.0,
            "STREAM_MAX_DURATION_SECONDS": 0,
            "STREAM_READ_TIMEOUT_SECONDS": 15,
            "STALE_MEDIA_CLEANUP_INTERVAL": 21600,
            "STALE_MEDIA_CLEANUP_BATCH_SIZE": 5000,
            "MAX_CATEGORY_SCAN_DEPTH": 0,
            "UI_SETTINGS_MODE": "basic",
            "AUTO_OPTIMIZE_FOR_HARDWARE": True,
            "SESSION_COOKIE_SECURE": "auto"
        },
        "javascript_config": {
            "main": {
                "socket_reconnectionAttempts": 5,
                "socket_reconnectionDelay": 2000,
                "phase2_init_delay": 62.5,
                "phase3_init_delay": 125
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
            },
            "ui": {
                "theme": "dark",
                "layout": "streaming",
                "features": {
                    "chat": True,
                    "search": True,
                    "syncButton": True,
                    "headerBranding": True
                }
            },
            "ghoststream": {
                "preferredQuality": "original",
                "autoTranscodeFormats": True,
                "autoTranscodeHighBitrate": True,
                "enableABR": False,
                "debug": False
            }
        }
    }

def load_config():
    """Loads the configuration from the JSON file, or returns defaults if not found/invalid."""
    try:
        # Ensure instance folder exists before trying to access config file
        if not os.path.exists(_instance_folder):
            try:
                os.makedirs(_instance_folder, exist_ok=True)
                logger.info(f"Created instance folder: {_instance_folder}")
            except OSError as e:
                logger.warning(f"Could not create instance folder {_instance_folder}: {e}")
                return get_default_config(), f"Could not create instance folder: {e}. Using defaults."
        
        if os.path.exists(CONFIG_FILE_PATH):
            with open(CONFIG_FILE_PATH, 'r') as f:
                config_data = json.load(f)
            
            # Ensure all sections and sub-sections are present, falling back to defaults
            default_config = get_default_config()
            
            # Ensure python_config section and its keys
            loaded_python_config = config_data.get("python_config", {})
            final_python_config = default_config["python_config"].copy()
            final_python_config.update(loaded_python_config) # User values override defaults
            
            # Apply hardware optimizations if enabled
            if final_python_config.get('AUTO_OPTIMIZE_FOR_HARDWARE', True):
                from app.services.system.system_stats_service import get_hardware_tier
                tier = get_hardware_tier()
                if tier == 'PRO':
                    # Pro tier: 8GB+ RAM
                    final_python_config['MAX_CACHE_SIZE'] = max(final_python_config.get('MAX_CACHE_SIZE', 50), 500)
                elif tier == 'STANDARD':
                    # Standard tier: 4GB RAM
                    final_python_config['MAX_CACHE_SIZE'] = max(final_python_config.get('MAX_CACHE_SIZE', 50), 200)
            
            config_data["python_config"] = final_python_config

            # Ensure javascript_config section and its sub-sections and keys
            loaded_javascript_config = config_data.get("javascript_config", {})
            final_javascript_config = {}

            for js_section_key, js_section_defaults in default_config["javascript_config"].items():
                loaded_js_section = loaded_javascript_config.get(js_section_key, {})
                
                # Handle nested objects (like ui.features)
                if isinstance(js_section_defaults, dict):
                    final_js_section = {}
                    # First, apply defaults
                    for key, default_value in js_section_defaults.items():
                        if isinstance(default_value, dict):
                            # Nested dict - merge
                            loaded_nested = loaded_js_section.get(key, {})
                            final_js_section[key] = {**default_value, **loaded_nested}
                        else:
                            # Simple value
                            final_js_section[key] = loaded_js_section.get(key, default_value)
                    # Then, preserve any additional user-defined keys (like customThemes, customThemeColors)
                    for key, value in loaded_js_section.items():
                        if key not in final_js_section:
                            final_js_section[key] = value
                else:
                    final_js_section = loaded_js_section if loaded_js_section else js_section_defaults
                    
                final_javascript_config[js_section_key] = final_js_section
            
            # Preserve any additional user-defined sections not in defaults (e.g., ghoststream custom settings)
            for extra_key, extra_value in loaded_javascript_config.items():
                if extra_key not in final_javascript_config:
                    final_javascript_config[extra_key] = extra_value

            config_data["javascript_config"] = final_javascript_config
            _sanitize_ui_theme_payload(config_data)

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

        # Ensure instance folder exists (use absolute path)
        if not os.path.exists(_instance_folder):
            try:
                os.makedirs(_instance_folder)
                logger.info(f"Created instance folder: {_instance_folder}")
            except OSError as e:
                logger.error(f"Error creating instance folder {_instance_folder} for config: {e}")
                return False, f'Failed to create instance folder: {str(e)}'
        
        config_to_save = _sanitize_ui_theme_payload(deepcopy(new_config_data))
        with open(CONFIG_FILE_PATH, 'w') as f:
            json.dump(config_to_save, f, indent=2)
        
        return True, "Configuration saved successfully. Some changes may require an application restart to take effect."
    except Exception as e:
        logger.error(f"Error saving config file {CONFIG_FILE_PATH}: {str(e)}")
        logger.debug(traceback.format_exc())
        return False, f'Failed to save configuration: {str(e)}'
