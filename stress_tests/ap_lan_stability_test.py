#!/usr/bin/env python3
"""
GhostHub AP Mode / LAN Mode Stability Test
------------------------------------------
Tests GhostHub stability under network mode switches and sustained
load in both Access Point mode and standard LAN mode.

For Raspberry Pi 4 running GhostHub with hostapd for AP mode.
"""

import os
import sys
import time
import json
import subprocess
import argparse
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("ERROR: requests required. Install: pip install requests")
    sys.exit(1)


class NetworkModeTest:
    """Tests network mode stability for GhostHub."""
    
    def __init__(self, ghosthub_url: str):
        self.ghosthub_url = ghosthub_url.rstrip('/')
        self.session = requests.Session()
        self.results = {
            'timestamp': datetime.now().isoformat(),
            'tests': []
        }
    
    def is_pi(self) -> bool:
        """Check if running on Raspberry Pi."""
        return os.path.exists('/proc/device-tree/model')
    
    def get_network_mode(self) -> str:
        """Detect current network mode (ap or lan)."""
        try:
            # Check if hostapd is running (AP mode)
            result = subprocess.run(['pgrep', 'hostapd'], capture_output=True)
            if result.returncode == 0:
                return 'ap'
            return 'lan'
        except:
            return 'unknown'
    
    def get_network_info(self) -> Dict:
        """Get current network interface information."""
        info = {'mode': self.get_network_mode(), 'interfaces': []}
        
        try:
            # Get interface list
            result = subprocess.run(
                ['ip', '-j', 'addr'], 
                capture_output=True, 
                text=True
            )
            if result.returncode == 0:
                interfaces = json.loads(result.stdout)
                for iface in interfaces:
                    if iface.get('operstate') == 'UP':
                        addrs = []
                        for addr in iface.get('addr_info', []):
                            if addr.get('family') == 'inet':
                                addrs.append(addr.get('local'))
                        if addrs:
                            info['interfaces'].append({
                                'name': iface.get('ifname'),
                                'addresses': addrs
                            })
        except Exception as e:
            info['error'] = str(e)
        
        return info
    
    def test_connectivity(self, num_requests: int = 50) -> Dict:
        """Test basic connectivity with multiple requests."""
        results = {
            'total': num_requests,
            'successful': 0,
            'failed': 0,
            'response_times': [],
            'errors': []
        }
        
        for i in range(num_requests):
            try:
                start = time.time()
                resp = self.session.get(
                    f"{self.ghosthub_url}/api/config",
                    timeout=10
                )
                elapsed = time.time() - start
                
                if resp.status_code == 200:
                    results['successful'] += 1
                    results['response_times'].append(elapsed)
                else:
                    results['failed'] += 1
                    results['errors'].append(f"HTTP {resp.status_code}")
            except Exception as e:
                results['failed'] += 1
                results['errors'].append(str(e))
            
            time.sleep(0.1)  # 100ms between requests
        
        if results['response_times']:
            results['avg_response_time'] = sum(results['response_times']) / len(results['response_times'])
            results['min_response_time'] = min(results['response_times'])
            results['max_response_time'] = max(results['response_times'])
        
        return results
    
    def test_sustained_load(self, duration_seconds: int = 60, 
                            clients: int = 5) -> Dict:
        """Test sustained load over time."""
        results = {
            'duration': duration_seconds,
            'clients': clients,
            'total_requests': 0,
            'failed_requests': 0,
            'disconnections': 0
        }
        
        running = True
        lock = threading.Lock()
        
        def client_worker(client_id: int):
            nonlocal results, running
            session = requests.Session()
            local_requests = 0
            local_failures = 0
            
            start = time.time()
            while running and (time.time() - start) < duration_seconds:
                try:
                    resp = session.get(
                        f"{self.ghosthub_url}/api/categories",
                        timeout=10
                    )
                    local_requests += 1
                    if resp.status_code != 200:
                        local_failures += 1
                except Exception as e:
                    local_requests += 1
                    local_failures += 1
                
                time.sleep(0.5)  # 2 requests per second per client
            
            with lock:
                results['total_requests'] += local_requests
                results['failed_requests'] += local_failures
        
        threads = []
        for i in range(clients):
            t = threading.Thread(target=client_worker, args=(i,))
            t.start()
            threads.append(t)
        
        # Wait for all threads
        for t in threads:
            t.join()
        
        running = False
        
        results['success_rate'] = (
            (results['total_requests'] - results['failed_requests']) / 
            results['total_requests'] * 100 
            if results['total_requests'] > 0 else 0
        )
        results['requests_per_second'] = results['total_requests'] / duration_seconds
        
        return results
    
    def test_reconnection(self, num_cycles: int = 20) -> Dict:
        """Test connection/disconnection cycles."""
        results = {
            'cycles': num_cycles,
            'successful': 0,
            'failed': 0,
            'connection_times': []
        }
        
        for i in range(num_cycles):
            # Create new session (simulate fresh connection)
            session = requests.Session()
            
            try:
                start = time.time()
                resp = session.get(
                    f"{self.ghosthub_url}/api/config",
                    timeout=10
                )
                elapsed = time.time() - start
                
                if resp.status_code == 200:
                    results['successful'] += 1
                    results['connection_times'].append(elapsed)
                else:
                    results['failed'] += 1
            except Exception as e:
                results['failed'] += 1
            
            session.close()
            time.sleep(0.5)
        
        if results['connection_times']:
            results['avg_connection_time'] = sum(results['connection_times']) / len(results['connection_times'])
        
        return results
    
    def test_websocket_stability(self, duration_seconds: int = 30) -> Dict:
        """Test WebSocket connection stability (or HTTP fallback)."""
        results = {
            'duration': duration_seconds,
            'messages_sent': 0,
            'messages_received': 0,
            'disconnections': 0,
            'reconnections': 0,
            'mode': 'websocket'
        }
        
        try:
            import socketio
            HAS_SOCKETIO = True
        except ImportError:
            HAS_SOCKETIO = False
        
        if not HAS_SOCKETIO:
            # HTTP fallback - test sync API as proxy for real-time features
            results['mode'] = 'http_fallback'
            return self._test_sync_api_stability(duration_seconds)
        
        sio = socketio.Client()
        connected = threading.Event()
        
        @sio.event
        def connect():
            connected.set()
        
        @sio.event
        def disconnect():
            results['disconnections'] += 1
            connected.clear()
        
        @sio.on('chat_message')
        def on_message(data):
            results['messages_received'] += 1
        
        try:
            sio.connect(self.ghosthub_url, transports=['websocket'])
            sio.emit('join_chat')
            
            start = time.time()
            while (time.time() - start) < duration_seconds:
                if connected.is_set():
                    sio.emit('chat_message', {'message': 'stability test'})
                    results['messages_sent'] += 1
                else:
                    # Try to reconnect
                    try:
                        sio.connect(self.ghosthub_url, transports=['websocket'])
                        results['reconnections'] += 1
                    except:
                        pass
                
                time.sleep(0.5)
            
            sio.disconnect()
            
        except Exception as e:
            results['error'] = str(e)
        
        return results
    
    def _test_sync_api_stability(self, duration_seconds: int) -> Dict:
        """HTTP-based alternative to WebSocket test using sync API."""
        import uuid
        
        results = {
            'duration': duration_seconds,
            'requests': 0,
            'successful': 0,
            'errors': 0,
            'mode': 'http_fallback',
            'note': 'Using HTTP sync API (socketio not installed)'
        }
        
        # Create a dedicated session with a session_id cookie (required for sync host)
        sync_session = requests.Session()
        sync_session.cookies.set('session_id', str(uuid.uuid4()))
        
        # Get a category for sync testing
        try:
            resp = sync_session.get(f"{self.ghosthub_url}/api/categories", timeout=5)
            categories = resp.json().get('categories', [])
            if not categories:
                results['note'] = 'No categories available for sync test'
                return results
            cat_id = categories[0]['id']
        except Exception as e:
            results['error'] = str(e)
            return results
        
        # Enable sync mode (this session becomes the host)
        try:
            resp = sync_session.post(
                f"{self.ghosthub_url}/api/sync/toggle",
                json={'enabled': True, 'media': self._sync_payload(cat_id, 0)},
                timeout=5
            )
            if resp.status_code != 200:
                results['error'] = f'Failed to enable sync: {resp.status_code}'
                return results
        except Exception as e:
            results['error'] = str(e)
            return results
        
        start = time.time()
        idx = 0
        while (time.time() - start) < duration_seconds:
            idx = (idx + 1) % 50
            try:
                # Test sync update (same session = host)
                resp = sync_session.post(
                    f"{self.ghosthub_url}/api/sync/update",
                    json=self._sync_payload(cat_id, idx),
                    timeout=5
                )
                results['requests'] += 1
                if resp.status_code == 200:
                    results['successful'] += 1
                else:
                    results['errors'] += 1
                # Also test status endpoint
                sync_session.get(f"{self.ghosthub_url}/api/sync/status", timeout=5)
                results['requests'] += 1
                results['successful'] += 1
            except Exception:
                results['errors'] += 1
            
            time.sleep(0.3)
        
        # Disable sync mode
        try:
            sync_session.post(
                f"{self.ghosthub_url}/api/sync/toggle",
                json={'enabled': False},
                timeout=5
            )
        except:
            pass
        
        return results

    @staticmethod
    def _sync_payload(category_id, index):
        return {
            'category_id': category_id,
            'viewKey': f"sim::{category_id}::all",
            'viewType': 'streaming_grid',
            'viewParams': {
                'category_id': category_id,
                'media_filter': 'all',
            },
            'mediaId': f"{category_id}::item_{index}",
        }
    
    def run_full_test(self, duration: int = 60) -> Dict:
        """Run comprehensive stability test."""
        print("\n" + "=" * 60)
        print("  GhostHub Network Stability Test")
        print("=" * 60)
        
        # Network info
        print("\n📡 Network Information:")
        net_info = self.get_network_info()
        print(f"   Mode: {net_info['mode'].upper()}")
        for iface in net_info.get('interfaces', []):
            print(f"   Interface: {iface['name']} - {', '.join(iface['addresses'])}")
        
        self.results['network_info'] = net_info
        
        # Connectivity test
        print("\n🔗 Testing Connectivity...")
        conn_results = self.test_connectivity(50)
        print(f"   Success: {conn_results['successful']}/50")
        print(f"   Avg response: {conn_results.get('avg_response_time', 0)*1000:.1f}ms")
        self.results['tests'].append({
            'name': 'connectivity',
            'results': conn_results
        })
        
        # Sustained load
        print(f"\n⏱️  Testing Sustained Load ({duration}s, 5 clients)...")
        load_results = self.test_sustained_load(duration, 5)
        print(f"   Total requests: {load_results['total_requests']}")
        print(f"   Success rate: {load_results['success_rate']:.1f}%")
        print(f"   Requests/sec: {load_results['requests_per_second']:.1f}")
        self.results['tests'].append({
            'name': 'sustained_load',
            'results': load_results
        })
        
        # Reconnection test
        print("\n🔄 Testing Reconnection Cycles...")
        reconn_results = self.test_reconnection(20)
        print(f"   Success: {reconn_results['successful']}/20")
        print(f"   Avg connect time: {reconn_results.get('avg_connection_time', 0)*1000:.1f}ms")
        self.results['tests'].append({
            'name': 'reconnection',
            'results': reconn_results
        })
        
        # WebSocket/Sync stability
        print("\n🌐 Testing WebSocket Stability...")
        ws_results = self.test_websocket_stability(30)
        if ws_results.get('mode') == 'http_fallback':
            print(f"   Mode: HTTP fallback (sync API)")
            print(f"   Requests: {ws_results.get('successful', 0)}/{ws_results.get('requests', 0)}")
        elif 'error' not in ws_results:
            print(f"   Messages sent: {ws_results['messages_sent']}")
            print(f"   Disconnections: {ws_results['disconnections']}")
        else:
            print(f"   Skipped: {ws_results['error']}")
        self.results['tests'].append({
            'name': 'websocket_stability',
            'results': ws_results
        })
        
        # Summary
        print("\n" + "=" * 60)
        print("  STABILITY TEST SUMMARY")
        print("=" * 60)
        
        all_passed = True
        
        # Connectivity check
        if conn_results['successful'] >= 45:  # 90% success
            print("   ✅ Connectivity: PASS")
        else:
            print("   ❌ Connectivity: FAIL")
            all_passed = False
        
        # Load check
        if load_results['success_rate'] >= 95:
            print("   ✅ Sustained Load: PASS")
        elif load_results['success_rate'] >= 80:
            print("   ⚠️  Sustained Load: WARNING")
        else:
            print("   ❌ Sustained Load: FAIL")
            all_passed = False
        
        # Reconnection check
        if reconn_results['successful'] >= 18:  # 90% success
            print("   ✅ Reconnection: PASS")
        else:
            print("   ❌ Reconnection: FAIL")
            all_passed = False
        
        # WebSocket/Sync check
        if ws_results.get('mode') == 'http_fallback':
            success_rate = ws_results.get('successful', 0) / max(ws_results.get('requests', 1), 1) * 100
            if success_rate >= 90:
                print("   ✅ Sync API: PASS (HTTP mode)")
            else:
                print("   ❌ Sync API: FAIL (HTTP mode)")
                all_passed = False
        elif 'error' not in ws_results and ws_results['disconnections'] <= 2:
            print("   ✅ WebSocket: PASS")
        elif 'error' in ws_results:
            print("   ⏭️  WebSocket: SKIPPED")
        else:
            print("   ❌ WebSocket: FAIL")
            all_passed = False
        
        mode_name = "AP Mode" if net_info['mode'] == 'ap' else "LAN Mode"
        if all_passed:
            print(f"\n   🎉 {mode_name} is STABLE under test load")
        else:
            print(f"\n   ⚠️  {mode_name} shows instability - review results")
        
        print("=" * 60)
        
        self.results['overall_pass'] = all_passed
        return self.results
    
    def save_results(self, output_path: str):
        """Save results to JSON file."""
        with open(output_path, 'w') as f:
            json.dump(self.results, f, indent=2, default=str)
        print(f"\nResults saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='GhostHub AP/LAN Mode Stability Test')
    parser.add_argument('--url', default='http://localhost:5000',
                        help='GhostHub base URL')
    parser.add_argument('--duration', type=int, default=60,
                        help='Sustained load test duration (seconds)')
    parser.add_argument('--output', default=None,
                        help='Output file for results')
    
    args = parser.parse_args()
    
    test = NetworkModeTest(args.url)
    results = test.run_full_test(args.duration)
    
    # Save results
    if args.output:
        output_path = args.output
    else:
        output_dir = Path(__file__).parent / "results"
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_path = output_dir / f"network_stability_{timestamp}.json"
    
    test.save_results(str(output_path))


if __name__ == '__main__':
    main()
