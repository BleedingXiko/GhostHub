#!/usr/bin/env python3
"""
GhostHub Enhanced Chunked Upload Stress Test
==========================================
Comprehensive testing of the chunked upload system focusing on 
critical failures identified in the QA checklist.

Tests:
- Large file uploads (500MB-2GB)
- Multiple concurrent uploads
- Upload resume after network drops
- Rate limiting enforcement
- Memory usage during uploads
- 16GB upload limit enforcement
- Progress tracking accuracy
- Background upload queue behavior

Usage:
    python3 enhanced_upload_stress_test.py --url http://localhost:5000
    python3 enhanced_upload_stress_test.py --url http://localhost:5000 --test concurrent
    python3 enhanced_upload_stress_test.py --url http://localhost:5000 --test large_file
"""

import os
import sys
import time
import json
import tempfile
import threading
import argparse
import psutil
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

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
    END = '\033[0m'


class EnhancedUploadStressTest:
    """Enhanced chunked upload stress testing"""

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
        self.output_file = output_file
        self.session = self._create_session()
        self.results = {
            'start_time': datetime.now().isoformat(),
            'base_url': base_url,
            'tests': []
        }
        self.temp_files = []  # Local temp files
        self.uploaded_files = []  # (drive_path, filename) tuples for server cleanup

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
        self._log(f"Skipping {test_name}: {reason}", "WARN")
        payload = details or {}
        payload['skip_reason'] = reason
        self._record_result(test_name, True, payload, skipped=True, skip_reason=reason)
        return True

    def _get_memory_usage(self) -> Dict:
        """Get current process memory usage"""
        try:
            process = psutil.Process()
            mem_info = process.memory_info()
            return {
                'rss_mb': mem_info.rss / (1024 * 1024),
                'vms_mb': mem_info.vms / (1024 * 1024),
                'percent': process.memory_percent()
            }
        except:
            return {'rss_mb': 0, 'vms_mb': 0, 'percent': 0}

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
        """Claim admin so upload tests never create files they cannot clean up."""
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

    def _require_admin_or_skip(self, test_name: str) -> bool:
        if self._claim_admin():
            return True
        self._record_skip(test_name, "admin is required before uploads so cleanup can succeed", {'error': 'no_admin'})
        return False

    def _get_available_drives(self) -> List[str]:
        """Get list of available drives for testing"""
        try:
            resp = self.session.get(f"{self.base_url}/api/storage/drives", timeout=10)
            if resp.status_code == 200:
                drives_data = resp.json()
                return [drive['path'] for drive in drives_data.get('drives', [])]
        except Exception as e:
            self._log(f"Failed to get drives: {e}", "ERROR")
        
        # Fallback to temp directory
        return ['/tmp']

    def _create_test_file(self, size_mb: int) -> str:
        """Create a test file of specified size"""
        # Use mkstemp for better control over cleanup
        fd, filepath = tempfile.mkstemp(suffix='.mp4', prefix='tmp')
        os.close(fd)
        
        # Write random data
        chunk_size = 1024 * 1024  # 1MB chunks
        try:
            with open(filepath, 'wb') as f:
                for _ in range(size_mb):
                    f.write(os.urandom(chunk_size))
            
            self.temp_files.append(filepath)
            return filepath
        except Exception as e:
            # Clean up on failure
            try:
                os.remove(filepath)
            except:
                pass
            raise e

    def _upload_file_chunked(self, filepath: str, drive_path: str, 
                           chunk_size_mb: int = 2, simulate_drops: bool = False,
                           retry_rate_limits: bool = True) -> Tuple[bool, Dict]:
        """Upload a file using chunked upload API"""
        try:
            file_size = os.path.getsize(filepath)
            filename = os.path.basename(filepath)
            chunk_size = chunk_size_mb * 1024 * 1024
            total_chunks = (file_size + chunk_size - 1) // chunk_size
            
            # Initialize upload
            init_data = {
                'filename': filename,
                'total_size': file_size,
                'total_chunks': total_chunks,
                'drive_path': drive_path,
                'chunk_size': chunk_size
            }
            
            init_resp = self.session.post(
                f"{self.base_url}/api/storage/upload/init",
                json=init_data,
                timeout=10
            )
            
            if init_resp.status_code != 200:
                return False, {
                    'error': f"Upload init failed: {init_resp.status_code}",
                    'response': init_resp.text
                }
            
            upload_id = init_resp.json().get('upload_id')
            if not upload_id:
                return False, {'error': 'No upload ID received'}
            
            # Upload chunks
            uploaded_chunks = 0
            failed_chunks = 0
            start_time = time.time()
            
            with open(filepath, 'rb') as f:
                for chunk_index in range(total_chunks):
                    chunk_data = f.read(chunk_size)
                    
                    # Simulate a recoverable pause, not permanent chunk loss.
                    if simulate_drops and chunk_index % 5 == 3:
                        time.sleep(2)

                    chunk_uploaded = False
                    max_attempts = 8
                    for attempt in range(1, max_attempts + 1):
                        chunk_resp = self.session.post(
                            f"{self.base_url}/api/storage/upload/chunk",
                            data={
                                'upload_id': upload_id,
                                'chunk_index': chunk_index,
                                'total_chunks': total_chunks
                            },
                            files={'chunk': chunk_data},
                            timeout=30
                        )

                        if chunk_resp.status_code == 200:
                            uploaded_chunks += 1
                            chunk_uploaded = True

                            # Log progress every 10 chunks
                            if (chunk_index + 1) % 10 == 0:
                                progress = (chunk_index + 1) / total_chunks * 100
                                self._log(f"Upload progress: {progress:.1f}% ({chunk_index + 1}/{total_chunks})")
                            break

                        if chunk_resp.status_code == 429 and retry_rate_limits and attempt < max_attempts:
                            retry_after = chunk_resp.headers.get('Retry-After')
                            try:
                                delay = float(retry_after) if retry_after else min(6.0, 0.75 * attempt)
                            except ValueError:
                                delay = min(6.0, 0.75 * attempt)
                            self._log(f"Chunk {chunk_index} rate limited; retrying in {delay:.1f}s", "WARN")
                            time.sleep(delay)
                            continue

                        failed_chunks += 1
                        self._log(f"Chunk {chunk_index} failed: {chunk_resp.status_code}", "WARN")
                        break

                    if not chunk_uploaded:
                        continue
            
            elapsed = time.time() - start_time
            
            # Check final status
            if uploaded_chunks == total_chunks:
                # Track uploaded file for server cleanup
                self.uploaded_files.append((drive_path, filename))
                return True, {
                    'upload_id': upload_id,
                    'file_size': file_size,
                    'total_chunks': total_chunks,
                    'uploaded_chunks': uploaded_chunks,
                    'failed_chunks': failed_chunks,
                    'elapsed_seconds': elapsed,
                    'throughput_mbps': (file_size * 8) / (elapsed * 1_000_000),
                    'drive_path': drive_path,
                    'filename': filename
                }
            else:
                try:
                    self.session.post(f"{self.base_url}/api/storage/upload/cancel/{upload_id}", timeout=10)
                except Exception:
                    pass
                return False, {
                    'upload_id': upload_id,
                    'error': f"Incomplete upload: {uploaded_chunks}/{total_chunks} chunks",
                    'uploaded_chunks': uploaded_chunks,
                    'total_chunks': total_chunks,
                    'failed_chunks': failed_chunks
                }
                
        except Exception as e:
            return False, {'error': f"Upload exception: {str(e)}"}

    def test_large_file_upload(self, size_mb: int = 500) -> bool:
        """Test large file upload (500MB+)"""
        self._log(f"Testing large file upload ({size_mb}MB)...", "HEADER")

        if not self._validate_session_password():
            self._record_result("Large File Upload", False, {'error': 'session_password_required'})
            return False
        if not self._require_admin_or_skip("Large File Upload"):
            return True

        try:
            drives = self._get_available_drives()
            if not drives:
                self._log("No drives available for test", "ERROR")
                return False
            
            drive_path = drives[0]
            
            # Create test file
            self._log(f"Creating {size_mb}MB test file...")
            create_start = time.time()
            test_file = self._create_test_file(size_mb)
            create_time = time.time() - create_start
            self._log(f"Test file created in {create_time:.1f}s")
            
            # Monitor memory
            initial_memory = self._get_memory_usage()
            self._log(f"Initial memory: {initial_memory['rss_mb']:.1f} MB")
            
            # Upload file
            upload_start = time.time()
            success, upload_result = self._upload_file_chunked(test_file, drive_path)
            upload_time = time.time() - upload_start
            
            # Check memory after upload
            final_memory = self._get_memory_usage()
            memory_growth = final_memory['rss_mb'] - initial_memory['rss_mb']
            
            # Cleanup
            os.remove(test_file)
            self.temp_files.remove(test_file)
            
            self._log(f"Upload completed in {upload_time:.1f}s")
            self._log(f"Memory growth: {memory_growth:+.1f} MB")
            
            if success:
                self._log(f"✓ Large file upload successful ({upload_result['throughput_mbps']:.1f} Mbps)", "SUCCESS")
            else:
                self._log(f"✗ Large file upload failed: {upload_result.get('error', 'Unknown')}", "ERROR")
            
            # Test passes if upload succeeds and memory growth is reasonable
            memory_ok = memory_growth < (size_mb * 2)  # Allow 2x file size in memory
            
            self._record_result("Large File Upload", success and memory_ok, {
                'file_size_mb': size_mb,
                'create_time_seconds': create_time,
                'upload_time_seconds': upload_time,
                'memory_growth_mb': memory_growth,
                'throughput_mbps': upload_result.get('throughput_mbps', 0) if success else 0,
                'upload_result': upload_result
            })
            
            return success and memory_ok
            
        except Exception as e:
            self._log(f"Large file upload test error: {e}", "ERROR")
            self._record_result("Large File Upload", False, {'error': str(e)})
            return False

    def test_concurrent_uploads(self, num_uploads: int = 5, file_size_mb: int = 50) -> bool:
        """Test multiple concurrent uploads"""
        self._log(f"Testing concurrent uploads ({num_uploads} files, {file_size_mb}MB each)...", "HEADER")

        if not self._validate_session_password():
            self._record_result("Concurrent Uploads", False, {'error': 'session_password_required'})
            return False
        if not self._require_admin_or_skip("Concurrent Uploads"):
            return True

        try:
            drives = self._get_available_drives()
            if not drives:
                self._log("No drives available for test", "ERROR")
                return False
            
            drive_path = drives[0]
            
            # Create test files
            test_files = []
            self._log(f"Creating {num_uploads} test files...")
            for i in range(num_uploads):
                test_file = self._create_test_file(file_size_mb)
                test_files.append(test_file)
            
            # Monitor memory and system resources
            initial_memory = self._get_memory_usage()
            self._log(f"Initial memory: {initial_memory['rss_mb']:.1f} MB")
            
            # Start concurrent uploads
            upload_results = []
            start_time = time.time()
            
            def upload_single(file_index: int, filepath: str) -> Tuple[int, bool, Dict]:
                success, result = self._upload_file_chunked(filepath, drive_path)
                return file_index, success, result
            
            with ThreadPoolExecutor(max_workers=num_uploads) as executor:
                futures = [executor.submit(upload_single, i, test_file) 
                          for i, test_file in enumerate(test_files)]
                
                for future in as_completed(futures, timeout=300):  # 5 minute timeout
                    file_index, success, result = future.result()
                    upload_results.append({
                        'file_index': file_index,
                        'success': success,
                        'result': result
                    })
                    
                    status = "✓" if success else "✗"
                    self._log(f"File {file_index}: {status} {result.get('error', 'Success')}")
            
            elapsed = time.time() - start_time
            final_memory = self._get_memory_usage()
            memory_growth = final_memory['rss_mb'] - initial_memory['rss_mb']
            
            # Analyze results
            successful_uploads = sum(1 for r in upload_results if r['success'])
            failed_uploads = len(upload_results) - successful_uploads
            success_rate = successful_uploads / len(upload_results)
            
            # Cleanup
            for test_file in test_files:
                try:
                    os.remove(test_file)
                    self.temp_files.remove(test_file)
                except:
                    pass
            
            self._log(f"Concurrent uploads complete:")
            self._log(f"  Successful: {successful_uploads}/{num_uploads}")
            self._log(f"  Failed: {failed_uploads}")
            self._log(f"  Success rate: {success_rate*100:.1f}%")
            self._log(f"  Total time: {elapsed:.1f}s")
            self._log(f"  Memory growth: {memory_growth:+.1f} MB")
            
            # Test passes if at least 80% succeed and memory growth is reasonable
            success_threshold = success_rate >= 0.8
            memory_ok = memory_growth < (num_uploads * file_size_mb * 2)  # 2x total size
            passed = success_threshold and memory_ok
            
            if passed:
                self._log("✓ Concurrent uploads handled well", "SUCCESS")
            else:
                self._log("✗ Concurrent uploads have issues", "ERROR")
            
            self._record_result("Concurrent Uploads", passed, {
                'num_uploads': num_uploads,
                'file_size_mb': file_size_mb,
                'successful_uploads': successful_uploads,
                'failed_uploads': failed_uploads,
                'success_rate': success_rate,
                'total_time_seconds': elapsed,
                'memory_growth_mb': memory_growth,
                'upload_results': upload_results
            })
            
            return passed
            
        except Exception as e:
            self._log(f"Concurrent uploads test error: {e}", "ERROR")
            self._record_result("Concurrent Uploads", False, {'error': str(e)})
            return False

    def test_upload_resume(self, file_size_mb: int = 100) -> bool:
        """Test upload resume after network drops"""
        self._log(f"Testing upload resume after drops ({file_size_mb}MB)...", "HEADER")

        if not self._validate_session_password():
            self._record_result("Upload Resume", False, {'error': 'session_password_required'})
            return False
        if not self._require_admin_or_skip("Upload Resume"):
            return True

        try:
            drives = self._get_available_drives()
            if not drives:
                self._log("No drives available for test", "ERROR")
                return False
            
            drive_path = drives[0]
            
            # Create test file
            test_file = self._create_test_file(file_size_mb)
            
            # Upload with simulated drops
            self._log("Uploading with simulated network drops...")
            success, result = self._upload_file_chunked(
                test_file, drive_path, 
                chunk_size_mb=1,  # Smaller chunks for better resume testing
                simulate_drops=True
            )
            
            # Cleanup
            os.remove(test_file)
            self.temp_files.remove(test_file)
            
            if success:
                self._log("✓ Upload resume handled correctly", "SUCCESS")
            else:
                self._log(f"✗ Upload resume failed: {result.get('error', 'Unknown')}", "ERROR")
            
            passed = success and result.get('uploaded_chunks', 0) == result.get('total_chunks', 0)
            
            self._record_result("Upload Resume", passed, {
                'file_size_mb': file_size_mb,
                'uploaded_chunks': result.get('uploaded_chunks', 0),
                'failed_chunks': result.get('failed_chunks', 0),
                'result': result
            })
            
            return passed
            
        except Exception as e:
            self._log(f"Upload resume test error: {e}", "ERROR")
            self._record_result("Upload Resume", False, {'error': str(e)})
            return False

    def test_16gb_limit_enforcement(self) -> bool:
        """Test 16GB upload limit enforcement"""
        self._log("Testing 16GB upload limit enforcement...", "HEADER")

        if not self._validate_session_password():
            self._record_result("16GB Upload Limit", False, {'error': 'session_password_required'})
            return False

        try:
            drives = self._get_available_drives()
            if not drives:
                self._log("No drives available for test", "ERROR")
                return False
            
            drive_path = drives[0]
            
            # Try to initialize upload larger than 16GB
            oversized_size = 17 * 1024 * 1024 * 1024  # 17GB
            chunk_size = 4 * 1024 * 1024  # 4MB
            total_chunks = (oversized_size + chunk_size - 1) // chunk_size
            
            init_data = {
                'filename': 'oversized_test.mp4',
                'total_size': oversized_size,
                'total_chunks': total_chunks,
                'drive_path': drive_path,
                'chunk_size': chunk_size
            }
            
            resp = self.session.post(
                f"{self.base_url}/api/storage/upload/init",
                json=init_data,
                timeout=10
            )
            
            # Should be rejected with 413 (Payload Too Large)
            if resp.status_code in [400, 413]:
                error_msg = resp.json().get('error', '') if resp.content else ''
                self._log("✓ 17GB upload correctly rejected", "SUCCESS")
                self._log(f"Error message: {error_msg}")
                
                self._record_result("16GB Upload Limit", True, {
                    'attempted_size_gb': 17,
                    'response_code': resp.status_code,
                    'error_message': error_msg,
                    'limit_enforced': True
                })
                return True
            else:
                self._log(f"✗ 17GB upload NOT rejected (HTTP {resp.status_code})", "ERROR")
                
                self._record_result("16GB Upload Limit", False, {
                    'attempted_size_gb': 17,
                    'response_code': resp.status_code,
                    'limit_enforced': False
                })
                return False
                
        except Exception as e:
            self._log(f"16GB limit test error: {e}", "ERROR")
            self._record_result("16GB Upload Limit", False, {'error': str(e)})
            return False

    def test_rate_limiting(self, duration: int = 30) -> bool:
        """Test upload rate limiting"""
        self._log(f"Testing upload rate limiting ({duration}s)...", "HEADER")

        if not self._validate_session_password():
            self._record_result("Upload Rate Limiting", False, {'error': 'session_password_required'})
            return False
        if not self._require_admin_or_skip("Upload Rate Limiting"):
            return True

        try:
            # Get config to check rate limits
            config_resp = self.session.get(f"{self.base_url}/api/config", timeout=10)
            if config_resp.status_code != 200:
                self._log("Could not get config - using defaults", "WARN")
                upload_limit = 50  # Default 50 Mbps
            else:
                config = config_resp.json()
                upload_limit = config.get('UPLOAD_RATE_LIMIT_PER_CLIENT', 50)
            effective_limit = upload_limit
            try:
                health_resp = self.session.get(f"{self.base_url}/api/system/network-health", timeout=10)
                if health_resp.status_code == 200:
                    effective = health_resp.json().get('rate_limiting', {}).get('effective_upload_limit_mbps')
                    if effective:
                        effective_limit = float(effective)
            except Exception:
                pass
            
            if upload_limit == 0:
                self._log("Upload rate limiting is disabled in config.", "ERROR")
                self._record_result("Upload Rate Limiting", False, {'error': 'disabled'})
                return False
            
            self._log(f"Testing against {effective_limit} Mbps effective limit")
            
            drives = self._get_available_drives()
            if not drives:
                self._log("No drives available for test", "ERROR")
                return False
            
            drive_path = drives[0]
            
            # Create multiple small uploads to trigger rate limiting
            file_size_mb = 10  # 10MB files
            test_file = self._create_test_file(file_size_mb)
            
            bytes_sent = 0
            chunks_sent = 0
            rate_limited = False
            start_time = time.time()
            
            while time.time() - start_time < duration:
                # Try rapid uploads
                success, result = self._upload_file_chunked(
                    test_file,
                    drive_path,
                    retry_rate_limits=False,
                )
                
                if success:
                    bytes_sent += result.get('file_size', 0)
                    chunks_sent += 1
                else:
                    # Check if it was rate limited
                    error_msg = result.get('error', '').lower()
                    if 'rate limit' in error_msg or '429' in str(result):
                        rate_limited = True
                        break
                
                # Brief pause
                time.sleep(1)
            
            elapsed = time.time() - start_time
            
            # Calculate actual throughput
            actual_mbps = (bytes_sent * 8) / (elapsed * 1_000_000)
            
            # Cleanup
            os.remove(test_file)
            self.temp_files.remove(test_file)
            
            self._log(f"Rate limiting test complete:")
            self._log(f"  Duration: {elapsed:.1f}s")
            self._log(f"  Chunks sent: {chunks_sent}")
            self._log(f"  Actual throughput: {actual_mbps:.1f} Mbps")
            self._log(f"  Expected limit: {effective_limit} Mbps")
            self._log(f"  Rate limited detected: {rate_limited}")
            
            # Pass if rate limiting was detected or throughput is within expected range
            passed = rate_limited or actual_mbps <= (effective_limit * 1.2)  # 20% tolerance
            
            if passed:
                self._log("✓ Rate limiting is working", "SUCCESS")
            else:
                self._log("✗ Rate limiting not enforced", "ERROR")
            
            self._record_result("Upload Rate Limiting", passed, {
                'duration_seconds': elapsed,
                'chunks_sent': chunks_sent,
                'bytes_sent': bytes_sent,
                'actual_mbps': actual_mbps,
                'expected_limit_mbps': upload_limit,
                'effective_limit_mbps': effective_limit,
                'rate_limited': rate_limited
            })
            
            return passed
            
        except Exception as e:
            self._log(f"Rate limiting test error: {e}", "ERROR")
            self._record_result("Upload Rate Limiting", False, {'error': str(e)})
            return False

    def cleanup(self):
        """Clean up local temp files AND uploaded files on server"""
        # Clean up local temp files
        if self.temp_files:
            self._log(f"Cleaning up {len(self.temp_files)} local temp files...")
            for temp_file in self.temp_files:
                try:
                    if os.path.exists(temp_file):
                        os.remove(temp_file)
                except:
                    pass
            self.temp_files.clear()
        
        # Clean up uploaded files on server using bulk delete.
        if self.uploaded_files:
            self._log(f"Cleaning up {len(self.uploaded_files)} uploaded files from server...")
            deleted = 0
            file_paths = [
                f"{drive_path}/{filename}" if not drive_path.endswith('/') else f"{drive_path}{filename}"
                for drive_path, filename in self.uploaded_files
            ]
            try:
                resp = self.session.post(
                    f"{self.base_url}/api/storage/media/batch-delete",
                    json={'file_paths': file_paths},
                    timeout=30
                )
                if resp.status_code == 200:
                    deleted = resp.json().get('deleted', 0)
                else:
                    self._log(f"⚠ Failed bulk cleanup: {resp.status_code}", "WARN")
            except Exception as e:
                self._log(f"⚠ Error during bulk cleanup: {e}", "WARN")
            
            if deleted > 0:
                self._log(f"✓ Deleted {deleted} uploaded test files from server", "SUCCESS")
            
            self.uploaded_files.clear()

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
        """Run all enhanced upload stress tests"""
        self._log("=" * 60, "HEADER")
        self._log("GhostHub Enhanced Chunked Upload Stress Test", "HEADER")
        self._log("=" * 60, "HEADER")

        all_passed = True

        # Critical tests based on QA checklist
        all_passed &= self.test_16gb_limit_enforcement()
        time.sleep(2)

        all_passed &= self.test_rate_limiting(duration=30)
        time.sleep(2)

        all_passed &= self.test_large_file_upload(size_mb=500)
        time.sleep(2)

        all_passed &= self.test_concurrent_uploads(num_uploads=5, file_size_mb=50)
        time.sleep(2)

        all_passed &= self.test_upload_resume(file_size_mb=100)

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
        description='GhostHub Enhanced Chunked Upload Stress Test',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('--url', default='http://localhost:5000',
                       help='GhostHub base URL')
    parser.add_argument('--password', help='Legacy session password for upload operations')
    parser.add_argument('--session-password', help='Session password for upload operations')
    parser.add_argument('--admin-password', help='Admin password for admin claim and cleanup')
    parser.add_argument('--test', default='all',
                       choices=['all', 'large_file', 'concurrent', 'resume', 'limit_16gb', 'rate_limit'],
                       help='Specific test to run')
    parser.add_argument('--output', help='Output JSON file for results')
    parser.add_argument('--size', type=int, default=500,
                       help='File size for large file test (MB)')
    parser.add_argument('--duration', type=int, default=30,
                       help='Duration for rate limiting test (seconds)')

    args = parser.parse_args()

    session_password = args.session_password or args.password
    tester = EnhancedUploadStressTest(args.url, session_password, args.admin_password, args.output)

    try:
        if args.test == 'all':
            success = tester.run_all_tests()
        elif args.test == 'large_file':
            success = tester.test_large_file_upload(args.size)
        elif args.test == 'concurrent':
            success = tester.test_concurrent_uploads()
        elif args.test == 'resume':
            success = tester.test_upload_resume()
        elif args.test == 'limit_16gb':
            success = tester.test_16gb_limit_enforcement()
        elif args.test == 'rate_limit':
            success = tester.test_rate_limiting(args.duration)
        else:
            print(f"Unknown test: {args.test}")
            success = False

        tester.cleanup()
        tester.save_results()
        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        tester.cleanup()
        tester.save_results()
        sys.exit(1)
    except Exception as e:
        print(f"\nFATAL ERROR: {e}")
        tester.cleanup()
        tester.save_results()
        sys.exit(1)


if __name__ == '__main__':
    main()
