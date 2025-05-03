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
    start_cloudflare_tunnel,
    start_pinggy_tunnel,  # Import the new function
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

    # Prompt for tunnel choice
    tunnel_process = None
    print("\n--- Tunnel Selection ---")
    print("Choose a tunneling service to expose the server publicly:")
    print("1: Cloudflare Tunnel (requires cloudflared)")
    print("2: Pinggy Tunnel (requires SSH and a token)")
    print("3: None (run locally only)")

    tunnel_choice = input("Enter your choice (1, 2, or 3): ").strip()

    try:
        if tunnel_choice == '1':
            if cloudflared_path:
                # Use 'y' to trigger the existing logic in start_cloudflare_tunnel
                tunnel_process = start_cloudflare_tunnel(cloudflared_path, port, use_tunnel='y')
            else:
                print("[!] Cloudflared executable not found. Cannot start Cloudflare Tunnel.")
        elif tunnel_choice == '2':
            pinggy_token = input("Enter your Pinggy token: ").strip()
            if pinggy_token:
                tunnel_process = start_pinggy_tunnel(port, pinggy_token)
            else:
                print("[!] Pinggy token not provided. Skipping Pinggy Tunnel.")
        elif tunnel_choice == '3':
            print("Skipping tunneling. Server will run locally.")
        else:
            print("Invalid choice. Skipping tunneling.")

    except Exception as e:
        print(f"[!] Error setting up tunnel: {e}")

    print("\n--- Starting Server ---")
    try:
        # Run the server (blocking call)
        run_server(app, port, debug=app.config.get('DEBUG', False))
    finally:
        # Clean up tunnel process if it exists
        cleanup_tunnel(tunnel_process)
