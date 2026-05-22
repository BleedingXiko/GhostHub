"""Tunnel URL capture and side-effect ownership."""

import logging
import re
import time

import gevent

from app.services.system.tunnel.state_service import (
    get_active_tunnel_info,
    set_active_tunnel_info,
)
from specter import Service, registry

logger = logging.getLogger(__name__)

try:
    import pyperclip
except ImportError:
    class _PyperclipFallback:
        def copy(self, text):
            logger.warning("pyperclip module not available. URL was not copied to clipboard.")

    pyperclip = _PyperclipFallback()

try:
    import requests
except ImportError:
    requests = None


class TunnelUrlCaptureService(Service):
    """Own tunnel URL capture readers and side effects."""

    def __init__(self):
        super().__init__('tunnel_url_capture')

    def capture_process_url(self, provider, process):
        """Extract and capture tunnel URL for a process-backed provider."""
        if provider == "pinggy":
            self.spawn(self._capture_pinggy_url, process, label='pinggy-url-capture')
            return True
        if provider == "cloudflare":
            self.spawn(self._capture_cloudflare_url, process, label='cloudflare-url-capture')
            return True

        logger.warning("Unsupported tunnel provider for URL capture: %s", provider)
        return False

    def collect_output_lines(self, process, output_lines, *, label_prefix):
        """Collect process output lines through service-owned readers."""
        url_pattern = re.compile(r'(https://[-a-zA-Z0-9.]+\.trycloudflare\.com)')

        def read_stream(stream, stream_name):
            try:
                for line in iter(stream.readline, ''):
                    if line:
                        line_str = line.strip()
                        logger.debug("%s %s: %s", label_prefix, stream_name, line_str)
                        output_lines.append(line_str)

                        if label_prefix == 'Cloudflare':
                            match = url_pattern.search(line_str)
                            if match:
                                cloudflare_url = match.group(0)
                                logger.info("Cloudflare URL found in stream: %s", cloudflare_url)
                                _store_captured_url(cloudflare_url)
                    else:
                        break
            except Exception as err:
                logger.debug("Error reading %s output: %s", label_prefix, err)

        self.spawn(
            read_stream,
            process.stderr,
            "stderr",
            label=f'{label_prefix}-stderr-reader',
        )
        self.spawn(
            read_stream,
            process.stdout,
            "stdout",
            label=f'{label_prefix}-stdout-reader',
        )
        return True

    def _capture_pinggy_url(self, process):
        """Capture Pinggy tunnel URL via the local API endpoint."""
        if requests is None:
            logger.error("requests module not available for Pinggy URL capture")
            return

        try:
            logger.info("Retrieving Pinggy tunnel URL via API endpoint")
            start_time = time.time()
            timeout = 30
            api_url = "http://localhost:4300/urls"

            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    logger.error("Pinggy tunnel process terminated unexpectedly")
                    return

                try:
                    response = requests.get(api_url, timeout=3)
                    if response.status_code == 200:
                        url_data = response.json()
                        urls = url_data.get("urls") or []
                        https_url = next(
                            (url for url in urls if url.startswith("https://")),
                            None,
                        )
                        if https_url:
                            logger.info("Pinggy tunnel URL: %s", https_url)
                            _store_captured_url(https_url)
                            return
                        logger.warning("No HTTPS URL found in Pinggy API response")
                except Exception:
                    pass

                gevent.sleep(1)

            logger.warning("Timed out waiting for Pinggy tunnel URL")
        except Exception as err:
            logger.error("Error retrieving Pinggy tunnel URL: %s", err)

    def _capture_cloudflare_url(self, process):
        """Capture Cloudflare tunnel URL from process output."""
        try:
            logger.info("Capturing Cloudflare tunnel URL from process output")
            start_time = time.time()
            timeout = 60

            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    logger.error("Cloudflare tunnel process terminated unexpectedly")
                    return
                active_info = get_active_tunnel_info()
                if active_info and active_info.get("url"):
                    logger.info("Cloudflare URL verified: %s", active_info.get("url"))
                    return
                gevent.sleep(0.5)

            logger.warning("Timed out waiting for Cloudflare tunnel URL")
        except Exception as err:
            logger.error("Error capturing Cloudflare tunnel URL: %s", err)


def capture_process_tunnel_url(provider, process):
    """Extract and capture tunnel URL through the registered runtime owner."""
    return registry.require('tunnel_url_capture').capture_process_url(provider, process)


def collect_process_output_lines(process, output_lines, *, label_prefix):
    """Collect process output lines through the registered runtime owner."""
    return registry.require('tunnel_url_capture').collect_output_lines(
        process,
        output_lines,
        label_prefix=label_prefix,
    )


def _store_captured_url(url):
    """Persist a captured URL and try to copy it to the clipboard."""
    if not url:
        return

    set_active_tunnel_info({"url": url})
    try:
        pyperclip.copy(url)
    except Exception:
        pass
