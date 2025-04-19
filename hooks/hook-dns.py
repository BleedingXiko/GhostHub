# hooks/hook-dns.py
from PyInstaller.utils.hooks import collect_submodules

# Collect all submodules from the 'dns' package
hiddenimports = collect_submodules('dns')
