#!/usr/bin/env python3
"""
GhostHub Server Entry Point (Docker Version)
-------------------------------------------
Docker-specific version that uses environment variables instead of prompts.
Supports automatic media detection from mounted volumes.

Environment Variables:
- FLASK_CONFIG: 'development' (default) or 'production'
- PORT: Server port number (default: 5000)
- USE_CLOUDFLARE_TUNNEL: 'y' or 'n' (default: 'n')
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
    start_cloudflare_tunnel,
    run_server,
    cleanup_tunnel
)

# Get configuration from environment variables
config_name = os.getenv('FLASK_CONFIG', 'development')
port = int(os.getenv('PORT', 5000))

# Initialize the Flask application
app = initialize_app(config_name, port)

if __name__ == '__main__':
    # Display server information
    display_server_info(config_name, port)
    
    # Find cloudflared executable
    cloudflared_path = find_cloudflared_path()
    
    # Use environment variable instead of prompting
    use_tunnel = os.getenv('USE_CLOUDFLARE_TUNNEL', 'n').lower()
    
    # Log the tunnel configuration
    if use_tunnel == 'y':
        print("Cloudflare Tunnel enabled via environment variable.")
    else:
        print("Cloudflare Tunnel disabled via environment variable.")
    
    # Start tunnel if requested
    tunnel_process = None
    if cloudflared_path:
        try:
            tunnel_process = start_cloudflare_tunnel(cloudflared_path, port, use_tunnel)
        except Exception as e:
            print(f"[!] Error handling Cloudflare Tunnel: {e}")
    
    try:
        # Run the server (blocking call)
        run_server(app, port, debug=app.config.get('DEBUG', False))
    finally:
        # Clean up tunnel process if it exists
        cleanup_tunnel(tunnel_process)
