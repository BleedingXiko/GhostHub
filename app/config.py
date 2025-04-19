# app/config.py
import os
import sys

def get_application_root():
    """
    Get the application root directory, handling both running as script and as frozen executable.
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
    """Base configuration."""
    SECRET_KEY = os.environ.get('SECRET_KEY', os.urandom(24))
    CATEGORIES_FILE = os.environ.get('CATEGORIES_FILE', 'media_categories.json')
    CACHE_EXPIRY = int(os.environ.get('CACHE_EXPIRY', 300))  # 5 minutes
    DEFAULT_PAGE_SIZE = int(os.environ.get('DEFAULT_PAGE_SIZE', 10))
    SESSION_EXPIRY = int(os.environ.get('SESSION_EXPIRY', 3600))  # 1 hour
    
    # Determine paths based on whether we're running as an executable or script
    APP_ROOT = get_application_root()
    
    # Static and Template folders are relative to the temporary _MEIPASS dir when frozen
    STATIC_FOLDER = os.path.join(APP_ROOT, 'static')
    TEMPLATE_FOLDER = os.path.join(APP_ROOT, 'templates')
    
    # Instance folder should be relative to the executable itself for persistence
    if getattr(sys, 'frozen', False):
        # Running as executable: Place 'instance' next to the .exe file
        INSTANCE_FOLDER_PATH = os.path.join(os.path.dirname(sys.executable), 'instance')
    else:
        # Running as script: Place 'instance' in the project root
        INSTANCE_FOLDER_PATH = os.path.join(APP_ROOT, 'instance')

    # Media Types Configuration
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

    # Flattened lists for easier checking
    IMAGE_EXTENSIONS = MEDIA_TYPES['image']['extensions']
    VIDEO_EXTENSIONS = MEDIA_TYPES['video']['extensions']
    MEDIA_EXTENSIONS = IMAGE_EXTENSIONS + VIDEO_EXTENSIONS

class DevelopmentConfig(Config):
    """Development configuration."""
    DEBUG = True

class ProductionConfig(Config):
    """Production configuration."""
    DEBUG = False
    # Add any production-specific settings here

# Dictionary to easily access configurations
config_by_name = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}
