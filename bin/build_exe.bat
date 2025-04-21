@echo off
echo ===============================
echo     GHOSTHUB BUILDER
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

REM Check if PyInstaller is installed
python -c "import PyInstaller" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] PyInstaller not found. Installing...
    pip install pyinstaller
    if %errorlevel% neq 0 (
        echo [!] Failed to install PyInstaller.
        pause
        exit /b 1
    )
    echo [+] PyInstaller installed successfully.
)

REM Check if required packages are installed
python -c "import flask, flask_socketio, eventlet, dns" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Required packages not found. Installing...
    pip install -r ../requirements.txt
    if %errorlevel% neq 0 (
        echo [!] Failed to install packages.
        pause
        exit /b 1
    )
    
    REM Double-check that dnspython is installed (critical for eventlet)
    python -c "import dns" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [!] dnspython package not found. Installing specifically...
        pip install dnspython>=2.2.0
        if %errorlevel% neq 0 (
            echo [!] Failed to install dnspython.
            pause
            exit /b 1
        )
    )
)

REM REMOVED: Instance folder will be created by the executable itself
REM if not exist "instance" (
REM     echo [+] Creating instance directory...
REM     mkdir instance
REM )

REM Ask if user wants debug mode
set /p debug_mode=Do you want to build in debug mode for more verbose output? (y/n): 

REM Build the executable
echo [+] Building GhostHub executable...
echo [i] Using python -m PyInstaller to ensure we use the installed module...

REM Use python -m PyInstaller instead of direct command to avoid PATH issues
REM The --debug flag is not allowed when using a spec file
python -m PyInstaller --clean ../ghosthub.spec

echo.
if %errorlevel% neq 0 (
    echo [!] Build failed. Check the error messages above.
) else (
    echo [+] Build successful!
    echo [+] Executable created at: dist\GhostHub.exe
    echo.
    echo [i] You can now distribute the executable to other Windows users.
    echo [i] They won't need to install Python or any dependencies.
)

pause
