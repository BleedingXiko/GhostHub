# app/__init__.py
import os
import uuid
import logging
from flask import Flask, request
from flask_socketio import SocketIO
from .config import config_by_name

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Initialize SocketIO with optimized settings
# Using gevent for WebSockets
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
    """Application factory function."""
    app = Flask(
        __name__,
        static_folder=config_by_name[config_name].STATIC_FOLDER,
        template_folder=config_by_name[config_name].TEMPLATE_FOLDER,
        instance_path=config_by_name[config_name].INSTANCE_FOLDER_PATH,
        instance_relative_config=True
    )
    app.config.from_object(config_by_name[config_name])
    
    # Set larger max content length for media uploads (if needed)
    app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB
    
    # Configure for better performance
    app.config['PROPAGATE_EXCEPTIONS'] = True  # Ensure exceptions are properly logged

    # Ensure the instance folder exists
    try:
        os.makedirs(app.instance_path, exist_ok=True)
        logger.info(f"Instance folder ensured at: {app.instance_path}")
    except OSError as e:
        logger.error(f"Could not create instance folder at {app.instance_path}: {e}")
        # Depending on the severity, you might want to raise the error or exit
        # For now, we log the error and continue

    # Initialize SocketIO with the app
    socketio.init_app(app)
    logger.info("Flask-SocketIO initialized with eventlet for WebSockets.")

    # Register Blueprints
    from .routes.main_routes import main_bp
    from .routes.api_routes import api_bp
    from .routes.media_routes import media_bp
    from .routes.sync_routes import sync_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(api_bp, url_prefix='/api')
    app.register_blueprint(media_bp)
    app.register_blueprint(sync_bp, url_prefix='/api/sync')

    # Add a global after_request handler to ensure all responses have a session cookie
    @app.after_request
    def ensure_session_cookie(response):
        """Ensure that all responses have a session cookie."""
        if 'session_id' not in request.cookies and response.status_code < 400:
            session_id = str(uuid.uuid4())
            max_age = app.config.get('SESSION_EXPIRY', 3600)
            logger.info(f"Setting new session_id cookie via global after_request: {session_id}")
            response.set_cookie('session_id', session_id, max_age=max_age, httponly=True, samesite='Lax')
        return response
    
    # Add a global after_request handler to optimize media file responses
    @app.after_request
    def optimize_response(response):
        """Optimize responses for better performance."""
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

    # Register socket events after app creation to avoid circular imports
    from .socket_events import register_socket_events
    register_socket_events(socketio)

    return app
