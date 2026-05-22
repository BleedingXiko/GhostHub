#!/usr/bin/env python3
"""
GhostHub Load Simulator
-----------------------
Python utilities for simulating various types of load against GhostHub:
- Chunked file uploads (1-4GB files)
- Concurrent video streaming clients
- WebSocket chat/command spam
- Sync mode stress testing
- TV casting cycles

Designed to work with GhostHub's actual API endpoints.
"""

import os
import sys
import json
import time
import random
import string
import hashlib
import argparse
import threading
import concurrent.futures
from pathlib import Path
from typing import Optional, List, Dict, Callable
from dataclasses import dataclass, field
from datetime import datetime

# HTTP/WebSocket libraries
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    import socketio
    HAS_SOCKETIO = True
except ImportError:
    HAS_SOCKETIO = False


def check_dependencies():
    """Check and report on available dependencies."""
    print("\n📦 Checking dependencies...")
    print(f"   requests:  ✓ available")
    print(f"   socketio:  {'✓ available' if HAS_SOCKETIO else '✗ not installed'}")
    if not HAS_SOCKETIO:
        print("   └─ WebSocket/Sync tests will use HTTP fallback")
        print("   └─ Install: pip install python-socketio[client]")
    return True


@dataclass
class TestResult:
    """Container for test results."""
    test_name: str
    success: bool
    duration_seconds: float
    requests_made: int = 0
    bytes_transferred: int = 0
    errors: List[str] = field(default_factory=list)
    metrics: Dict = field(default_factory=dict)


class GhostHubClient:
    """Base client for interacting with GhostHub API."""
    
    def __init__(
        self,
        base_url: str = "http://localhost:5000",
        session_password: str = None,
        admin_password: str = None,
    ):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        self.session_password = session_password
        self.admin_password = admin_password
        self.session_id = None
        
        # Set a realistic user agent
        self.session.headers.update({
            'User-Agent': 'GhostHub-StressTest/1.0'
        })
    
    def authenticate_admin(self) -> bool:
        """Validate the session password, then claim admin when possible."""
        try:
            # First get a session cookie
            resp = self.session.get(f"{self.base_url}/")
            if 'session_id' in resp.cookies:
                self.session_id = resp.cookies['session_id']

            if self.session_password:
                resp = self.session.post(
                    f"{self.base_url}/api/validate_session_password",
                    json={'password': self.session_password}
                )
                if resp.status_code != 200 or not resp.json().get('valid'):
                    return False

            payload = {'password': self.admin_password} if self.admin_password else {}
            resp = self.session.post(f"{self.base_url}/api/admin/claim", json=payload)
            return resp.status_code == 200
        except Exception as e:
            print(f"Auth error: {e}")
            return False
    
    def get_categories(self) -> List[Dict]:
        """Fetch all categories."""
        try:
            resp = self.session.get(f"{self.base_url}/api/categories")
            if resp.status_code == 200:
                return resp.json().get('categories', [])
        except Exception as e:
            print(f"Error fetching categories: {e}")
        return []

    def get_drives(self) -> List[str]:
        """Fetch writable storage drives for upload tests."""
        try:
            resp = self.session.get(f"{self.base_url}/api/storage/drives", timeout=10)
            if resp.status_code == 200:
                return [
                    drive.get('path')
                    for drive in resp.json().get('drives', [])
                    if drive.get('path')
                ]
        except Exception as e:
            print(f"Error fetching drives: {e}")
        return []
    
    def get_category_media(self, category_id: str, page: int = 1, limit: int = 50) -> Dict:
        """Fetch media for a category."""
        try:
            view_key = f"load_simulator::{category_id}::{page}::{limit}"
            resp = self.session.post(
                f"{self.base_url}/api/media/orders",
                json={'requests': [{
                    'view': 'load_simulator',
                    'viewKey': view_key,
                    'category_id': category_id,
                    'page': page,
                    'limit': limit,
                    'media_filter': 'all',
                    'hydrate': 'true',
                }]},
            )
            if resp.status_code == 200:
                results = resp.json().get('results') or []
                if results and results[0].get('status') != 'error':
                    return {'files': list((results[0].get('records') or {}).values())}
        except Exception as e:
            print(f"Error fetching media: {e}")
        return {'files': [], 'pagination': {}}


class ChunkedUploadSimulator:
    """Simulates large file uploads using GhostHub's chunked upload API.

    Tracks uploaded files for cleanup — call cleanup() when done to remove
    test files from the server so they don't pollute the user's real library.
    """

    CHUNK_SIZE = 5 * 1024 * 1024  # 5MB chunks (matches GhostHub default)

    def __init__(self, client: GhostHubClient):
        self.client = client
        self.results = []
        self._uploaded_files = []  # (drive_path, filename) for cleanup
        self._temp_files = []  # local temp files to remove
    
    def generate_test_file(self, size_bytes: int, output_path: str = None) -> str:
        """Generate a test file of specified size with random data."""
        if output_path is None:
            output_path = f"/tmp/ghosthub_test_{size_bytes}.bin"
        self._temp_files.append(output_path)
        
        print(f"Generating {size_bytes / 1024 / 1024 / 1024:.2f}GB test file...")
        
        chunk = os.urandom(1024 * 1024)  # 1MB of random data
        
        with open(output_path, 'wb') as f:
            remaining = size_bytes
            while remaining > 0:
                write_size = min(len(chunk), remaining)
                f.write(chunk[:write_size])
                remaining -= write_size
        
        print(f"Test file created: {output_path}")
        return output_path
    
    def upload_file_chunked(self, file_path: str, drive_path: str, subfolder: str = "") -> TestResult:
        """Upload a file using chunked upload API."""
        start_time = time.time()
        errors = []
        bytes_transferred = 0
        requests_made = 0
        
        try:
            file_size = os.path.getsize(file_path)
            filename = os.path.basename(file_path)
            total_chunks = (file_size + self.CHUNK_SIZE - 1) // self.CHUNK_SIZE
            
            print(f"Uploading {filename} ({file_size / 1024 / 1024:.1f}MB) in {total_chunks} chunks...")
            
            # Initialize upload
            init_resp = self.client.session.post(
                f"{self.client.base_url}/api/storage/upload/init",
                json={
                    'filename': filename,
                    'total_chunks': total_chunks,
                    'total_size': file_size,
                    'drive_path': drive_path,
                    'subfolder': subfolder
                }
            )
            requests_made += 1
            
            if init_resp.status_code != 200:
                return TestResult(
                    test_name="chunked_upload",
                    success=False,
                    duration_seconds=time.time() - start_time,
                    errors=[f"Init failed: {init_resp.text}"]
                )
            
            upload_id = init_resp.json().get('upload_id')
            print(f"Upload initialized: {upload_id}")
            
            # Upload chunks
            with open(file_path, 'rb') as f:
                for chunk_index in range(total_chunks):
                    chunk_data = f.read(self.CHUNK_SIZE)
                    
                    chunk_resp = None
                    for attempt in range(1, 7):
                        chunk_resp = self.client.session.post(
                            f"{self.client.base_url}/api/storage/upload/chunk",
                            data={
                                'upload_id': upload_id,
                                'chunk_index': chunk_index
                            },
                            files={'chunk': ('chunk', chunk_data, 'application/octet-stream')}
                        )
                        requests_made += 1
                        if chunk_resp.status_code == 200:
                            bytes_transferred += len(chunk_data)
                            break
                        if chunk_resp.status_code == 429 and attempt < 6:
                            time.sleep(min(6.0, attempt))
                            continue
                        errors.append(f"Chunk {chunk_index} failed: {chunk_resp.text}")
                        break
                    
                    progress = (chunk_index + 1) / total_chunks * 100
                    speed = bytes_transferred / (time.time() - start_time) / 1024 / 1024
                    print(f"  Progress: {progress:.1f}% ({speed:.1f} MB/s)", end='\r')
            
            print()  # New line after progress

            duration = time.time() - start_time
            success = len(errors) == 0

            if success:
                self._uploaded_files.append((drive_path, filename))

            return TestResult(
                test_name="chunked_upload",
                success=success,
                duration_seconds=duration,
                requests_made=requests_made,
                bytes_transferred=bytes_transferred,
                errors=errors,
                metrics={
                    'file_size': file_size,
                    'chunks': total_chunks,
                    'avg_speed_mbps': bytes_transferred / duration / 1024 / 1024 if duration > 0 else 0
                }
            )
            
        except Exception as e:
            return TestResult(
                test_name="chunked_upload",
                success=False,
                duration_seconds=time.time() - start_time,
                requests_made=requests_made,
                bytes_transferred=bytes_transferred,
                errors=[str(e)]
            )
    
    def cleanup(self):
        """Remove test files from server and local temp files."""
        if self._uploaded_files:
            file_paths = [
                f"{drive_path}/{filename}" if not drive_path.endswith('/') else f"{drive_path}{filename}"
                for drive_path, filename in self._uploaded_files
            ]
            try:
                self.client.session.post(
                    f"{self.client.base_url}/api/storage/media/batch-delete",
                    json={'file_paths': file_paths},
                    timeout=10,
                )
                print(f"  Cleaned up {len(file_paths)} server test file(s)")
            except Exception:
                pass
        self._uploaded_files.clear()

        for path in self._temp_files:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
        self._temp_files.clear()

    def run_concurrent_uploads(self, file_paths: List[str], drive_path: str, max_concurrent: int = 2) -> List[TestResult]:
        """Run multiple uploads concurrently."""
        results = []
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrent) as executor:
            futures = {
                executor.submit(self.upload_file_chunked, fp, drive_path): fp 
                for fp in file_paths
            }
            
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                results.append(result)
                print(f"Upload completed: {futures[future]} - {'Success' if result.success else 'Failed'}")
        
        return results


class StreamingSimulator:
    """Simulates multiple concurrent video streaming clients."""
    
    def __init__(self, client: GhostHubClient):
        self.client = client
        self.active_streams = 0
        self.lock = threading.Lock()
    
    def stream_video(self, video_url: str, duration_seconds: int = 30, 
                     chunk_size: int = 1024 * 1024) -> TestResult:
        """Simulate streaming a video file with HTTP range requests."""
        start_time = time.time()
        bytes_received = 0
        requests_made = 0
        errors = []
        
        try:
            # Get file size first
            head_resp = self.client.session.head(f"{self.client.base_url}{video_url}")
            requests_made += 1
            
            if head_resp.status_code != 200:
                return TestResult(
                    test_name="video_stream",
                    success=False,
                    duration_seconds=0,
                    errors=[f"HEAD request failed: {head_resp.status_code}"]
                )
            
            file_size = int(head_resp.headers.get('Content-Length', 0))
            
            # Stream with range requests
            position = 0
            while time.time() - start_time < duration_seconds and position < file_size:
                range_end = min(position + chunk_size - 1, file_size - 1)
                
                resp = self.client.session.get(
                    f"{self.client.base_url}{video_url}",
                    headers={'Range': f'bytes={position}-{range_end}'},
                    stream=True
                )
                requests_made += 1
                
                if resp.status_code not in (200, 206):
                    errors.append(f"Range request failed: {resp.status_code}")
                    break
                
                # Consume the response
                for chunk in resp.iter_content(chunk_size=8192):
                    bytes_received += len(chunk)
                
                position = range_end + 1
                
                # Simulate realistic playback timing (don't hammer the server)
                time.sleep(0.1)
            
            duration = time.time() - start_time
            
            return TestResult(
                test_name="video_stream",
                success=len(errors) == 0,
                duration_seconds=duration,
                requests_made=requests_made,
                bytes_transferred=bytes_received,
                errors=errors,
                metrics={
                    'avg_speed_mbps': bytes_received / duration / 1024 / 1024 if duration > 0 else 0,
                    'video_url': video_url
                }
            )
            
        except Exception as e:
            return TestResult(
                test_name="video_stream",
                success=False,
                duration_seconds=time.time() - start_time,
                errors=[str(e)]
            )
    
    def run_concurrent_streams(self, video_urls: List[str], num_clients: int = 5, 
                               duration_seconds: int = 30) -> List[TestResult]:
        """Run multiple concurrent streaming clients."""
        results = []
        
        # Distribute videos among clients
        assignments = []
        for i in range(num_clients):
            url = video_urls[i % len(video_urls)]
            assignments.append(url)
        
        print(f"Starting {num_clients} concurrent stream clients for {duration_seconds}s...")
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=num_clients) as executor:
            futures = [
                executor.submit(self.stream_video, url, duration_seconds)
                for url in assignments
            ]
            
            for i, future in enumerate(concurrent.futures.as_completed(futures)):
                result = future.result()
                results.append(result)
                print(f"Stream {i+1}/{num_clients} completed: {result.metrics.get('avg_speed_mbps', 0):.1f} MB/s")
        
        # Summary
        total_bytes = sum(r.bytes_transferred for r in results)
        total_duration = max(r.duration_seconds for r in results)
        print(f"\nTotal streamed: {total_bytes / 1024 / 1024:.1f}MB in {total_duration:.1f}s")
        print(f"Aggregate throughput: {total_bytes / total_duration / 1024 / 1024:.1f} MB/s")
        
        return results


class WebSocketSpammer:
    """Simulates multiple WebSocket clients sending chat commands."""

    CHAT_MESSAGES = [
        "Testing GhostHub performance",
        "Stress test in progress",
        "Hello from load simulator",
        "How's the Pi handling this?",
        "Checking WebSocket throughput",
    ]
    SEARCH_TERMS = [
        "test",
        "video",
        "photo",
        "holiday",
        "family"
    ]
    
    def __init__(self, base_url: str = "http://localhost:5000", categories: Optional[List[Dict]] = None):
        self.base_url = base_url
        self.clients = []
        self.results = []
        self.running = False
        self.categories = categories or []
        self.http_session = requests.Session()

    def _build_myview_command(self, client_id: int) -> Optional[Dict]:
        """Build a /myview command payload compatible with the server."""
        if not self.categories:
            return None

        category = random.choice(self.categories)
        category_id = category.get('id')
        if not category_id:
            return None

        media_count = category.get('mediaCount') or category.get('media_count') or 1
        try:
            media_count = int(media_count)
        except (TypeError, ValueError):
            media_count = 1

        index = 0
        if media_count > 1:
            index = random.randint(0, media_count - 1)

        payload = self._sync_payload(category_id, index)
        return {
            'cmd': 'myview',
            'from': f"stress_{client_id}",
            'arg': payload
        }

    def _run_search_request(self) -> bool:
        """Trigger a search request via HTTP to simulate /search load."""
        try:
            term = random.choice(self.SEARCH_TERMS)
            resp = self.http_session.get(
                f"{self.base_url}/api/search",
                params={'q': term},
                timeout=10
            )
            return resp.status_code == 200
        except Exception:
            return False
    
    def create_client(self, client_id: int) -> Optional[socketio.Client]:
        """Create a WebSocket client."""
        if not HAS_SOCKETIO:
            print("ERROR: python-socketio not installed")
            return None
        
        sio = socketio.Client()
        
        @sio.event
        def connect():
            print(f"Client {client_id} connected")
        
        @sio.event
        def disconnect():
            print(f"Client {client_id} disconnected")
        
        @sio.event
        def chat_message(data):
            pass  # Just receive, don't print
        
        try:
            sio.connect(self.base_url, transports=['websocket'])
            sio.emit('join_chat')
            return sio
        except Exception as e:
            print(f"Client {client_id} connection failed: {e}")
            return None
    
    def spam_client(self, client_id: int, duration_seconds: int, 
                    messages_per_second: float = 2.0) -> TestResult:
        """Run a single spamming client."""
        start_time = time.time()
        messages_sent = 0
        errors = []
        
        sio = self.create_client(client_id)
        if not sio:
            return TestResult(
                test_name="websocket_spam",
                success=False,
                duration_seconds=0,
                errors=["Failed to connect"]
            )
        
        try:
            delay = 1.0 / messages_per_second
            
            while self.running and (time.time() - start_time) < duration_seconds:
                # Randomly choose message type
                roll = random.random()
                if roll < 0.15:
                    # Send /myview command when possible
                    cmd = self._build_myview_command(client_id)
                    if cmd:
                        sio.emit('command', cmd)
                    else:
                        msg = random.choice(self.CHAT_MESSAGES)
                        sio.emit('chat_message', {'message': f"[{client_id}] {msg}"})
                elif roll < 0.3:
                    # Simulate /search load via HTTP
                    self._run_search_request()
                else:
                    # Send chat message
                    msg = random.choice(self.CHAT_MESSAGES)
                    sio.emit('chat_message', {'message': f"[{client_id}] {msg}"})
                
                messages_sent += 1
                time.sleep(delay)
            
        except Exception as e:
            errors.append(str(e))
        finally:
            try:
                sio.disconnect()
            except:
                pass
        
        duration = time.time() - start_time
        return TestResult(
            test_name="websocket_spam",
            success=len(errors) == 0,
            duration_seconds=duration,
            requests_made=messages_sent,
            errors=errors,
            metrics={
                'client_id': client_id,
                'messages_per_second': messages_sent / duration if duration > 0 else 0
            }
        )
    
    def run_spam_test(self, num_clients: int = 10, duration_seconds: int = 30,
                      messages_per_second: float = 2.0) -> List[TestResult]:
        """Run multiple spamming clients concurrently."""
        if not HAS_SOCKETIO:
            print("  ⚠️  WebSocket test SKIPPED (python-socketio not installed)")
            print("      Install with: pip install python-socketio[client]")
            return [TestResult(
                test_name="websocket_spam",
                success=True,  # Not a failure, just skipped
                duration_seconds=0,
                errors=["SKIPPED: python-socketio not installed"],
                metrics={'skipped': True}
            )]
        
        self.running = True
        results = []
        
        print(f"Starting {num_clients} WebSocket spam clients for {duration_seconds}s...")
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=num_clients) as executor:
            futures = [
                executor.submit(self.spam_client, i, duration_seconds, messages_per_second)
                for i in range(num_clients)
            ]
            
            for future in concurrent.futures.as_completed(futures):
                results.append(future.result())
        
        self.running = False
        
        # Summary
        total_messages = sum(r.requests_made for r in results)
        total_duration = max(r.duration_seconds for r in results) if results else 0
        print(f"\nTotal messages sent: {total_messages}")
        print(f"Aggregate rate: {total_messages / total_duration:.1f} msg/s" if total_duration > 0 else "N/A")
        
        return results


class SyncModeSimulator:
    """Simulates sync mode with host and multiple followers.
    
    Supports both WebSocket (if socketio available) and HTTP-only mode.
    """
    
    def __init__(self, base_url: str = "http://localhost:5000"):
        import uuid
        self.base_url = base_url
        self.host_client = None
        self.follower_clients = []
        self.http_session = requests.Session()
        # Set session_id cookie (required for sync host identification)
        self.http_session.cookies.set('session_id', str(uuid.uuid4()))
        self.use_websocket = HAS_SOCKETIO
    
    def setup_host(self, category_id: str, start_index: int = 0) -> bool:
        """Enable sync mode and set up host."""
        try:
            # Enable sync via HTTP API (session becomes host)
            resp = self.http_session.post(
                f"{self.base_url}/api/sync/toggle",
                json={'enabled': True, 'media': self._sync_payload(category_id, start_index)},
                timeout=10
            )
            if resp.status_code != 200:
                print(f"Failed to enable sync: {resp.status_code}")
                return False
            
            # Optionally connect WebSocket if available
            if HAS_SOCKETIO:
                try:
                    self.host_client = socketio.Client()
                    self.host_client.connect(self.base_url, transports=['websocket'])
                    self.host_client.emit('join_sync')
                except Exception as e:
                    print(f"WebSocket connection failed, using HTTP-only mode: {e}")
                    self.use_websocket = False
            else:
                self.use_websocket = False
            
            return True
            
        except Exception as e:
            print(f"Host setup failed: {e}")
            return False
    
    def add_follower(self) -> bool:
        """Add a follower client to sync session (WebSocket only)."""
        if not HAS_SOCKETIO:
            return False
        
        try:
            sio = socketio.Client()
            sio.connect(self.base_url, transports=['websocket'])
            sio.emit('join_sync')
            self.follower_clients.append(sio)
            return True
        except Exception as e:
            print(f"Follower connection failed: {e}")
            return False
    
    def simulate_navigation(self, category_id: str, total_items: int, 
                            duration_seconds: int = 30, 
                            nav_per_second: float = 1.0) -> TestResult:
        """Simulate rapid navigation through media items."""
        start_time = time.time()
        navigations = 0
        errors = []
        
        try:
            delay = 1.0 / nav_per_second
            current_index = 0
            
            while (time.time() - start_time) < duration_seconds:
                # Navigate to next/random item
                if random.random() < 0.7:
                    current_index = (current_index + 1) % total_items
                else:
                    current_index = random.randint(0, total_items - 1)
                
                # Send sync update via WebSocket or HTTP
                payload = self._sync_payload(category_id, current_index)
                if self.use_websocket and self.host_client:
                    self.host_client.emit('sync_update', payload)
                    navigations += 1
                else:
                    # HTTP fallback
                    resp = self.http_session.post(
                        f"{self.base_url}/api/sync/update",
                        json=payload
                    )
                    if resp.status_code == 200:
                        navigations += 1
                    else:
                        errors.append(f"HTTP sync update failed: {resp.status_code}")
                
                time.sleep(delay)
                
        except Exception as e:
            errors.append(str(e))
        
        duration = time.time() - start_time
        return TestResult(
            test_name="sync_navigation",
            success=len(errors) == 0 or navigations > 0,
            duration_seconds=duration,
            requests_made=navigations,
            errors=errors[:5],  # Limit error count
            metrics={
                'followers': len(self.follower_clients),
                'nav_per_second': navigations / duration if duration > 0 else 0,
                'mode': 'websocket' if self.use_websocket else 'http'
            }
        )

    @staticmethod
    def _sync_payload(category_id: str, current_index: int) -> Dict:
        media_id = f"{category_id}::item_{current_index}"
        return {
            'category_id': category_id,
            'viewKey': f"sim::{category_id}::all",
            'viewType': 'streaming_grid',
            'viewParams': {
                'category_id': category_id,
                'media_filter': 'all',
            },
            'mediaId': media_id,
        }
    
    def cleanup(self):
        """Disconnect all clients and disable sync."""
        try:
            # Disable sync
            self.http_session.post(f"{self.base_url}/api/sync/toggle", json={'enabled': False})
            
            if self.host_client:
                try:
                    self.host_client.emit('leave_sync')
                    self.host_client.disconnect()
                except:
                    pass
            
            for client in self.follower_clients:
                try:
                    client.emit('leave_sync')
                    client.disconnect()
                except:
                    pass
        except:
            pass


class TVCastingSimulator:
    """Simulates TV casting cycles."""
    
    def __init__(self, base_url: str = "http://localhost:5000"):
        self.base_url = base_url
        self.sio = None
    
    def connect(self) -> bool:
        """Connect to GhostHub as a casting client."""
        if not HAS_SOCKETIO:
            print("  ⚠️  TV Casting test SKIPPED (python-socketio not installed)")
            return False
        
        try:
            self.sio = socketio.Client()
            self.sio.connect(self.base_url, transports=['websocket'])
            return True
        except Exception as e:
            print(f"Connection failed: {e}")
            return False
    
    def run_cast_cycles(self, media_urls: List[Dict], num_cycles: int = 10,
                        cast_duration: float = 2.0) -> TestResult:
        """Run multiple cast/uncast cycles."""
        start_time = time.time()
        cycles_completed = 0
        errors = []
        
        if not self.connect():
            return TestResult(
                test_name="tv_casting",
                success=False,
                duration_seconds=0,
                errors=["Failed to connect"]
            )
        
        try:
            for i in range(num_cycles):
                media = media_urls[i % len(media_urls)]
                category_id = media.get('category_id')
                media_id = media.get('id') or f"{category_id or 'media'}::item_{i}"
                view_params = {
                    'category_id': category_id,
                    'media_filter': 'all',
                }
                
                # Cast
                self.sio.emit('cast_media_to_tv', {
                    'media_type': media.get('type', 'video'),
                    'media_path': media.get('url'),
                    'viewKey': f"sim::{category_id or 'media'}::all",
                    'viewType': 'streaming_grid',
                    'viewParams': view_params,
                    'mediaId': media_id,
                    'category_id': category_id,
                    'media_id': media_id,
                    'loop': False
                })
                
                time.sleep(cast_duration)
                
                # Stop cast
                self.sio.emit('tv_stop_casting')
                
                cycles_completed += 1
                print(f"Cast cycle {i+1}/{num_cycles} completed")
                
                time.sleep(0.5)  # Brief pause between cycles
                
        except Exception as e:
            errors.append(str(e))
        finally:
            if self.sio:
                self.sio.disconnect()
        
        duration = time.time() - start_time
        return TestResult(
            test_name="tv_casting",
            success=len(errors) == 0 and cycles_completed == num_cycles,
            duration_seconds=duration,
            requests_made=cycles_completed * 2,  # cast + stop per cycle
            errors=errors,
            metrics={
                'cycles_completed': cycles_completed,
                'cycles_per_minute': cycles_completed / (duration / 60) if duration > 0 else 0
            }
        )


class MediaBrowsingSimulator:
    """Hammer the normalized media browsing endpoints.

    Exercises the canonical id-first browsing contract that backs every
    streaming row, gallery timeline page, and viewer hydration:
      GET  /api/media/order            single ordered id window
      POST /api/media/orders           batched ordered id windows (rows fan-out)
      POST /api/media/records          stable-id hydration

    This is the new hot path on the media-manifest-refactor branch and is
    not covered by the older streaming/sync/upload stressors.
    """

    MAX_BATCH_REQUESTS = 50  # Server-enforced cap in MediaOrderingController.
    MAX_RECORD_IDS = 200     # Server-enforced cap in MediaRecordsService.

    def __init__(self, client: GhostHubClient, categories: List[Dict]):
        self.client = client
        self.base_url = client.base_url
        self.session = client.session
        self.categories = [c for c in (categories or []) if c.get('id')]
        self.running = False
        self.errors: List[str] = []
        self.requests_made = 0
        self.bytes_received = 0

    def run_browsing_storm(
        self,
        num_clients: int = 5,
        duration_seconds: int = 30,
        records_per_batch: int = 20,
        rows_per_batch: int = 10,
    ) -> TestResult:
        """Spawn N worker threads each looping the order → records cycle."""
        if not self.categories:
            return TestResult(
                test_name="media_browsing",
                success=False,
                duration_seconds=0,
                errors=["No categories available for browsing storm"],
            )

        self.running = True
        start_time = time.time()
        per_thread_stats: List[Dict] = []
        stats_lock = threading.Lock()

        def worker(worker_id: int):
            stats = {
                'order_requests': 0,
                'batch_requests': 0,
                'records_requests': 0,
                'errors': 0,
                'first_error': None,
            }
            local_session = requests.Session()
            local_session.headers.update(self.session.headers)
            for cookie in self.session.cookies:
                local_session.cookies.set_cookie(cookie)

            while self.running and (time.time() - start_time) < duration_seconds:
                roll = random.random()
                try:
                    if roll < 0.45:
                        self._hit_single_order(local_session, stats, records_per_batch)
                    elif roll < 0.80:
                        self._hit_batched_orders(local_session, stats, rows_per_batch)
                    else:
                        self._hit_records(local_session, stats)
                except Exception as exc:
                    stats['errors'] += 1
                    if not stats['first_error']:
                        stats['first_error'] = f"worker {worker_id}: {exc}"

                time.sleep(random.uniform(0.05, 0.25))

            with stats_lock:
                per_thread_stats.append(stats)

        threads = [
            threading.Thread(target=worker, args=(i,), daemon=True)
            for i in range(num_clients)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=duration_seconds + 30)

        self.running = False
        duration = time.time() - start_time

        totals = {
            'order_requests': sum(s['order_requests'] for s in per_thread_stats),
            'batch_requests': sum(s['batch_requests'] for s in per_thread_stats),
            'records_requests': sum(s['records_requests'] for s in per_thread_stats),
            'errors': sum(s['errors'] for s in per_thread_stats),
        }
        total_requests = (
            totals['order_requests']
            + totals['batch_requests']
            + totals['records_requests']
        )
        error_samples = [s['first_error'] for s in per_thread_stats if s.get('first_error')]

        # Tolerate 5% error rate — the storm includes random pagination beyond
        # the actual library size, which the server legitimately rejects.
        error_rate = totals['errors'] / max(1, total_requests)
        return TestResult(
            test_name="media_browsing",
            success=error_rate <= 0.05,
            duration_seconds=duration,
            requests_made=total_requests,
            bytes_transferred=self.bytes_received,
            errors=error_samples[:5],
            metrics={
                **totals,
                'requests_per_second': total_requests / duration if duration > 0 else 0,
                'error_rate': error_rate,
                'workers': num_clients,
            },
        )

    def _hit_single_order(self, session, stats: Dict, page_limit: int) -> None:
        """GET /api/media/order for a single streaming row / grid window."""
        cat = random.choice(self.categories)
        view = random.choice(['streaming_row', 'streaming_grid', 'subfolder_grid'])
        params = {
            'view': view,
            'category_id': cat['id'],
            'page': random.randint(1, 3),
            'limit': page_limit,
            'media_filter': random.choice(['all', 'image', 'video']),
            'hydrate': random.choice(['true', 'false']),
        }
        if view == 'subfolder_grid':
            # Subfolder views require a subfolder param; the server returns
            # a clean empty window when the path doesn't exist, which is
            # exactly the shape the client also has to handle.
            params['subfolder'] = 'stress'
        resp = session.get(
            f"{self.base_url}/api/media/order",
            params=params,
            timeout=15,
        )
        stats['order_requests'] += 1
        if resp.status_code == 200:
            self._consume_body(resp)
            self._validate_order_shape(resp.json())
        elif resp.status_code in (400, 404):
            # Validation rejection is acceptable feedback, not a server fault.
            return
        else:
            raise RuntimeError(f"/api/media/order returned {resp.status_code}")

    def _hit_batched_orders(self, session, stats: Dict, rows_per_batch: int) -> None:
        """POST /api/media/orders — fan out N rows in one round-trip."""
        count = min(self.MAX_BATCH_REQUESTS, max(1, rows_per_batch))
        picks = random.choices(self.categories, k=count)
        body = {
            'requests': [
                {
                    'view': 'streaming_row',
                    'viewKey': f"stress::row::{cat['id']}::{idx}",
                    'category_id': cat['id'],
                    'page': 1,
                    'limit': 20,
                    'media_filter': 'all',
                    'hydrate': 'true',
                }
                for idx, cat in enumerate(picks)
            ]
        }
        resp = session.post(
            f"{self.base_url}/api/media/orders",
            json=body,
            timeout=20,
        )
        stats['batch_requests'] += 1
        if resp.status_code != 200:
            raise RuntimeError(f"/api/media/orders returned {resp.status_code}")
        payload = resp.json()
        results = payload.get('results') or []
        if len(results) != len(body['requests']):
            raise RuntimeError(
                f"/api/media/orders result count {len(results)} != request count {len(body['requests'])}"
            )
        self._consume_body(resp)

    def _hit_records(self, session, stats: Dict) -> None:
        """POST /api/media/records — hydrate stable ids."""
        cat = random.choice(self.categories)
        # Seed: pull a real order window first so we hydrate real ids when
        # possible, then mix in synthetic ids to exercise the missing path.
        seed_resp = session.get(
            f"{self.base_url}/api/media/order",
            params={
                'view': 'streaming_row',
                'category_id': cat['id'],
                'page': 1,
                'limit': 20,
                'media_filter': 'all',
            },
            timeout=10,
        )
        stats['order_requests'] += 1
        seed_ids = []
        if seed_resp.status_code == 200:
            seed_ids = list(seed_resp.json().get('orderedIds') or [])
        synthetic = [
            f"{cat['id']}::stress-missing-{random.randint(0, 9999)}.bin"
            for _ in range(min(5, max(1, self.MAX_RECORD_IDS - len(seed_ids))))
        ]
        ids = (seed_ids + synthetic)[: self.MAX_RECORD_IDS]
        if not ids:
            return
        resp = session.post(
            f"{self.base_url}/api/media/records",
            json={'ids': ids},
            timeout=15,
        )
        stats['records_requests'] += 1
        if resp.status_code != 200:
            raise RuntimeError(f"/api/media/records returned {resp.status_code}")
        body = resp.json()
        if not isinstance(body.get('records'), dict) or not isinstance(body.get('missing'), list):
            raise RuntimeError("/api/media/records payload missing records/missing keys")
        self._consume_body(resp)

    @staticmethod
    def _validate_order_shape(payload: Dict) -> None:
        if not isinstance(payload, dict):
            raise RuntimeError("/api/media/order returned non-object")
        if not isinstance(payload.get('orderedIds'), list):
            raise RuntimeError("/api/media/order missing orderedIds list")
        if 'hasMore' not in payload:
            raise RuntimeError("/api/media/order missing hasMore")
        view_meta = payload.get('viewMeta')
        if view_meta is not None and not isinstance(view_meta, dict):
            raise RuntimeError("/api/media/order viewMeta must be an object")

    def _consume_body(self, resp) -> None:
        try:
            self.bytes_received += len(resp.content or b'')
        except Exception:
            pass


class ThumbnailStressTest:
    """Triggers mass thumbnail generation."""
    
    def __init__(self, client: GhostHubClient):
        self.client = client
    
    def trigger_thumbnail_generation(self, category_id: str) -> TestResult:
        """Force thumbnail generation for all media in a category."""
        start_time = time.time()
        requests_made = 0
        thumbnails_generated = 0
        errors = []
        
        try:
            # Get media list
            media_data = self.client.get_category_media(category_id, limit=1000)
            files = media_data.get('files', [])
            
            print(f"Requesting thumbnails for {len(files)} files in {category_id}...")
            
            for i, file_info in enumerate(files):
                filename = file_info.get('name', '')
                if not filename:
                    continue
                
                # Request thumbnail (will be generated if not exists)
                thumb_url = f"{self.client.base_url}/thumbnails/{category_id}/{filename}"
                resp = self.client.session.get(thumb_url)
                requests_made += 1
                
                if resp.status_code == 200:
                    thumbnails_generated += 1
                elif resp.status_code != 404:
                    errors.append(f"Thumbnail error for {filename}: {resp.status_code}")
                
                if (i + 1) % 10 == 0:
                    print(f"  Progress: {i+1}/{len(files)}")
                
        except Exception as e:
            errors.append(str(e))
        
        duration = time.time() - start_time
        return TestResult(
            test_name="thumbnail_generation",
            success=len(errors) < len(files) * 0.1,  # Allow 10% failure
            duration_seconds=duration,
            requests_made=requests_made,
            errors=errors[:10],  # Only keep first 10 errors
            metrics={
                'total_files': len(files) if 'files' in locals() else 0,
                'thumbnails_generated': thumbnails_generated,
                'generation_rate': thumbnails_generated / duration if duration > 0 else 0
            }
        )


def save_results(results: List[TestResult], output_path: str):
    """Save test results to JSON file."""
    data = {
        'timestamp': datetime.now().isoformat(),
        'tests': [
            {
                'name': r.test_name,
                'success': r.success,
                'duration_seconds': r.duration_seconds,
                'requests_made': r.requests_made,
                'bytes_transferred': r.bytes_transferred,
                'errors': r.errors,
                'metrics': r.metrics
            }
            for r in results
        ]
    }
    
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)
    
    print(f"Results saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='GhostHub Load Simulator')
    parser.add_argument('--url', default='http://localhost:5000',
                        help='GhostHub base URL')
    parser.add_argument('--password', default=None,
                        help='Legacy alias for --session-password')
    parser.add_argument('--session-password', default=None,
                        help='Session password if password protection is enabled')
    parser.add_argument('--admin-password', default=None,
                        help='Admin password for admin claim and cleanup')
    parser.add_argument('--test', choices=['upload', 'stream', 'websocket', 'sync', 'cast', 'thumbnail', 'browsing', 'all'],
                        default='all', help='Test to run')
    parser.add_argument('--duration', type=int, default=30,
                        help='Test duration in seconds')
    parser.add_argument('--clients', type=int, default=5,
                        help='Number of concurrent clients')
    parser.add_argument('--output', default='stress_tests/results/load_test.json',
                        help='Output file path')
    
    args = parser.parse_args()
    
    if not HAS_REQUESTS:
        print("ERROR: requests library required. Install with: pip install requests")
        sys.exit(1)
    
    # Create output directory
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    
    session_password = args.session_password or args.password
    client = GhostHubClient(args.url, session_password, args.admin_password)
    
    check_dependencies()
    
    print(f"\n🔗 Connecting to GhostHub at {args.url}...")
    admin_ok = client.authenticate_admin()
    if not admin_ok:
        print("⚠️  Admin was not claimed. Admin-required upload cleanup will be skipped.")
    
    results = []
    
    # Get available categories and media for testing
    categories = client.get_categories()
    if not categories:
        print("No categories found. Please add media to GhostHub first.")
        sys.exit(1)
    
    print(f"Found {len(categories)} categories")
    
    # Find videos for streaming test
    video_urls = []
    for cat in categories[:3]:  # Check first 3 categories
        media = client.get_category_media(cat['id'])
        for f in media.get('files', []):
            if f.get('type') == 'video':
                video_url = f.get('url') or f.get('media_url')
                if not video_url:
                    continue
                video_urls.append(video_url)
                if len(video_urls) >= 5:
                    break
        if len(video_urls) >= 5:
            break
    
    # Run requested tests
    if args.test in ['upload', 'all']:
        print("\n=== Running Upload Test ===")
        if not admin_ok:
            results.append(TestResult(
                test_name="chunked_upload",
                success=True,
                duration_seconds=0,
                metrics={'skipped': True, 'skip_reason': 'admin was not claimed'},
            ))
        else:
            upload_sim = ChunkedUploadSimulator(client)
            drives = client.get_drives()
            if not drives:
                results.append(TestResult(
                    test_name="chunked_upload",
                    success=True,
                    duration_seconds=0,
                    metrics={'skipped': True, 'skip_reason': 'no writable drives'},
                ))
            else:
                size = 16 * 1024 * 1024
                files = [
                    upload_sim.generate_test_file(size, f"/tmp/ghosthub_load_{os.getpid()}_{i}.bin")
                    for i in range(min(args.clients, 2))
                ]
                try:
                    results.extend(upload_sim.run_concurrent_uploads(files, drives[0], max_concurrent=2))
                finally:
                    upload_sim.cleanup()

    if args.test in ['stream', 'all'] and video_urls:
        print("\n=== Running Streaming Test ===")
        sim = StreamingSimulator(client)
        stream_results = sim.run_concurrent_streams(
            video_urls, 
            num_clients=args.clients,
            duration_seconds=args.duration
        )
        results.extend(stream_results)
    
    if args.test in ['websocket', 'all']:
        print("\n=== Running WebSocket Spam Test ===")
        spammer = WebSocketSpammer(args.url, categories=categories)
        ws_results = spammer.run_spam_test(
            num_clients=args.clients,
            duration_seconds=args.duration
        )
        results.extend(ws_results)
    
    if args.test in ['thumbnail', 'all'] and categories:
        print("\n=== Running Thumbnail Generation Test ===")
        thumb_test = ThumbnailStressTest(client)
        for cat in categories[:2]:  # Test first 2 categories
            result = thumb_test.trigger_thumbnail_generation(cat['id'])
            results.append(result)

    if args.test in ['browsing', 'all'] and categories:
        print("\n=== Running Media Browsing Storm ===")
        browse_sim = MediaBrowsingSimulator(client, categories)
        result = browse_sim.run_browsing_storm(
            num_clients=args.clients,
            duration_seconds=args.duration,
        )
        results.append(result)
    
    if args.test in ['sync', 'all'] and categories:
        print("\n=== Running Sync Mode Test ===")
        sync_sim = SyncModeSimulator(args.url)
        if sync_sim.setup_host(categories[0]['id']):
            for _ in range(min(args.clients, 10)):
                sync_sim.add_follower()
            result = sync_sim.simulate_navigation(
                categories[0]['id'],
                total_items=100,
                duration_seconds=args.duration
            )
            results.append(result)
            sync_sim.cleanup()
    
    if args.test in ['cast', 'all'] and video_urls:
        print("\n=== Running TV Casting Test ===")
        cast_sim = TVCastingSimulator(args.url)
        media_items = [{'url': url, 'type': 'video', 'category_id': 'test'} for url in video_urls]
        result = cast_sim.run_cast_cycles(media_items, num_cycles=10)
        results.append(result)
    
    # Save results
    save_results(results, args.output)
    
    # Print summary
    print("\n" + "=" * 60)
    print("LOAD TEST SUMMARY")
    print("=" * 60)
    
    successful = sum(1 for r in results if r.success)
    print(f"Tests passed: {successful}/{len(results)}")
    
    for r in results:
        status = "✓" if r.success else "✗"
        print(f"  {status} {r.test_name}: {r.duration_seconds:.1f}s, {r.requests_made} requests")
        if r.errors:
            print(f"      Errors: {r.errors[0]}")


if __name__ == '__main__':
    main()
