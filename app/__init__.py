"""
Application Factory
-----------------
Flask application initialization and configuration.
"""
# app/__init__.py
import os
import uuid
import logging
from flask import Flask, request
from flask_socketio import SocketIO
from .config import config_by_name
from .utils.log_utils import LogObfuscationFilter # Import the filter

# Logging configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Apply the obfuscation filter
obfuscation_filter = LogObfuscationFilter()

# Add filter to the root logger itself
root_logger = logging.getLogger()
root_logger.addFilter(obfuscation_filter)

# Also, add filter to all handlers of the root logger
# This is important because basicConfig adds a handler to the root logger.
for handler in root_logger.handlers:
    handler.addFilter(obfuscation_filter)

logger = logging.getLogger(__name__) # Get a logger for this module AFTER filter is applied

# SocketIO initialization with optimized settings
socketio = SocketIO(
    async_mode='gevent',    # Use gevent for WebSockets
    ping_timeout=120,       # Increased ping timeout for better stability
    ping_interval=10,       # More frequent pings to detect disconnections earlier
    cors_allowed_origins="*",  # Allow all origins for simplicity
    max_http_buffer_size=50 * 1024 * 1024,  # 50MB buffer for large media transfers
    engineio_logger=False,  # Disable engineio logging for cleaner logs
    logger=False,           # Disable socketio logging for cleaner logs
    always_connect=True,    # Always allow connections even if the client doesn't respond to pings
    reconnection=True,      # Enable automatic reconnection
    reconnection_attempts=5,# Number of reconnection attempts
    reconnection_delay=1,   # Initial delay between reconnection attempts (in seconds)
    reconnection_delay_max=5# Maximum delay between reconnection attempts (in seconds)
)

def create_app(config_name='default'):
    """
    Create and configure Flask application instance.
    Returns configured Flask app with registered blueprints.
    """
    app = Flask(
        __name__,
        static_folder=config_by_name[config_name].STATIC_FOLDER,
        template_folder=config_by_name[config_name].TEMPLATE_FOLDER,
        instance_path=config_by_name[config_name].INSTANCE_FOLDER_PATH,
        instance_relative_config=True
    )
    app.config.from_object(config_by_name[config_name])
    app.ADMIN_SESSION_ID = None # Stores the session ID of the admin
    
    # Increase upload size limit for media files
    app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB
    
    # Performance optimization
    app.config['PROPAGATE_EXCEPTIONS'] = True  # Ensure exceptions are properly logged

    # Create instance directory for persistent data
    try:
        os.makedirs(app.instance_path, exist_ok=True)
        logger.info(f"Instance folder ensured at: {app.instance_path}")
    except OSError as e:
        logger.error(f"Could not create instance folder at {app.instance_path}: {e}")
        # Depending on the severity, you might want to raise the error or exit
        # For now, we log the error and continue

    # Connect SocketIO to Flask app
    socketio.init_app(app)
    logger.info("Flask-SocketIO initialized with eventlet for WebSockets.")

    # Register route blueprints
    from .routes.main_routes import main_bp
    from .routes.api_routes import api_bp
    from .routes.media_routes import media_bp
    from .routes.sync_routes import sync_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(api_bp, url_prefix='/api')
    app.register_blueprint(media_bp)
    app.register_blueprint(sync_bp, url_prefix='/api/sync')

    # Global middleware for session management
    @app.after_request
    def ensure_session_cookie(response):
        """Add session cookie to all successful responses."""
        if 'session_id' not in request.cookies and response.status_code < 400:
            session_id = str(uuid.uuid4())
            max_age = app.config.get('SESSION_EXPIRY', 3600)
            
            # Get secure flag from config or determine based on request
            secure_setting = app.config.get('SESSION_COOKIE_SECURE', 'auto')
            if secure_setting == 'auto':
                secure = request.is_secure
            else:
                secure = secure_setting == 'true'
            
            logger.info(f"Setting new session_id cookie via global after_request: {session_id}")
            response.set_cookie(
                'session_id', 
                session_id, 
                max_age=max_age, 
                httponly=True, 
                samesite='Lax',
                secure=secure
            )
        return response
    
    # Response optimization middleware
    @app.after_request
    def optimize_response(response):
        """Add caching headers to static and media responses."""
        # Add cache headers for static files
        if request.path.startswith('/static/'):
            response.headers['Cache-Control'] = 'public, max-age=86400'  # Cache for 1 day
            
        # Add appropriate headers for media files
        if request.path.startswith('/media/'):
            response.headers['Content-Encoding'] = 'identity'
            
        return response

    logger.info(f"Flask app created with config: {config_name}")
    logger.info(f"Static folder: {app.static_folder}")
    logger.info(f"Template folder: {app.template_folder}")
    logger.info(f"Instance path: {app.instance_path}")

    # Register WebSocket event handlers
    from .socket_events import register_socket_events
    register_socket_events(socketio)

    return app
