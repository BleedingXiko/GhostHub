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
import threading
import re
import pyperclip
from app import create_app, socketio, logger as app_logger
from app.utils.system_utils import get_local_ip
from app.utils.file_utils import init_categories_file

def initialize_app(config_name='development', port=5000):
    """
    Initialize Flask application with configuration.
    
    Returns initialized Flask app.
    """
    # Create the Flask app instance using the factory
    app = create_app(config_name)
    
    # Initialize the categories file on startup using the app context
    # This ensures that app.instance_path is available
    with app.app_context():
        init_categories_file()
        
    return app

def display_server_info(config_name, port):
    """Display server information and access URLs in console."""
    # Get local IP address for display
    local_ip = get_local_ip()

    # Use the application's logger
    app_logger.info(f"Starting GhostHub server ({config_name} config) with optimized performance...")
    app_logger.info(f"Server running on http://{local_ip}:{port}")
    app_logger.info(f"Also available on http://0.0.0.0:{port}")
    print(f"Starting GhostHub server ({config_name} config) with optimized performance...")
    print(f"Access locally at http://localhost:{port} or http://127.0.0.1:{port}")
    print(f"Access on your local network at http://{local_ip}:{port}")
    print(f"(Ensure your firewall allows connections on port {port})")

def find_cloudflared_path():
    """
    Find cloudflared executable in various locations.
    
    Returns path to executable or None if not found.
    """
    cloudflared_path = None
    
    # Check if running as executable (PyInstaller)
    if getattr(sys, 'frozen', False):
        # Running as executable (PyInstaller)
        # Check in the temporary _MEIPASS directory where bundled files are extracted
        if hasattr(sys, '_MEIPASS'):
            base_path = sys._MEIPASS
        else:
            # Fallback if _MEIPASS is not available (shouldn't happen with --onefile)
            base_path = os.path.dirname(sys.executable)
        potential_path = os.path.join(base_path, 'cloudflared.exe')
        if os.path.exists(potential_path):
            cloudflared_path = potential_path
            app_logger.info(f"Found bundled cloudflared.exe at: {cloudflared_path}")
        else:
             app_logger.warning(f"cloudflared.exe not found in bundled files at: {base_path}")
    else:
        # Running as script
        script_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        potential_path = os.path.join(script_dir, 'cloudflared.exe')
        if os.path.exists(potential_path):
            cloudflared_path = potential_path
            
    # Also check in /usr/local/bin for Linux environments
    if not cloudflared_path and os.path.exists('/usr/local/bin/cloudflared'):
        cloudflared_path = '/usr/local/bin/cloudflared'
        app_logger.info(f"Found cloudflared at: {cloudflared_path}")
            
    return cloudflared_path

def capture_tunnel_url(process):
    """Extract and copy Cloudflare Tunnel URL from process output."""
    url_pattern = re.compile(r'(https://[a-zA-Z0-9-]+\.trycloudflare\.com)')
    try:
        # Read stderr first as cloudflared often prints the URL there
        for line in iter(process.stderr.readline, ''):
            print(f"[Tunnel] {line.strip()}") # Print tunnel output
            match = url_pattern.search(line)
            if match:
                tunnel_url = match.group(1)
                print(f"[*] Cloudflare Tunnel URL: {tunnel_url}")
                try:
                    pyperclip.copy(tunnel_url)
                    print("[+] Tunnel URL copied to clipboard!")
                except Exception as clip_err:
                    print(f"[!] Failed to copy URL to clipboard: {clip_err}")
                return # Stop reading once URL is found
        # If not found in stderr, check stdout
        for line in iter(process.stdout.readline, ''):
             print(f"[Tunnel] {line.strip()}") # Print tunnel output
             match = url_pattern.search(line)
             if match:
                 tunnel_url = match.group(1)
                 print(f"[*] Cloudflare Tunnel URL: {tunnel_url}")
                 try:
                     pyperclip.copy(tunnel_url)
                     print("[+] Tunnel URL copied to clipboard!")
                 except Exception as clip_err:
                     print(f"[!] Failed to copy URL to clipboard: {clip_err}")
                 return # Stop reading once URL is found
    except Exception as read_err:
         print(f"[!] Error reading tunnel output: {read_err}")

def start_cloudflare_tunnel(cloudflared_path, port, use_tunnel='n'):
    """
    Start Cloudflare Tunnel if requested.
    
    Returns tunnel process or None if not started.
    """
    tunnel_process = None
    
    if not cloudflared_path:
        print("[i] cloudflared not found, skipping tunnel option.")
        return None
        
    try:
        if use_tunnel.lower() == 'y':
            print("Starting Cloudflare Tunnel...")
            
            # Start tunnel process, capturing stdout and stderr
            tunnel_process = subprocess.Popen(
                [cloudflared_path, "tunnel", "--url", f"http://localhost:{port}/"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # Line buffered
                universal_newlines=True
            )

            # Start a thread to capture the URL without blocking the main server
            url_capture_thread = threading.Thread(target=capture_tunnel_url, args=(tunnel_process,))
            url_capture_thread.daemon = True # Allow thread to exit when main program exits
            url_capture_thread.start()
            print("Cloudflare Tunnel process started. Waiting for URL...")
        else:
            print("Skipping Cloudflare Tunnel.")
    except Exception as e:
        print(f"[!] Error starting Cloudflare Tunnel: {e}")
        
    return tunnel_process

def configure_socket_options():
    """Configure socket options for connection stability."""
    # Configure socket options for better stability
    # This helps prevent the "connection reset by peer" errors on Windows
    socket_options = [
        (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
        (socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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

def run_server(app, port, debug=False):
    """Run Flask application with SocketIO using gevent."""
    try:
        # Configure and apply socket options
        socket_options = configure_socket_options()
        apply_socket_options(socket_options)

        # Run the app with SocketIO using gevent for WebSockets
        # Check if we're running in Docker environment
        in_docker = os.environ.get('DOCKER_ENV', 'false').lower() == 'true'
        
        # Different parameters for Docker vs non-Docker environments
        if in_docker:
            # Docker environment - don't use allow_unsafe_werkzeug
            socketio.run(
                app,
                host='0.0.0.0', # Listen on all interfaces
                port=port,
                debug=debug,
                use_reloader=False,  # Disable reloader for production
                log_output=False     # Disable default logging for cleaner output
            )
        else:
            # Non-Docker environment - can use allow_unsafe_werkzeug
            socketio.run(
                app,
                host='0.0.0.0', # Listen on all interfaces
                port=port,
                debug=debug,
                use_reloader=False,  # Disable reloader for production
                log_output=False,    # Disable default logging for cleaner output
                allow_unsafe_werkzeug=True  # Allow unsafe Werkzeug options for better performance
            )
    except Exception as server_err:
         app_logger.error(f"Failed to start server: {server_err}")
         print(f"[!] Failed to start server: {server_err}")

def cleanup_tunnel(tunnel_process):
    """Terminate Cloudflare Tunnel process gracefully."""
    if tunnel_process:
        print("Terminating Cloudflare Tunnel process...")
        tunnel_process.terminate()
        try:
            tunnel_process.wait(timeout=5) # Wait briefly for termination
        except subprocess.TimeoutExpired:
            print("Tunnel process did not terminate quickly, killing...")
            tunnel_process.kill()
        print("Cloudflare Tunnel process stopped.")
