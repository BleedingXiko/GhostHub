#!/usr/bin/env python3
"""
GhostPack 2.0
=============
A parallel release packaging system for GhostHub.

Features:
- Parallel Phase Execution (using concurrent.futures)
- Smart Dependency Management (Auto-detects npm environment)
- Multi-tier Minification (Ultra-fast parallel optimization)
- Python bytecode packaging (parallel compilation + source stubs)
- Consolidated Entry Points (Automated boot logic with bytecode hook)
- Build Report (Space savings analysis + performance metrics)
- better visual feedback (ANSI-enhanced logging)

Usage:
    python scripts/ghostpack.py [--zip] [--dist PATH] [--verbose]
"""

import argparse
import marshal
import os
import re
import shutil
import subprocess
import sys
import time
import types
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

# Enable ANSI escape codes on Windows for beautiful output
if sys.platform == 'win32':
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass

# --- CONSTANTS & CONFIGURATION ---

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Visual Constants
CLR_RESET = "\033[0m"
CLR_BOLD = "\033[1m"
CLR_CYAN = "\033[36m"
CLR_GREEN = "\033[32m"
CLR_YELLOW = "\033[33m"
CLR_RED = "\033[31m"
CLR_BLUE = "\033[34m"
CLR_MAGENTA = "\033[35m"

BANNER = f"""{CLR_CYAN}{CLR_BOLD}
   ______ __                      __     ____               __   
  / ____// /_   ____   _____ / /_   / __ \\ ____ _ _____ / /__ 
 / / __ / __ \\ / __ \\ / ___// __/  / /_/ // __ `// ___// //_/ 
/ /_/ // / / // /_/ /(__  )/ /_   / ____// /_/ // /__ / ,<    
\\____//_/ /_/ \\____//____/ \\__/  /_/     \\__,_/ \\___//_/|_|   
                                                               
{CLR_RED}                           GHOSTPACK 2.0{CLR_RESET}
"""

DEFAULT_EXCLUDE_DIRS = {
    ".git", ".pytest_cache", ".claude", ".cursor", "__pycache__",
    "docs", "scripts", "config", "tests", "htmlcov", "node_modules",
    "vitest", "venv", "GhostHubSwift", "instance", ".tmp", ".ruff_cache",
    ".mypy_cache", ".tox", ".nox", ".vscode", ".idea", ".pytest-tmp",
    "tmp",
    "test_temp_py", ".cache", ".hypothesis", ".eggs", "*.egg-info",
    "coverage", "playwright-report", "test-results", "dist", "build"
}

DEFAULT_EXCLUDE_FILES = {
    ".DS_Store", ".coverage", "coverage.xml", "pytestdebug.log",
    "Thumbs.db", ".env", ".env.local", ".env.development",
    ".env.test", ".env.production", "ghostpack_log.json"
}

DEFAULT_EXCLUDE_SUFFIXES = {
    ".md", ".zip", ".log", ".tmp", ".pid", ".seed", ".bak",
    ".orig", ".rej", ".coverage"
}

LICENSE_ALLOWLIST_PREFIXES = ("license", "copying")

SKIP_JS_DIRS = {"static/js/libs"}
ROOT_ONLY_EXCLUDE_DIRS = {"config"}

# Minimum counts — the dist must register at least this many services/controllers
# to prove the build didn't silently drop modules.  Bump these when you add new
# feature domains (not every single service/controller).
MIN_SPECTER_SERVICES = 25
MIN_CONTROLLERS = 20

# --- SHARED TEMPLATES ---

BYTECODE_IMPORTER_TEMPLATE = r'''
import sys, importlib.util, importlib.machinery
from pathlib import Path

# Third-party packages that should NOT use bytecode (installed via pip)
THIRD_PARTY = {'socketio', 'gevent', 'flask', 'flask_socketio', 'python_socketio', 'engineio', 'python_engineio'}

class BytecodeImporter:
    def __init__(self): self._loading = set()
    def find_spec(self, name, path=None, target=None):
        # Handle compiled GhostHub modules/packages directly from __pycache__.
        root_name = name.split('.')[0]
        if root_name in THIRD_PARTY or (name != 'app' and not name.startswith('app.')):
            return None
        if name in self._loading: return None
        self._loading.add(name)
        try:
            module_name = name.split('.')[-1]
            tag = getattr(sys.implementation, 'cache_tag', 'cpython-' + str(sys.version_info.major) + str(sys.version_info.minor))
            for entry in (path if path else sys.path):
                try:
                    base = Path(entry).resolve()
                    package_dir = base / module_name
                    package_pyc = package_dir / "__pycache__" / f"__init__.{tag}.pyc"
                    if package_pyc.exists():
                        loader = importlib.machinery.SourcelessFileLoader(name, str(package_pyc))
                        return importlib.util.spec_from_file_location(
                            name,
                            str(package_pyc),
                            loader=loader,
                            submodule_search_locations=[str(package_dir)],
                        )

                    module_pyc = base / "__pycache__" / f"{module_name}.{tag}.pyc"
                    if module_pyc.exists():
                        loader = importlib.machinery.SourcelessFileLoader(name, str(module_pyc))
                        return importlib.util.spec_from_file_location(name, str(module_pyc), loader=loader)
                except Exception: continue
            return None
        finally: self._loading.remove(name)
if not any(isinstance(h, BytecodeImporter) for h in sys.meta_path):
    sys.meta_path.insert(0, BytecodeImporter())
'''


def build_dist_validation_script() -> str:
    """Return the dist bootstrap validation script executed by GhostPack."""
    return f'''
import sys
from pathlib import Path

root = Path.cwd().resolve()
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

src = (root / "main.py").read_text()
prelude = src.split("from gevent import monkey")[0]
exec(prelude, globals(), globals())

from app.app_bootstrap import build_specter_services
from app.controllers import build_controller_classes
from app.services.system.display.native_tv_runtime import GhostHubRuntime
from app.utils.server_utils import initialize_app

service_names = [service.name for service in build_specter_services()]
controller_names = [controller.__name__ for controller in build_controller_classes()]

if len(service_names) < {MIN_SPECTER_SERVICES}:
    raise RuntimeError(
        f"Dist build only registered {{len(service_names)}} services (minimum {MIN_SPECTER_SERVICES}). "
        f"Got: {{service_names}}"
    )

if len(set(service_names)) != len(service_names):
    dupes = [n for n in service_names if service_names.count(n) > 1]
    raise RuntimeError(f"Duplicate service names in dist build: {{sorted(set(dupes))}}")

if len(controller_names) < {MIN_CONTROLLERS}:
    raise RuntimeError(
        f"Dist build only registered {{len(controller_names)}} controllers (minimum {MIN_CONTROLLERS}). "
        f"Got: {{controller_names}}"
    )

if len(set(controller_names)) != len(controller_names):
    dupes = [n for n in controller_names if controller_names.count(n) > 1]
    raise RuntimeError(f"Duplicate controller names in dist build: {{sorted(set(dupes))}}")

if GhostHubRuntime.__name__ != "GhostHubRuntime":
    raise RuntimeError("Failed to import GhostHubRuntime from dist package")

if "_socketio" not in GhostHubRuntime.__init__.__code__.co_varnames:
    raise RuntimeError(
        "GhostHubRuntime dist bytecode is stale or incorrect: local _socketio import alias missing"
    )

if not callable(initialize_app):
    raise RuntimeError("Failed to import initialize_app from dist package")

print(
    f"Validated dist boot manifests: {{len(service_names)}} services, "
    f"{{len(controller_names)}} controllers"
)
'''


def get_validation_python() -> str:
    """Return the interpreter GhostPack should use for dist validation."""
    candidates = []
    if sys.platform == "win32":
        candidates.append(PROJECT_ROOT / "venv" / "Scripts" / "python.exe")
    else:
        candidates.append(PROJECT_ROOT / "venv" / "bin" / "python")
    candidates.append(Path(sys.executable))

    for candidate in candidates:
        candidate_path = Path(candidate)
        if not (candidate_path.exists() and os.access(candidate_path, os.X_OK)):
            continue
        probe = subprocess.run(
            [
                str(candidate_path),
                "-c",
                "import specter, flask, flask_socketio, gevent",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode == 0:
            return str(candidate_path)

    for candidate in candidates:
        candidate_path = Path(candidate)
        if candidate_path.exists() and os.access(candidate_path, os.X_OK):
            return str(candidate_path)
    return sys.executable

# --- HELPER FUNCTIONS ---

def _norm_rel(path: Path) -> str:
    return path.as_posix().lstrip("./")

def _get_project_version() -> str:
    try:
        ver_file = PROJECT_ROOT / "app" / "version.py"
        content = ver_file.read_text()
        match = re.search(r'VERSION\s*=\s*["\']([^"\']+)["\']', content)
        return match.group(1) if match else "unknown"
    except Exception:
        return "unknown"

def _minify_css_fallback(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{}:;,>])\s*", r"\1", css)
    return css.strip()

def _minify_js_fallback(js: str) -> str:
    js = js.replace("\r\n", "\n")
    return "\n".join(ln.rstrip() for ln in js.split("\n") if ln.strip()).strip() + "\n"


def _iter_code_filenames(code_obj: types.CodeType) -> Iterable[str]:
    yield code_obj.co_filename
    for const in code_obj.co_consts:
        if isinstance(const, types.CodeType):
            yield from _iter_code_filenames(const)


def _find_host_path_in_pyc(pyc_path: Path) -> Optional[str]:
    """Return the first host-machine absolute path found in a pyc, if any."""
    try:
        with pyc_path.open("rb") as fh:
            fh.read(16)  # pyc header (magic, flags, timestamp/hash)
            code = marshal.load(fh)
        for filename in _iter_code_filenames(code):
            if not filename:
                continue
            # Reject absolute developer paths (macOS/Linux/Windows) in shipped bytecode.
            if filename.startswith("/Users/") or filename.startswith("/home/"):
                return filename
            if re.match(r"^[A-Za-z]:[\\/]", filename):
                return filename
    except Exception:
        return None
    return None

# --- WORKER FUNCTIONS (PARALLEL) ---

def worker_minify_css(path_str: str, cleancss_bin: Optional[str]) -> Tuple[bool, str, int, int]:
    path = Path(path_str)
    try:
        orig_size = path.stat().st_size
        if cleancss_bin:
            proc = subprocess.run([cleancss_bin, "-O2", "-o", path_str, path_str], 
                                capture_output=True, text=True)
            if proc.returncode == 0:
                return True, "", orig_size, path.stat().st_size
            
        css = path.read_text(encoding="utf-8", errors="ignore")
        minified = _minify_css_fallback(css)
        path.write_text(minified, encoding="utf-8")
        return True, "", orig_size, path.stat().st_size
    except Exception as e:
        return False, str(e), 0, 0

def worker_minify_js(path_str: str, terser_bin: Optional[str]) -> Tuple[bool, str, int, int]:
    path = Path(path_str)
    try:
        orig_size = path.stat().st_size
        if terser_bin:
            proc = subprocess.run([terser_bin, path_str, "-o", path_str, "--compress", "--mangle"], 
                                capture_output=True, text=True)
            if proc.returncode == 0:
                return True, "", orig_size, path.stat().st_size
            
        js = path.read_text(encoding="utf-8", errors="ignore")
        minified = _minify_js_fallback(js)
        path.write_text(minified, encoding="utf-8")
        return True, "", orig_size, path.stat().st_size
    except Exception as e:
        return False, str(e), 0, 0

def worker_compile_py(path_str: str, cfile_str: str) -> Tuple[bool, str]:
    import py_compile
    import os
    try:
        Path(cfile_str).parent.mkdir(parents=True, exist_ok=True)
        # Change to project root so bytecode uses relative paths
        orig_cwd = os.getcwd()
        os.chdir(PROJECT_ROOT)
        try:
            # Use relative path for compilation to avoid embedding absolute Mac/Linux paths
            rel_path = os.path.relpath(path_str, PROJECT_ROOT)
            py_compile.compile(rel_path, cfile=cfile_str, dfile=rel_path, doraise=True)
        finally:
            os.chdir(orig_cwd)
        return True, ""
    except Exception as e:
        return False, str(e)

# --- CORE BUILDER ---

class GhostPack:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.start_time = time.time()
        self.version = _get_project_version()
        self.stats = {
            "copied": 0, "minified_css": 0, "minified_js": 0,
            "compiled_py": 0, "removed_py": 0, "errors": [],
            "orig_size": 0, "packed_size": 0
        }
        self.dist_dir = Path(args.dist).resolve() / "Ghosthub_pi_github"
        self.zip_path = self.dist_dir.parent / f"Ghosthub_pi_github.zip"
        
        self.workers = os.cpu_count() or 4
        self.terser_bin = self._find_bin("terser")
        self.cleancss_bin = self._find_bin("cleancss")

    def _find_bin(self, name: str) -> Optional[str]:
        local = PROJECT_ROOT / "static" / "js" / "node_modules" / ".bin" / (f"{name}.cmd" if sys.platform == "win32" else name)
        return str(local) if local.exists() else None

    def _python_has_build_deps(self, python_executable: str) -> Tuple[bool, str]:
        probe = subprocess.run(
            [
                python_executable,
                "-c",
                "import specter, flask, flask_socketio, gevent",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        detail = (probe.stderr or probe.stdout or "").strip()
        return probe.returncode == 0, detail

    def _bootstrap_validation_python(self) -> None:
        validation_python = get_validation_python()
        has_deps, detail = self._python_has_build_deps(validation_python)
        if has_deps:
            return

        validation_path = Path(validation_python).resolve()
        project_venv = (
            PROJECT_ROOT / ("venv/Scripts/python.exe" if sys.platform == "win32" else "venv/bin/python")
        ).resolve()

        if validation_path != project_venv:
            raise RuntimeError(
                "GhostPack validation interpreter is missing Python dependencies. "
                f"Install them for {validation_python}: pip install -r requirements.txt\n{detail}"
            )

        pip_executable = validation_path.parent / ("pip.exe" if sys.platform == "win32" else "pip")
        if not pip_executable.exists():
            raise RuntimeError(
                "GhostPack validation venv is missing pip. "
                f"Recreate or repair the venv at {validation_path.parent.parent}"
            )

        self.log("Python deps missing in repo venv, installing from requirements.txt...")
        install = subprocess.run(
            [str(pip_executable), "install", "-r", str(PROJECT_ROOT / "requirements.txt")],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if install.returncode != 0:
            detail = (install.stderr or install.stdout or "pip install failed").strip()
            raise RuntimeError(
                "GhostPack could not install Python dependencies into the repo venv. "
                f"Run `{pip_executable} install -r requirements.txt`.\n{detail}"
            )

        has_deps, detail = self._python_has_build_deps(str(validation_path))
        if not has_deps:
            raise RuntimeError(
                "GhostPack installed requirements but the validation interpreter still "
                f"cannot import build dependencies.\n{detail}"
            )

    def log(self, msg: str, prefix: str = f"{CLR_BLUE}[*]{CLR_RESET}"):
        print(f"{prefix} {msg}")

    def error(self, msg: str):
        print(f"{CLR_RED}[!] {msg}{CLR_RESET}")
        self.stats["errors"].append(msg)

    def success(self, msg: str):
        print(f"{CLR_GREEN}[+] {msg}{CLR_RESET}")

    def phase(self, name: str):
        print(f"\n{CLR_BOLD}{CLR_CYAN}--- {name.upper()} ---{CLR_RESET}")

    def execute(self):
        print(BANNER)
        self.log(f"GhostHub v{self.version} | Workers: {self.workers}")
        
        try:
            self._phase_prepare()
            self._phase_collect()
            self._phase_optimize()
            self._phase_compile()
            self._phase_entry_points()
            self._phase_validate()
            if self.args.zip:
                self._phase_package()
            self._report()
        except KeyboardInterrupt:
            self.error("Build interrupted by user.")
            sys.exit(130)

    def _phase_prepare(self):
        self.phase("Preparing environment")
        if self.dist_dir.parent.exists() and not self.args.no_clean:
            self.log(f"Cleaning existing dist: {self.dist_dir.parent}")
            if not self.args.dry_run:
                shutil.rmtree(self.dist_dir.parent)
        
        if self.zip_path.exists() and not self.args.no_clean:
            self.log(f"Cleaning existing zip: {self.zip_path}")
            if not self.args.dry_run:
                self.zip_path.unlink()
                
        self.dist_dir.mkdir(parents=True, exist_ok=True)
        
        # Ensure NPM deps
        bin_dir = PROJECT_ROOT / "static" / "js" / "node_modules" / ".bin"
        if not bin_dir.exists():
            self.log("NPM deps missing, installing...")
            npm = "npm.cmd" if sys.platform == "win32" else "npm"
            subprocess.run([npm, "install", "--prefer-offline"], cwd=PROJECT_ROOT / "static" / "js", 
                         capture_output=True, check=False)
            self.terser_bin = self._find_bin("terser")
            self.cleancss_bin = self._find_bin("cleancss")

        self._bootstrap_validation_python()

    def _phase_collect(self):
        self.phase("Collecting Project Files")
        count = 0
        for root, dirs, files in os.walk(PROJECT_ROOT):
            root_path = Path(root)
            rel_root = _norm_rel(root_path.relative_to(PROJECT_ROOT))

            filtered_dirs = []
            for directory in dirs:
                if directory in ROOT_ONLY_EXCLUDE_DIRS and root_path == PROJECT_ROOT:
                    continue
                if directory in DEFAULT_EXCLUDE_DIRS and directory not in ROOT_ONLY_EXCLUDE_DIRS:
                    continue
                filtered_dirs.append(directory)
            dirs[:] = filtered_dirs
            
            for f in files:
                src = root_path / f
                if f in DEFAULT_EXCLUDE_FILES or src.suffix in DEFAULT_EXCLUDE_SUFFIXES:
                    if not any(f.lower().startswith(p) for p in LICENSE_ALLOWLIST_PREFIXES):
                        continue
                if f.endswith((".test.js", ".spec.js", ".test.ts", ".spec.ts")):
                    continue
                
                rel = src.relative_to(PROJECT_ROOT)
                dst = self.dist_dir / rel
                
                if not self.args.dry_run:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
                count += 1
        
        self.stats["copied"] = count
        self.success(f"Collected {count} files")

    def _phase_optimize(self):
        self.phase("Optimizing Assets")
        tasks = []
        css_files = list(self.dist_dir.rglob("*.css"))
        js_files = [p for p in self.dist_dir.rglob("*.js") 
                   if not any(str(p).startswith(str(self.dist_dir / s)) for s in SKIP_JS_DIRS)
                   and not p.name.endswith(".min.js")]

        with ProcessPoolExecutor(max_workers=self.workers) as executor:
            # CSS Tasks
            for p in css_files:
                tasks.append(executor.submit(worker_minify_css, str(p), self.cleancss_bin))
            # JS Tasks
            for p in js_files:
                tasks.append(executor.submit(worker_minify_js, str(p), self.terser_bin))
                
            for future in as_completed(tasks):
                ok, err, old, new = future.result()
                if ok:
                    self.stats["orig_size"] += old
                    self.stats["packed_size"] += new
                else:
                    self.error(f"Asset optimization failed: {err}")

        self.stats["minified_css"] = len(css_files)
        self.stats["minified_js"] = len(js_files)
        save = (self.stats["orig_size"] - self.stats["packed_size"]) / 1024
        self.success(f"Optimized {len(css_files)} CSS and {len(js_files)} JS files (Saved {save:.1f} KB)")

    def _phase_compile(self):
        self.phase("Bytecode Compilation & Protection")
        tasks = []
        py_files = []
        
        # Identity protection logic
        for p in self.dist_dir.rglob("*.py"):
            if p.name in ("main.py", "wsgi.py", "tv_runtime.py") or "stress_tests" in p.parts:
                continue
            py_files.append(p)

        with ProcessPoolExecutor(max_workers=self.workers) as executor:
            tag = getattr(sys.implementation, "cache_tag", f"cpython-{sys.version_info.major}{sys.version_info.minor}")
            for py in py_files:
                cfile = py.parent / "__pycache__" / f"{py.stem}.{tag}.pyc"
                tasks.append(executor.submit(worker_compile_py, str(py), str(cfile)))
                
            for future in as_completed(tasks):
                ok, err = future.result()
                if ok:
                    self.stats["compiled_py"] += 1
                else:
                    self.error(f"Python compilation failed: {err}")

        # Hard-fail if bytecode still embeds build-machine absolute paths.
        leaked_paths = []
        for pyc in self.dist_dir.rglob("*.pyc"):
            leaked = _find_host_path_in_pyc(pyc)
            if leaked:
                leaked_paths.append((pyc, leaked))

        if leaked_paths:
            for pyc, leaked in leaked_paths[:10]:
                self.error(f"Path leak in {pyc}: {leaked}")
            raise RuntimeError(
                "Bytecode contains absolute host paths; refusing to produce deployable dist"
            )

        # Remove Python sources after compilation; the bytecode importer loads
        # directly from __pycache__ so no discovery stubs are needed.
        for py in py_files:
            if not self.args.dry_run:
                py.unlink()
            self.stats["removed_py"] += 1
        self.success(
            f"Compiled {self.stats['compiled_py']} files to bytecode and removed "
            f"{self.stats['removed_py']} Python source files"
        )

    def _phase_entry_points(self):
        self.phase("Generating Power Entry Points")
        
        # Main Entry Point
        main_tpl = f"""#!/usr/bin/env python3
import os, sys
{BYTECODE_IMPORTER_TEMPLATE}
from gevent import monkey
if not monkey.is_module_patched('socket'): monkey.patch_all()

from pathlib import Path
def run():
    app_root = Path(__file__).parent.resolve()
    if str(app_root) not in sys.path: sys.path.insert(0, str(app_root))
    try:
        from app.utils.server_utils import initialize_app, display_server_info, find_cloudflared_path, run_server
        c, p = os.getenv('FLASK_CONFIG', 'production'), int(os.getenv('PORT', 5000))
        app = initialize_app(c, p)
        display_server_info(c, p)
        find_cloudflared_path()
        print("\\n--- GHOSTHUB ELITE RUNTIME ---")
        run_server(app, p)
    except Exception as e:
        print(f"\\n[!] Startup Failure: {{e}}")
        import traceback; traceback.print_exc(); sys.exit(1)
if __name__ == "__main__": run()
"""
        (self.dist_dir / "main.py").write_text(main_tpl)
        
        # WSGI Entry Point
        wsgi_tpl = f"""import os, sys
{BYTECODE_IMPORTER_TEMPLATE}
from gevent import monkey
if not monkey.is_module_patched('socket'): monkey.patch_all()

from pathlib import Path
app_root = Path(__file__).parent.resolve()
if str(app_root) not in sys.path: sys.path.insert(0, str(app_root))
from app.utils.server_utils import initialize_app
app = initialize_app(os.getenv('FLASK_CONFIG', 'production'), int(os.getenv('PORT', 5000)))
"""
        (self.dist_dir / "wsgi.py").write_text(wsgi_tpl)
        
        # TV Runtime Point
        tv_tpl = f"""#!/usr/bin/env python3
import sys
from pathlib import Path
import os

# CRITICAL: Add venv site-packages FIRST, before ANY other imports
venv_site = Path(sys.prefix) / "lib" / f"python{{sys.version_info.major}}.{{sys.version_info.minor}}" / "site-packages"
if venv_site.exists() and str(venv_site) not in sys.path:
    sys.path.insert(0, str(venv_site))

# Add app_root to path
app_root = Path(__file__).parent.resolve()
if str(app_root) not in sys.path: sys.path.insert(0, str(app_root))

# Install bytecode importer (AFTER venv is in path so socketio can be imported)
{BYTECODE_IMPORTER_TEMPLATE}
from gevent import monkey
if not monkey.is_module_patched('socket'): monkey.patch_all(queue=False)

try:
    from app.services.system.display.native_tv_runtime import main
    main()
except Exception as e:
    print(f"[!] TV Runtime Error: {{e}}")
    import traceback; traceback.print_exc(); sys.exit(1)
"""
        (self.dist_dir / "tv_runtime.py").write_text(tv_tpl)
        self.success("Entry points generated with optimized bytecode hooks")

    def _phase_validate(self):
        self.phase("Validating Boot Manifests")
        if self.args.dry_run:
            self.log("Skipping dist validation during dry run")
            return

        validation_python = get_validation_python()
        self.log(f"Validation Python: {validation_python}")
        self.log(f"Validation CWD: {self.dist_dir}")
        result = subprocess.run(
            [validation_python, "-c", build_dist_validation_script()],
            cwd=self.dist_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.stdout.strip():
            self.log("Validation stdout:")
            print(result.stdout.rstrip())
        if result.returncode != 0:
            if result.stderr.strip():
                self.error("Validation stderr:")
                print(result.stderr.rstrip())
            detail = (result.stderr or result.stdout or "unknown validation failure").strip()
            self.error(f"Dist validation failed: {detail}")
            raise RuntimeError("GhostPack dist validation failed")

        message = (result.stdout or "Dist validation passed").strip().splitlines()[-1]
        self.success(message)

        # Validation boots the app inside dist, which creates an empty instance/
        # directory. Strip it back out so update deploys don't collide with the
        # live preserved instance directory on the Pi.
        dist_instance_dir = self.dist_dir / "instance"
        if dist_instance_dir.exists():
            shutil.rmtree(dist_instance_dir, ignore_errors=True)

    def _phase_package(self):
        self.phase("Packaging Distribution")
        self.log(f"Compressing into: {self.zip_path.name}")
        if not self.args.dry_run:
            base_name = str(self.zip_path.with_suffix(""))
            shutil.make_archive(base_name, "zip", root_dir=str(self.dist_dir.parent), base_dir="Ghosthub_pi_github")
        self.success(f"Package ready: {self.zip_path.stat().st_size / 1024 / 1024:.2f} MB")

    def _report(self):
        duration = time.time() - self.start_time
        print(f"\n{CLR_BOLD}{CLR_GREEN}=========================================={CLR_RESET}")
        print(f"{CLR_BOLD}BUILD COMPLETE - {CLR_YELLOW}{duration:.2f}s{CLR_RESET}")
        print(f"{CLR_BOLD}{CLR_GREEN}=========================================={CLR_RESET}")
        print(f"Files Processed: {self.stats['copied']}")
        print(f"JS Minified:    {self.stats['minified_js']}")
        print(f"CSS Minified:   {self.stats['minified_css']}")
        print(f"Py Compiled:    {self.stats['compiled_py']}")
        print(f"Py Removed:     {self.stats['removed_py']}")
        print(f"Asset Savings:  {CLR_GREEN}{ (self.stats['orig_size'] - self.stats['packed_size']) / 1024:.1f} KB{CLR_RESET}")
        
        if self.stats["errors"]:
            print(f"\n{CLR_RED}Warnings/Errors ({len(self.stats['errors'])}):{CLR_RESET}")
            for err in self.stats["errors"][:5]:
                print(f"  - {err}")
        else:
            print(f"\n{CLR_BOLD}{CLR_CYAN}STATUS: ALL SYSTEMS NOMINAL{CLR_RESET}")
        print(f"{CLR_BOLD}{CLR_GREEN}=========================================={CLR_RESET}\n")

def main():
    parser = argparse.ArgumentParser(description="GhostPack 2.0 - Elite GhostHub Builder")
    parser.add_argument("--dist", default=str(PROJECT_ROOT / "dist"), help="Output directory")
    parser.add_argument("--no-clean", action="store_true", help="Keep existing dist directory")
    parser.add_argument("--zip", action="store_true", help="Generate ZIP archive")
    parser.add_argument("--dry-run", action="store_true", help="Preview build without writing")
    parser.add_argument("--verbose", action="store_true", help="Detailed logging")
    args = parser.parse_args()
    
    GhostPack(args).execute()

if __name__ == "__main__":
    main()
