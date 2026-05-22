"""
Rate Limiting Service
--------------------
Token bucket rate limiting for uploads/downloads.
Optimized for NAS-like usage on Raspberry Pi (2GB RAM).
Connection-aware: Ethernet gets higher limits than AP/WiFi.
"""
import time
import logging
from typing import Dict, Optional, Tuple
from collections import defaultdict
import ipaddress

import gevent

# Use gevent locks instead of threading.Lock to avoid greenlet assertion warnings
# when called from streaming generators. gevent.lock.BoundedSemaphore(1) is
# equivalent to threading.Lock but greenlet-aware.
from gevent.lock import BoundedSemaphore

from app.services.core.runtime_config_service import get_runtime_config_value
from app.services.system.rate_limit_runtime_store import rate_limit_runtime_store

logger = logging.getLogger(__name__)
BURST_WINDOW_SECONDS = 2.0


def _rate_limit_runtime_access(reader):
    """Read rate-limit runtime state atomically."""
    return rate_limit_runtime_store.access(reader)


def _update_rate_limit_runtime(mutator):
    """Mutate rate-limit runtime state atomically."""
    return rate_limit_runtime_store.update(mutator)

# ============== Token Bucket Rate Limiter ==============

class TokenBucket:
    """
    Token bucket algorithm for rate limiting.
    Allows bursts while enforcing average rate limits.
    """

    def __init__(self, capacity: float, refill_rate: float):
        """
        Initialize token bucket.

        Args:
            capacity: Maximum tokens (burst size in bytes)
            refill_rate: Tokens added per second (bytes/sec)
        """
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = capacity
        self.last_refill = time.time()
        self.lock = BoundedSemaphore(1)  # gevent-aware lock

    def consume(self, tokens: float) -> bool:
        """
        Try to consume tokens from bucket.

        Args:
            tokens: Number of tokens to consume

        Returns:
            True if tokens consumed, False if rate limit exceeded
        """
        with self.lock:
            self._refill()

            if tokens <= self.tokens:
                self.tokens -= tokens
                return True
            return False

    def refund(self, tokens: float) -> None:
        """Return tokens after a later bucket rejects the same operation."""
        with self.lock:
            self.tokens = min(self.capacity, self.tokens + tokens)

    def _refill(self):
        """Refill tokens based on elapsed time."""
        now = time.time()
        elapsed = now - self.last_refill

        # Add tokens based on refill rate
        new_tokens = elapsed * self.refill_rate
        self.tokens = min(self.capacity, self.tokens + new_tokens)
        self.last_refill = now

    def get_wait_time(self, tokens: float) -> float:
        """
        Get estimated wait time for tokens to be available.

        Args:
            tokens: Number of tokens needed

        Returns:
            Estimated wait time in seconds
        """
        with self.lock:
            self._refill()

            if tokens <= self.tokens:
                return 0.0

            deficit = tokens - self.tokens
            return deficit / self.refill_rate


# ============== Global Rate Limiter ==============

class RateLimiter:
    """
    Global rate limiter with per-client and global limits.
    """

    def __init__(self):
        self.client_buckets: Dict[str, Dict[str, TokenBucket]] = defaultdict(dict)
        self.global_buckets: Dict[str, TokenBucket] = {}
        self.lock = BoundedSemaphore(1)  # gevent-aware lock
        self.cleanup_interval = 300  # Clean up stale clients every 5 minutes
        self.last_cleanup = time.time()
        self.per_client_limits = {}  # Initialize to empty to avoid AttributeError if used before init_limits

    def init_limits(self, upload_per_client_mbps: float, upload_global_mbps: float,
                   download_per_client_mbps: float, download_global_mbps: float):
        """
        Initialize rate limits.

        Args:
            upload_per_client_mbps: Upload limit per client (Mbps)
            upload_global_mbps: Total upload limit (Mbps)
            download_per_client_mbps: Download limit per client (Mbps)
            download_global_mbps: Total download limit (Mbps)
        """
        # Convert megabits/sec to bytes/sec. Config values are Mbps, not MB/s.
        upload_per_client_bps = float(upload_per_client_mbps) * 1_000_000 / 8
        upload_global_bps = float(upload_global_mbps) * 1_000_000 / 8
        download_per_client_bps = float(download_per_client_mbps) * 1_000_000 / 8
        download_global_bps = float(download_global_mbps) * 1_000_000 / 8

        with self.lock:
            # NOTE: Config allows setting to 0 to disable rate limiting for that category.
            # A refill rate of 0 would otherwise permanently block all traffic.
            self.global_buckets = {}
            if upload_global_bps > 0:
                self.global_buckets['upload'] = TokenBucket(
                    capacity=upload_global_bps * BURST_WINDOW_SECONDS,
                    refill_rate=upload_global_bps
                )
            if download_global_bps > 0:
                self.global_buckets['download'] = TokenBucket(
                    capacity=download_global_bps * BURST_WINDOW_SECONDS,
                    refill_rate=download_global_bps
                )

            # Store per-client limits for lazy initialization (only if enabled)
            self.per_client_limits = {}
            if upload_per_client_bps > 0:
                self.per_client_limits['upload'] = (upload_per_client_bps * BURST_WINDOW_SECONDS, upload_per_client_bps)
            if download_per_client_bps > 0:
                self.per_client_limits['download'] = (download_per_client_bps * BURST_WINDOW_SECONDS, download_per_client_bps)

        logger.info(
            f"Rate limiter initialized: "
            f"Upload={upload_per_client_mbps}Mbps/client, {upload_global_mbps}Mbps global | "
            f"Download={download_per_client_mbps}Mbps/client, {download_global_mbps}Mbps global"
        )

    def check_limit(self, client_ip: str, operation: str, bytes_count: int) -> bool:
        """
        Check if operation is within rate limits.

        Args:
            client_ip: Client IP address
            operation: 'upload' or 'download'
            bytes_count: Number of bytes for this operation

        Returns:
            True if allowed, False if rate limited
        """
        # Loopback traffic (kiosk on the same Pi using localhost) should never be throttled.
        try:
            if client_ip and ipaddress.ip_address(client_ip).is_loopback:
                return True
        except ValueError:
            pass

        # Periodically cleanup stale clients
        self._maybe_cleanup()

        # Check per-client limit
        client_bucket = self._get_client_bucket(client_ip, operation)
        if client_bucket and not client_bucket.consume(bytes_count):
            logger.debug(f"Client {client_ip} {operation} rate limit exceeded")
            return False

        with self.lock:
            global_bucket = self.global_buckets.get(operation)
        if global_bucket and not global_bucket.consume(bytes_count):
            if client_bucket:
                client_bucket.refund(bytes_count)
            logger.warning(f"Global {operation} rate limit exceeded")
            return False

        return True

    def _get_client_bucket(self, client_ip: str, operation: str) -> Optional[TokenBucket]:
        """Get or create token bucket for client, applying connection-type multiplier."""
        with self.lock:
            if operation not in self.per_client_limits:
                return None

            if operation not in self.client_buckets[client_ip]:
                base_capacity, base_refill_rate = self.per_client_limits[operation]

                # Apply connection-type multiplier
                multiplier = _get_rate_limit_multiplier(client_ip)
                if multiplier == 0.0:
                    # Multiplier of 0 means no limit for this connection type
                    return None

                capacity = base_capacity * multiplier
                refill_rate = base_refill_rate * multiplier

                self.client_buckets[client_ip][operation] = TokenBucket(
                    capacity=capacity,
                    refill_rate=refill_rate
                )

                if multiplier != 1.0:
                    logger.debug(f"Client {client_ip} gets {multiplier}x rate limit ({refill_rate * 8 / 1_000_000:.1f} Mbps)")

            return self.client_buckets[client_ip][operation]

    def _maybe_cleanup(self):
        """Clean up stale client buckets to prevent memory leak."""
        now = time.time()
        if now - self.last_cleanup < self.cleanup_interval:
            return

        with self.lock:
            # Remove clients with no recent activity (5 min idle)
            stale_threshold = now - 300
            stale_clients = []
            for client_ip, buckets in self.client_buckets.items():
                # Stale if all buckets haven't been accessed recently
                all_idle = all(
                    bucket.last_refill < stale_threshold
                    for bucket in buckets.values()
                )
                if all_idle:
                    stale_clients.append(client_ip)

            for client_ip in stale_clients:
                del self.client_buckets[client_ip]

            self.last_cleanup = now

            if stale_clients:
                logger.debug(f"Cleaned up {len(stale_clients)} stale client rate limiters")

    def get_stats(self) -> Dict:
        """Get rate limiter statistics."""
        with self.lock:
            return {
                'active_clients': len(self.client_buckets),
                'global_upload_available': self.global_buckets.get('upload').tokens if 'upload' in self.global_buckets else None,
                'global_download_available': self.global_buckets.get('download').tokens if 'download' in self.global_buckets else None
            }


def _get_rate_limiter() -> RateLimiter:
    """Get or create the shared rate limiter owner."""
    rate_limiter = _rate_limit_runtime_access(
        lambda state: state.get('rate_limiter')
    )
    if rate_limiter is not None:
        return rate_limiter

    created_rate_limiter = RateLimiter()
    _update_rate_limit_runtime(
        lambda state: state.update({
            'rate_limiter': state.get('rate_limiter') or created_rate_limiter,
        })
    )
    return _rate_limit_runtime_access(lambda state: state.get('rate_limiter'))


def _get_rate_limit_multiplier(client_ip: str) -> float:
    """
    Get rate limit multiplier based on client connection type.

    Returns:
        Multiplier to apply to base rate limit (0.0 = no limit)
    """
    try:
        ip = ipaddress.ip_address(client_ip)

        # Localhost gets no limit (handled separately, but just in case)
        if ip.is_loopback:
            return get_runtime_config_value('RATE_LIMIT_MULTIPLIER_LOCALHOST', 0.0)

        # Tailscale CGNAT range: 100.64.0.0/10
        if ip.version == 4:
            ip_int = int(ip)
            # 100.64.0.0/10 = 100.64.0.0 to 100.127.255.255
            if (ip_int & 0xFFC00000) == 0x64400000:
                return get_runtime_config_value('RATE_LIMIT_MULTIPLIER_TAILSCALE', 0.5)

        # Detect connection type via network_detection_service
        # Lazy import to avoid circular dependency
        from app.services.system.network_detection_service import detect_interface_for_client

        interface = detect_interface_for_client(client_ip)

        if interface == 'eth0':
            return get_runtime_config_value('RATE_LIMIT_MULTIPLIER_ETHERNET', 4.0)
        elif interface and interface.startswith('wlan'):
            return get_runtime_config_value('RATE_LIMIT_MULTIPLIER_WIFI', 1.0)

        # Default: use base limit
        return 1.0

    except Exception as e:
        logger.debug(f"Could not determine rate limit multiplier for {client_ip}: {e}")
        return 1.0


def init_rate_limiter(upload_per_client_mbps: float = 50.0,
                     upload_global_mbps: float = 100.0,
                     download_per_client_mbps: float = 50.0,
                     download_global_mbps: float = 100.0):
    """
    Initialize global rate limiter.

    Default limits are generous for home NAS use:
    - 50 Mbps per client (6.25 MB/s, fast enough for 4K streaming)
    - 100 Mbps global (12.5 MB/s total, reasonable for Pi's 1 Gbps ethernet)
    """
    _get_rate_limiter().init_limits(
        upload_per_client_mbps,
        upload_global_mbps,
        download_per_client_mbps,
        download_global_mbps
    )


def check_upload_limit(client_ip: str, bytes_count: int) -> bool:
    """Check if upload is within rate limits."""
    return _get_rate_limiter().check_limit(client_ip, 'upload', bytes_count)


def wait_for_upload_capacity(
    client_ip: str,
    bytes_count: int,
    timeout: float = 30.0,
) -> bool:
    """Block until the upload limiter can accept this many bytes.

    Real rate-limiters slow callers down; they don't fail their requests.
    The HTTP-429 path is fine for synthetic stress tests that want to
    measure rejection rate, but for an actual chunked upload it makes the
    browser give up partway through and corrupts the file. This helper
    polls the limiter with gevent.sleep until tokens are available (or the
    timeout elapses), so chunks queue up and eventually succeed at the
    configured rate rather than dropping on the floor.

    Returns True if the request was eventually allowed, False on timeout.
    """
    limiter = _get_rate_limiter()
    deadline = time.time() + timeout
    while True:
        if limiter.check_limit(client_ip, 'upload', bytes_count):
            return True
        remaining = deadline - time.time()
        if remaining <= 0:
            return False
        # Ask the buckets how long to wait for the deficit to refill, then
        # sleep that long (capped so a misconfigured bucket can't park us
        # forever, and floored so we always yield to other greenlets).
        wait = 0.05
        try:
            global_bucket = limiter.global_buckets.get('upload')
            client_bucket = limiter._get_client_bucket(client_ip, 'upload')
            for bucket in (client_bucket, global_bucket):
                if bucket is not None:
                    wait = max(wait, bucket.get_wait_time(bytes_count))
        except Exception:
            pass
        gevent.sleep(min(wait, remaining, 1.0))


def get_effective_upload_limit_mbps(client_ip: str) -> Optional[float]:
    """Return the effective per-client upload limit for a client, or None when disabled."""
    limiter = _get_rate_limiter()
    with limiter.lock:
        limit = limiter.per_client_limits.get('upload')
    if not limit:
        return None
    _capacity, refill_rate = limit
    multiplier = _get_rate_limit_multiplier(client_ip)
    if multiplier == 0.0:
        return None
    return refill_rate * multiplier * 8 / 1_000_000


def check_download_limit(client_ip: str, bytes_count: int) -> bool:
    """Check if download is within rate limits."""
    return _get_rate_limiter().check_limit(client_ip, 'download', bytes_count)


def get_rate_limiter_stats() -> Dict:
    """Get rate limiter statistics."""
    return _get_rate_limiter().get_stats()
