"""
GhostHub Configuration Module
----------------------------
Defines application settings and handles different runtime environments.
Supports both script and executable modes with environment variable overrides.
"""
# app/config.py
import os
import sys

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
        # The root is the directory containing media_server.py
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Config:
    """
    Base configuration with default settings and environment variable overrides.
    Includes core settings, security, WebSocket, paths, and media type definitions.
    """
    # Core settings
    SECRET_KEY = os.environ.get('SECRET_KEY', os.urandom(24))  # Session security
    CATEGORIES_FILE = os.environ.get('CATEGORIES_FILE', 'media_categories.json')
    CACHE_EXPIRY = int(os.environ.get('CACHE_EXPIRY', 300))  # 5 minutes
    DEFAULT_PAGE_SIZE = int(os.environ.get('DEFAULT_PAGE_SIZE', 10))
    SESSION_EXPIRY = int(os.environ.get('SESSION_EXPIRY', 3600))  # 1 hour
    SHUFFLE_MEDIA = os.environ.get('SHUFFLE_MEDIA', 'true').lower() == 'false'  # BUG issue with using shuffle and sync while inside a folder
    
    # Security settings - 'auto', 'true', or 'false'
    SESSION_COOKIE_SECURE = os.environ.get('SESSION_COOKIE_SECURE', 'auto') == 'true'
    
    # WebSocket settings
    WS_RECONNECT_ATTEMPTS = int(os.environ.get('WS_RECONNECT_ATTEMPTS', 10))
    WS_RECONNECT_DELAY = int(os.environ.get('WS_RECONNECT_DELAY', 1000))  # ms
    WS_RECONNECT_FACTOR = float(os.environ.get('WS_RECONNECT_FACTOR', 1.5))
    
    # Memory management
    MEMORY_CLEANUP_INTERVAL = int(os.environ.get('MEMORY_CLEANUP_INTERVAL', 60000))  # ms
    MAX_CACHE_SIZE = int(os.environ.get('MAX_CACHE_SIZE', 50))
    
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

class DevelopmentConfig(Config):
    """Development configuration with debug mode enabled."""
    DEBUG = True

class ProductionConfig(Config):
    """Production configuration with debug mode disabled."""
    DEBUG = False
    # Add any production-specific settings here

# Configuration registry by name
config_by_name = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}
