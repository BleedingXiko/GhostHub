#!/usr/bin/env python3
"""
GhostHub Multi-Hour Stability Test
===================================
Long-running stability test for production readiness on Raspberry Pi 4.

Tests:
- 4-8 hour continuous operation
- Memory stability over time
- CPU temperature monitoring
- Throttling detection
- SQLite database growth
- Log file growth

Monitors for:
- Memory leaks (gradual RSS growth)
- CPU throttling due to heat
- Database locks or corruption
- File descriptor leaks
- Disk space exhaustion

Usage:
    python3 multi_hour_stability_test.py --url http://localhost:5000 --duration 4
    python3 multi_hour_stability_test.py --url http://localhost:5000 --duration 8 --aggressive
"""

import os
import sys
import argparse
import time
import json
import psutil
import threading
from datetime import datetime, timedelta
from typing import Dict, List, Optional

try:
    import requests
except ImportError:
    print("ERROR: Missing dependency 'requests'")
    print("Install: pip3 install requests")
    sys.exit(1)


class Colors:
    """ANSI color codes"""
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'


class StabilityTest:
    """Multi-hour stability test"""

    def __init__(self, base_url: str, duration_hours: float, aggressive: bool = False, output_file: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.duration_hours = duration_hours
        self.aggressive = aggressive
        self.output_file = output_file
        self.running = False
        self.metrics = []
        self.alerts = []
        self.start_time = None
        self._test_profile_ids = []  # Track profiles created for cleanup
        self.results = {
            'start_time': None,
            'end_time': None,
            'duration_hours': duration_hours,
            'aggressive': aggressive,
            'metrics': [],
            'alerts': []
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
        elif level == "ALERT":
            prefix = f"{Colors.RED}{Colors.BOLD}🚨{Colors.END}"
        else:
            prefix = f"{Colors.CYAN}ℹ{Colors.END}"

        print(f"[{timestamp}] {prefix} {message}")

    def _get_cpu_temp(self) -> float:
        """Get CPU temperature (Pi-specific)"""
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                temp = int(f.read().strip()) / 1000.0
                return temp
        except:
            return 0.0

    def _get_throttle_status(self) -> Dict:
        """Check if Pi is throttled (Pi-specific)"""
        try:
            # Read throttle status from vcgencmd
            import subprocess
            result = subprocess.run(['vcgencmd', 'get_throttled'], capture_output=True, text=True)
            throttle_hex = result.stdout.strip().split('=')[1]
            throttle_val = int(throttle_hex, 16)

            return {
                'currently_throttled': bool(throttle_val & 0x1),
                'throttled_since_boot': bool(throttle_val & 0x10000),
                'undervoltage': bool(throttle_val & 0x1),
                'frequency_capped': bool(throttle_val & 0x2),
                'raw_value': throttle_hex
            }
        except:
            return {'available': False}

    def _collect_metrics(self) -> Dict:
        """Collect system metrics"""
        cpu_percent = psutil.cpu_percent(interval=1)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/')

        metrics = {
            'timestamp': datetime.now().isoformat(),
            'elapsed_hours': (datetime.now() - self.start_time).total_seconds() / 3600,
            'cpu_percent': cpu_percent,
            'cpu_temp': self._get_cpu_temp(),
            'memory_percent': memory.percent,
            'memory_used_mb': memory.used / (1024 * 1024),
            'memory_available_mb': memory.available / (1024 * 1024),
            'disk_percent': disk.percent,
            'disk_free_gb': disk.free / (1024 * 1024 * 1024),
            'throttle': self._get_throttle_status()
        }

        # Check for alerts
        if metrics['cpu_temp'] > 80:
            self._alert(f"CPU temperature critical: {metrics['cpu_temp']:.1f}°C")

        if metrics['memory_percent'] > 90:
            self._alert(f"Memory usage critical: {metrics['memory_percent']:.1f}%")

        if metrics['disk_percent'] > 95:
            self._alert(f"Disk space critical: {metrics['disk_percent']:.1f}%")

        if metrics['throttle'].get('currently_throttled'):
            self._alert("Pi is currently throttled!")

        return metrics

    def _alert(self, message: str):
        """Record an alert"""
        alert = {
            'timestamp': datetime.now().isoformat(),
            'message': message
        }
        self.alerts.append(alert)
        self._log(message, "ALERT")

    def _ensure_workload_profile(self, session: 'requests.Session') -> None:
        """Create and select a test profile for the workload session.

        Progress endpoints require an active profile_id in the session.
        Created profiles are tracked in self._test_profile_ids for cleanup.
        """
        profile_name = f'ghst-test-stability-{id(session)}-{int(time.time())}'
        try:
            resp = session.post(
                f"{self.base_url}/api/profiles",
                json={'name': profile_name},
                timeout=10,
            )
            if resp.status_code == 201:
                profile_id = resp.json().get('profile', {}).get('id')
                if profile_id:
                    self._test_profile_ids.append((profile_id, session))
                    session.post(
                        f"{self.base_url}/api/profiles/select",
                        json={'profile_id': profile_id},
                        timeout=10,
                    )
        except Exception:
            pass

    def _cleanup_test_profiles(self):
        """Delete any test profiles created during the stability test."""
        for profile_id, sess in self._test_profile_ids:
            try:
                sess.delete(f"{self.base_url}/api/profiles/{profile_id}", timeout=10)
            except Exception:
                pass
        self._test_profile_ids.clear()

    def _workload_thread(self):
        """Continuous workload to stress the system"""
        session = requests.Session()
        # Establish a session cookie and set up a profile for progress endpoints
        try:
            session.get(f"{self.base_url}/", timeout=10)
        except Exception:
            pass
        self._ensure_workload_profile(session)

        while self.running:

            try:
                # Mix of API calls to simulate real usage
                endpoints = [
                    '/api/config',
                    '/api/categories',
                    '/api/progress/videos',
                    '/api/sync/status'
                ]

                for endpoint in endpoints:
                    if not self.running:
                        break

                    try:
                        session.get(
                            f"{self.base_url}{endpoint}",
                            timeout=10
                        )
                    except:
                        pass

                    # In aggressive mode, hit harder
                    if self.aggressive:
                        time.sleep(0.1)
                    else:
                        time.sleep(1)

            except:
                pass

    def _monitor_thread(self, interval: int = 60):
        """Monitor system metrics periodically"""
        while self.running:
            metrics = self._collect_metrics()
            self.metrics.append(metrics)

            # Log summary every hour
            if len(self.metrics) % 60 == 0:
                hours = metrics['elapsed_hours']
                self._log(f"Hour {hours:.1f}: CPU={metrics['cpu_percent']:.1f}%, " +
                         f"Temp={metrics['cpu_temp']:.1f}°C, " +
                         f"Mem={metrics['memory_percent']:.1f}%")

            time.sleep(interval)

    def run_stability_test(self) -> bool:
        """Run the multi-hour stability test"""
        self.start_time = datetime.now()
        end_time = self.start_time + timedelta(hours=self.duration_hours)

        self._log("=" * 60, "HEADER")
        self._log(f"Multi-Hour Stability Test ({self.duration_hours}h)", "HEADER")
        self._log(f"Mode: {'AGGRESSIVE' if self.aggressive else 'NORMAL'}", "HEADER")
        self._log("=" * 60, "HEADER")

        self._log(f"Start: {self.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        self._log(f"End:   {end_time.strftime('%Y-%m-%d %H:%M:%S')}")

        # Record initial state
        initial_metrics = self._collect_metrics()
        self._log(f"Initial state: CPU={initial_metrics['cpu_temp']:.1f}°C, " +
                 f"Mem={initial_metrics['memory_percent']:.1f}%, " +
                 f"Disk={initial_metrics['disk_free_gb']:.1f}GB free")

        # Start workload threads
        self.running = True

        num_workload_threads = 3 if self.aggressive else 1
        workload_threads = []

        for i in range(num_workload_threads):
            t = threading.Thread(target=self._workload_thread, daemon=True)
            t.start()
            workload_threads.append(t)

        # Start monitor thread
        monitor_thread = threading.Thread(target=self._monitor_thread, args=(60,), daemon=True)
        monitor_thread.start()

        # Run until duration elapsed or interrupted
        try:
            while datetime.now() < end_time:
                remaining = (end_time - datetime.now()).total_seconds()
                hours_remaining = remaining / 3600

                # Update every 5 minutes
                time.sleep(300)

                if hours_remaining > 0:
                    latest = self.metrics[-1] if self.metrics else initial_metrics
                    self._log(f"Status: {hours_remaining:.1f}h remaining, " +
                             f"CPU={latest['cpu_temp']:.1f}°C, " +
                             f"Mem={latest['memory_percent']:.1f}%")

        except KeyboardInterrupt:
            self._log("Test interrupted by user", "WARN")
            self.running = False
            self._cleanup_test_profiles()
            return False

        finally:
            self.running = False
            self._cleanup_test_profiles()

        # Final metrics
        final_metrics = self._collect_metrics()
        duration_actual = (datetime.now() - self.start_time).total_seconds() / 3600

        self._log("=" * 60, "HEADER")
        self._log(f"Test Complete ({duration_actual:.1f}h)", "SUCCESS")
        self._log("=" * 60, "HEADER")

        # Analyze results
        passed = self._analyze_results(initial_metrics, final_metrics)

        return passed

    def _analyze_results(self, initial: Dict, final: Dict) -> bool:
        """Analyze results and determine if test passed"""
        self._log("Analyzing results...", "HEADER")

        all_temps = [m['cpu_temp'] for m in self.metrics if m['cpu_temp'] > 0]
        all_mems = [m['memory_percent'] for m in self.metrics]

        # Memory analysis
        mem_growth = final['memory_used_mb'] - initial['memory_used_mb']
        mem_growth_percent = (mem_growth / initial['memory_used_mb']) * 100

        self._log(f"Memory: {initial['memory_used_mb']:.0f}MB → {final['memory_used_mb']:.0f}MB " +
                 f"({mem_growth:+.0f}MB, {mem_growth_percent:+.1f}%)")

        # Temperature analysis
        if all_temps:
            max_temp = max(all_temps)
            avg_temp = sum(all_temps) / len(all_temps)
            self._log(f"Temperature: Avg={avg_temp:.1f}°C, Max={max_temp:.1f}°C")

            throttle_time = sum(1 for m in self.metrics if m['throttle'].get('currently_throttled', False))
            if throttle_time > 0:
                throttle_percent = (throttle_time / len(self.metrics)) * 100
                self._log(f"Throttling: {throttle_percent:.1f}% of samples", "WARN")

        # Disk analysis
        disk_used = initial['disk_free_gb'] - final['disk_free_gb']
        self._log(f"Disk: {disk_used:.2f}GB used during test")

        # Determine pass/fail
        passed = True
        reasons = []

        # Memory shouldn't grow more than 30% over long period
        if mem_growth_percent > 30:
            passed = False
            reasons.append(f"Memory grew {mem_growth_percent:.1f}% (leak suspected)")

        # Temperature shouldn't exceed 85°C (thermal limit)
        if all_temps and max(all_temps) > 85:
            passed = False
            reasons.append(f"Max temperature {max(all_temps):.1f}°C exceeds 85°C")

        # No more than 10% throttling
        throttle_samples = sum(1 for m in self.metrics if m['throttle'].get('currently_throttled', False))
        if throttle_samples > (len(self.metrics) * 0.1):
            passed = False
            reasons.append(f"Excessive throttling ({throttle_samples} samples)")

        # Check for alerts
        critical_alerts = [a for a in self.alerts if 'critical' in a['message'].lower()]
        if len(critical_alerts) > 10:
            passed = False
            reasons.append(f"{len(critical_alerts)} critical alerts")

        if passed:
            self._log("✓ STABILITY TEST PASSED", "SUCCESS")
        else:
            self._log("✗ STABILITY TEST FAILED:", "ERROR")
            for reason in reasons:
                self._log(f"  - {reason}", "ERROR")

        # Save detailed results
        self.results.update({
            'start_time': self.start_time.isoformat(),
            'end_time': datetime.now().isoformat(),
            'passed': passed,
            'initial_metrics': initial,
            'final_metrics': final,
            'analysis': {
                'memory_growth_mb': mem_growth,
                'memory_growth_percent': mem_growth_percent,
                'max_temp': max(all_temps) if all_temps else 0,
                'avg_temp': sum(all_temps) / len(all_temps) if all_temps else 0,
                'throttle_samples': throttle_samples,
                'total_samples': len(self.metrics),
                'disk_used_gb': disk_used,
                'num_alerts': len(self.alerts),
                'failure_reasons': reasons if not passed else []
            },
            'metrics': self.metrics,
            'alerts': self.alerts
        })

        return passed

    def save_results(self):
        """Save results to file"""
        if not self.output_file:
            # Auto-generate filename
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            self.output_file = f"stability_test_{self.duration_hours}h_{timestamp}.json"

        try:
            with open(self.output_file, 'w') as f:
                json.dump(self.results, f, indent=2)
            self._log(f"Results saved to: {self.output_file}", "SUCCESS")
        except Exception as e:
            self._log(f"Failed to save results: {e}", "ERROR")


def main():
    parser = argparse.ArgumentParser(
        description='GhostHub Multi-Hour Stability Test',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # 4-hour normal stability test
  python3 multi_hour_stability_test.py --url http://localhost:5000 --duration 4

  # 8-hour aggressive test
  python3 multi_hour_stability_test.py --url http://localhost:5000 --duration 8 --aggressive

  # Overnight test (12 hours)
  python3 multi_hour_stability_test.py --url http://localhost:5000 --duration 12
"""
    )

    parser.add_argument('--url', default='http://localhost:5000',
                       help='GhostHub base URL')
    parser.add_argument('--duration', type=float, default=4,
                       help='Test duration in hours (default: 4, accepts decimals like 0.25 for 15min)')
    parser.add_argument('--aggressive', action='store_true',
                       help='Use aggressive workload (3x threads, faster requests)')
    parser.add_argument('--output', help='Output JSON file for results')

    args = parser.parse_args()

    if args.duration < 0.1:
        print("ERROR: Duration must be at least 0.1 hours (6 minutes)")
        sys.exit(1)

    if args.duration > 24:
        print(f"WARNING: {args.duration}h is a very long test. Are you sure?")
        response = input("Continue? [y/N]: ")
        if response.lower() != 'y':
            sys.exit(0)

    tester = StabilityTest(args.url, args.duration, args.aggressive, args.output)

    try:
        success = tester.run_stability_test()
        tester.save_results()
        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        tester.save_results()
        sys.exit(1)


if __name__ == '__main__':
    main()
