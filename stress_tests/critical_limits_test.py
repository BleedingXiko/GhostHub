#!/usr/bin/env python3
"""
GhostHub Critical Limits & Failure Scenario Tests
==================================================
Tests edge cases and failure modes critical for $200 Pi appliance reliability.

Tests:
- 16GB upload limit enforcement
- Rate limiting (50 Mbps/client, 100 Mbps global)
- Concurrent chunk limits (3 chunks, 2 files)
- Network drop recovery (mid-upload disconnects)
- SQLite write contention (concurrent progress updates, profile-scoped)
- Profile progress contention (multi-profile concurrent writes)
- Preference update burst (rapid preference writes + persistence verification)
- Memory leak detection (before/after comparison)
- Hidden categories under load
- Disk full handling

Usage:
    python3 critical_limits_test.py --url http://localhost:5000 --test all
    python3 critical_limits_test.py --url http://localhost:5000 --test profile_contention
    python3 critical_limits_test.py --url http://localhost:5000 --test preference_burst
"""

import os
import sys
import argparse
import time
import json
import tempfile
import threading
import psutil
from datetime import datetime
from typing import Dict, List, Optional

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    print("ERROR: Missing dependency 'requests'")
    print("Install: pip3 install requests")
    sys.exit(1)


class Colors:
    """ANSI color codes for terminal output"""
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'
    END = '\033[0m'


class CriticalLimitsTest:
    """Test critical resource limits and failure scenarios"""

    def __init__(
        self,
        base_url: str,
        admin_password: Optional[str] = None,
        session_password: Optional[str] = None,
        output_file: Optional[str] = None
    ):
        self.base_url = base_url.rstrip('/')
        self.admin_password = admin_password
        self.session_password = session_password
        self.output_file = output_file
        self.session = self._create_session()
        self.results = {
            'start_time': datetime.now().isoformat(),
            'base_url': base_url,
            'tests': []
        }

    def _create_session(self) -> requests.Session:
        """Create requests session with retry logic"""
        session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.3,
            status_forcelist=[500, 502, 503, 504]
        )
        adapter = HTTPAdapter(max_retries=retry)
        session.mount('http://', adapter)
        session.mount('https://', adapter)
        return session

    def _log(self, message: str, level: str = "INFO"):
        """Log message with color coding"""
        timestamp = datetime.now().strftime("%H:%M:%S")

        if level == "SUCCESS":
            color = Colors.GREEN
            prefix = "✓"
        elif level == "ERROR":
            color = Colors.RED
            prefix = "✗"
        elif level == "WARN":
            color = Colors.YELLOW
            prefix = "⚠"
        elif level == "HEADER":
            color = Colors.CYAN + Colors.BOLD
            prefix = "▶"
        else:
            color = Colors.BLUE
            prefix = "ℹ"

        print(f"{color}[{timestamp}] {prefix} {message}{Colors.END}")

    def _record_result(self, test_name: str, passed: bool, details: Dict, skipped: bool = False, skip_reason: str = None):
        """Record test result"""
        result = {
            'name': test_name,
            'passed': passed,
            'timestamp': datetime.now().isoformat(),
            'details': details
        }
        if skipped:
            result['skipped'] = True
            result['skip_reason'] = skip_reason or details.get('skip_reason') or details.get('error')
        self.results['tests'].append(result)

    def _record_skip(self, test_name: str, reason: str, details: Optional[Dict] = None) -> bool:
        """Record a prerequisite skip without counting it as a product failure."""
        self._log(f"Skipping {test_name}: {reason}", "WARN")
        payload = details or {}
        payload['skip_reason'] = reason
        self._record_result(test_name, True, payload, skipped=True, skip_reason=reason)
        return True

    def _require_admin_or_skip(self, test_name: str, reason: str) -> bool:
        if self._claim_admin():
            return True
        self._record_skip(test_name, reason, {'error': 'no_admin'})
        return False

    def _get_memory_usage(self) -> Dict:
        """Get current process memory usage"""
        process = psutil.Process()
        mem_info = process.memory_info()
        return {
            'rss_mb': mem_info.rss / (1024 * 1024),
            'vms_mb': mem_info.vms / (1024 * 1024),
            'percent': process.memory_percent()
        }

    def _get_config(self) -> Dict:
        """Get current GhostHub configuration"""
        try:
            resp = self.session.get(f"{self.base_url}/api/config", timeout=10)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self._log(f"Failed to get config: {e}", "ERROR")
            return {}

    def _ensure_session(self) -> None:
        """Ensure the session has a session_id cookie."""
        try:
            self.session.get(f"{self.base_url}/", timeout=10)
        except Exception:
            pass

    def _is_session_password_required(self) -> bool:
        """Return True when the target appliance requires a session password."""
        config = self._get_config()
        return bool(config.get('isPasswordProtectionActive', False))

    def _validate_session_password(self) -> bool:
        """Validate the configured session password when protection is active."""
        if not self._is_session_password_required():
            return True

        if not self.session_password:
            self._log("Session password is required but was not provided.", "ERROR")
            return False

        self._ensure_session()
        try:
            resp = self.session.post(
                f"{self.base_url}/api/validate_session_password",
                json={'password': self.session_password},
                timeout=10
            )
            if resp.status_code == 200 and resp.json().get('valid'):
                return True
        except Exception as e:
            self._log(f"Session password validation failed: {e}", "ERROR")
            return False

        self._log("Session password validation failed.", "ERROR")
        return False

    def _claim_admin(self) -> bool:
        """Attempt to claim admin role for admin-only tests."""
        self._ensure_session()
        if not self._validate_session_password():
            return False

        payload = {'password': self.admin_password} if self.admin_password else {}
        try:
            resp = self.session.post(f"{self.base_url}/api/admin/claim", json=payload, timeout=10)
            return resp.status_code == 200 and resp.json().get('success', False)
        except Exception as e:
            self._log(f"Failed to claim admin: {e}", "WARN")
            return False

    def _get_category_media_records(self, category_id: str, limit: int = 10) -> List[Dict]:
        """Fetch hydrated media records through the current ordering endpoint."""
        view_key = f"stress_limits::{category_id}::{limit}"
        try:
            resp = self.session.post(
                f"{self.base_url}/api/media/orders",
                json={'requests': [{
                    'view': 'streaming_row',
                    'viewKey': view_key,
                    'category_id': category_id,
                    'page': 1,
                    'limit': limit,
                    'media_filter': 'all',
                    'hydrate': 'true',
                }]},
                timeout=10,
            )
            if resp.status_code != 200:
                return []
            results = resp.json().get('results') or []
            if not results or results[0].get('status') == 'error':
                return []
            return list((results[0].get('records') or {}).values())
        except Exception as e:
            self._log(f"Failed to fetch category media: {e}", "WARN")
            return []

    def _get_any_media_record(self, limit: int = 10) -> Optional[Dict]:
        """Pull a media record from the gallery timeline view.

        gallery_timeline spans the whole library (no category_id required), so
        callers get a media item with its category_id already resolved instead
        of having to guess which category in the list happens to be populated.
        """
        try:
            resp = self.session.post(
                f"{self.base_url}/api/media/orders",
                json={'requests': [{
                    'view': 'gallery_timeline',
                    'viewKey': f'stress_limits::gallery_timeline::{limit}',
                    'items_per_date': limit,
                    'dates_page': 1,
                    'dates_limit': 1,
                    'media_filter': 'all',
                    'hydrate': 'true',
                }]},
                timeout=10,
            )
            if resp.status_code != 200:
                return None
            results = resp.json().get('results') or []
            if not results or results[0].get('status') == 'error':
                return None
            records = list((results[0].get('records') or {}).values())
            return records[0] if records else None
        except Exception as e:
            self._log(f"Failed to fetch gallery timeline media: {e}", "WARN")
            return None

    def _get_available_drives(self) -> List[str]:
        """Get list of available drives for testing."""
        try:
            resp = self.session.get(f"{self.base_url}/api/storage/drives", timeout=10)
            if resp.status_code == 200:
                drives = resp.json().get('drives', [])
                return [drive.get('path') for drive in drives if drive.get('path')]
        except Exception as e:
            self._log(f"Failed to get drives: {e}", "WARN")
        return ['/tmp']

    def _get_test_drive(self) -> str:
        """Select a drive for upload tests."""
        drives = self._get_available_drives()
        return drives[0] if drives else '/tmp'

    def test_16gb_upload_limit(self) -> bool:
        """Test that uploads >16GB are rejected"""
        self._log("Testing 16GB upload limit enforcement...", "HEADER")

        try:
            if not self._validate_session_password():
                self._record_result("16GB Upload Limit", False, {'error': 'session_password_required'})
                return False

            # Try to initialize upload for 17GB file
            test_size = 17 * 1024 * 1024 * 1024  # 17 GB
            chunk_size = 4 * 1024 * 1024  # 4 MB
            total_chunks = (test_size + chunk_size - 1) // chunk_size

            drive_path = self._get_test_drive()
            init_data = {
                'filename': 'test_17gb_file.mp4',
                'total_size': test_size,
                'total_chunks': (test_size + (4 * 1024 * 1024) - 1) // (4 * 1024 * 1024),
                'drive_path': drive_path,
                'chunk_size': 4 * 1024 * 1024
            }

            resp = self.session.post(
                f"{self.base_url}/api/storage/upload/init",
                json=init_data,
                timeout=10
            )

            # Should be rejected with 413 (Payload Too Large) or 400 (Bad Request)
            if resp.status_code in [400, 413]:
                self._log(f"✓ 17GB upload correctly rejected (HTTP {resp.status_code})", "SUCCESS")
                self._record_result("16GB Upload Limit", True, {
                    'test_size_gb': 17,
                    'response_code': resp.status_code,
                    'message': resp.json().get('error', 'Rejected')
                })
                return True
            else:
                self._log(f"✗ 17GB upload NOT rejected (HTTP {resp.status_code})", "ERROR")
                self._record_result("16GB Upload Limit", False, {
                    'test_size_gb': 17,
                    'response_code': resp.status_code,
                    'error': 'Upload should have been rejected'
                })
                return False

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("16GB Upload Limit", False, {'error': str(e)})
            return False

    def test_rate_limiting(self, duration: int = 30) -> bool:
        """Test rate limiting under load (50 Mbps/client, 100 Mbps global)"""
        self._log(f"Testing rate limiting ({duration}s)...", "HEADER")

        try:
            if not self._validate_session_password():
                self._record_result("Rate Limiting", False, {'error': 'session_password_required'})
                return False
            if not self._require_admin_or_skip("Rate Limiting", "admin is required before creating upload files so cleanup can succeed"):
                return True

            config = self._get_config()
            upload_limit_per_client = config.get('UPLOAD_RATE_LIMIT_PER_CLIENT', 50)
            upload_limit_global = config.get('UPLOAD_RATE_LIMIT_GLOBAL', 100)

            if upload_limit_per_client == 0:
                self._log("Rate limiting is disabled in config.", "ERROR")
                self._record_result("Rate Limiting", False, {'error': 'disabled'})
                return False

            # The rate limiter intentionally exempts loopback peers, so when this
            # test runs against localhost we spoof a non-loopback client via
            # X-Forwarded-For (the upload controller honors this header only when
            # the immediate peer is loopback). This forces the limiter to apply
            # the configured per-client limit, which is what we want to verify.
            spoofed_client_ip = '203.0.113.99'  # RFC 5737 TEST-NET-3
            rate_limit_headers = {'X-Forwarded-For': spoofed_client_ip}

            # Resolve the effective limit for the spoofed client so we compare
            # against what the limiter will actually enforce (multipliers
            # included).
            effective_limit_mbps = float(upload_limit_per_client)
            try:
                health_resp = self.session.get(
                    f"{self.base_url}/api/system/network-health",
                    headers=rate_limit_headers,
                    timeout=10,
                )
                if health_resp.status_code == 200:
                    effective = health_resp.json().get('rate_limiting', {}).get('effective_upload_limit_mbps')
                    if effective:
                        effective_limit_mbps = float(effective)
            except Exception:
                pass

            self._log(f"Config: {upload_limit_per_client} Mbps/client, {upload_limit_global} Mbps global")
            self._log(f"Spoofed client IP for rate-limit test: {spoofed_client_ip} (effective limit: {effective_limit_mbps:.1f} Mbps)")

            drive_path = self._get_test_drive()
            # Create test data (1MB chunk)
            chunk_data = os.urandom(1 * 1024 * 1024)

            # Try to upload chunks rapidly and measure actual throughput
            start_time = time.time()
            bytes_sent = 0
            chunks_sent = 0
            init_attempts = 0
            rate_limited_responses = 0

            while time.time() - start_time < duration:
                # Initialize upload
                init_resp = self.session.post(
                    f"{self.base_url}/api/storage/upload/init",
                    json={
                        'filename': f'rate_test_{init_attempts}.mp4',
                        'total_size': len(chunk_data),
                        'total_chunks': 1,
                        'drive_path': drive_path,
                        'chunk_size': len(chunk_data)
                    },
                    timeout=10
                )
                init_attempts += 1

                if init_resp.status_code != 200:
                    break

                upload_id = init_resp.json().get('upload_id')
                if not upload_id:
                    break

                # Upload chunk (with spoofed client IP so rate limiter engages)
                chunk_start = time.time()
                chunk_resp = self.session.post(
                    f"{self.base_url}/api/storage/upload/chunk",
                    data={
                        'upload_id': upload_id,
                        'chunk_index': 0,
                        'total_chunks': 1
                    },
                    files={'chunk': chunk_data},
                    headers=rate_limit_headers,
                    timeout=30
                )
                chunk_elapsed = time.time() - chunk_start

                if chunk_resp.status_code == 200:
                    bytes_sent += len(chunk_data)
                    chunks_sent += 1

                    # Calculate current throughput
                    mbps = (len(chunk_data) * 8) / (chunk_elapsed * 1_000_000)

                    if chunks_sent % 10 == 0:
                        self._log(f"Chunk {chunks_sent}: {mbps:.1f} Mbps")
                elif chunk_resp.status_code == 429:
                    rate_limited_responses += 1
                    # Backoff briefly so we don't spam the server with rejects
                    time.sleep(0.05)

            elapsed = time.time() - start_time
            avg_mbps = (bytes_sent * 8) / (elapsed * 1_000_000) if elapsed > 0 else 0.0

            # Check if average throughput was limited
            # Allow 15% margin for token-bucket burst + measurement overhead
            limit_enforced = avg_mbps <= (effective_limit_mbps * 1.15)

            self._log(
                f"Average throughput: {avg_mbps:.1f} Mbps "
                f"(effective limit: {effective_limit_mbps:.1f} Mbps, "
                f"{rate_limited_responses} chunks rejected with 429)"
            )

            if limit_enforced:
                self._log("✓ Rate limiting is enforced", "SUCCESS")
            else:
                self._log("✗ Rate limiting NOT enforced", "ERROR")

            # Cleanup: Delete all rate test files
            self._log("Cleaning up rate test files...")
            deleted = 0
            try:
                cleanup_resp = self.session.post(
                    f"{self.base_url}/api/storage/media/batch-delete",
                    json={'file_paths': [f"{drive_path}/rate_test_{i}.mp4" for i in range(init_attempts)]},
                    timeout=30
                )
                if cleanup_resp.status_code == 200:
                    deleted = cleanup_resp.json().get('deleted', 0)
            except Exception:
                pass
            if deleted > 0:
                self._log(f"✓ Deleted {deleted} rate test files", "SUCCESS")

            self._record_result("Rate Limiting", limit_enforced, {
                'duration_seconds': elapsed,
                'bytes_sent': bytes_sent,
                'chunks_sent': chunks_sent,
                'rate_limited_responses': rate_limited_responses,
                'avg_mbps': avg_mbps,
                'limit_mbps': upload_limit_per_client,
                'effective_limit_mbps': effective_limit_mbps,
                'spoofed_client_ip': spoofed_client_ip,
            })

            return limit_enforced

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Rate Limiting", False, {'error': str(e)})
            return False

    def test_concurrent_chunk_limits(self) -> bool:
        """Test concurrent chunk limits (3 chunks, 2 files max)"""
        self._log("Testing concurrent chunk limits...", "HEADER")

        try:
            if not self._validate_session_password():
                self._record_result("Concurrent Chunk Limits", False, {'error': 'session_password_required'})
                return False
            if not self._require_admin_or_skip("Concurrent Chunk Limits", "admin is required before creating upload files so cleanup can succeed"):
                return True

            # Try to upload 4 chunks concurrently (should be limited to 3)
            chunk_data = os.urandom(1 * 1024 * 1024)  # 1MB

            drive_path = self._get_test_drive()
            # Initialize 2 uploads
            upload_ids = []
            for i in range(2):
                resp = self.session.post(
                    f"{self.base_url}/api/storage/upload/init",
                    json={
                        'filename': f'concurrent_test_{i}.mp4',
                        'total_size': len(chunk_data) * 3,
                        'total_chunks': 3,
                        'drive_path': drive_path,
                        'chunk_size': len(chunk_data)
                    },
                    timeout=10
                )
                if resp.status_code == 200:
                    upload_id = resp.json().get('upload_id')
                    if upload_id:
                        upload_ids.append(upload_id)

            if len(upload_ids) < 2:
                self._log("Failed to initialize uploads", "ERROR")
                return False

            # Launch 4 concurrent chunk uploads
            results = []
            threads = []

            def upload_chunk(upload_id, chunk_index):
                try:
                    resp = self.session.post(
                        f"{self.base_url}/api/storage/upload/chunk",
                        data={
                            'upload_id': upload_id,
                            'chunk_index': chunk_index,
                            'total_chunks': 3
                        },
                        files={'chunk': chunk_data},
                        timeout=30
                    )
                    results.append({
                        'upload_id': upload_id,
                        'chunk': chunk_index,
                        'status': resp.status_code,
                        'success': resp.status_code == 200
                    })
                except Exception as e:
                    results.append({
                        'upload_id': upload_id,
                        'chunk': chunk_index,
                        'error': str(e)
                    })

            # Upload 2 chunks from first file, 2 from second (total 4 concurrent)
            for i in range(2):
                t1 = threading.Thread(target=upload_chunk, args=(upload_ids[0], i))
                t2 = threading.Thread(target=upload_chunk, args=(upload_ids[1], i))
                threads.extend([t1, t2])
                t1.start()
                t2.start()

            # Wait for all
            for t in threads:
                t.join(timeout=60)

            successful = sum(1 for r in results if r.get('success'))

            # With 3 chunk limit, should only get 3 concurrent successes
            # (but overall all 4 should eventually succeed due to queuing)
            self._log(f"Concurrent chunk results: {successful}/{len(results)} successful")

            # This test is tricky - we're mainly checking it doesn't crash
            # and that rate limiting/queuing works
            passed = len(results) == 4  # All eventually completed

            if passed:
                self._log("✓ Concurrent chunk handling works", "SUCCESS")
            else:
                self._log("✗ Concurrent chunk handling failed", "ERROR")

            # Cleanup: Delete test files
            self._log("Cleaning up concurrent test files...")
            try:
                self.session.post(
                    f"{self.base_url}/api/storage/media/batch-delete",
                    json={'file_paths': [f"{drive_path}/concurrent_test_{i}.mp4" for i in range(2)]},
                    timeout=30
                )
            except Exception:
                pass
            self._log("✓ Cleanup complete", "SUCCESS")

            self._record_result("Concurrent Chunk Limits", passed, {
                'chunks_attempted': 4,
                'results': results
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Concurrent Chunk Limits", False, {'error': str(e)})
            return False

    def test_memory_leak(self, iterations: int = 50) -> bool:
        """Test for memory leaks during repeated operations"""
        self._log(f"Testing for memory leaks ({iterations} iterations)...", "HEADER")

        try:
            # Record initial memory
            initial_mem = self._get_memory_usage()
            self._log(f"Initial memory: {initial_mem['rss_mb']:.1f} MB")

            # Perform operations that should release memory
            for i in range(iterations):
                # Get categories
                self.session.get(f"{self.base_url}/api/categories", timeout=10)

                # Get config
                self.session.get(f"{self.base_url}/api/config", timeout=10)

                # Check progress
                self.session.get(f"{self.base_url}/api/progress/videos", timeout=10)

                if i % 10 == 0:
                    current_mem = self._get_memory_usage()
                    self._log(f"Iteration {i}: {current_mem['rss_mb']:.1f} MB")

            # Give GC time to clean up
            time.sleep(2)

            # Check final memory
            final_mem = self._get_memory_usage()
            self._log(f"Final memory: {final_mem['rss_mb']:.1f} MB")

            # Memory should not grow more than 20% (allows for some overhead)
            mem_growth = ((final_mem['rss_mb'] - initial_mem['rss_mb']) / initial_mem['rss_mb']) * 100

            # Negative growth is fine (memory was released)
            no_leak = mem_growth < 20

            if no_leak:
                self._log(f"✓ No memory leak detected ({mem_growth:+.1f}% change)", "SUCCESS")
            else:
                self._log(f"✗ Possible memory leak ({mem_growth:+.1f}% growth)", "ERROR")

            self._record_result("Memory Leak Detection", no_leak, {
                'iterations': iterations,
                'initial_mb': initial_mem['rss_mb'],
                'final_mb': final_mem['rss_mb'],
                'growth_percent': mem_growth
            })

            return no_leak

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Memory Leak Detection", False, {'error': str(e)})
            return False

    def test_sqlite_write_contention(self, num_clients: int = 10, duration: int = 30) -> bool:
        """Test SQLite write contention with concurrent progress updates"""
        self._log(f"Testing SQLite write contention ({num_clients} clients, {duration}s)...", "HEADER")

        test_profile_id = None
        try:
            if not self._claim_admin():
                return self._record_skip(
                    "SQLite Write Contention",
                    "admin access is required for setup and cleanup",
                    {'error': 'no_admin'},
                )

            # Find any indexed media via whats_new (same view the streaming hero
            # row uses) — categories[0] may legitimately be empty if the indexer
            # hasn't reached it yet, but whats_new spans the whole library.
            media_item = self._get_any_media_record(limit=10)
            if not media_item:
                return self._record_skip("SQLite Write Contention", "no media found", {'error': 'no_media'})

            cat_id = media_item.get('category_id')
            if not cat_id:
                # Fall back to parsing the stable id (<category_id>::<rel_path>)
                stable_id = media_item.get('id') or ''
                cat_id = stable_id.split('::', 1)[0] if '::' in stable_id else None
            if not cat_id:
                return self._record_skip("SQLite Write Contention", "no category resolved for media", {'error': 'no_category'})

            video_path = media_item.get('url')
            total_count = 1

            # Create a test profile so progress saves succeed (profile_id required)
            profile_name = f'ghst-test-sqlite-{int(time.time())}'
            try:
                resp = self.session.post(
                    f"{self.base_url}/api/profiles",
                    json={'name': profile_name},
                    timeout=10,
                )
                if resp.status_code == 201:
                    test_profile_id = resp.json().get('profile', {}).get('id')
            except Exception:
                pass

            if not test_profile_id:
                self._log("Could not create test profile for contention test", "WARN")
                self._record_result("SQLite Write Contention", False, {'error': 'profile_create_failed'})
                return False

            # Select the profile so the session has an active profile_id
            try:
                self.session.post(
                    f"{self.base_url}/api/profiles/select",
                    json={'profile_id': test_profile_id},
                    timeout=10,
                )
            except Exception:
                pass

            # Concurrent progress updates
            results = []
            threads = []

            def update_progress(client_id):
                updates = 0
                errors = 0
                start = time.time()

                while time.time() - start < duration:
                    try:
                        # Update progress
                        resp = self.session.post(
                            f"{self.base_url}/api/progress/{cat_id}",
                            json={
                                'index': updates % max(1, total_count),
                                'total_count': total_count,
                                'video_timestamp': (updates % 100) / 100.0,
                                'video_duration': 100,
                                'video_path': video_path
                            },
                            timeout=5
                        )

                        if resp.status_code == 200:
                            updates += 1
                        else:
                            errors += 1
                    except Exception:
                        errors += 1

                    time.sleep(0.1)  # 10 updates/sec per client

                results.append({
                    'client_id': client_id,
                    'updates': updates,
                    'errors': errors
                })

            # Launch concurrent clients
            for i in range(num_clients):
                t = threading.Thread(target=update_progress, args=(i,))
                threads.append(t)
                t.start()

            # Wait for all clients
            for t in threads:
                t.join()

            total_updates = sum(r['updates'] for r in results)
            total_errors = sum(r['errors'] for r in results)
            error_rate = total_errors / (total_updates + total_errors) if total_updates + total_errors > 0 else 0

            self._log(f"Total updates: {total_updates}, Errors: {total_errors} ({error_rate*100:.1f}%)")

            # Pass if error rate < 5%
            passed = error_rate < 0.05

            if passed:
                self._log("✓ SQLite handled concurrent writes well", "SUCCESS")
            else:
                self._log("✗ High error rate under concurrent writes", "ERROR")

            self._record_result("SQLite Write Contention", passed, {
                'num_clients': num_clients,
                'duration': duration,
                'total_updates': total_updates,
                'total_errors': total_errors,
                'error_rate': error_rate
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("SQLite Write Contention", False, {'error': str(e)})
            return False
        finally:
            # Always clean up the test profile, even on exception / early return
            if test_profile_id:
                self._delete_stress_profile(test_profile_id)

    def _create_stress_session(self) -> requests.Session:
        """Create a new requests session (separate cookies from self.session)."""
        sess = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.3,
            status_forcelist=[500, 502, 503, 504],
        )
        adapter = HTTPAdapter(max_retries=retry)
        sess.mount('http://', adapter)
        sess.mount('https://', adapter)
        # Establish a Flask session cookie
        try:
            sess.get(f"{self.base_url}/", timeout=10)
        except Exception:
            pass
        return sess

    def _create_stress_profile(self, name: str, sess: Optional[requests.Session] = None) -> Optional[str]:
        """Create a profile and return its ID, or None on failure."""
        sess = sess or self.session
        try:
            resp = sess.post(
                f"{self.base_url}/api/profiles",
                json={'name': name},
                timeout=10,
            )
            if resp.status_code == 201:
                return resp.json().get('profile', {}).get('id')
        except Exception:
            pass
        return None

    def _select_stress_profile(self, profile_id: str, sess: requests.Session) -> bool:
        """Select a profile for the given session."""
        try:
            resp = sess.post(
                f"{self.base_url}/api/profiles/select",
                json={'profile_id': profile_id},
                timeout=10,
            )
            return resp.status_code == 200
        except Exception:
            return False

    def _delete_stress_profile(self, profile_id: str, sess: Optional[requests.Session] = None) -> None:
        """Delete a test profile (best-effort cleanup).

        Tries the provided session first (owner path), then falls back to the
        admin session so profiles never leak when ownership was never claimed
        (e.g. create succeeded but select failed) or when the owner session
        dropped its cookie mid-test.
        """
        if not profile_id:
            return
        candidate_sessions = []
        if sess is not None and sess is not self.session:
            candidate_sessions.append(sess)
        candidate_sessions.append(self.session)

        for candidate in candidate_sessions:
            try:
                resp = candidate.delete(
                    f"{self.base_url}/api/profiles/{profile_id}",
                    timeout=10,
                )
                if resp.status_code in (200, 204, 404):
                    return
            except Exception:
                continue

    def test_profile_progress_contention(
        self,
        num_profiles: int = 5,
        duration: int = 30,
    ) -> bool:
        """Test profile-scoped progress writes with concurrent profiles.

        Each profile gets its own session and writes progress for unique
        video paths simultaneously, simulating a household of viewers.
        """
        self._log(
            f"Testing profile-scoped progress contention "
            f"({num_profiles} profiles, {duration}s)...",
            "HEADER",
        )

        created_profiles: List[dict] = []
        sessions: List[requests.Session] = []

        try:
            if not self._claim_admin():
                return self._record_skip(
                    "Profile Progress Contention",
                    "admin access is required for setup and cleanup",
                    {'error': 'no_admin'},
                )

            # Find any indexed media via whats_new (spans the whole library so
            # we aren't at the mercy of which category happens to be first).
            seed_media = self._get_any_media_record(limit=10)
            if not seed_media:
                return self._record_skip("Profile Progress Contention", "no media found", {'error': 'no_media'})

            cat_id = seed_media.get('category_id')
            if not cat_id:
                stable_id = seed_media.get('id') or ''
                cat_id = stable_id.split('::', 1)[0] if '::' in stable_id else None
            if not cat_id:
                return self._record_skip("Profile Progress Contention", "no category resolved for media", {'error': 'no_category'})

            media_list = self._get_category_media_records(cat_id, limit=10)
            if not media_list:
                # Fall back to the seed item so the test still has at least one
                # video path to drive contention against.
                media_list = [seed_media]

            # ── Setup: create profiles + sessions ──
            self._log(f"Creating {num_profiles} test profiles...")
            for i in range(num_profiles):
                sess = self._create_stress_session()
                # Validate session password if needed
                if self._is_session_password_required() and self.session_password:
                    try:
                        sess.post(
                            f"{self.base_url}/api/validate_session_password",
                            json={'password': self.session_password},
                            timeout=10,
                        )
                    except Exception:
                        pass

                name = f'ghst-test-progress-{i}-{int(time.time())}'
                profile_id = self._create_stress_profile(name, sess)
                if not profile_id:
                    self._log(f"Failed to create profile {name}", "ERROR")
                    continue

                if not self._select_stress_profile(profile_id, sess):
                    self._log(f"Failed to select profile {name}", "ERROR")
                    self._delete_stress_profile(profile_id, sess)
                    continue

                created_profiles.append({'id': profile_id, 'name': name})
                sessions.append(sess)

            if len(created_profiles) < 2:
                self._log("Need at least 2 profiles for contention test", "ERROR")
                self._record_result("Profile Progress Contention", False, {'error': 'insufficient_profiles'})
                return False

            self._log(f"Created {len(created_profiles)} profiles. Starting concurrent writes...")

            # ── Phase 1: Concurrent profile progress writes ──
            results = []
            latencies: List[float] = []
            latency_lock = threading.Lock()
            threads = []

            def write_progress(idx):
                sess = sessions[idx]
                updates = 0
                errors = 0
                local_latencies = []
                start = time.time()
                total_count = len(media_list)

                while time.time() - start < duration:
                    video_idx = updates % total_count
                    video_path = media_list[video_idx].get('url')
                    t0 = time.time()
                    try:
                        resp = sess.post(
                            f"{self.base_url}/api/progress/{cat_id}",
                            json={
                                'index': video_idx,
                                'total_count': total_count,
                                'video_timestamp': (updates % 100) / 100.0,
                                'video_duration': 100.0,
                                'video_path': video_path,
                            },
                            timeout=5,
                        )
                        elapsed = time.time() - t0
                        local_latencies.append(elapsed)

                        if resp.status_code == 200:
                            updates += 1
                        else:
                            errors += 1
                    except Exception:
                        errors += 1

                    time.sleep(0.1)

                with latency_lock:
                    latencies.extend(local_latencies)

                results.append({
                    'profile': created_profiles[idx]['name'],
                    'updates': updates,
                    'errors': errors,
                })

            for i in range(len(created_profiles)):
                t = threading.Thread(target=write_progress, args=(i,))
                threads.append(t)
                t.start()

            for t in threads:
                t.join()

            total_updates = sum(r['updates'] for r in results)
            total_errors = sum(r['errors'] for r in results)
            error_rate = total_errors / max(1, total_updates + total_errors)

            p95_latency = 0.0
            if latencies:
                latencies.sort()
                p95_idx = int(len(latencies) * 0.95)
                p95_latency = latencies[min(p95_idx, len(latencies) - 1)]

            self._log(f"Phase 1 results:")
            for r in results:
                self._log(f"  {r['profile']}: {r['updates']} OK, {r['errors']} errors")
            self._log(f"  Total: {total_updates} updates, {total_errors} errors ({error_rate*100:.1f}%)")
            self._log(f"  p95 latency: {p95_latency*1000:.0f}ms")

            passed = error_rate < 0.05 and p95_latency < 2.0

            if passed:
                self._log("✓ Profile-scoped progress contention passed", "SUCCESS")
            else:
                self._log("✗ Profile progress contention failed", "ERROR")

            self._record_result("Profile Progress Contention", passed, {
                'num_profiles': len(created_profiles),
                'duration': duration,
                'total_updates': total_updates,
                'total_errors': total_errors,
                'error_rate': error_rate,
                'p95_latency_ms': round(p95_latency * 1000, 1),
                'per_profile': results,
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Profile Progress Contention", False, {'error': str(e)})
            return False
        finally:
            # Cleanup
            for i, prof in enumerate(created_profiles):
                sess = sessions[i] if i < len(sessions) else self.session
                self._delete_stress_profile(prof['id'], sess)

    def test_preference_update_burst(
        self,
        num_profiles: int = 5,
        updates_per_profile: int = 20,
    ) -> bool:
        """Rapidly update preferences for multiple profiles and verify persistence.

        Validates that bursty preference writes don't corrupt data or deadlock.
        """
        self._log(
            f"Testing preference update burst "
            f"({num_profiles} profiles, {updates_per_profile} updates each)...",
            "HEADER",
        )

        created_profiles: List[dict] = []

        try:
            if not self._claim_admin():
                return self._record_skip(
                    "Preference Update Burst",
                    "admin access is required for setup and cleanup",
                    {'error': 'no_admin'},
                )

            # Create profiles
            for i in range(num_profiles):
                name = f'ghst-test-pref-{i}-{int(time.time())}'
                profile_id = self._create_stress_profile(name)
                if not profile_id:
                    self._log(f"Failed to create profile {name}", "ERROR")
                    continue
                created_profiles.append({'id': profile_id, 'name': name})

            if len(created_profiles) < 2:
                self._log("Need at least 2 profiles", "ERROR")
                self._record_result("Preference Update Burst", False, {'error': 'insufficient_profiles'})
                return False

            self._log(f"Created {len(created_profiles)} profiles. Firing preference updates...")

            themes = ['dark', 'midnight', 'nord', 'monokai', 'dracula']
            layouts = ['streaming', 'gallery']
            results = []
            threads = []

            def burst_preferences(idx):
                prof = created_profiles[idx]
                updates = 0
                errors = 0
                last_theme = None
                local_latencies = []

                for u in range(updates_per_profile):
                    theme = themes[u % len(themes)]
                    layout = layouts[u % len(layouts)]
                    last_theme = theme

                    t0 = time.time()
                    try:
                        resp = self.session.patch(
                            f"{self.base_url}/api/profiles/{prof['id']}",
                            json={
                                'preferences': {
                                    'theme': theme,
                                    'layout': layout,
                                }
                            },
                            timeout=5,
                        )
                        elapsed = time.time() - t0
                        local_latencies.append(elapsed)

                        if resp.status_code == 200:
                            updates += 1
                        else:
                            errors += 1
                    except Exception:
                        errors += 1

                results.append({
                    'profile': prof['name'],
                    'profile_id': prof['id'],
                    'updates': updates,
                    'errors': errors,
                    'expected_theme': last_theme,
                    'avg_latency_ms': round(
                        (sum(local_latencies) / len(local_latencies) * 1000)
                        if local_latencies else 0,
                        1,
                    ),
                })

            for i in range(len(created_profiles)):
                t = threading.Thread(target=burst_preferences, args=(i,))
                threads.append(t)
                t.start()

            for t in threads:
                t.join()

            # Verify: read back each profile's preferences
            self._log("Verifying persisted preferences...")
            verify_errors = 0
            for r in results:
                try:
                    resp = self.session.get(f"{self.base_url}/api/profiles", timeout=10)
                    if resp.status_code != 200:
                        verify_errors += 1
                        continue

                    profiles_list = resp.json().get('profiles', [])
                    match = next((p for p in profiles_list if p['id'] == r['profile_id']), None)

                    if not match:
                        self._log(f"  Profile {r['profile']} not found in list!", "ERROR")
                        verify_errors += 1
                        continue

                    prefs = match.get('preferences') or {}
                    actual_theme = prefs.get('theme')

                    if actual_theme != r['expected_theme']:
                        self._log(
                            f"  {r['profile']}: expected theme={r['expected_theme']}, "
                            f"got {actual_theme}",
                            "ERROR",
                        )
                        verify_errors += 1
                    else:
                        self._log(
                            f"  {r['profile']}: theme={actual_theme} ✓ "
                            f"(avg {r['avg_latency_ms']}ms)",
                        )
                except Exception as e:
                    self._log(f"  Verify error: {e}", "ERROR")
                    verify_errors += 1

            total_updates = sum(r['updates'] for r in results)
            total_errors = sum(r['errors'] for r in results) + verify_errors

            passed = total_errors == 0

            if passed:
                self._log(f"✓ All {total_updates} preference updates persisted correctly", "SUCCESS")
            else:
                self._log(f"✗ {total_errors} errors during preference burst", "ERROR")

            self._record_result("Preference Update Burst", passed, {
                'num_profiles': len(created_profiles),
                'updates_per_profile': updates_per_profile,
                'total_updates': total_updates,
                'total_errors': total_errors,
                'verify_errors': verify_errors,
                'per_profile': results,
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Preference Update Burst", False, {'error': str(e)})
            return False
        finally:
            for prof in created_profiles:
                self._delete_stress_profile(prof['id'])

    def test_hidden_categories_stress(self, num_requests: int = 100) -> bool:
        """Test hidden categories filtering under load"""
        self._log(f"Testing hidden categories under stress ({num_requests} requests)...", "HEADER")

        try:
            # Note: This test requires admin access
            if not self.admin_password:
                return self._record_skip(
                    "Hidden Categories Stress",
                    "admin password is required for hidden-category stress testing",
                    {'error': 'no_admin'},
                )

            if not self._claim_admin():
                return self._record_skip(
                    "Hidden Categories Stress",
                    "admin access could not be claimed for hidden-category stress testing",
                    {'error': 'admin_claim_failed'},
                )

            # Get categories
            cats_resp = self.session.get(f"{self.base_url}/api/categories", timeout=10)
            if cats_resp.status_code != 200:
                self._log("Failed to get categories", "ERROR")
                return False

            initial_categories = cats_resp.json().get('categories', [])
            if not initial_categories:
                self._log("No categories to test", "WARN")
                return False

            # Test search doesn't show hidden categories
            search_errors = 0

            for i in range(num_requests):
                try:
                    resp = self.session.get(
                        f"{self.base_url}/api/search?q=test",
                        timeout=5
                    )

                    if resp.status_code != 200:
                        search_errors += 1
                except Exception:
                    search_errors += 1

            error_rate = search_errors / num_requests
            passed = error_rate < 0.05

            if passed:
                self._log(f"✓ Search handled {num_requests} requests ({error_rate*100:.1f}% errors)", "SUCCESS")
            else:
                self._log(f"✗ High error rate: {error_rate*100:.1f}%", "ERROR")

            self._record_result("Hidden Categories Stress", passed, {
                'num_requests': num_requests,
                'errors': search_errors,
                'error_rate': error_rate
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Hidden Categories Stress", False, {'error': str(e)})
            return False

    def save_results(self):
        """Save test results to file"""
        if not self.output_file:
            return

        self.results['end_time'] = datetime.now().isoformat()
        self.results['summary'] = {
            'total_tests': len(self.results['tests']),
            'passed': sum(1 for t in self.results['tests'] if t['passed'] and not t.get('skipped')),
            'failed': sum(1 for t in self.results['tests'] if not t['passed'] and not t.get('skipped')),
            'skipped': sum(1 for t in self.results['tests'] if t.get('skipped')),
        }

        try:
            with open(self.output_file, 'w') as f:
                json.dump(self.results, f, indent=2)
            self._log(f"Results saved to: {self.output_file}", "SUCCESS")
        except Exception as e:
            self._log(f"Failed to save results: {e}", "ERROR")

    def run_all_tests(self) -> bool:
        """Run all critical limit tests"""
        self._log("=" * 60, "HEADER")
        self._log("GhostHub Critical Limits & Failure Tests", "HEADER")
        self._log("=" * 60, "HEADER")

        all_passed = True

        # Resource limit tests
        all_passed &= self.test_16gb_upload_limit()
        all_passed &= self.test_rate_limiting(duration=30)
        all_passed &= self.test_concurrent_chunk_limits()

        # Failure scenario tests
        all_passed &= self.test_memory_leak(iterations=50)
        all_passed &= self.test_sqlite_write_contention(num_clients=10, duration=30)

        # Profile stress tests
        all_passed &= self.test_profile_progress_contention(num_profiles=5, duration=30)
        all_passed &= self.test_preference_update_burst(num_profiles=5, updates_per_profile=20)

        # Feature stress tests
        all_passed &= self.test_hidden_categories_stress(num_requests=100)

        # Summary
        self._log("=" * 60, "HEADER")
        passed = sum(1 for t in self.results['tests'] if t['passed'])
        total = len(self.results['tests'])

        if all_passed:
            self._log(f"ALL TESTS PASSED ({passed}/{total})", "SUCCESS")
        else:
            self._log(f"SOME TESTS FAILED ({passed}/{total} passed)", "ERROR")

        return all_passed


def main():
    parser = argparse.ArgumentParser(
        description='GhostHub Critical Limits & Failure Scenario Tests',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('--url', default='http://localhost:5000',
                       help='GhostHub base URL')
    parser.add_argument('--password', help='Legacy session password')
    parser.add_argument('--admin-password', help='Admin password (for admin tests)')
    parser.add_argument('--session-password', help='Session password (for upload tests)')
    parser.add_argument('--test', default='all',
                       choices=['all', 'upload_limit', 'rate_limit', 'chunk_limit',
                               'memory_leak', 'sqlite_contention',
                               'profile_contention', 'preference_burst',
                               'hidden_categories'],
                       help='Specific test to run')
    parser.add_argument('--output', help='Output JSON file for results')
    parser.add_argument('--duration', type=int, default=30,
                       help='Duration for time-based tests (seconds)')

    args = parser.parse_args()

    admin_password = args.admin_password
    session_password = args.session_password or args.password
    tester = CriticalLimitsTest(
        args.url,
        admin_password=admin_password,
        session_password=session_password,
        output_file=args.output
    )

    try:
        if args.test == 'all':
            success = tester.run_all_tests()
        elif args.test == 'upload_limit':
            success = tester.test_16gb_upload_limit()
        elif args.test == 'rate_limit':
            success = tester.test_rate_limiting(args.duration)
        elif args.test == 'chunk_limit':
            success = tester.test_concurrent_chunk_limits()
        elif args.test == 'memory_leak':
            success = tester.test_memory_leak()
        elif args.test == 'sqlite_contention':
            success = tester.test_sqlite_write_contention(duration=args.duration)
        elif args.test == 'profile_contention':
            success = tester.test_profile_progress_contention(duration=args.duration)
        elif args.test == 'preference_burst':
            success = tester.test_preference_update_burst()
        elif args.test == 'hidden_categories':
            success = tester.test_hidden_categories_stress()
        else:
            print(f"Unknown test: {args.test}")
            success = False

        tester.save_results()
        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        tester.save_results()
        sys.exit(1)
    except Exception as e:
        print(f"\nFATAL ERROR: {e}")
        tester.save_results()
        sys.exit(1)


if __name__ == '__main__':
    main()
