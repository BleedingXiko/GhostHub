@echo off
echo ===============================
echo     GHOSTHUB MEDIA SERVER
echo ===============================
echo.

cd /d "%~dp0.."

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python is not installed or not in your PATH.
    pause
    exit /b 1
)

REM Check if required packages are installed
python -c "import flask, flask_socketio, eventlet" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Required packages not found. Installing...
    pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [!] Failed to install packages.
        pause
        exit /b 1
    )
)

REM Set environment variables for server configuration
set PORT=5000

echo [+] Starting GhostHub with optimized performance...
echo [+] Server will run on http://localhost:%PORT%

REM Start the server directly in this window
echo [+] Running python media_server.py...
python media_server.py

REM The script will now pause here until the server is stopped (e.g., with Ctrl+C)
REM The lines below might not be reached unless the server exits cleanly.

REM Wait a few seconds to make sure it's running
timeout /t 3 >nul


echo.
echo [i] GhostHub is now running with improved performance:
echo     - Optimized media streaming for faster video loading
echo     - Non-blocking file serving for better stability
echo     - Chat messages now persist through page refreshes
echo     - Chat history is automatically cleared when you close the tab
echo.
echo [i] Press any key to stop the server...
pause
