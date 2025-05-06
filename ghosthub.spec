# -*- mode: python ; coding: utf-8 -*-
import sys
import os
from os import path
from PyInstaller.utils.hooks import collect_all # Import collect_all

block_cipher = None

# Define the base directory - use current working directory instead of __file__
base_dir = os.getcwd()

# Collect data/binaries/hiddenimports for opencv BEFORE Analysis
opencv_datas, opencv_binaries, opencv_hiddenimports = collect_all('cv2')

# Define paths for resources
static_dir = path.join(base_dir, 'static')
templates_dir = path.join(base_dir, 'templates')
instance_dir = path.join(base_dir, 'instance')

# Create the analysis object
a = Analysis(
    ['ghosthub.py'],
    pathex=[base_dir],
    binaries=opencv_binaries, # Add opencv binaries here
    datas=[
        # Include static files
        (static_dir, 'static'),
        # Include templates
        (templates_dir, 'templates'),
        # REMOVED: Instance folder will be created next to the executable
        # (instance_dir, 'instance') if path.exists(instance_dir) else ([], 'instance'),
        # Include cloudflared.exe if it exists
        (path.join(base_dir, 'cloudflared.exe'), '.') if path.exists(path.join(base_dir, 'cloudflared.exe')) else ([],'.'),
    ] + opencv_datas, # Add opencv datas here
    hiddenimports=[
        # OpenCV and dependencies
        'cv2',
        'numpy',
        'PIL', # Pillow dependency

        # Socket.IO and Gevent dependencies
        'engineio.async_drivers.gevent', # Use gevent driver
        'gevent',
        'geventwebsocket',
        'greenlet', # Core gevent dependency
        # 'engineio.async_drivers.eventlet', # Removed
        # 'eventlet.hubs.epolls', # Removed
        # 'eventlet.hubs.kqueue', # Removed
        # 'eventlet.hubs.selects', # Removed
        # 'eventlet.tpool', # Removed
        'dns', # Keep dns
        'threading', # Keep threading module (gevent patches it)

        # Tkinter for folder browser
        'tkinter',
        'tkinter.filedialog',
        
        # Flask dependencies
        'flask',
        'flask_socketio',
        'jinja2',
        'werkzeug',
        
        # Additional dependencies that might be needed
        'json',
        'uuid',
        'logging',
        'time',
        'random',
        'socket',
        'urllib.parse',
        'io',
        'traceback',
        'pyperclip', # Added pyperclip for clipboard support
        'PIL._imagingtk', # Sometimes needed for Tkinter + Pillow
        'PIL._tkinter_finder', # Sometimes needed for Tkinter + Pillow
    ] + opencv_hiddenimports, # Add opencv hiddenimports here
    hookspath=['hooks'], # Add the hooks directory
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# Create the PYZ archive
pyz = PYZ(
    a.pure, 
    a.zipped_data,
    cipher=block_cipher
)

# Create the executable
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='GhostHub',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=path.join(static_dir, 'icons', 'Ghosthub.ico') if path.exists(path.join(static_dir, 'icons', 'Ghosthub.ico')) else None,
)
