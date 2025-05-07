#!/usr/bin/env python3
"""
GhostHub Server Entry Point
---------------------------
Initializes and runs the Flask application with SocketIO using gevent for WebSockets.
Supports optional Cloudflare Tunnel for public sharing.

Environment Variables:
- FLASK_CONFIG: 'development' (default) or 'production'
- PORT: Server port number (default: 5000)
"""

import os
import sys
# Apply gevent monkey patching early to ensure proper async I/O
from gevent import monkey
monkey.patch_all()

# Import server utilities after monkey patching
from app.utils.server_utils import (
    initialize_app,
    display_server_info,
    find_cloudflared_path,
    # start_cloudflare_tunnel, # No longer called directly at startup
    # start_pinggy_tunnel,    # No longer called directly at startup
    run_server,
    stop_active_tunnel, # Ensures any active tunnel is stopped on exit
    # get_active_tunnel_status # No longer needed at startup
    find_cloudflared_path # Still needed for the API to find the executable
)

# Get configuration from environment variables
# Default to 'production' if FLASK_CONFIG is not set
config_name = os.getenv('FLASK_CONFIG', 'production')
port = int(os.getenv('PORT', 5000))

# Initialize the Flask application
app = initialize_app(config_name, port)

if __name__ == '__main__':
    # Display server information
    display_server_info(config_name, port)
    
    # Find cloudflared executable path (needed for API calls, not direct CLI start)
    # This call doesn't start anything, just finds the path if it exists.
    find_cloudflared_path() 

    # CLI tunnel selection logic has been removed.
    # Tunnels will be managed via the UI.

    print("\n--- Starting Server ---")
    print("Tunnel management is now available via the web UI.")
    try:
        run_server(app, port)
    finally:
        # Clean up any active tunnel using the new global state function
        print("\n--- Server Shutting Down ---")
        stop_active_tunnel()
