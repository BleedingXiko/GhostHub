@echo off
echo ===============================
echo     GHOSTHUB TESTER
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

REM Check if requests is installed
python -c "import requests" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Requests library not found. Installing...
    pip install requests
    if %errorlevel% neq 0 (
        echo [!] Failed to install requests.
        pause
        exit /b 1
    )
)

REM Run the test script
echo [+] Running GhostHub executable test...
python tests/test_ghosthub.py

pause
