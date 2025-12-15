"""
GhostStream Service
-------------------
Client for discovering and using GhostStream transcoding servers.
Provides synchronous API suitable for Flask integration.
"""

import logging
import threading
import time
import urllib.request
import urllib.error
import json as json_lib
from typing import Optional, Dict, List, Callable, Any
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

# Optional dependencies
try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False
    logger.warning("httpx not installed - GhostStream integration disabled")

try:
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
    import socket
    HAS_ZEROCONF = True
except ImportError:
    HAS_ZEROCONF = False
    logger.info("zeroconf not installed - mDNS discovery disabled")


class TranscodeStatus(str, Enum):
    """Status of a transcoding job."""
    QUEUED = "queued"
    PROCESSING = "processing"
    READY = "ready"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class GhostStreamServer:
    """Represents a discovered GhostStream server."""
    name: str
    host: str
    port: int
    version: str = ""
    hw_accels: List[str] = field(default_factory=list)
    video_codecs: List[str] = field(default_factory=list)
    max_jobs: int = 2
    
    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"
    
    @property
    def has_hw_accel(self) -> bool:
        """Check if hardware acceleration is available."""
        return any(hw != "software" for hw in self.hw_accels)


@dataclass
class TranscodeJob:
    """Represents a transcoding job."""
    job_id: str
    status: TranscodeStatus
    progress: float = 0
    stream_url: Optional[str] = None
    download_url: Optional[str] = None
    error_message: Optional[str] = None
    hw_accel_used: Optional[str] = None
    mode: str = "stream"
    eta_seconds: Optional[float] = None
    current_time: Optional[float] = None
    duration: Optional[float] = None


class GhostStreamDiscoveryListener:
    """Listens for GhostStream services on the network via mDNS."""
    
    SERVICE_TYPE = "_ghoststream._tcp.local."
    
    def __init__(self, on_found: Callable, on_removed: Callable):
        self.on_found = on_found
        self.on_removed = on_removed
    
    def add_service(self, zc, type_: str, name: str) -> None:
        info = zc.get_service_info(type_, name)
        if info:
            addresses = [socket.inet_ntoa(addr) for addr in info.addresses]
            if addresses:
                props = {
                    k.decode(): v.decode() if isinstance(v, bytes) else v
                    for k, v in info.properties.items()
                }
                
                server = GhostStreamServer(
                    name=name,
                    host=addresses[0],
                    port=info.port,
                    version=props.get("version", ""),
                    hw_accels=props.get("hw_accels", "").split(",") if props.get("hw_accels") else [],
                    video_codecs=props.get("video_codecs", "").split(",") if props.get("video_codecs") else [],
                    max_jobs=int(props.get("max_jobs", 2))
                )
                
                logger.info(f"Found GhostStream: {server.host}:{server.port}")
                self.on_found(server)
    
    def remove_service(self, zc, type_: str, name: str) -> None:
        logger.info(f"GhostStream removed: {name}")
        self.on_removed(name)
    
    def update_service(self, zc, type_: str, name: str) -> None:
        self.add_service(zc, type_, name)


class GhostStreamService:
    """
    Synchronous client for GhostStream transcoding services.
    
    Thread-safe singleton service for Flask integration.
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self.servers: Dict[str, GhostStreamServer] = {}
        self.preferred_server: Optional[str] = None
        self.active_jobs: Dict[str, str] = {}  # job_id -> server_name
        self._zeroconf = None
        self._browser = None
        self._discovery_started = False
        self._enabled = False
        self._manual_server = None
        self._initialized = True
    
    def configure(self, enabled: bool, server_url: str = ""):
        """
        Configure the GhostStream service.
        
        Args:
            enabled: Whether GhostStream is enabled
            server_url: Manual server address (e.g., "192.168.4.2:8765")
        """
        logger.info(f"GhostStream configure called: enabled={enabled}, server_url='{server_url}'")
        
        self._enabled = enabled
        self._manual_server = server_url
        
        if not enabled:
            logger.info("GhostStream is disabled")
            return
        
        if not HAS_HTTPX:
            logger.error("GhostStream enabled but httpx not installed! Run: pip install httpx")
            return
        
        if server_url:
            # Manual server configuration
            server_url = server_url.strip()
            
            # Remove http:// or https:// prefix if present
            if server_url.startswith("http://"):
                server_url = server_url[7:]
            elif server_url.startswith("https://"):
                server_url = server_url[8:]
            
            # Remove trailing slash
            server_url = server_url.rstrip("/")
            
            try:
                # Handle URLs with or without port
                if ":" in server_url:
                    host, port_str = server_url.rsplit(":", 1)
                    port = int(port_str)
                else:
                    host = server_url
                    port = 8765  # Default GhostStream port
                
                self.servers["manual"] = GhostStreamServer(
                    name="manual",
                    host=host,
                    port=port
                )
                self.preferred_server = "manual"
                logger.info(f"GhostStream configured with server: {host}:{port}")
                
                # Test connection immediately
                if self.health_check():
                    logger.info(f"GhostStream server {host}:{port} is reachable!")
                else:
                    logger.warning(f"GhostStream server {host}:{port} configured but not reachable yet")
                    
            except ValueError as e:
                logger.error(f"Invalid GhostStream server URL '{server_url}': {e}")
        elif HAS_ZEROCONF:
            # Start mDNS discovery
            logger.info("No server URL, starting mDNS discovery...")
            self.start_discovery()
        else:
            logger.warning("GhostStream enabled but no server URL and zeroconf not available")
    
    def start_discovery(self) -> bool:
        """Start mDNS discovery for GhostStream servers."""
        if not HAS_ZEROCONF:
            logger.warning("zeroconf not available for mDNS discovery")
            return False
        
        if self._discovery_started:
            return True
        
        try:
            self._zeroconf = Zeroconf()
            listener = GhostStreamDiscoveryListener(
                on_found=self._on_server_found,
                on_removed=self._on_server_removed
            )
            self._browser = ServiceBrowser(
                self._zeroconf,
                GhostStreamDiscoveryListener.SERVICE_TYPE,
                listener
            )
            self._discovery_started = True
            logger.info("Started GhostStream mDNS discovery")
            return True
        except Exception as e:
            logger.error(f"Failed to start GhostStream discovery: {e}")
            return False
    
    def stop_discovery(self):
        """Stop mDNS discovery."""
        if self._browser:
            self._browser.cancel()
        if self._zeroconf:
            self._zeroconf.close()
        self._browser = None
        self._zeroconf = None
        self._discovery_started = False
    
    def _on_server_found(self, server: GhostStreamServer):
        """Called when a server is discovered."""
        self.servers[server.name] = server
        
        # Auto-select first server with hw accel, or first found
        if self.preferred_server is None:
            self.preferred_server = server.name
        elif server.has_hw_accel and self.get_server() and not self.get_server().has_hw_accel:
            self.preferred_server = server.name
    
    def _on_server_removed(self, name: str):
        """Called when a server is removed."""
        self.servers.pop(name, None)
        
        if self.preferred_server == name:
            self.preferred_server = next(iter(self.servers.keys()), None)
    
    def is_enabled(self) -> bool:
        """Check if GhostStream is enabled."""
        return self._enabled and HAS_HTTPX
    
    def is_available(self) -> bool:
        """Check if any GhostStream server is available."""
        return self.is_enabled() and len(self.servers) > 0
    
    def get_server(self, name: Optional[str] = None) -> Optional[GhostStreamServer]:
        """Get a server by name, or the preferred server."""
        if name:
            return self.servers.get(name)
        if self.preferred_server:
            return self.servers.get(self.preferred_server)
        return None
    
    def get_all_servers(self) -> List[GhostStreamServer]:
        """Get all discovered servers."""
        return list(self.servers.values())
    
    def get_active_jobs_for_category(self, category_id: str) -> List[Dict]:
        """Get all active jobs that match a category (by checking source URL)."""
        jobs = []
        for job_id in list(self.active_jobs.keys()):
            job = self.get_job_status(job_id)
            if job and category_id in str(job_id):  # Simple check
                jobs.append({
                    "job_id": job.job_id,
                    "status": job.status.value,
                    "progress": job.progress,
                    "download_url": job.download_url
                })
        return jobs
    
    def health_check(self, server: Optional[GhostStreamServer] = None) -> bool:
        """Check if a server is healthy."""
        if not HAS_HTTPX:
            logger.debug("health_check: httpx not available")
            return False
        
        server = server or self.get_server()
        if not server:
            logger.debug("health_check: no server configured")
            return False
        
        try:
            url = f"{server.base_url}/api/health"
            logger.debug(f"health_check: checking {url}")
            with httpx.Client(timeout=5.0) as client:
                response = client.get(url)
                if response.status_code == 200:
                    logger.debug(f"health_check: {url} returned 200 OK")
                    return True
                else:
                    logger.warning(f"health_check: {url} returned {response.status_code}")
                    return False
        except httpx.ConnectError as e:
            logger.warning(f"health_check: Connection failed to {server.base_url}: {e}")
            return False
        except httpx.TimeoutException as e:
            logger.warning(f"health_check: Timeout connecting to {server.base_url}: {e}")
            return False
        except Exception as e:
            logger.error(f"health_check: Error checking {server.base_url}: {e}")
            return False
    
    def get_capabilities(self, server: Optional[GhostStreamServer] = None) -> Optional[Dict]:
        """Get server capabilities."""
        if not HAS_HTTPX:
            return None
        
        server = server or self.get_server()
        if not server:
            return None
        
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(f"{server.base_url}/api/capabilities")
                if response.status_code == 200:
                    return response.json()
        except Exception as e:
            logger.error(f"Failed to get GhostStream capabilities: {e}")
        
        return None
    
    def start_transcode(
        self,
        source: str,
        mode: str = "stream",
        format: str = "hls",
        video_codec: str = "h264",
        audio_codec: str = "aac",
        resolution: str = "1080p",
        bitrate: str = "auto",
        hw_accel: str = "auto",
        start_time: float = 0,
        tone_map: bool = True,
        two_pass: bool = False,
        max_audio_channels: int = 2,
        callback_url: Optional[str] = None,
        server: Optional[GhostStreamServer] = None
    ) -> Optional[TranscodeJob]:
        """
        Start a transcoding job.
        
        Args:
            source: Source file URL (accessible from GhostStream server)
            mode: "stream" for live HLS, "abr" for adaptive bitrate, "batch" for file output
            format: Output format (hls, mp4, webm, mkv)
            video_codec: Video codec (h264, h265, vp9, av1, copy)
            audio_codec: Audio codec (aac, opus, mp3, copy)
            resolution: Target resolution (4k, 1080p, 720p, 480p, original)
            bitrate: Target bitrate or "auto"
            hw_accel: Hardware acceleration (auto, nvenc, qsv, vaapi, software)
            start_time: Start position in seconds (for seeking)
            tone_map: Convert HDR to SDR automatically (default: True)
            two_pass: Two-pass encoding for batch mode (default: False)
            max_audio_channels: Max audio channels, 2=stereo, 6=5.1 (default: 2)
            callback_url: URL to POST when job completes (optional)
            server: Specific server to use
        
        Returns:
            TranscodeJob with stream_url for playback, or None on failure
        """
        if not HAS_HTTPX:
            logger.error("httpx not available for GhostStream")
            return None
        
        server = server or self.get_server()
        if not server:
            logger.error("No GhostStream server available")
            return None
        
        request_body = {
            "source": source,
            "mode": mode,
            "output": {
                "format": format,
                "video_codec": video_codec,
                "audio_codec": audio_codec,
                "resolution": resolution,
                "bitrate": bitrate,
                "hw_accel": hw_accel,
                "tone_map": tone_map,
                "two_pass": two_pass,
                "max_audio_channels": max_audio_channels
            },
            "start_time": start_time
        }
        
        if callback_url:
            request_body["callback_url"] = callback_url
        
        try:
            import urllib.request
            import json as json_lib
            
            url = f"{server.base_url}/api/transcode/start"
            data_bytes = json_lib.dumps(request_body).encode('utf-8')
            
            req = urllib.request.Request(url, data=data_bytes, method='POST')
            req.add_header('Content-Type', 'application/json')
            req.add_header('Accept', 'application/json')
            
            with urllib.request.urlopen(req, timeout=30) as response:
                data = json_lib.loads(response.read().decode('utf-8'))
                job = TranscodeJob(
                    job_id=data["job_id"],
                    status=TranscodeStatus(data["status"]),
                    progress=data.get("progress", 0),
                    stream_url=data.get("stream_url"),
                    download_url=data.get("download_url"),
                    hw_accel_used=data.get("hw_accel_used"),
                    mode=mode
                )
                self.active_jobs[job.job_id] = server.name
                return job
        except urllib.error.HTTPError as e:
            logger.error(f"GhostStream transcode HTTP error: {e.code} - {e.reason}")
        except urllib.error.URLError as e:
            logger.error(f"GhostStream transcode URL error: {e.reason}")
        except Exception as e:
            logger.error(f"GhostStream transcode error: {e}")
        
        return None
    
    def start_hls_stream(
        self,
        source: str,
        resolution: str = "1080p",
        video_codec: str = "h264",
        audio_codec: str = "aac",
        start_time: float = 0,
        hw_accel: str = "auto",
        server: Optional[GhostStreamServer] = None
    ) -> Optional[TranscodeJob]:
        """
        Start single-quality HLS streaming (fastest startup).
        Best for: Quick playback, lower-powered clients, known bandwidth.
        """
        return self.start_transcode(
            source=source,
            mode="stream",
            format="hls",
            resolution=resolution,
            video_codec=video_codec,
            audio_codec=audio_codec,
            start_time=start_time,
            hw_accel=hw_accel,
            server=server
        )
    
    def start_abr_stream(
        self,
        source: str,
        video_codec: str = "h264",
        audio_codec: str = "aac",
        start_time: float = 0,
        hw_accel: str = "auto",
        server: Optional[GhostStreamServer] = None
    ) -> Optional[TranscodeJob]:
        """
        Start Adaptive Bitrate (ABR) streaming with multiple quality variants.
        Best for: Variable network conditions, quality selection UI.
        
        Automatically generates quality variants based on source:
        - 4K source -> 4K, 1080p, 720p, 480p variants
        - 1080p source -> 1080p, 720p, 480p variants
        - etc. (never upscales)
        """
        return self.start_transcode(
            source=source,
            mode="abr",
            format="hls",
            resolution="original",  # ABR handles resolution automatically
            video_codec=video_codec,
            audio_codec=audio_codec,
            start_time=start_time,
            hw_accel=hw_accel,
            server=server
        )
    
    def start_batch_transcode(
        self,
        source: str,
        output_format: str = "mp4",
        resolution: str = "1080p",
        video_codec: str = "h264",
        audio_codec: str = "aac",
        two_pass: bool = False,
        hw_accel: str = "auto",
        callback_url: Optional[str] = None,
        server: Optional[GhostStreamServer] = None
    ) -> Optional[TranscodeJob]:
        """
        Start batch (file-to-file) transcoding.
        Best for: Pre-transcoding library, overnight processing.
        
        Args:
            output_format: Output format (mp4, mkv, webm)
            two_pass: Enable two-pass encoding for better quality (slower)
        """
        return self.start_transcode(
            source=source,
            mode="batch",
            format=output_format,
            resolution=resolution,
            video_codec=video_codec,
            audio_codec=audio_codec,
            two_pass=two_pass,
            hw_accel=hw_accel,
            callback_url=callback_url,
            server=server
        )
    
    def get_job_status(self, job_id: str, server: Optional[GhostStreamServer] = None) -> Optional[TranscodeJob]:
        """Get the status of a transcoding job."""
        # Try the server we used to start this job
        if job_id in self.active_jobs:
            server_name = self.active_jobs[job_id]
            if server_name in self.servers:
                server = self.servers[server_name]
        
        server = server or self.get_server()
        if not server:
            return None
        
        try:
            url = f"{server.base_url}/api/transcode/{job_id}/status"
            req = urllib.request.Request(url, method='GET')
            req.add_header('Accept', 'application/json')
            
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json_lib.loads(response.read().decode('utf-8'))
                return TranscodeJob(
                    job_id=data["job_id"],
                    status=TranscodeStatus(data["status"]),
                    progress=data.get("progress", 0),
                    stream_url=data.get("stream_url"),
                    download_url=data.get("download_url"),
                    error_message=data.get("error_message"),
                    hw_accel_used=data.get("hw_accel_used"),
                    mode=data.get("mode", "stream"),
                    eta_seconds=data.get("eta_seconds"),
                    current_time=data.get("current_time"),
                    duration=data.get("duration")
                )
        except urllib.error.HTTPError as e:
            if e.code != 404:  # Don't log 404s as errors
                logger.error(f"GhostStream status HTTP error: {e.code}")
        except Exception as e:
            logger.error(f"GhostStream status error: {e}")
        
        return None
    
    def cancel_job(self, job_id: str, server: Optional[GhostStreamServer] = None) -> bool:
        """Cancel a transcoding job."""
        if not HAS_HTTPX:
            return False
        
        # Try the server we used to start this job
        if job_id in self.active_jobs:
            server_name = self.active_jobs[job_id]
            if server_name in self.servers:
                server = self.servers[server_name]
        
        server = server or self.get_server()
        if not server:
            return False
        
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(f"{server.base_url}/api/transcode/{job_id}/cancel")
                if response.status_code == 200:
                    self.active_jobs.pop(job_id, None)
                    return True
        except Exception as e:
            logger.error(f"GhostStream cancel error: {e}")
        
        return False
    
    def delete_job(self, job_id: str, server: Optional[GhostStreamServer] = None) -> bool:
        """Delete a transcoding job and clean up temp files."""
        if not HAS_HTTPX:
            return False
        
        # Try the server we used to start this job
        if job_id in self.active_jobs:
            server_name = self.active_jobs[job_id]
            if server_name in self.servers:
                server = self.servers[server_name]
        
        server = server or self.get_server()
        if not server:
            return False
        
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.delete(f"{server.base_url}/api/transcode/{job_id}")
                if response.status_code == 200:
                    self.active_jobs.pop(job_id, None)
                    return True
        except Exception as e:
            logger.error(f"GhostStream delete error: {e}")
        
        return False
    
    def wait_for_ready(
        self,
        job_id: str,
        timeout: float = 60,
        poll_interval: float = 1.0,
        server: Optional[GhostStreamServer] = None
    ) -> Optional[TranscodeJob]:
        """
        Wait for a job to be ready for streaming.
        
        For live transcoding (HLS), the job becomes ready quickly
        as segments are generated.
        """
        elapsed = 0
        while elapsed < timeout:
            job = self.get_job_status(job_id, server)
            
            if job is None:
                return None
            
            if job.status == TranscodeStatus.READY:
                return job
            
            if job.status == TranscodeStatus.ERROR:
                logger.error(f"GhostStream job failed: {job.error_message}")
                return job
            
            if job.status == TranscodeStatus.CANCELLED:
                return job
            
            # For streaming mode, return as soon as we have a stream URL
            if job.stream_url and job.status == TranscodeStatus.PROCESSING:
                return job
            
            time.sleep(poll_interval)
            elapsed += poll_interval
        
        logger.warning(f"Timeout waiting for GhostStream job {job_id}")
        return None
    
    def get_status_summary(self) -> Dict[str, Any]:
        """Get a summary of GhostStream status for the UI."""
        server = self.get_server()
        return {
            "enabled": self._enabled,
            "available": self.is_available(),
            "server_count": len(self.servers),
            "servers": [
                {
                    "name": s.name,
                    "host": s.host,
                    "port": s.port,
                    "has_hw_accel": s.has_hw_accel,
                    "hw_accels": s.hw_accels,
                    "is_preferred": s.name == self.preferred_server
                }
                for s in self.servers.values()
            ],
            "active_jobs": len(self.active_jobs),
            "preferred_server": self.preferred_server
        }


# Global singleton instance
ghoststream_service = GhostStreamService()
