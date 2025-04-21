"""
Main Routes
----------
Primary web page routes for the application.
"""
# app/routes/main_routes.py
import uuid
import logging
from flask import Blueprint, render_template, request, make_response, current_app

logger = logging.getLogger(__name__)
main_bp = Blueprint('main', __name__)

@main_bp.route('/')
def index():
    """Render main category listing page."""
    logger.info("Serving index page.")
    # Session cookie is set by the global after_request handler in app/__init__.py
    return render_template('index.html')

@main_bp.route('/add_category')
def add_category_page():
    """Render category creation page."""
    logger.info("Serving add category page.")
    # Session cookie is set by the global after_request handler in app/__init__.py
    return render_template('add_category.html')

# Session cookie handling moved to app/__init__.py
# @main_bp.after_request
# def set_session_cookie(response):
#     """Set session cookie for user tracking."""
#     if 'session_id' not in request.cookies and response.status_code < 400:
#         session_id = str(uuid.uuid4())
#         max_age = current_app.config.get('SESSION_EXPIRY', 3600)
#         logger.info(f"Setting new session_id cookie via after_request: {session_id}")
#         response.set_cookie('session_id', session_id, max_age=max_age, httponly=True, samesite='Lax')
#     return response

# Blueprint-specific error handlers (currently disabled)
# @main_bp.app_errorhandler(404)
# def page_not_found(e):
#     """Render custom 404 page."""
#     logger.warning(f"404 Not Found: {request.path}")
#     return render_template('404.html'), 404

# @main_bp.app_errorhandler(500)
# def internal_server_error(e):
#     """Render custom 500 page."""
#     logger.error(f"500 Internal Server Error: {e}", exc_info=True)
#     return render_template('500.html'), 500
