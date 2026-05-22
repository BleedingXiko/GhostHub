#!/usr/bin/env python3
"""
GhostHub Network Drop Recovery Test
====================================
Simulates network failures and tests recovery mechanisms.

Tests:
- Mid-upload disconnects (chunk upload interrupted)
- WebSocket reconnection after drop
- Resume upload after network recovery
- Partial chunk retry logic

Usage:
    python3 network_drop_recovery_test.py --url http://localhost:5000
    python3 network_drop_recovery_test.py --url http://localhost:5000 --test upload_drop
    python3 network_drop_recovery_test.py --url http://localhost:5000 --drops 5
"""

import os
import sys
import argparse
import time
import json
import socket
import threading
from datetime import datetime
from typing import Dict, Optional

try:
    import requests
except ImportError:
    print("ERROR: Missing dependency 'requests'")
    print("Install: pip3 install requests")
    sys.exit(1)

try:
    import socketio
    HAS_SOCKETIO = True
except ImportError:
    HAS_SOCKETIO = False


class Colors:
    """ANSI color codes"""
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'


class NetworkDropTest:
    """Test network failure recovery"""

    def __init__(
        self,
        base_url: str,
        session_password: Optional[str] = None,
        admin_password: Optional[str] = None,
        output_file: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip('/')
        self.session_password = session_password
        self.admin_password = admin_password
        self.session = requests.Session()
        self.output_file = output_file
        self.results = {
            'start_time': datetime.now().isoformat(),
            'base_url': base_url,
            'tests': []
        }

    def _log(self, message: str, level: str = "INFO"):
        """Log with colors"""
        timestamp = datetime.now().strftime("%H:%M:%S")

        if level == "SUCCESS":
            prefix = f"{Colors.GREEN}✓{Colors.END}"
        elif level == "ERROR":
            prefix = f"{Colors.RED}✗{Colors.END}"
        elif level == "WARN":
            prefix = f"{Colors.YELLOW}⚠{Colors.END}"
        else:
            prefix = f"{Colors.CYAN}ℹ{Colors.END}"

        print(f"[{timestamp}] {prefix} {message}")

    def _record_result(self, test_name: str, passed: bool, details: Dict, skipped: bool = False):
        """Record test result"""
        result = {
            'name': test_name,
            'passed': passed,
            'timestamp': datetime.now().isoformat(),
            'details': details
        }
        if skipped:
            result['skipped'] = True
            result['skip_reason'] = details.get('skip_reason') or details.get('error')
        self.results['tests'].append(result)

    def _record_skip(self, test_name: str, reason: str) -> bool:
        self._log(f"Skipping {test_name}: {reason}", "WARN")
        self._record_result(test_name, True, {'skip_reason': reason}, skipped=True)
        return True

    def _ensure_session(self) -> None:
        """Ensure session cookie is set."""
        try:
            self.session.get(f"{self.base_url}/", timeout=10)
        except Exception:
            pass

    def _is_session_password_required(self) -> bool:
        """Return True when the target appliance requires a session password."""
        try:
            resp = self.session.get(f"{self.base_url}/api/config", timeout=10)
            if resp.status_code == 200:
                return bool(resp.json().get('isPasswordProtectionActive', False))
        except Exception as e:
            self._log(f"Failed to determine password protection status: {e}", "ERROR")
        return bool(self.session_password)

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
        self._ensure_session()
        if not self._validate_session_password():
            return False
        payload = {'password': self.admin_password} if self.admin_password else {}
        try:
            resp = self.session.post(f"{self.base_url}/api/admin/claim", json=payload, timeout=10)
            return resp.status_code == 200 and resp.json().get('success', False)
        except Exception:
            return False

    def _get_test_drive(self) -> str:
        """Get a valid drive path for upload tests."""
        try:
            resp = self.session.get(f"{self.base_url}/api/storage/drives", timeout=10)
            if resp.status_code == 200:
                drives = resp.json().get('drives', [])
                for drive in drives:
                    path = drive.get('path')
                    if path:
                        return path
        except Exception as e:
            self._log(f"Failed to get drives: {e}", "WARN")
        return '/tmp'

    def test_upload_resume_after_drop(self, num_drops: int = 3) -> bool:
        """Test upload resume after simulated network drops"""
        self._log(f"Testing upload resume after {num_drops} simulated drops...", "HEADER")

        try:
            if not self._validate_session_password():
                self._record_result("Upload Resume After Drop", False, {'error': 'session_password_required'})
                return False
            if not self._claim_admin():
                return self._record_skip(
                    "Upload Resume After Drop",
                    "admin is required before uploads so cleanup can succeed",
                )

            # Create test data - 10MB file split into 10 chunks
            chunk_size = 1 * 1024 * 1024  # 1MB chunks
            total_size = 10 * chunk_size
            total_chunks = 10
            drive_path = self._get_test_drive()

            # Initialize upload
            init_resp = self.session.post(
                f"{self.base_url}/api/storage/upload/init",
                json={
                    'filename': 'network_drop_test.mp4',
                    'total_size': total_size,
                    'total_chunks': total_chunks,
                    'drive_path': drive_path,
                    'chunk_size': chunk_size
                },
                timeout=10
            )

            if init_resp.status_code != 200:
                self._log(f"Failed to initialize upload: {init_resp.status_code}", "ERROR")
                return False

            upload_id = init_resp.json().get('upload_id')
            self._log(f"Upload initialized: {upload_id}")

            # Upload chunks with simulated drops
            drops_triggered = 0
            successful_chunks = 0

            for chunk_idx in range(total_chunks):
                chunk_data = os.urandom(chunk_size)

                # Simulate drop on specific chunks
                if drops_triggered < num_drops and chunk_idx % 3 == 2:
                    self._log(f"Simulating network drop at chunk {chunk_idx}...", "WARN")

                    # Attempt upload with very short timeout (will fail)
                    try:
                        self.session.post(
                            f"{self.base_url}/api/storage/upload/chunk",
                            data={
                                'upload_id': upload_id,
                                'chunk_index': chunk_idx,
                                'total_chunks': total_chunks
                            },
                            files={'chunk': chunk_data},
                            timeout=0.01  # Extremely short timeout
                        )
                    except requests.exceptions.Timeout:
                        self._log("Connection dropped (timeout)", "WARN")
                        drops_triggered += 1

                    # Wait a bit for "network recovery"
                    time.sleep(2)

                # Retry the chunk (simulating recovery)
                retry_attempts = 0
                max_retries = 3

                while retry_attempts < max_retries:
                    try:
                        chunk_resp = self.session.post(
                            f"{self.base_url}/api/storage/upload/chunk",
                            data={
                                'upload_id': upload_id,
                                'chunk_index': chunk_idx,
                                'total_chunks': total_chunks
                            },
                            files={'chunk': chunk_data},
                            timeout=30
                        )

                        if chunk_resp.status_code == 200:
                            successful_chunks += 1
                            self._log(f"Chunk {chunk_idx+1}/{total_chunks} uploaded")
                            break
                        else:
                            retry_attempts += 1
                            self._log(f"Retry {retry_attempts}/{max_retries}", "WARN")
                            time.sleep(1)

                    except Exception as e:
                        retry_attempts += 1
                        self._log(f"Retry {retry_attempts}/{max_retries}: {e}", "WARN")
                        time.sleep(1)

                if retry_attempts >= max_retries:
                    self._log(f"Failed to upload chunk {chunk_idx} after retries", "ERROR")
                    break

            # Check final status
            passed = successful_chunks == total_chunks

            if passed:
                self._log(f"✓ All {total_chunks} chunks uploaded ({drops_triggered} drops simulated)", "SUCCESS")
            else:
                self._log(f"✗ Only {successful_chunks}/{total_chunks} chunks uploaded", "ERROR")

            # Cleanup: Delete test file
            self._log("Cleaning up network drop test file...")
            try:
                file_path = f"{drive_path}/network_drop_test.mp4"
                cleanup_resp = self.session.post(
                    f"{self.base_url}/api/storage/media/batch-delete",
                    json={'file_paths': [file_path]},
                    timeout=10
                )
                if cleanup_resp.status_code == 200:
                    self._log("✓ Deleted test file", "SUCCESS")
            except:
                pass

            self._record_result("Upload Resume After Drop", passed, {
                'total_chunks': total_chunks,
                'successful_chunks': successful_chunks,
                'drops_simulated': drops_triggered
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("Upload Resume After Drop", False, {'error': str(e)})
            return False

    def test_websocket_reconnection(self, num_reconnects: int = 5) -> bool:
        """Test WebSocket reconnection after drops"""
        self._log(f"Testing WebSocket reconnection ({num_reconnects} drops)...", "HEADER")

        if not HAS_SOCKETIO:
            self._log("python-socketio is required for WebSocket reconnection testing.", "ERROR")
            self._record_result("WebSocket Reconnection", False, {'error': 'no_socketio'})
            return False

        try:
            reconnects = 0
            disconnects = 0
            messages_received = 0

            sio = socketio.Client(reconnection=True, reconnection_attempts=10)

            @sio.on('connect')
            def on_connect():
                nonlocal reconnects
                reconnects += 1
                self._log(f"Connected (reconnect #{reconnects})")

            @sio.on('disconnect')
            def on_disconnect():
                nonlocal disconnects
                disconnects += 1
                self._log(f"Disconnected (#{disconnects})", "WARN")

            @sio.on('chat_message')
            def on_message(data):
                nonlocal messages_received
                messages_received += 1

            # Connect
            sio.connect(self.base_url, transports=['websocket'])
            time.sleep(1)

            # Simulate disconnects and reconnects
            for i in range(num_reconnects):
                # Force disconnect
                sio.disconnect()
                self._log(f"Forced disconnect {i+1}/{num_reconnects}", "WARN")

                time.sleep(2)

                # Reconnect
                try:
                    sio.connect(self.base_url, transports=['websocket'])
                    time.sleep(1)
                    self._log(f"Reconnected {i+1}/{num_reconnects}", "SUCCESS")
                except Exception as e:
                    self._log(f"Failed to reconnect: {e}", "ERROR")

            # Final cleanup
            sio.disconnect()

            # Check if reconnections worked
            # We should have at least num_reconnects successful reconnections
            passed = reconnects >= num_reconnects

            if passed:
                self._log(f"✓ {reconnects} successful reconnections", "SUCCESS")
            else:
                self._log(f"✗ Only {reconnects}/{num_reconnects} reconnections", "ERROR")

            self._record_result("WebSocket Reconnection", passed, {
                'num_reconnects_attempted': num_reconnects,
                'successful_reconnects': reconnects,
                'disconnects': disconnects
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("WebSocket Reconnection", False, {'error': str(e)})
            return False

    def test_api_resilience(self, num_failures: int = 10) -> bool:
        """Test API resilience to intermittent failures"""
        self._log(f"Testing API resilience ({num_failures} simulated failures)...", "HEADER")

        try:
            successful_requests = 0
            failed_requests = 0
            total_requests = num_failures * 2

            for i in range(total_requests):
                # Simulate intermittent failures with very short timeouts
                timeout = 0.1 if i % 2 == 0 else 10  # Every other request has aggressive timeout

                try:
                    resp = self.session.get(
                        f"{self.base_url}/api/config",
                        timeout=timeout
                    )

                    if resp.status_code == 200:
                        successful_requests += 1
                    else:
                        failed_requests += 1

                except requests.exceptions.Timeout:
                    failed_requests += 1
                    self._log(f"Request {i+1} timeout (expected)", "WARN")
                except Exception as e:
                    failed_requests += 1

                time.sleep(0.1)

            # At least half should succeed (the ones with normal timeout)
            passed = successful_requests >= (total_requests // 2)

            if passed:
                self._log(f"✓ {successful_requests}/{total_requests} requests succeeded", "SUCCESS")
            else:
                self._log(f"✗ Only {successful_requests}/{total_requests} succeeded", "ERROR")

            self._record_result("API Resilience", passed, {
                'total_requests': total_requests,
                'successful': successful_requests,
                'failed': failed_requests
            })

            return passed

        except Exception as e:
            self._log(f"Test error: {e}", "ERROR")
            self._record_result("API Resilience", False, {'error': str(e)})
            return False

    def save_results(self):
        """Save results to file"""
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

    def run_all_tests(self, num_drops: int = 3) -> bool:
        """Run all network drop recovery tests"""
        self._log("=" * 60, "HEADER")
        self._log("GhostHub Network Drop Recovery Tests", "HEADER")
        self._log("=" * 60, "HEADER")

        all_passed = True

        all_passed &= self.test_upload_resume_after_drop(num_drops)
        all_passed &= self.test_websocket_reconnection(num_drops)
        all_passed &= self.test_api_resilience(num_drops * 2)

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
        description='GhostHub Network Drop Recovery Tests'
    )

    parser.add_argument('--url', default='http://localhost:5000',
                       help='GhostHub base URL')
    parser.add_argument('--test', default='all',
                       choices=['all', 'upload_drop', 'websocket', 'api_resilience'],
                       help='Specific test to run')
    parser.add_argument('--drops', type=int, default=3,
                       help='Number of drops to simulate')
    parser.add_argument('--session-password', help='Session password if required')
    parser.add_argument('--admin-password', help='Admin password for upload cleanup')
    parser.add_argument('--output', help='Output JSON file for results')

    args = parser.parse_args()

    tester = NetworkDropTest(args.url, args.session_password, args.admin_password, args.output)

    try:
        if args.test == 'all':
            success = tester.run_all_tests(args.drops)
        elif args.test == 'upload_drop':
            success = tester.test_upload_resume_after_drop(args.drops)
        elif args.test == 'websocket':
            success = tester.test_websocket_reconnection(args.drops)
        elif args.test == 'api_resilience':
            success = tester.test_api_resilience(args.drops * 2)
        else:
            print(f"Unknown test: {args.test}")
            success = False

        tester.save_results()
        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        tester.save_results()
        sys.exit(1)


if __name__ == '__main__':
    main()
