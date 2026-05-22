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
        current_file = os.path.abspath(__file__)
        
        # Handle bytecode case: if __file__ is in __pycache__, go up one more level
        if '__pycache__' in current_file:
            # __file__ is something like /path/to/app/__pycache__/config.cpython-39.pyc
            # We need to go up 3 levels: __pycache__ -> app -> ghosthub
            return os.path.dirname(os.path.dirname(os.path.dirname(current_file)))
        else:
            # Normal case: go up two directories from app/config.py
            return os.path.dirname(os.path.dirname(current_file))

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
    SESSION_EXPIRY = 604800  # 7 days (prevents admin session from expiring during normal usage)
    SHUFFLE_MEDIA = False  # Better default: chronological order instead of shuffle
    WS_RECONNECT_ATTEMPTS = 10
    WS_RECONNECT_DELAY = 1000  # ms
    WS_RECONNECT_FACTOR = 1.5
    MEMORY_CLEANUP_INTERVAL = 60000  # ms
    MAX_CACHE_SIZE = 50
    SAVE_VIDEO_PROGRESS = True  # Better default: save user's place for better UX
    SAVE_PROGRESS_FOR_HIDDEN_FILES = True  # When False, progress is not saved for hidden files
    ENABLE_SUBTITLES = True  # Better default: subtitles should be available by default
    ENABLE_TV_SORTING = True  # Enable intelligent TV season/episode sorting
    VIDEO_END_BEHAVIOR = "loop"  # What to do when video ends: "stop", "loop", or "play_next"
    DEBUG_MODE = False  # Enable verbose console/debug logging (set True for development)
    MAX_CATEGORY_SCAN_DEPTH = 0  # 0 = unlimited scan depth for nested media folders
    UI_SETTINGS_MODE = "basic"  # Settings modal mode: "basic" (simplified) or "advanced" (all settings)
    AUTO_OPTIMIZE_FOR_HARDWARE = True  # Enable dynamic scaling based on RAM
    ENABLE_GZIP_COMPRESSION = True  # Compress text responses when clients support gzip
    GZIP_MIN_SIZE = 1024  # Skip compression for tiny responses to save CPU on Pi hardware
    GZIP_COMPRESSION_LEVEL = 5  # Middle-ground level for CPU vs bandwidth on embedded devices
    ENABLE_GZIP_CACHE = True  # Reuse compressed static assets instead of recompressing on each request
    GZIP_CACHE_MAX_ENTRIES = 64  # Keep the in-memory cache small for Raspberry Pi deployments
    
    # HDMI-CEC TV Wake-up Configuration
    ENABLE_CEC_WAKE = True  # Enable automatic TV wake-up via CEC before casting
    CEC_WAKE_TIMEOUT = 5    # Seconds to wait for CEC commands before proceeding

    # Smaller chunks = less RAM per upload, better recovery from connection drops
    UPLOAD_CHUNK_SIZE_FAST = 4 * 1024 * 1024    # 4MB for Ethernet connections
    UPLOAD_CHUNK_SIZE_MEDIUM = 2 * 1024 * 1024  # 2MB for WiFi AP mode
    UPLOAD_CHUNK_SIZE_SLOW = 1 * 1024 * 1024    # 1MB for mobile on AP
    UPLOAD_CHUNK_SIZE_TAILSCALE = 128 * 1024    # 128KB for Tailscale (high latency, low jitter)

    # Rate limiting (Mbps) - Prevents network saturation and abuse
    # These are base limits for AP/WiFi; Ethernet gets 4x multiplier via network detection
    # Set to 0 to disable rate limiting for that category
    UPLOAD_RATE_LIMIT_PER_CLIENT = 500.0   # Mbps per client for uploads (LAN-class; chunks block-and-wait, not 429)
    UPLOAD_RATE_LIMIT_GLOBAL = 1000.0      # Mbps total for all uploads (~125 MB/s; above realistic Pi+USB disk write)
    DOWNLOAD_RATE_LIMIT_PER_CLIENT = 50.0  # Mbps per client for downloads (base for AP/WiFi)
    DOWNLOAD_RATE_LIMIT_GLOBAL = 100.0     # Mbps total for all downloads
    STREAM_MAX_DURATION_SECONDS = 0         # 0 = unlimited, >0 = hard cap per stream request
    STREAM_READ_TIMEOUT_SECONDS = 15        # Per-chunk file read timeout for streaming
    STALE_MEDIA_CLEANUP_INTERVAL = 21600    # Run stale media cleanup every 6 hours
    STALE_MEDIA_CLEANUP_BATCH_SIZE = 5000   # Max rows validated per cleanup pass
    INDEXING_CHUNK_SIZE_BASE = 25           # 2GB tier: files processed per indexing batch
    INDEXING_CHUNK_SIZE_STANDARD = 75       # 4GB tier
    INDEXING_CHUNK_SIZE_PRO = 150           # 8GB tier

    # Connection-type rate limit multipliers (applied by rate_limit_service)
    RATE_LIMIT_MULTIPLIER_ETHERNET = 4.0   # Ethernet: 50 * 4 = 200 Mbps effective
    RATE_LIMIT_MULTIPLIER_LOCALHOST = 0.0  # Localhost: no limit (0 = disabled)
    RATE_LIMIT_MULTIPLIER_WIFI = 1.0       # WiFi AP: use base limit
    RATE_LIMIT_MULTIPLIER_TAILSCALE = 0.5  # Tailscale: 50 * 0.5 = 25 Mbps (high latency)

    # Tunneling settings
    TUNNEL_PROVIDER = "none"  # "none", "pinggy", "cloudflare", "wireguard"
    PINGGY_ACCESS_TOKEN = ""
    TUNNEL_LOCAL_PORT = 5000
    TUNNEL_AUTO_START = False  # Automatically start configured tunnel on boot
    SESSION_PASSWORD = ""  # Password for session access, empty means no password
    ADMIN_PASSWORD = "admin"  # Master password to reclaim admin status
    
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
# Use absolute path to prevent nested folder issues
_instance_folder = os.path.abspath(Config.INSTANCE_FOLDER_PATH)
_config_json_path = os.path.join(_instance_folder, 'ghosthub_config.json')
_python_config_from_json = {}

if not os.path.exists(_instance_folder):
    try:
        os.makedirs(_instance_folder)
        logger.info(f"Created instance folder: {_instance_folder}")
    except OSError as e:
        logger.error(f"Error creating instance folder {_instance_folder}: {e}")

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
    'TUNNEL_AUTO_START': lambda v: str(v).lower() == 'true',
    'SESSION_PASSWORD': str,
    'ADMIN_PASSWORD': str,
    'SAVE_VIDEO_PROGRESS': lambda v: str(v).lower() == 'true',
    'SAVE_PROGRESS_FOR_HIDDEN_FILES': lambda v: str(v).lower() == 'true',
    'ENABLE_SUBTITLES': lambda v: str(v).lower() == 'true',
    'ENABLE_TV_SORTING': lambda v: str(v).lower() == 'true',
    'VIDEO_END_BEHAVIOR': str,
    'DEBUG_MODE': lambda v: str(v).lower() == 'true',
    'UPLOAD_CHUNK_SIZE_FAST': int,
    'UPLOAD_CHUNK_SIZE_MEDIUM': int,
    'UPLOAD_CHUNK_SIZE_SLOW': int,
    'UPLOAD_RATE_LIMIT_PER_CLIENT': float,
    'UPLOAD_RATE_LIMIT_GLOBAL': float,
    'DOWNLOAD_RATE_LIMIT_PER_CLIENT': float,
    'DOWNLOAD_RATE_LIMIT_GLOBAL': float,
    'STREAM_MAX_DURATION_SECONDS': float,
    'STREAM_READ_TIMEOUT_SECONDS': float,
    'STALE_MEDIA_CLEANUP_INTERVAL': int,
    'STALE_MEDIA_CLEANUP_BATCH_SIZE': int,
    'INDEXING_CHUNK_SIZE_BASE': int,
    'INDEXING_CHUNK_SIZE_STANDARD': int,
    'INDEXING_CHUNK_SIZE_PRO': int,
    'MAX_CATEGORY_SCAN_DEPTH': int,
    'UI_SETTINGS_MODE': str,
    'AUTO_OPTIMIZE_FOR_HARDWARE': lambda v: str(v).lower() == 'true',
    'ENABLE_GZIP_COMPRESSION': lambda v: str(v).lower() == 'true',
    'GZIP_MIN_SIZE': int,
    'GZIP_COMPRESSION_LEVEL': int,
    'ENABLE_GZIP_CACHE': lambda v: str(v).lower() == 'true',
    'GZIP_CACHE_MAX_ENTRIES': int,
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
