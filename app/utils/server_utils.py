#!/usr/bin/env python3
"""
GhostHub Server Utilities
-------------------------
Server initialization and management utilities for standard and Docker modes.
"""

import os
import sys
import logging
import socket
import subprocess
import shutil # For finding gunicorn executable
import threading
import re
import time
import json
import requests
from pathlib import Path
from app import create_app, socketio, logger as app_logger
import app.services.system.tunnel.service as system_tunnel_service
from app.services.system.tunnel.binary_service import find_cloudflared_path as resolve_cloudflared_path
from app.services.system.tunnel.mesh_service import start_mesh_tunnel as launch_mesh_tunnel
from app.services.system.tunnel.provider_service import (
    start_cloudflare_tunnel as launch_cloudflare_tunnel,
    start_pinggy_tunnel as launch_pinggy_tunnel,
)
from app.utils.system_utils import get_local_ip
from app.utils.file_utils import init_categories_file
from app.services.media.playlist_service import PlaylistService # Import PlaylistService

def initialize_app(config_name='development', port=5000):
    """
    Initialize Flask application with configuration.
    
    Returns initialized Flask app.
    """
    # Create the Flask app instance first to get access to its context
    app = create_app(config_name)

    # Use the app context to run validation and initialization
    with app.app_context():
        # Initialize the categories file on startup
        init_categories_file()
        
        # Clear the session playlist on startup
        PlaylistService.clear_playlist()
        app_logger.info("Session playlist cleared on startup.")
        
    return app

def display_server_info(config_name, port):
    """Display server information and access URLs in console."""
    # Get local IP address for display
    local_ip = get_local_ip()

    # Use the application's logger
    app_logger.info(f"GhostHub: Booting [{config_name.upper()} MODE] on port {port}")
    app_logger.info(f"GhostHub: Local network access available at http://{local_ip}:{port}")
    app_logger.info("GhostHub: Listening on all interfaces (0.0.0.0)")

    print("\n============================")
    print("     GhostHub is LIVE!     ")
    print("============================")
    print(f" - Localhost : http://localhost:{port}")
    print(f" - Loopback  : http://127.0.0.1:{port}")
    print(f" - LAN Access: http://{local_ip}:{port}\n")

def find_cloudflared_path():
    """Find cloudflared executable through the tunnel provider owner."""
    return resolve_cloudflared_path()


def start_cloudflare_tunnel(cloudflared_path, port):
    """Start Cloudflare Tunnel through the tunnel provider owner."""
    return launch_cloudflare_tunnel(cloudflared_path, port)


def start_pinggy_tunnel(port, token):
    """Start Pinggy Tunnel through the tunnel provider owner."""
    return launch_pinggy_tunnel(port, token)


def start_mesh_tunnel():
    """Start unified Secure Mesh through the mesh tunnel owner."""
    return launch_mesh_tunnel()


def remove_mesh_node(node_id: int):
    """Remove a node from the mesh through the mesh tunnel owner."""
    return system_tunnel_service.remove_tunnel_node(node_id)


def stop_active_tunnel():
    """Stop the active tunnel through the tunnel domain owners."""
    return system_tunnel_service.stop_tunnel()


def get_active_tunnel_status():
    """Get tunnel status through the tunnel domain owners."""
    return system_tunnel_service.get_tunnel_status()


def configure_socket_options():
    """Configure socket options for connection stability."""
    # Configure socket options for better stability
    # This helps prevent the "connection reset by peer" errors on Windows
    socket_options = [
        (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
        (socket.SOL_SOCKET, socket.SO_REUSEADDR, 1) # type: ignore
    ]
    
    # On Windows, we can set additional TCP keepalive options
    if sys.platform == 'win32':
        try:
            # Windows-specific socket options for TCP keepalive
            socket_options.extend([
                (socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60),    # Start keepalive after 60 seconds
                (socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10),   # Send keepalive every 10 seconds
                (socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5)       # Drop connection after 5 failed keepalives
            ])
        except AttributeError:
            # Some TCP options might not be available in older Python versions
            app_logger.warning("Some TCP keepalive options are not available on this Python version")
    
    return socket_options

def apply_socket_options(socket_options):
    """Apply socket options to improve connection stability."""
    # Apply socket options to the default socket
    if hasattr(socket, 'SOL_SOCKET') and hasattr(socket, 'SO_KEEPALIVE'):
        # Set up a dummy socket to test if options are supported
        test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # Apply basic keepalive
            test_socket.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            app_logger.info("Applied SO_KEEPALIVE to improve connection stability")
            
            # Try Windows-specific TCP keepalive options
            if sys.platform == 'win32':
                try:
                    if hasattr(socket, 'TCP_KEEPIDLE'):
                        test_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
                        app_logger.info("Applied TCP_KEEPIDLE for Windows stability")
                    if hasattr(socket, 'TCP_KEEPINTVL'):
                        test_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
                        app_logger.info("Applied TCP_KEEPINTVL for Windows stability")
                    if hasattr(socket, 'TCP_KEEPCNT'):
                        test_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5)
                        app_logger.info("Applied TCP_KEEPCNT for Windows stability")
                except Exception as e:
                    app_logger.warning(f"Could not apply Windows-specific TCP keepalive options: {e}")
        except Exception as e:
            app_logger.warning(f"Could not apply socket options: {e}")
        finally:
            test_socket.close()

def run_server(app, port):
    """
    Run Flask application with SocketIO.
    Uses Gunicorn (found via PATH after pip install) with geventwebsocket worker
    on Linux/macOS for production.
    Uses gevent directly via socketio.run() on Windows for production and
    all platforms for development.
    """
    config_env = app.config.get('ENV', 'development') # Get environment from Flask config
    is_production = config_env == 'production'
    is_debug = not is_production

    try:
        # Configure and apply socket options (still relevant for direct gevent use)
        socket_options = configure_socket_options()
        apply_socket_options(socket_options)

        if is_production:
            app_logger.info(f"Starting server in PRODUCTION mode on port {port}")
            print(f"Starting server in PRODUCTION mode on port {port}")
            if sys.platform.startswith('linux') or sys.platform == 'darwin':
                # Use Gunicorn on Linux/macOS (requires 'pip install gunicorn gevent-websocket')
                gunicorn_path = shutil.which('gunicorn')
                if gunicorn_path:
                    app_logger.info("Found gunicorn executable in PATH. Attempting to start with geventwebsocket worker...")
                    print("Found gunicorn executable in PATH. Attempting to start with geventwebsocket worker...")
                    # Recommended worker count: (2 * num_cores) + 1
                    # Defaulting to 1 for simplicity, can be configured via env var later if needed
                    workers = os.getenv('GUNICORN_WORKERS', '1')
                    # Bind to all interfaces including Tailscale
                    bind_address = f'0.0.0.0:{port}'
                    # Locate gunicorn_config.py — walk up from this file to find project root
                    _config_path = None
                    _cur = Path(__file__).resolve().parent
                    for _ in range(5):
                        _candidate = _cur / 'gunicorn_config.py'
                        if _candidate.exists():
                            _config_path = _candidate
                            break
                        _cur = _cur.parent
                    # Use os.execvp to replace the current Python process with Gunicorn
                    # This is standard practice for process managers.
                    args = [
                        gunicorn_path,
                        '-k', 'geventwebsocket.gunicorn.workers.GeventWebSocketWorker', # Specify the gevent worker for SocketIO
                        '-w', workers,
                        '--bind', bind_address,
                        '--log-level', 'info', # Adjust log level as needed
                    ]
                    if _config_path:
                        args += ['-c', str(_config_path)]
                    args.append('wsgi:app') # Point to the app instance in wsgi.py
                    app_logger.info(f"Executing Gunicorn: {' '.join(args)}")
                    print(f"Executing Gunicorn: {' '.join(args)}")
                    try:
                        # Replace the current process with Gunicorn
                        os.execvp(gunicorn_path, args)
                        # If execvp returns, it means it failed (e.g., wsgi:app not found, worker class invalid)
                        app_logger.error("os.execvp failed to start Gunicorn. Check Gunicorn logs or configuration.")
                        print("[!] CRITICAL: os.execvp failed to start Gunicorn. Check Gunicorn logs or configuration.")
                        # Fallback to gevent if execvp fails unexpectedly
                        print("[!] Gunicorn failed, falling back to gevent server...")
                        socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False, log_output=False)
                    except Exception as exec_err:
                        app_logger.error(f"Failed to execute Gunicorn via os.execvp: {exec_err}")
                        print(f"[!] CRITICAL: Failed to execute Gunicorn via os.execvp: {exec_err}")
                        print("[!] Falling back to gevent server...")
                        socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False, log_output=False)

                else:
                    app_logger.warning("Gunicorn command not found in PATH. Falling back to gevent server for production.")
                    print("[!] WARNING: 'gunicorn' command not found in PATH. Ensure Gunicorn and gevent-websocket are installed ('pip install gunicorn gevent-websocket'). Falling back to gevent server for production.")
                    # Fallback for Linux/macOS if Gunicorn isn't installed or found
                    app_logger.info("Using gevent server directly via socketio.run()...")
                    print("Using gevent server directly via socketio.run()...")
                    print(f"Server will be accessible on all interfaces (0.0.0.0:{port})")
                    print("This includes: localhost, LAN IP, AP mode IP, and Tailscale IP")
                    socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False, log_output=False)
            else:
                # Use gevent directly on Windows or other non-Linux/macOS platforms for production
                app_logger.info("Running production server directly with gevent (OS is not Linux or macOS)")
                print("Running production server directly with gevent (OS is not Linux or macOS)")
                socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False, log_output=False)
        else:
            # Development mode - use Werkzeug reloader via socketio.run
            app_logger.info(f"Starting server in DEVELOPMENT mode on port {port} with reloader")
            print(f"Starting server in DEVELOPMENT mode on port {port} with reloader")

            socketio.run(
                app,
                host='0.0.0.0',
                port=port,
                debug=True,
                use_reloader=True,
                log_output=False # Keep logging clean
            )

    except Exception as server_err:
        app_logger.error(f"Failed to start server: {server_err}")
        print(f"[!] Failed to start server: {server_err}")
