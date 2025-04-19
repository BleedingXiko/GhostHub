# app/routes/main_routes.py
import uuid
import logging
from flask import Blueprint, render_template, request, make_response, current_app

logger = logging.getLogger(__name__)
main_bp = Blueprint('main', __name__)

@main_bp.route('/')
def index():
    """Serve the main category listing page."""
    logger.info("Serving index page.")
    # Set session cookie here if needed, or use @after_request
    resp = make_response(render_template('index.html'))
    if 'session_id' not in request.cookies:
        session_id = str(uuid.uuid4())
        max_age = current_app.config.get('SESSION_EXPIRY', 3600)
        logger.info(f"Setting new session_id cookie: {session_id}")
        resp.set_cookie('session_id', session_id, max_age=max_age, httponly=True, samesite='Lax')
    return resp

@main_bp.route('/add_category')
def add_category_page():
    """Serve the page for adding a new category."""
    logger.info("Serving add category page.")
    # Set session cookie here as well, in case user lands here directly
    resp = make_response(render_template('add_category.html'))
    if 'session_id' not in request.cookies:
        session_id = str(uuid.uuid4())
        max_age = current_app.config.get('SESSION_EXPIRY', 3600)
        logger.info(f"Setting new session_id cookie on add_category page: {session_id}")
        resp.set_cookie('session_id', session_id, max_age=max_age, httponly=True, samesite='Lax')
    return resp

# A global @after_request has been added in app/__init__.py for setting the cookie
# @main_bp.after_request
# def set_session_cookie(response):
#     """Set a session cookie if it doesn't exist."""
#     if 'session_id' not in request.cookies and response.status_code < 400:
#         session_id = str(uuid.uuid4())
#         max_age = current_app.config.get('SESSION_EXPIRY', 3600)
#         logger.info(f"Setting new session_id cookie via after_request: {session_id}")
#         response.set_cookie('session_id', session_id, max_age=max_age, httponly=True, samesite='Lax')
#     return response

# Add error handlers if they are specific to this blueprint
# @main_bp.app_errorhandler(404)
# def page_not_found(e):
#     logger.warning(f"404 Not Found: {request.path}")
#     # Render a custom 404 page or return JSON
#     return render_template('404.html'), 404

# @main_bp.app_errorhandler(500)
# def internal_server_error(e):
#     logger.error(f"500 Internal Server Error: {e}", exc_info=True)
#     # Render a custom 500 page or return JSON
#     return render_template('500.html'), 500
