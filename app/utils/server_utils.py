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
import pyperclip
import time # For Pinggy URL capture delay
from app import create_app, socketio, logger as app_logger
from app.utils.system_utils import get_local_ip
from app.utils.file_utils import init_categories_file

# --- Global Tunnel State ---
_active_tunnel_info = {
    "provider": None,  # "cloudflare", "pinggy"
    "url": None,
    "process": None,   # subprocess.Popen object
    "local_port": None 
}

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
    global _active_tunnel_info
    try:
        # Read stderr first as cloudflared often prints the URL there
        for line_bytes in iter(process.stderr.readline, b''):
            line = line_bytes.decode('utf-8', errors='ignore').strip()
            app_logger.debug(f"[Tunnel Output CF]: {line}")
            print(f"[Tunnel] {line}") 
            match = url_pattern.search(line)
            if match:
                tunnel_url = match.group(1)
                app_logger.info(f"Cloudflare Tunnel URL found: {tunnel_url}")
                print(f"[*] Cloudflare Tunnel URL: {tunnel_url}")
                _active_tunnel_info["url"] = tunnel_url
                try:
                    pyperclip.copy(tunnel_url)
                    print("[+] Cloudflare Tunnel URL copied to clipboard!")
                except Exception as clip_err:
                    print(f"[!] Failed to copy Cloudflare URL to clipboard: {clip_err}")
                return # Stop reading once URL is found
        # If not found in stderr, check stdout
        for line_bytes in iter(process.stdout.readline, b''):
            line = line_bytes.decode('utf-8', errors='ignore').strip()
            app_logger.debug(f"[Tunnel Output CF]: {line}")
            print(f"[Tunnel] {line}")
            match = url_pattern.search(line)
            if match:
                tunnel_url = match.group(1)
                app_logger.info(f"Cloudflare Tunnel URL found: {tunnel_url}")
                print(f"[*] Cloudflare Tunnel URL: {tunnel_url}")
                _active_tunnel_info["url"] = tunnel_url
                try:
                    pyperclip.copy(tunnel_url)
                    print("[+] Cloudflare Tunnel URL copied to clipboard!")
                except Exception as clip_err:
                    print(f"[!] Failed to copy Cloudflare URL to clipboard: {clip_err}")
                return # Stop reading once URL is found
        app_logger.warning("Cloudflare Tunnel URL not found in output after process start.")
    except Exception as read_err:
         app_logger.error(f"Error reading Cloudflare tunnel output: {read_err}")
         print(f"[!] Error reading tunnel output: {read_err}")

def start_cloudflare_tunnel(cloudflared_path, port):
    """
    Start Cloudflare Tunnel.
    Updates global _active_tunnel_info.
    Returns dict with status and url/message.
    """
    global _active_tunnel_info
    if _active_tunnel_info["process"] and _active_tunnel_info["process"].poll() is None:
        return {"status": "error", "message": f"Another tunnel ({_active_tunnel_info.get('provider', 'unknown')}) is already running."}

    if not cloudflared_path:
        app_logger.warning("cloudflared executable not found.")
        return {"status": "error", "message": "cloudflared executable not found."}
        
    try:
        app_logger.info(f"Attempting to start Cloudflare Tunnel for port {port}")
        print(f"Starting Cloudflare Tunnel for port {port}...")
        
        process = subprocess.Popen(
            [cloudflared_path, "tunnel", "--url", f"http://localhost:{port}/"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # text=True, # Removed for direct byte reading
            bufsize=1 # Line buffered
            # universal_newlines=True # Removed
        )

        _active_tunnel_info["provider"] = "cloudflare"
        _active_tunnel_info["process"] = process
        _active_tunnel_info["url"] = None # Will be updated by capture_tunnel_url
        _active_tunnel_info["local_port"] = port

        # Start a thread to capture the URL without blocking
        url_capture_thread = threading.Thread(target=capture_tunnel_url, args=(process,))
        url_capture_thread.daemon = True 
        url_capture_thread.start()
        
        app_logger.info("Cloudflare Tunnel process initiated. Waiting for URL capture thread.")
        print("Cloudflare Tunnel process started. Check console for URL.")
        # Give a brief moment for the URL to potentially be captured
        # The API will return immediately, client can poll status for URL
        return {"status": "success", "message": "Cloudflare Tunnel starting. URL will be available shortly."}

    except Exception as e:
        app_logger.error(f"Error starting Cloudflare Tunnel: {e}")
        _active_tunnel_info["process"] = None # Ensure it's cleared on error
        return {"status": "error", "message": f"Error starting Cloudflare Tunnel: {e}"}

def start_pinggy_tunnel(port, token):
    """
    Start Pinggy Tunnel using SSH.
    Updates global _active_tunnel_info.
    Returns dict with status and message.
    """
    global _active_tunnel_info
    if _active_tunnel_info["process"] and _active_tunnel_info["process"].poll() is None:
        return {"status": "error", "message": f"Another tunnel ({_active_tunnel_info.get('provider', 'unknown')}) is already running."}

    if not token:
        app_logger.warning("Pinggy token not provided.")
        return {"status": "error", "message": "Pinggy token is required."}

    try:
        app_logger.info(f"Attempting to start Pinggy Tunnel for port {port}")
        print(f"Starting Pinggy Tunnel for port {port}...")

        # Attempt to run ssh-keygen as requested by user
        try:
            # Define the path for the key, making it specific to this application
            # os.path.expanduser will resolve ~ to the user's home directory
            ssh_key_path = os.path.expanduser("~/.ssh/id_rsa_gh_pinggy")
            
            # Ensure the .ssh directory exists, creating it if necessary
            ssh_dir = os.path.dirname(ssh_key_path)
            if not os.path.exists(ssh_dir):
                os.makedirs(ssh_dir, exist_ok=True)
                # On Unix-like systems, .ssh directory should have 0700 permissions
                if sys.platform != 'win32': 
                    os.chmod(ssh_dir, 0o700) 
            
            # Run ssh-keygen only if the specific key does not already exist.
            # ssh-keygen options: -t type, -b bits, -N new_passphrase, -f output_keyfile
            if not os.path.exists(ssh_key_path):
                keygen_command = ["ssh-keygen", "-t", "rsa", "-b", "2048", "-N", "", "-f", ssh_key_path]
                app_logger.info(f"Executing ssh-keygen command: {' '.join(keygen_command)}")
                
                creation_flags_keygen = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0 
                
                keygen_process = subprocess.run(keygen_command, capture_output=True, text=True, check=False, creationflags=creation_flags_keygen)
                if keygen_process.returncode == 0:
                    app_logger.info(f"ssh-keygen created new key successfully: {ssh_key_path}")
                    # Set permissions for the newly created key files on Unix-like systems
                    if sys.platform != 'win32':
                        os.chmod(ssh_key_path, 0o600)
                        if os.path.exists(ssh_key_path + ".pub"):
                             os.chmod(ssh_key_path + ".pub", 0o644)
                else:
                    app_logger.warning(f"ssh-keygen command failed for new key generation. stdout: {keygen_process.stdout}, stderr: {keygen_process.stderr}")
            else:
                app_logger.info(f"SSH key {ssh_key_path} already exists. Skipping ssh-keygen generation.")

        except Exception as e_kg:
            app_logger.error(f"Failed to execute or prepare for ssh-keygen: {e_kg}")

        command = [
            "ssh", "-p", "443",
            f"-R0:127.0.0.1:{port}",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=30", # Changed from 60
            f"{token}@pro.pinggy.io" # Changed from a.pinggy.io
        ]
        app_logger.info(f"Executing Pinggy command: {' '.join(command)}")

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True, # Use text mode for easier string matching
            bufsize=1,
            universal_newlines=True, # Ensure consistent line endings
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
        )
        
        # Monitor Pinggy's output for success/failure indicators
        # Timeout after ~7 seconds if no clear indicator is found but process is running
        # Expanded success indicators to catch more possible success messages
        success_indicators = ["Tunnel established", "Authenticated.", "URL:", "tcp.pinggy.io", "http.pinggy.io", 
                             "Remote forwarding", "Entering interactive session", "debug1: Connection established"]
        # More specific error patterns from SSH/Pinggy
        error_patterns = [
            "Permission denied", "Connection refused", "Could not resolve hostname",
            "port forwarding failed", "administratively prohibited", "Authentication failed",
            "Connection timed out", "Host key verification failed", "Bad PTY allocation request"
        ]
        
        output_lines = []
        start_time = time.time()
        pinggy_ready = False
        pinggy_error_message = None

        # Non-blocking read from stderr and stdout
        def read_stream(stream, stream_name):
            try:
                for line in iter(stream.readline, ''):
                    if line:
                        app_logger.debug(f"[Pinggy Output {stream_name}]: {line.strip()}")
                        output_lines.append(line.strip())
                    else: # Stream closed
                        break 
            except Exception as e:
                app_logger.debug(f"Exception reading Pinggy {stream_name}: {e}")
            finally:
                stream.close()

        stderr_thread = threading.Thread(target=read_stream, args=(process.stderr, "stderr"))
        stdout_thread = threading.Thread(target=read_stream, args=(process.stdout, "stdout"))
        stderr_thread.daemon = True
        stdout_thread.daemon = True
        stderr_thread.start()
        stdout_thread.start()

        while time.time() - start_time < 7: # Check for 7 seconds
            if process.poll() is not None: # Process terminated
                break 
            
            # Check collected output for indicators
            current_output = "\n".join(output_lines)
            if any(indicator in current_output for indicator in success_indicators):
                pinggy_ready = True
                break
            
            for pattern in error_patterns:
                if pattern.lower() in current_output.lower():
                    pinggy_error_message = f"Pinggy error: '{pattern}' detected in output."
                    # Extract more context if possible
                    for line_err in output_lines:
                        if pattern.lower() in line_err.lower():
                            pinggy_error_message = f"Pinggy error: {line_err.strip()}"
                            break
                    break
            if pinggy_error_message:
                break
            
            time.sleep(0.2) # Brief pause before re-checking output

        # Wait for threads to finish to ensure all output is captured before process.poll() check
        stderr_thread.join(timeout=1)
        stdout_thread.join(timeout=1)
        
        final_output = "\n".join(output_lines)

        if process.poll() is not None and not pinggy_ready: # Process terminated and no success
            if not pinggy_error_message: # Generic termination message if no specific error pattern matched
                 pinggy_error_message = f"Pinggy process terminated unexpectedly. Exit code: {process.returncode}."
            if final_output:
                pinggy_error_message += f" Output: {final_output[:500]}" # Limit output length
            app_logger.error(pinggy_error_message)
            return {"status": "error", "message": pinggy_error_message}

        if not pinggy_ready and not pinggy_error_message and process.poll() is None:
            # Timeout without clear success/error, but process is running
            app_logger.warning("Pinggy tunnel started, but explicit success message not detected in output within timeout. Assuming it might be working if process is alive.")
            # We proceed, but this is less certain.
        elif pinggy_error_message:
            app_logger.error(pinggy_error_message)
            if process.poll() is None: # If process is still running despite error message
                process.terminate()
                process.wait(timeout=2)
                if process.poll() is None: process.kill()
            return {"status": "error", "message": pinggy_error_message}


        _active_tunnel_info["provider"] = "pinggy"
        _active_tunnel_info["process"] = process
        _active_tunnel_info["url"] = "Please use your configured permanent Pinggy URL."
        _active_tunnel_info["local_port"] = port
        
        app_logger.info("Pinggy Tunnel process initiated.")
        print("\n[+] Pinggy Tunnel process started successfully.")
        print("[!] Please use your permanent Pinggy URL to access the server.")
        return {"status": "success", "message": "Pinggy Tunnel started. Please use your permanent Pinggy URL."}

    except FileNotFoundError:
        app_logger.error("'ssh' command not found for Pinggy Tunnel.")
        return {"status": "error", "message": "'ssh' command not found. Make sure SSH client is installed and in your PATH."}
    except Exception as e:
        app_logger.error(f"Error starting Pinggy Tunnel: {e}")
        if _active_tunnel_info.get("process"):
            _active_tunnel_info["process"].kill()
        _active_tunnel_info["process"] = None
        return {"status": "error", "message": f"Error starting Pinggy Tunnel: {e}"}


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
                    bind_address = f'0.0.0.0:{port}'
                    # Use os.execvp to replace the current Python process with Gunicorn
                    # This is standard practice for process managers.
                    args = [
                        gunicorn_path,
                        '-k', 'geventwebsocket.gunicorn.workers.GeventWebSocketWorker', # Specify the gevent worker for SocketIO
                        '-w', workers,
                        '--bind', bind_address,
                        '--log-level', 'info', # Adjust log level as needed
                        'wsgi:app' # Point to the app instance in wsgi.py
                    ]
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
            # Check if running in Docker environment for allow_unsafe_werkzeug
            in_docker = os.environ.get('DOCKER_ENV', 'false').lower() == 'true'
            allow_unsafe = not in_docker # Only allow unsafe outside Docker

            socketio.run(
                app,
                host='0.0.0.0',
                port=port,
                debug=True,
                use_reloader=True,
                log_output=False, # Keep logging clean
                allow_unsafe_werkzeug=allow_unsafe
            )

    except Exception as server_err:
        app_logger.error(f"Failed to start server: {server_err}")
        print(f"[!] Failed to start server: {server_err}")

def stop_active_tunnel():
    """Terminate the active tunnel process and reset state."""
    global _active_tunnel_info
    process = _active_tunnel_info.get("process")
    provider = _active_tunnel_info.get("provider", "Unknown")

    if process and process.poll() is None: # Check if process exists and is running
        app_logger.info(f"Attempting to terminate {provider} tunnel process (PID: {process.pid}).")
        print(f"Terminating {provider} tunnel process...")
        process.terminate()
        try:
            process.wait(timeout=5) # Wait for graceful termination
            app_logger.info(f"{provider} tunnel process terminated gracefully.")
            print(f"{provider} tunnel process terminated.")
        except subprocess.TimeoutExpired:
            app_logger.warning(f"{provider} tunnel process did not terminate gracefully, killing...")
            print(f"{provider} tunnel process did not terminate gracefully, killing...")
            process.kill()
            app_logger.info(f"{provider} tunnel process killed.")
            print(f"{provider} tunnel process killed.")
        except Exception as e:
            app_logger.error(f"Error during {provider} tunnel cleanup: {e}")
            print(f"[!] Error during {provider} tunnel cleanup: {e}")
    elif process: # Process exists but is not running
        app_logger.info(f"{provider} tunnel process (PID: {process.pid}) already stopped.")
        print(f"{provider} tunnel process already stopped.")
    else: # No process recorded
        app_logger.info("No active tunnel process found to stop.")
        print("No active tunnel process found to stop.")
        return {"status": "success", "message": "No active tunnel to stop."}

    # Reset global state
    _active_tunnel_info = {
        "provider": None,
        "url": None,
        "process": None,
        "local_port": None
    }
    return {"status": "success", "message": f"{provider.capitalize() if provider else 'Tunnel'} stopped successfully."}

def get_active_tunnel_status():
    """Get the status of the currently managed tunnel."""
    global _active_tunnel_info
    process = _active_tunnel_info.get("process")
    if process and process.poll() is None:
        return {
            "status": "running",
            "provider": _active_tunnel_info.get("provider"),
            "url": _active_tunnel_info.get("url"),
            "local_port": _active_tunnel_info.get("local_port")
        }
    else:
        # If process is None or has terminated, ensure state is clean
        if _active_tunnel_info["provider"] is not None: # If it was previously running
            app_logger.info(f"Tunnel ({_active_tunnel_info.get('provider')}) found to be stopped. Cleaning up state.")
            stop_active_tunnel() # Call stop to ensure state is fully reset
        return {
            "status": "stopped",
            "provider": None,
            "url": None,
            "local_port": None
        }
