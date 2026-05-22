import os
import sys
import json
import socket
import logging
import time
import threading
import subprocess
import signal
import shutil
import re
import queue
import socketio
from collections import deque
from typing import Optional, List, Dict

from app.constants import SOCKET_EVENTS, TV_EVENTS

# GHOSTHUB NATIVE TV RUNTIME
# Version: 2.1 (Diagnostic Enhanced)

# AGGRESSIVE LOGGING (Stdout bypass)
def log_immediate(msg):
    print(f"DIAG: {msg}", flush=True)

# log_immediate(f"Script starting. Python version: {sys.version}")  # Moved to __main__

# Dependencies check
def check_dependencies():
    log_immediate("socketio module loaded successfully")

# Configuration
MPV_IPC_PATH = "/tmp/mpv-socket"
SERVER_URL = "http://127.0.0.1:5000"

# Dynamically determine the logo path relative to the script installation
def get_base_dir():
    try:
        current = os.path.abspath(__file__)
        for _ in range(5):
            current = os.path.dirname(current)
            if os.path.exists(os.path.join(current, 'static')):
                return current
    except Exception:
        pass
    
    PI_INSTALL_PATH = '/home/ghost/ghosthub'
    if os.path.exists(os.path.join(PI_INSTALL_PATH, 'static')):
        return PI_INSTALL_PATH
    
    return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_dir()
# log_immediate(f"BASE_DIR determined: {BASE_DIR}")  # Moved to main() or start()
# LOGO_PATH removed as not required for casting backbone

def detect_hdmi_audio_card():
    """
    Detect HDMI audio card number dynamically at runtime.
    Returns card number (int) or 0 as fallback.
    Matches install_ghosthub.sh detection logic for consistency.
    """
    try:
        # Method 1: Parse aplay -l output (matches install script)
        result = subprocess.run(
            ['aplay', '-l'],
            capture_output=True,
            text=True,
            timeout=2
        )

        if result.returncode != 0:
            log_immediate("aplay -l failed, using default card 0")
            return 0

        # Parse for HDMI card
        # Example: "card 1: vc4hdmi [vc4-hdmi], device 0: MAI PCM i2s-hifi-0"
        for line in result.stdout.splitlines():
            if 'HDMI' in line.upper() or 'vc4' in line.lower():
                match = re.search(r'card\s+(\d+)', line, re.IGNORECASE)
                if match:
                    card = int(match.group(1))
                    log_immediate(f"Detected HDMI audio card via aplay: {card}")
                    return card

        # Method 2: Check /proc/asound/cards as fallback
        log_immediate("No HDMI in aplay, checking /proc/asound/cards")
        with open('/proc/asound/cards', 'r') as f:
            proc_cards = f.read()

        for line in proc_cards.splitlines():
            if 'HDMI' in line.upper() or 'vc4' in line.lower():
                match = re.search(r'^\s*(\d+)', line)
                if match:
                    card = int(match.group(1))
                    log_immediate(f"Detected HDMI audio card from /proc/asound: {card}")
                    return card

        log_immediate("No HDMI card detected, defaulting to card 0")
        return 0

    except FileNotFoundError:
        log_immediate("/proc/asound/cards not found, using card 0")
        return 0
    except Exception as e:
        log_immediate(f"Error detecting HDMI audio card: {e}, using card 0")
        return 0

# Setup standard logging
logging.basicConfig(level=logging.INFO)
try:
    _kiosk_log_path = "/tmp/ghosthub_kiosk.log"
    _file_handler = logging.FileHandler(_kiosk_log_path)
    _file_handler.setLevel(logging.INFO)
    _file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logging.getLogger().addHandler(_file_handler)
except Exception:
    pass
logger = logging.getLogger("NativeTVRuntime")
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
logger.addHandler(handler)
logger.propagate = False

class MPVController:
    """Controls an MPV instance via JSON IPC with Async Dispatcher."""
    def __init__(self, ipc_path: str):
        self.ipc_path = ipc_path
        self.process: Optional[subprocess.Popen] = None
        self.socket: Optional[socket.socket] = None
        self._lock = threading.RLock()
        self._request_id = 0
        self._running = False
        
        self._response_futures = {} # ID -> Event() + Data
        self._dispatcher_thread = None
        self.on_event = None # Callback for mpv events
        
        log_immediate("MPVController: Cleaning up stale instances...")
        try:
            # Move pkill outside the constructor or at least handle it better
            subprocess.run(['pkill', '-9', '-x', 'mpv'], timeout=2, stderr=subprocess.DEVNULL)
        except Exception as e:
            log_immediate(f"pkill error (non-fatal): {e}")
            
        with self._lock:
            log_immediate("MPVController: Initialized internal state")
            if os.path.exists(self.ipc_path):
                try: os.remove(self.ipc_path)
                except: pass

    def start(self):
        """Start MPV with optimized Pi 4 arguments."""
        with self._lock:
            # KMS/DRM must be available for the native runtime (no X11/Wayland).
            # If /dev/dri isn't present, the Pi is likely running in legacy display mode (dispmanx)
            # or the vc4 kms/fkms overlay hasn't loaded yet.
            if not os.path.exists("/dev/dri"):
                log_immediate("/dev/dri not present; waiting briefly for DRM devices to appear...")
                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline and not os.path.exists("/dev/dri"):
                    time.sleep(0.5)

            if not os.path.exists("/dev/dri"):
                log_immediate("CRITICAL: /dev/dri is missing; mpv DRM/KMS output cannot start.")
                
                # DIAGNOSTIC DUMP
                log_immediate("--- DIAGNOSTIC DUMP START ---")
                try:
                    cfg_paths = ["/boot/config.txt", "/boot/firmware/config.txt"]
                    cfg_found = False
                    for p in cfg_paths:
                        if os.path.exists(p):
                            log_immediate(f"Found config at: {p}")
                            cfg_found = True
                            with open(p, 'r') as f:
                                for line in f:
                                    line = line.strip()
                                    if not line or line.startswith('#'): continue
                                    if any(k in line for k in ['dtoverlay', 'gpu_mem', 'hdmi', 'driver', 'display']):
                                        log_immediate(f"  [CONFIG] {line}")
                            break
                    if not cfg_found:
                        log_immediate("CRITICAL: No config.txt found in standard locations!")
                except Exception as e:
                    log_immediate(f"Failed to dump config: {e}")
                
                log_immediate("--- DIAGNOSTIC DUMP END ---")

                log_immediate("This usually means the Pi is in legacy display mode (dispmanx) or vc4 kms/fkms is not enabled.")
                log_immediate("Fix: ensure /boot/config.txt (or /boot/firmware/config.txt) contains ONE of:")
                log_immediate("  dtoverlay=vc4-kms-v3d   (preferred on Bullseye)")
                log_immediate("  dtoverlay=vc4-fkms-v3d  (fallback)")
                log_immediate("Then reboot and verify: ls -l /dev/dri shows card0/renderD*.")
                return False

            def read_text(path: str) -> Optional[str]:
                try:
                    with open(path, 'r') as f:
                        return f.read().strip()
                except Exception:
                    return None

            def get_drm_device_candidates() -> List[str]:
                """
                Return likely DRM KMS devices to try for MPV.

                Pi 4 on Bullseye frequently exposes multiple DRM cards (e.g., card0=KMS, card1=V3D).
                Choosing the highest card is unreliable; prefer cards that actually own HDMI connectors.
                """
                candidates: List[str] = []

                # Highest confidence: cards with HDMI connectors (connected first, then EDID-present, then any HDMI)
                try:
                    import glob
                    status_files = sorted(glob.glob('/sys/class/drm/card*-HDMI*/status'))
                    log_immediate(f"Scanning DRM HDMI status files: {status_files}")

                    connector_info: List[Dict] = []
                    for status_path in status_files:
                        status = read_text(status_path) or "unknown"
                        parent = os.path.dirname(status_path)
                        base = os.path.basename(parent)  # card0-HDMI-A-1
                        card_match = re.match(r'card(\d+)-', base)
                        connector_name = base
                        if card_match:
                            connector_name = base[len(f"card{card_match.group(1)}-"):]

                        edid_path = os.path.join(parent, 'edid')
                        edid_size = 0
                        try:
                            if os.path.exists(edid_path):
                                edid_size = os.path.getsize(edid_path)
                        except Exception:
                            edid_size = 0

                        connector_info.append({
                            'status_path': status_path,
                            'base': base,
                            'connector': connector_name,
                            'status': status,
                            'edid_size': edid_size,
                        })

                    if connector_info:
                        summary_parts = []
                        for info in connector_info:
                            summary_parts.append(f"{info['base']}={info['status']}(edid={info['edid_size']})")
                        log_immediate(f"DRM connector summary: {', '.join(summary_parts)}")

                    connected_cards: List[int] = []
                    edid_cards: List[int] = []
                    hdmi_cards: List[int] = []

                    for info in connector_info:
                        match = re.search(r'card(\d+)-', info['base'])
                        if not match:
                            continue
                        card_num = int(match.group(1))
                        if card_num not in hdmi_cards:
                            hdmi_cards.append(card_num)
                        if info['status'] == 'connected' and card_num not in connected_cards:
                            connected_cards.append(card_num)
                        if info['edid_size'] > 0 and card_num not in edid_cards:
                            edid_cards.append(card_num)

                    connected_cards.sort()
                    edid_cards.sort()
                    hdmi_cards.sort()

                    ordered_cards = connected_cards[:]
                    ordered_cards += [c for c in edid_cards if c not in ordered_cards]
                    ordered_cards += [c for c in hdmi_cards if c not in ordered_cards]

                    for card_num in ordered_cards:
                        dev = f"/dev/dri/card{card_num}"
                        if os.path.exists(dev):
                            candidates.append(dev)
                except Exception as e:
                    log_immediate(f"DRM sysfs scan error (non-fatal): {e}")

                # Fallback: add card0 first, then all /dev/dri/card* in ascending order
                if os.path.exists("/dev/dri/card0"):
                    candidates.append("/dev/dri/card0")
                if os.path.exists("/dev/dri"):
                    try:
                        cards = sorted([c for c in os.listdir("/dev/dri") if c.startswith("card")])
                        for c in cards:
                            candidates.append(f"/dev/dri/{c}")
                    except Exception:
                        pass

                # Deduplicate while preserving order
                deduped: List[str] = []
                for dev in candidates:
                    if dev not in deduped:
                        deduped.append(dev)
                if deduped:
                    return deduped
                if os.path.exists("/dev/dri/card0"):
                    return ["/dev/dri/card0"]
                return []

            candidates = get_drm_device_candidates()
            if not candidates:
                log_immediate("CRITICAL: No DRM card devices found under /dev/dri (expected card0/card1).")
                try:
                    log_immediate(f"/dev/dri entries: {sorted(os.listdir('/dev/dri'))}")
                except Exception as e:
                    log_immediate(f"Could not list /dev/dri entries: {e}")
                return False

            override_device = os.environ.get("GHOSTHUB_DRM_DEVICE")
            if override_device:
                if override_device in candidates:
                    candidates.remove(override_device)
                candidates.insert(0, override_device)
                log_immediate(f"Using GHOSTHUB_DRM_DEVICE override: {override_device}")

            log_immediate(f"DRM device candidates (in order): {candidates}")

            # Get MPV version for logs
            try:
                v_proc = subprocess.run(['mpv', '--version'], capture_output=True, text=True, timeout=2)
                v_msg = v_proc.stdout.splitlines()[0] if v_proc.stdout else "Unknown"
                log_immediate(f"MPV Version: {v_msg}")
            except Exception as e:
                log_immediate(f"Could not get MPV version: {e}")

            # MPV IPC option name differs across versions; pick best supported (fallback to trying both).
            ipc_arg_variants = [
                f'--input-ipc-server={self.ipc_path}',
                f'--input-unix-socket={self.ipc_path}'
            ]
            opts_text = ""
            try:
                opts_proc = subprocess.run(['mpv', '--list-options'], capture_output=True, text=True, timeout=4)
                opts_text = (opts_proc.stdout or "") + "\n" + (opts_proc.stderr or "")
                if "input-ipc-server" in opts_text and "input-unix-socket" not in opts_text:
                    ipc_arg_variants = [f'--input-ipc-server={self.ipc_path}']
                elif "input-unix-socket" in opts_text and "input-ipc-server" not in opts_text:
                    ipc_arg_variants = [f'--input-unix-socket={self.ipc_path}']
                elif "input-ipc-server" in opts_text and "input-unix-socket" in opts_text:
                    ipc_arg_variants = [f'--input-ipc-server={self.ipc_path}']
            except Exception as e:
                log_immediate(f"Could not query mpv options (non-fatal): {e}")

            log_immediate(f"MPV IPC arg candidates (in order): {ipc_arg_variants}")

            # CRITICAL FIX: Detect HDMI audio card dynamically at runtime
            # Previously hardcoded to hw:0,0, which fails on Pis where HDMI is card 1/2
            hdmi_card = detect_hdmi_audio_card()

            base_args_template = [
                'mpv',
                '--idle=yes',
                '--fs',
                '--no-border',
                '--hwdec=auto-safe',
                f'--audio-device=alsa/hw:{hdmi_card},0',  # Dynamic card detection
                '--ao=alsa',
                '--volume=100',
                '--sub-auto=all',  # Auto-load external subtitles
                '--sub-visibility=yes',  # Show subtitles by default
                '--config=no',
                '--osd-level=1',
                '--msg-level=vo/drm=v,vo/gpu=v',
                # RAM optimizations for Pi (prevent 600MB+ usage)
                '--cache=yes',
                '--demuxer-max-bytes=50M',  # Limit read-ahead buffer (default: 400M)
                '--demuxer-max-back-bytes=25M',  # Limit backward seek buffer (default: 150M)
                '--audio-buffer=0.5',  # 500ms audio buffer (default: 1s)
                '--vd-lavc-threads=2',  # Limit decode threads (default: auto = 4 on Pi 4)
            ]

            log_immediate(f"MPV configured with audio device: alsa/hw:{hdmi_card},0")

            # CRITICAL FIX: Unmute and set ALSA volume before starting MPV
            try:
                # Unmute all channels
                subprocess.run(['amixer', '-c', str(hdmi_card), 'set', 'Master', 'unmute'],
                               capture_output=True, timeout=2)
                subprocess.run(['amixer', '-c', str(hdmi_card), 'set', 'PCM', 'unmute'],
                               capture_output=True, timeout=2)
                # Set volume to 100%
                subprocess.run(['amixer', '-c', str(hdmi_card), 'set', 'Master', '100%'],
                               capture_output=True, timeout=2)
                subprocess.run(['amixer', '-c', str(hdmi_card), 'set', 'PCM', '100%'],
                               capture_output=True, timeout=2)
                log_immediate(f"ALSA volume initialized for card {hdmi_card}")
            except Exception as e:
                log_immediate(f"ALSA volume setup failed (non-fatal): {e}")

            def drm_card_index(dev_path: str) -> Optional[str]:
                match = re.search(r'card(\d+)$', dev_path)
                return match.group(1) if match else None

            opts_lower = opts_text.lower()
            has_drm_device_opt = "drm-device" in opts_lower
            has_drm_card_opt = "drm-card" in opts_lower
            has_gpu_context_opt = "gpu-context" in opts_lower

            log_immediate(
                "MPV option support hints: "
                f"gpu-context={'yes' if has_gpu_context_opt else 'no'}, "
                f"drm-device={'yes' if has_drm_device_opt else 'no'}, "
                f"drm-card={'yes' if has_drm_card_opt else 'no'}"
            )

            def try_launch(mpv_args: List[str], env: Dict[str, str]) -> bool:
                # Ensure no stale socket file blocks startup
                if os.path.exists(self.ipc_path):
                    try:
                        os.remove(self.ipc_path)
                    except Exception:
                        pass

                mpv_log_buffer = deque(maxlen=60)

                try:
                    self.process = subprocess.Popen(
                        mpv_args,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        env=env
                    )
                except Exception as e:
                    log_immediate(f"ERROR: Failed to spawn MPV: {e}")
                    return False

                def pipe_logs(proc: subprocess.Popen):
                    try:
                        if not proc.stdout:
                            return
                        for line in iter(proc.stdout.readline, ''):
                            if not line:
                                continue
                            line_clean = line.strip()
                            mpv_log_buffer.append(line_clean)
                            print(f"MPV-OUT: {line_clean}", flush=True)
                        proc.stdout.close()
                    except Exception:
                        pass

                threading.Thread(target=pipe_logs, args=(self.process,), daemon=True).start()

                log_immediate("Waiting for MPV IPC socket...")
                for i in range(80):
                    if os.path.exists(self.ipc_path):
                        log_immediate(f"Socket found after {i*0.1:.1f}s")
                        if self._connect_socket():
                            self._start_dispatcher()
                            return True
                    if self.process.poll() is not None:
                        log_immediate(f"MPV process died immediately with code {self.process.poll()}")
                        if mpv_log_buffer:
                            log_immediate("Recent MPV output (tail):")
                            for line in list(mpv_log_buffer)[-12:]:
                                log_immediate(f"  {line}")
                        break
                    time.sleep(0.1)

                if self.process and self.process.poll() is None:
                    log_immediate("MPV did not create IPC socket in time; terminating attempt")
                    if mpv_log_buffer:
                        log_immediate("Recent MPV output (tail):")
                        for line in list(mpv_log_buffer)[-12:]:
                            log_immediate(f"  {line}")

                return False

            # Build attempts. Start with "auto" modes (no explicit card), then try explicit cards.
            # Avoid deprecated VO/AO suboption syntax (e.g. --vo=drm:device=...), removed in mpv >= 0.23.
            attempts: List[Dict[str, Optional[str]]] = []

            for ipc_arg in ipc_arg_variants:
                base_args = base_args_template + [ipc_arg]

                if has_gpu_context_opt:
                    attempts.append({
                        'name': 'gpu+drm(auto)',
                        'dev': None,
                        'args': base_args + ['--vo=gpu', '--gpu-context=drm'],
                    })

                attempts.append({
                    'name': 'drm(auto)',
                    'dev': None,
                    'args': base_args + ['--vo=drm'],
                })

                for dev in candidates:
                    card_idx = drm_card_index(dev)

                    if has_gpu_context_opt and has_drm_device_opt:
                        attempts.append({
                            'name': 'gpu+drm-device',
                            'dev': dev,
                            'args': base_args + ['--vo=gpu', '--gpu-context=drm', f'--drm-device={dev}'],
                        })
                    if has_drm_device_opt:
                        attempts.append({
                            'name': 'drm+drm-device',
                            'dev': dev,
                            'args': base_args + ['--vo=drm', f'--drm-device={dev}'],
                        })

                    if card_idx and has_gpu_context_opt and has_drm_card_opt:
                        attempts.append({
                            'name': 'gpu+drm-card',
                            'dev': dev,
                            'args': base_args + ['--vo=gpu', '--gpu-context=drm', f'--drm-card={card_idx}'],
                        })
                    if card_idx and has_drm_card_opt:
                        attempts.append({
                            'name': 'drm+drm-card',
                            'dev': dev,
                            'args': base_args + ['--vo=drm', f'--drm-card={card_idx}'],
                        })

            seen = set()
            for attempt in attempts:
                mpv_args = attempt['args']
                attempt_key = " ".join(mpv_args)
                if attempt_key in seen:
                    continue
                seen.add(attempt_key)

                env = os.environ.copy()
                if attempt.get('dev'):
                    env["MPV_DRM_CARD"] = str(attempt['dev'])

                name = attempt.get('name') or "unknown"
                dev = attempt.get('dev') or "auto"

                log_immediate(f"Launching mpv ({name}) on {dev} with: {' '.join(mpv_args)}")

                if try_launch(mpv_args, env):
                    return True

                # Cleanly stop between attempts
                self.stop()

            log_immediate("Failed to start MPV after trying all DRM/VO variants")
            try:
                if os.path.exists("/dev/dri"):
                    log_immediate(f"/dev/dri entries: {sorted(os.listdir('/dev/dri'))}")
            except Exception as e:
                log_immediate(f"Could not list /dev/dri entries: {e}")
            return False

    def _connect_socket(self):
        try:
            self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.socket.connect(self.ipc_path)
            self.socket.settimeout(2.0)
            log_immediate("Successfully connected to MPV socket")
            return True
        except Exception as e:
            try:
                if self.socket:
                    self.socket.close()
            except Exception:
                pass
            self.socket = None
            log_immediate(f"ERROR: IPC Connect error: {e}")
            return False

    def _start_dispatcher(self):
        self._running = True
        self._dispatcher_thread = threading.Thread(
            target=self._dispatcher_loop,
            name="mpv-ipc-dispatcher",
            daemon=True
        )
        self._dispatcher_thread.start()
        log_immediate("IPC Dispatcher thread started")

    def _dispatcher_loop(self):
        """Background thread that reads and dispatches IPC messages."""
        buffer = b""
        while self._running and self.socket:
            try:
                data = self.socket.recv(8192)
                if not data: break
                
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line: continue
                    try:
                        msg = json.loads(line.decode())
                        self._handle_incoming_message(msg)
                    except json.JSONDecodeError:
                        continue
            except socket.timeout:
                continue
            except Exception as e:
                if self._running: log_immediate(f"Dispatcher error: {e}")
                break
        
        self.socket = None
        self._running = False
        log_immediate("IPC Dispatcher thread stopped")

    def _handle_incoming_message(self, msg):
        if 'request_id' in msg:
            rid = msg['request_id']
            with self._lock:
                future = self._response_futures.get(rid)
            if future:
                future['data'] = msg
                future['event'].set()
        elif 'event' in msg:
            if self.on_event:
                self.on_event(msg['event'], msg)

    def send_command(self, cmd: list, async_cmd=False):
        if not self._running or not self.socket: return None
        
        rid = None
        try:
            with self._lock:
                self._request_id += 1
                rid = self._request_id
                payload = json.dumps({"command": cmd, "request_id": rid}) + "\n"

                future = None
                if not async_cmd:
                    future = {'event': threading.Event(), 'data': None}
                    self._response_futures[rid] = future

                self.socket.sendall(payload.encode())

            if async_cmd:
                return True
            
            if future['event'].wait(timeout=2.0):
                with self._lock:
                    resp_obj = self._response_futures.pop(rid, None)
                if not resp_obj:
                    return None
                resp = resp_obj.get('data')
                if not resp or resp.get('error') != 'success':
                    return None
                return resp.get('data')
            else:
                with self._lock:
                    self._response_futures.pop(rid, None)
                return None
        except Exception as e:
            log_immediate(f"IPC Send error: {e}")
            if not async_cmd and rid is not None:
                with self._lock:
                    self._response_futures.pop(rid, None)
            return None

    def get_property(self, prop: str):
        return self.send_command(["get_property", prop])

    def stop(self):
        log_immediate("Stopping MPVController")
        self._running = False
        if self.socket:
            try: self.socket.close()
            except Exception: pass
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2)
            except Exception:
                try: self.process.kill()
                except Exception: pass
        if os.path.exists(self.ipc_path):
            try: os.remove(self.ipc_path)
            except Exception: pass

    def show_osd_text(self, text: str, duration_ms: int = 2000):
        self.send_command(["show-text", text, str(duration_ms)], async_cmd=True)

    def play_url(self, url: str, start_time: float = 0, subtitle_url: str = None):
        """Play a URL with optional subtitle.
        
        Args:
            url: The media URL to play
            start_time: Starting position in seconds
            subtitle_url: Optional external subtitle URL to load with the video
        """
        log_immediate(f"Playing URL: {url} @ {start_time}s" + (f" with subtitle: {subtitle_url}" if subtitle_url else ""))
        
        # Build loadfile options
        options = {}
        if start_time > 0:
            options["start"] = start_time
        
        # BULLSEYE FIX: Pass subtitle URL directly in loadfile options if provided
        # This is more reliable than sub-add for older MPV versions
        if subtitle_url:
            options["sub-files"] = subtitle_url
        
        if options:
            # Convert options dict to MPV option string format
            # Format: start=10.5,sub-files=<url>
            opts_str = ",".join([f"{k}={v}" for k, v in options.items()])
            self.send_command(["loadfile", url, "replace", opts_str], async_cmd=True)
        else:
            self.send_command(["loadfile", url, "replace"], async_cmd=True)

        # Ensure playback is unpaused after load
        self.send_command(["set_property", "pause", False], async_cmd=True)

        # Enable first EMBEDDED subtitle track by default (for embedded subs in MKV/MP4)
        # Only do this if no external subtitle was provided
        if not subtitle_url:
            self.send_command(["set_property", "sid", 1], async_cmd=True)

    def reset_video_geometry(self):
        cmds = [
            ["set_property", "video-aspect-override", -1],
            ["set_property", "video-rotate", 0],
            ["set_property", "fullscreen", True],
            ["set_property", "video-zoom", 0],
            ["set_property", "keepaspect", True]
        ]
        for cmd in cmds:
            self.send_command(cmd, async_cmd=True)

    def show_image(self, image_path: str):
        if not os.path.exists(image_path): return False
        self.send_command(["stop"], async_cmd=True)
        self.send_command(["playlist-clear"], async_cmd=True)
        self.send_command(["loadfile", image_path, "replace"], async_cmd=True)
        self.send_command(["set_property", "loop-file", "inf"], async_cmd=True)
        return True

    def stop_playback(self):
        self.send_command(["stop"], async_cmd=True)
        self.send_command(["playlist-clear"], async_cmd=True)

    def add_subtitle(self, subtitle_url: str):
        """Add a subtitle track from URL and enable it.
        
        NOTE: Uses "auto" flag for compatibility with older MPV versions
        (Bullseye 2022 ships MPV 0.32 which doesn't support "select" flag).
        After adding with "auto", we explicitly enable subtitle visibility
        and select the newly added subtitle track.
        """
        log_immediate(f"Adding subtitle: {subtitle_url}")
        # BULLSEYE COMPATIBILITY: Use "auto" instead of "select"
        # MPV 0.32 on Bullseye 2022 only supports "auto" or no flag for sub-add
        # "auto" = select the subtitle if it's the first one
        self.send_command(["sub-add", subtitle_url, "auto"], async_cmd=True)
        
        # Ensure subtitle visibility is enabled (defensive)
        self.send_command(["set_property", "sub-visibility", True], async_cmd=True)
        
        # CRITICAL: Explicitly select the subtitle track we just added
        # In MPV 0.32, sub-add with "auto" may not auto-select, so we force it
        # External subtitle tracks in MPV start at index 0
        # We need a small delay to let MPV process the subtitle file
        def select_subtitle_delayed():
            time.sleep(0.3)  # Wait for subtitle to be loaded
            self.send_command(["set_property", "sid", 0], async_cmd=True)
            log_immediate("Subtitle track sid=0 selected")
        
        threading.Thread(target=select_subtitle_delayed, daemon=True).start()
        
        log_immediate(f"Subtitle added with auto flag: {subtitle_url}")


class GhostHubRuntime:
    def __init__(self, server_url: str):
        import socketio as _socketio
        log_immediate(f"Initializing GhostHubRuntime with server: {server_url}")
        self.server_url = server_url
        log_immediate("GhostHubRuntime: Creating SocketIO client...")
        try:
            self.sio = _socketio.Client()
            log_immediate("GhostHubRuntime: SocketIO client created")
        except Exception as e:
            log_immediate(f"CRITICAL: Failed to create socketio.Client: {e}")
            raise

        log_immediate("GhostHubRuntime: Initializing MPVController...")
        self.mpv = MPVController(MPV_IPC_PATH)
        log_immediate("GhostHubRuntime: MPVController initialized")
        self.mpv.on_event = self._handle_mpv_event
        self.running = True
        self.mode = "IDLE"
        
        self.view_key = None
        self.view_type = None
        self.view_params = {}
        self.category_id = None
        self.media_path = None
        self.media_id = None
        self.thumbnail_url = None
        self.is_guest_cast = True
        self.last_reported_time = -1
        self.last_reported_pause = None
        self.last_reported_emit_time = 0.0
        self.cast_start_time = 0.0
        self.estimated_time = 0.0
        self.estimated_wallclock = 0.0
        self.estimated_paused = False
        self._playback_attempt_id = 0
        
        self._setup_handlers()

    def _coerce_float(self, value):
        try:
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    def _coerce_bool(self, value) -> bool:
        if value is None:
            return False
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            v = value.strip().lower()
            if v in ('1', 'true', 'yes', 'on'):
                return True
            if v in ('0', 'false', 'no', 'off', ''):
                return False
        return bool(value)

    def _emit_state_snapshot(self, reason: str = "snapshot"):
        if not self.sio.connected or self.mode != "CASTING":
            return
        try:
            t = self._coerce_float(self.mpv.get_property("time-pos"))
            if t is None:
                t = self._coerce_float(self.mpv.get_property("playback-time"))
            d = self._coerce_float(self.mpv.get_property("duration"))
            if d is None:
                d = self._coerce_float(self.mpv.get_property("file-duration"))
            p_raw = self.mpv.get_property("pause")
            p = self._coerce_bool(p_raw)

            if t is None:
                idle_raw = self.mpv.get_property("idle-active")
                idle_active = None if idle_raw is None else self._coerce_bool(idle_raw)
                if idle_active is True:
                    # MPV is idle, so there is no authoritative playback position.
                    return
                now = time.time()
                if not self.estimated_paused:
                    t = self.estimated_time + max(0.0, now - self.estimated_wallclock)
                else:
                    t = self.estimated_time

            if t is None:
                return

            now = time.time()
            # Keep the fallback clock aligned to mpv when we have real data.
            self.estimated_time = float(t)
            self.estimated_wallclock = now
            self.estimated_paused = p

            self.sio.emit(TV_EVENTS['TV_REPORT_STATE'], {
                'currentTime': t,
                'duration': d,
                'paused': p,
                'viewKey': self.view_key,
                'viewType': self.view_type,
                'viewParams': self.view_params or {},
                'mediaId': self.media_id,
                'category_id': self.category_id,
            })
            self.last_reported_time = float(t)
            self.last_reported_pause = p
            self.last_reported_emit_time = now
            log_immediate(f"State snapshot emitted ({reason}): t={t}, d={d}, p={p}")
        except Exception as e:
            log_immediate(f"State snapshot error ({reason}): {e}")

    def _burst_state_reports(self):
        # Emit quick state snapshots right after cast starts
        for _ in range(10):
            if not self.running or self.mode != "CASTING":
                return
            self._emit_state_snapshot("burst")
            time.sleep(0.5)

    def _handle_mpv_event(self, event, data):
        if event == "file-loaded":
            log_immediate("Media loaded - resetting geometry")
            self.mpv.reset_video_geometry()

    def _setup_handlers(self):
        @self.sio.on(SOCKET_EVENTS['CONNECT'])
        def on_connect():
            log_immediate("Connected to GhostHub server via socketio")
            self.sio.emit(TV_EVENTS['TV_CONNECTED'])
            # Ensure playback is stopped/cleared when in idle mode on connection
            if self.mode == "IDLE": 
                self.mpv.stop_playback()

        @self.sio.on(SOCKET_EVENTS['CONNECTION_ERROR'])
        def on_connect_error(data):
            log_immediate(f"SocketIO Connection Error: {data}")

        @self.sio.on(TV_EVENTS['DISPLAY_MEDIA_ON_TV'])
        def on_display_media(data):
            log_immediate(f"EVENT: display_media_on_tv: {data.get('media_path')}")
            self.mode = "CASTING"
            url = data.get('media_path')
            local_path = data.get('media_local_path')
            start_time = float(data.get('start_time', 0))
            if local_path and os.path.exists(local_path):
                url = local_path
                log_immediate(f"Using local media path for MPV: {local_path}")
            elif url and url.startswith('/'):
                url = f"{self.server_url}{url}"
            self.view_key = data.get('viewKey')
            self.view_type = data.get('viewType')
            self.view_params = data.get('viewParams') if isinstance(data.get('viewParams'), dict) else {}
            self.category_id = data.get('category_id')
            self.media_id = data.get('mediaId')
            self.media_path = data.get('media_path')
            self.thumbnail_url = data.get('thumbnail_url')
            self.is_guest_cast = data.get('is_guest_cast', True)
            self.last_reported_time = -1
            self.last_reported_pause = None
            self.cast_start_time = time.time()
            self.estimated_time = float(start_time) if start_time is not None else 0.0
            self.estimated_wallclock = time.time()
            self.estimated_paused = False
            
            # BULLSEYE FIX: Handle subtitle URL before playing video
            subtitle_url = data.get('subtitle_url')
            subtitle_label = data.get('subtitle_label', 'Subtitle')
            if subtitle_url:
                # Convert relative URL to absolute
                if subtitle_url.startswith('/'):
                    subtitle_url = f"{self.server_url}{subtitle_url}"
                log_immediate(f"Including subtitle in playback: {subtitle_label}")
                # Pass subtitle URL to play_url for proper handling
                self.mpv.play_url(url, start_time, subtitle_url)
            else:
                self.mpv.play_url(url, start_time)

            # Emit an initial state update immediately for faster UI feedback
            try:
                self.sio.emit(TV_EVENTS['TV_REPORT_STATE'], {
                    'currentTime': start_time,
                    'duration': data.get('duration', 0),
                    'paused': False,
                    'viewKey': self.view_key,
                    'viewType': self.view_type,
                    'viewParams': self.view_params or {},
                    'mediaId': self.media_id,
                    'category_id': self.category_id,
                })
                self.last_reported_time = float(start_time) if start_time is not None else -1
                self.last_reported_pause = False
                self.last_reported_emit_time = time.time()
            except Exception as e:
                log_immediate(f"Initial state emit failed: {e}")

            # Verify MPV actually starts playback; retry if it stays idle.
            self._playback_attempt_id += 1
            attempt_id = self._playback_attempt_id
            threading.Thread(
                target=self._verify_playback_started,
                args=(url, start_time, subtitle_url, attempt_id),
                daemon=True
            ).start()

            # Burst state reports for first few seconds to ensure UI updates immediately
            threading.Thread(target=self._burst_state_reports, daemon=True).start()

        @self.sio.on(TV_EVENTS['TV_PLAYBACK_CONTROL'])
        def on_playback_control(data):
            if self.mode != "CASTING": return
            action = data.get('action')
            t = data.get('currentTime', 0)
            log_immediate(f"EVENT: tv_playback_control: {action} @ {t}")
            if action == 'play':
                self.mpv.send_command(["set_property", "pause", False], async_cmd=True)
                if self.estimated_paused:
                    self.estimated_paused = False
                    self.estimated_wallclock = time.time()
            elif action == 'pause':
                self.mpv.send_command(["set_property", "pause", True], async_cmd=True)
                if not self.estimated_paused:
                    now = time.time()
                    self.estimated_time = self.estimated_time + max(0.0, now - self.estimated_wallclock)
                    self.estimated_paused = True
            elif action in ['seek', 'sync']:
                try:
                    seek_t = float(t)
                except (TypeError, ValueError):
                    seek_t = 0.0
                # "time-pos" is the canonical mpv seekable playback position.
                self.mpv.send_command(["set_property", "time-pos", seek_t], async_cmd=True)
                self.estimated_time = seek_t
                self.estimated_wallclock = time.time()
            # Force a quick state snapshot so clients reflect TV immediately
            timer = threading.Timer(0.25, self._emit_state_snapshot, args=(f"control:{action}",))
            timer.daemon = True
            timer.start()

        @self.sio.on(TV_EVENTS['TV_REQUEST_STATE'])
        def on_request_state(data=None):
            if self.mode != "CASTING": return
            self._emit_state_snapshot("request")

        @self.sio.on(TV_EVENTS['TV_STOP_CASTING'])
        def on_stop_casting(data=None):
            log_immediate("EVENT: tv_stop_casting")
            self.mpv.stop_playback()
            self.mode = "IDLE"
            self.view_key = None
            self.view_type = None
            self.view_params = {}
            self.category_id = None
            self.media_id = None
            self.media_path = None
            self.thumbnail_url = None

        @self.sio.on(TV_EVENTS['TV_ADD_SUBTITLE'])
        def on_add_subtitle(data):
            subtitle_url = data.get('subtitle_url', '')
            label = data.get('label', 'Subtitle')

            if not subtitle_url:
                return

            log_immediate(f"EVENT: tv_add_subtitle: {label} - {subtitle_url}")

            # Convert relative URL to absolute
            if subtitle_url.startswith('/'):
                subtitle_url = f"{self.server_url}{subtitle_url}"
                log_immediate(f"Converted to absolute: {subtitle_url}")

            self.mpv.add_subtitle(subtitle_url)

    def run(self):
        log_immediate("Starting GhostHubRuntime main loop")
        log_immediate("Attempting to start MPV...")
        if not self.mpv.start(): 
            log_immediate("CRITICAL: MPV failed to start. Exiting.")
            sys.exit(1)
            
        log_immediate("MPV started successfully. Clearing screen...")
        # Ensure initial state is clean (black screen)
        self.mpv.stop_playback()
        log_immediate("Screen cleared. Starting state reporter...")
        
        def reporter():
            log_immediate("State reporter thread started")
            while self.running:
                try:
                    if self.sio.connected and self.mode == "CASTING":
                        t = self._coerce_float(self.mpv.get_property("time-pos"))
                        if t is None:
                            t = self._coerce_float(self.mpv.get_property("playback-time"))
                        d = self._coerce_float(self.mpv.get_property("duration"))
                        if d is None:
                            d = self._coerce_float(self.mpv.get_property("file-duration"))
                        p = self._coerce_bool(self.mpv.get_property("pause"))

                        now = time.time()
                        if t is None:
                            # Fallback: estimate time progression if MPV doesn't report time
                            idle_raw = self.mpv.get_property("idle-active")
                            idle_active = None if idle_raw is None else self._coerce_bool(idle_raw)
                            if idle_active is not True:
                                if not self.estimated_paused:
                                    t = self.estimated_time + max(0.0, now - self.estimated_wallclock)
                                else:
                                    t = self.estimated_time

                        if t is not None:
                            # Keep the fallback clock aligned to mpv when we have real data.
                            self.estimated_time = float(t)
                            self.estimated_wallclock = now
                            self.estimated_paused = p

                            should_emit = False
                            if self.last_reported_time < 0:
                                should_emit = True
                            elif abs(float(t) - self.last_reported_time) > 0.8:
                                should_emit = True
                            elif self.last_reported_pause is None or p != self.last_reported_pause:
                                should_emit = True
                            elif now - self.last_reported_emit_time > 5.0:
                                should_emit = True
                            elif self.cast_start_time and (now - self.cast_start_time) < 5.0 and (now - self.last_reported_emit_time) > 0.5:
                                should_emit = True

                            if should_emit:
                                self.sio.emit(TV_EVENTS['TV_REPORT_STATE'], {
                                    'currentTime': t,
                                    'duration': d,
                                    'paused': p,
                                    'viewKey': self.view_key,
                                    'viewType': self.view_type,
                                    'viewParams': self.view_params or {},
                                    'mediaId': self.media_id,
                                    'category_id': self.category_id,
                                })
                                self.last_reported_time = float(t)
                                self.last_reported_pause = p
                                self.last_reported_emit_time = now
                except Exception as e: 
                    log_immediate(f"Reporter error: {e}")
                time.sleep(1)
        
        threading.Thread(target=reporter, name="tv-state-reporter", daemon=True).start()
        
        while self.running:
            try:
                if not self.sio.connected:
                    log_immediate(f"Attempting to connect to server: {self.server_url}")
                    self.sio.connect(self.server_url, wait_timeout=10)
                time.sleep(10)
            except Exception as e:
                log_immediate(f"Connect loop exception: {e}")
                time.sleep(5)

    def _verify_playback_started(self, url: str, start_time: float, subtitle_url: Optional[str], attempt_id: int):
        """
        Ensure MPV actually starts playback. If it stays idle, retry loadfile a few times.
        """
        max_retries = 2
        for retry in range(max_retries + 1):
            # Abort if a newer play attempt superseded this one
            if attempt_id != self._playback_attempt_id:
                return

            # Give MPV a moment to load
            time.sleep(1.0 + retry * 0.8)

            try:
                idle_active = self.mpv.get_property("idle-active")
                playback_time = self._coerce_float(self.mpv.get_property("time-pos"))
                if playback_time is None:
                    playback_time = self._coerce_float(self.mpv.get_property("playback-time"))
                duration = self._coerce_float(self.mpv.get_property("duration"))
            except Exception:
                idle_active = None
                playback_time = None
                duration = None

            started = False
            idle_active_bool = None
            if idle_active is not None:
                idle_active_bool = self._coerce_bool(idle_active)

            if idle_active_bool is False:
                started = True
            elif playback_time is not None:
                started = True
            elif duration is not None and duration > 0:
                started = True

            if started:
                return

            if retry < max_retries:
                log_immediate(f"Playback did not start (retry {retry + 1}/{max_retries}). Reloading media.")
                try:
                    self.mpv.play_url(url, start_time, subtitle_url)
                except Exception as e:
                    log_immediate(f"Retry load failed: {e}")
            else:
                log_immediate("Playback failed to start after retries")
                try:
                    self.sio.emit(TV_EVENTS['TV_ERROR'], {'message': 'TV playback failed to start'})
                except Exception:
                    pass

    def stop(self):
        log_immediate("Shutting down GhostHubRuntime")
        self.running = False
        try: self.sio.disconnect()
        except: pass
        self.mpv.stop()


def main():
    log_immediate("Entering main()")
    try:
        runtime = GhostHubRuntime(SERVER_URL)
        def handler(sig, frame):
            log_immediate(f"Signal {sig} received - triggering stop")
            runtime.stop()
            sys.exit(0)
        signal.signal(signal.SIGINT, handler)
        signal.signal(signal.SIGTERM, handler)
        runtime.run()
    except Exception as e:
        log_immediate(f"FATAL ERROR in main: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    log_immediate(f"Script starting. Python version: {sys.version}")
    check_dependencies()
    log_immediate(f"BASE_DIR determined: {BASE_DIR}")
    main()
