"""
Test script for GhostHub executable
This script tests the basic functionality of GhostHub to help diagnose issues.
"""

import os
import sys
import time
import socket
import requests
import subprocess
import webbrowser
from pathlib import Path

def print_separator():
    print("\n" + "="*50 + "\n")

def check_python_version():
    print(f"Python version: {sys.version}")
    print(f"Python executable: {sys.executable}")
    print_separator()

def check_dependencies():
    print("Checking dependencies...")
    try:
        import flask
        try:
            # Try to get version using importlib.metadata (newer method)
            import importlib.metadata
            try:
                flask_version = importlib.metadata.version("flask")
            except Exception:
                # Fall back to __version__ attribute (deprecated)
                flask_version = getattr(flask, "__version__", "unknown")
        except ImportError:
            # importlib.metadata not available
            flask_version = getattr(flask, "__version__", "unknown")
        print(f"Flask version: {flask_version}")
    except ImportError:
        print("Flask not installed")
    
    try:
        import flask_socketio
        try:
            # Try to get version using importlib.metadata
            import importlib.metadata
            try:
                socketio_version = importlib.metadata.version("flask-socketio")
            except Exception:
                # Fall back to __version__ attribute if available
                socketio_version = getattr(flask_socketio, "__version__", "installed (version unknown)")
        except ImportError:
            # importlib.metadata not available
            socketio_version = getattr(flask_socketio, "__version__", "installed (version unknown)")
        print(f"Flask-SocketIO version: {socketio_version}")
    except ImportError:
        print("Flask-SocketIO not installed")
    
    try:
        import eventlet
        eventlet_version = getattr(eventlet, "__version__", "installed (version unknown)")
        print(f"Eventlet version: {eventlet_version}")
    except ImportError:
        print("Eventlet not installed")
    
    print_separator()

def check_executable():
    exe_path = Path("dist") / "GhostHub.exe"
    if not exe_path.exists():
        print(f"Executable not found at {exe_path}")
        return False
    
    print(f"Executable found at {exe_path}")
    print(f"Size: {exe_path.stat().st_size / (1024*1024):.2f} MB")
    print(f"Created: {time.ctime(exe_path.stat().st_ctime)}")
    print_separator()
    return True

def check_port_available(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.close()
        return True
    except socket.error:
        s.close()
        return False

def test_server_connection(port=5000, max_attempts=10):
    print(f"Testing connection to server on port {port}...")
    
    for attempt in range(max_attempts):
        try:
            response = requests.get(f"http://localhost:{port}", timeout=2)
            print(f"Server responded with status code: {response.status_code}")
            return True
        except requests.exceptions.RequestException:
            print(f"Attempt {attempt+1}/{max_attempts}: Server not responding yet...")
            time.sleep(1)
    
    print("Failed to connect to server after multiple attempts")
    return False

def main():
    print("\nGhostHub Executable Test\n")
    print_separator()
    
    # Check Python environment
    check_python_version()
    
    # Check dependencies
    check_dependencies()
    
    # Check if executable exists
    if not check_executable():
        print("Please run build_exe.bat first to create the executable")
        return
    
    # Check if port 5000 is available
    if not check_port_available(5000):
        print("Port 5000 is already in use. Please close any running instances of GhostHub.")
        return
    
    # Ask user if they want to test the executable
    response = input("Do you want to test the executable? (y/n): ")
    if response.lower() != 'y':
        print("Test cancelled")
        return
    
    print("Starting GhostHub executable...")
    try:
        # Start the executable in a new process
        process = subprocess.Popen(["dist/GhostHub.exe"], 
                                  stdout=subprocess.PIPE, 
                                  stderr=subprocess.PIPE,
                                  text=True)
        
        # Test connection to server
        if test_server_connection():
            print("Server is running!")
            print_separator()
            
            # Open browser
            print("Opening browser...")
            webbrowser.open("http://localhost:5000")
            
            # Wait for user to finish testing
            input("Press Enter to stop the server and end the test...")
        else:
            print("Failed to connect to server")
        
        # Terminate the process
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        
        # Print output
        print_separator()
        print("Executable output:")
        print(stdout)
        
        if stderr:
            print_separator()
            print("Executable errors:")
            print(stderr)
        
    except Exception as e:
        print(f"Error during test: {e}")
    
    print_separator()
    print("Test completed")

if __name__ == "__main__":
    main()
