#!/usr/bin/env python3
"""
WSGI Entry Point for Gunicorn
-----------------------------
Initializes the Flask application for production deployment via Gunicorn.
It assumes the 'production' configuration will be used.
"""

import os
# Apply gevent monkey patching early, required for Gunicorn's gevent worker
from gevent import monkey
monkey.patch_all()

from app.utils.server_utils import initialize_app

# Set the config name explicitly for Gunicorn environment
# Gunicorn doesn't typically read the FLASK_CONFIG env var in the same way
# as the direct script execution might.
config_name = 'production'
port = int(os.getenv('PORT', 5000)) # Port might still be relevant for app internals

# Initialize the Flask application instance
app = initialize_app(config_name, port)

# Gunicorn will look for this 'app' variable by default
