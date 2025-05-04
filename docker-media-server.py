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
    start_pinggy_tunnel,  # Import the new function
    run_server,
    cleanup_tunnel
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
    
    # Find cloudflared executable
    cloudflared_path = find_cloudflared_path()
    
    # Determine tunnel choice from environment variables
    tunnel_process = None
    tunnel_choice = os.getenv('TUNNEL_CHOICE', 'none').lower()
    pinggy_token = os.getenv('PINGGY_TOKEN') # Will be None if not set

    print("\n--- Tunnel Configuration (Docker) ---")
    print(f"TUNNEL_CHOICE set to: {tunnel_choice}")

    # Start the selected tunnel
    try:
        if tunnel_choice == 'cloudflare':
            if cloudflared_path:
                # Use 'y' to trigger the existing logic in start_cloudflare_tunnel
                tunnel_process = start_cloudflare_tunnel(cloudflared_path, port, use_tunnel='y')
            else:
                print("[!] Cloudflared executable not found in container. Cannot start Cloudflare Tunnel.")
        elif tunnel_choice == 'pinggy':
            if pinggy_token:
                print("PINGGY_TOKEN found.")
                tunnel_process = start_pinggy_tunnel(port, pinggy_token)
            else:
                print("[!] WARNING: TUNNEL_CHOICE is 'pinggy' but PINGGY_TOKEN is not set. Tunnel will not start.")
        elif tunnel_choice == 'none':
            print("Skipping tunneling as per TUNNEL_CHOICE=none.")
        else:
            print(f"Invalid TUNNEL_CHOICE '{tunnel_choice}'. Skipping tunneling.")

    except Exception as e:
        print(f"[!] Error setting up tunnel: {e}")

    print("\n--- Starting Server ---")
    try:
        # Run the server (blocking call)
        # The run_server function now determines debug/production mode internally
        run_server(app, port)
    finally:
        # Clean up tunnel process if it exists
        cleanup_tunnel(tunnel_process)
