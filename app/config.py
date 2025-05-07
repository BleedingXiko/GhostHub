"""
GhostHub Configuration Module
----------------------------
Defines application settings and handles different runtime environments.
Supports both script and executable modes with environment variable overrides.
"""
# app/config.py
import os
import sys
import json
import logging

logger = logging.getLogger(__name__)

def get_application_root():
    """
    Get the application root directory for script or executable mode.
    
    Returns:
        str: Path to application root
    """
    if getattr(sys, 'frozen', False):
        # Running as a PyInstaller executable
        # The root is the temporary _MEIPASS directory
        if hasattr(sys, '_MEIPASS'):
            return sys._MEIPASS
        else:
            # Fallback if _MEIPASS is not set (should not happen with --onefile)
            return os.path.dirname(sys.executable)
    else:
        # Running as a script
        # The root is the directory containing ghosthub.py
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Config:
    """
    Base configuration with default settings and environment variable overrides.
    Includes core settings, security, WebSocket, paths, and media type definitions.
    """
    # Core settings
    SECRET_KEY = os.environ.get('SECRET_KEY', os.urandom(24))  # Session security
    CATEGORIES_FILE = os.environ.get('CATEGORIES_FILE', 'media_categories.json')
    SESSION_COOKIE_SECURE = os.environ.get('SESSION_COOKIE_SECURE', 'auto') == 'true' # Stays as env-var/default only

    # Default values for settings that can be overridden by JSON and then ENV VARS
    CACHE_EXPIRY = 300  # 5 minutes
    DEFAULT_PAGE_SIZE = 10
    SESSION_EXPIRY = 3600  # 1 hour
    SHUFFLE_MEDIA = True 
    WS_RECONNECT_ATTEMPTS = 10
    WS_RECONNECT_DELAY = 1000  # ms
    WS_RECONNECT_FACTOR = 1.5
    MEMORY_CLEANUP_INTERVAL = 60000  # ms
    MAX_CACHE_SIZE = 50

    # Tunneling settings
    TUNNEL_PROVIDER = "none"  # "none", "pinggy", "cloudflare"
    PINGGY_ACCESS_TOKEN = ""
    TUNNEL_LOCAL_PORT = 5000
    SESSION_PASSWORD = ""  # Password for session access, empty means no password
    
    # Path resolution for script/executable modes
    APP_ROOT = get_application_root()
    
    # Static and template directories
    STATIC_FOLDER = os.path.join(APP_ROOT, 'static')
    TEMPLATE_FOLDER = os.path.join(APP_ROOT, 'templates')
    
    # Instance folder for persistent data
    if getattr(sys, 'frozen', False):
        # Running as executable: Place 'instance' next to the .exe file
        INSTANCE_FOLDER_PATH = os.path.join(os.path.dirname(sys.executable), 'instance')
    else:
        # Running as script: Place 'instance' in the project root
        INSTANCE_FOLDER_PATH = os.path.join(APP_ROOT, 'instance')

    # Supported media formats and MIME types
    MEDIA_TYPES = {
        'image': {
            'extensions': [
                '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.svg',
                '.webp', '.ico', '.heic', '.heif', '.raw', '.cr2', '.nef',
                '.arw', '.dng', '.orf', '.sr2', '.psd', '.xcf'
            ],
            'mime_types': {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.bmp': 'image/bmp',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.tiff': 'image/tiff',
                '.tif': 'image/tiff',
                '.ico': 'image/x-icon',
                '.heic': 'image/heic',
                '.heif': 'image/heif'
            }
        },
        'video': {
            'extensions': [
                '.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.m4v',
                '.3gp', '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.ogv', '.mts',
                '.m2v', '.divx', '.asf', '.rm', '.rmvb', '.mp2', '.mpv', '.f4v', '.swf'
            ],
            'mime_types': {
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mov': 'video/quicktime',
                '.avi': 'video/x-msvideo',
                '.mkv': 'video/x-matroska',
                '.wmv': 'video/x-ms-wmv',
                '.flv': 'video/x-flv',
                '.m4v': 'video/mp4',
                '.3gp': 'video/3gpp',
                '.mpg': 'video/mpeg',
                '.mpeg': 'video/mpeg',
                '.ts': 'video/mp2t',
                '.m2ts': 'video/mp2t',
                '.ogv': 'video/ogg',
                '.mts': 'video/mp2t'
            }
        }
    }

    # Flattened extension lists for faster checking
    IMAGE_EXTENSIONS = MEDIA_TYPES['image']['extensions']
    VIDEO_EXTENSIONS = MEDIA_TYPES['video']['extensions']
    MEDIA_EXTENSIONS = IMAGE_EXTENSIONS + VIDEO_EXTENSIONS

# Load configurations from JSON and environment variables after Config class definition
_config_json_path = os.path.join(Config.INSTANCE_FOLDER_PATH, 'ghosthub_config.json')
_python_config_from_json = {}

if not os.path.exists(Config.INSTANCE_FOLDER_PATH):
    try:
        os.makedirs(Config.INSTANCE_FOLDER_PATH)
        logger.info(f"Created instance folder: {Config.INSTANCE_FOLDER_PATH}")
    except OSError as e:
        logger.error(f"Error creating instance folder {Config.INSTANCE_FOLDER_PATH}: {e}")

if os.path.exists(_config_json_path):
    try:
        with open(_config_json_path, 'r') as f:
            _loaded_json = json.load(f)
            _python_config_from_json = _loaded_json.get('python_config', {})
    except FileNotFoundError:
        # This case should ideally not be hit if os.path.exists is true, but as a safeguard:
        logger.warning(f"Config file disappeared between check and open: {_config_json_path}. Using defaults.")
    except json.JSONDecodeError:
        logger.warning(f"Error decoding JSON from {_config_json_path}. Using defaults and environment variables.")
    except Exception as e:
        logger.warning(f"An unexpected error occurred while reading {_config_json_path}: {e}. Using defaults and environment variables.")
else:
    logger.info(f"Configuration file {_config_json_path} not found. Using defaults and environment variables. A default config will be created if settings are saved via UI.")

_configurable_keys_info = {
    'CACHE_EXPIRY': int,
    'DEFAULT_PAGE_SIZE': int,
    'SESSION_EXPIRY': int,
    'SHUFFLE_MEDIA': lambda v: str(v).lower() == 'true',
    'WS_RECONNECT_ATTEMPTS': int,
    'WS_RECONNECT_DELAY': int,
    'WS_RECONNECT_FACTOR': float,
    'MEMORY_CLEANUP_INTERVAL': int,
    'MAX_CACHE_SIZE': int,
    'TUNNEL_PROVIDER': str,
    'PINGGY_ACCESS_TOKEN': str,
    'TUNNEL_LOCAL_PORT': int,
    'SESSION_PASSWORD': str
}

for key, type_converter in _configurable_keys_info.items():
    # 1. Default is already set in Config class definition
    
    # 2. Apply JSON value if present (overrides hardcoded default)
    if key in _python_config_from_json:
        try:
            json_val = _python_config_from_json[key]
            setattr(Config, key, type_converter(json_val))
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid value for '{key}' in config.json: '{_python_config_from_json[key]}'. Error: {e}. Using previous value.")
            # Value remains as hardcoded default or previously set env var if this is a re-load
            
    # 3. Apply Environment variable if present (overrides JSON and hardcoded default)
    env_value = os.environ.get(key)
    if env_value is not None:
        try:
            setattr(Config, key, type_converter(env_value))
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid value for environment variable '{key}': '{env_value}'. Error: {e}. Using previous value.")
            # Value remains as hardcoded default or JSON value


class DevelopmentConfig(Config):
    """Development configuration with debug mode enabled."""
    ENV = 'development'
    DEBUG = True

class ProductionConfig(Config):
    """Production configuration with debug mode disabled."""
    ENV = 'production'
    DEBUG = False
    # Add any production-specific settings here

# Configuration registry by name
config_by_name = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}
