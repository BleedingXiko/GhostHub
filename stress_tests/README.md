# GhostHub Stress Tests

## Quick Start

### Run ALL Tests (Recommended Before Release)
```bash
./run_all_tests.sh
```

This runs the full Pi hardware validation flow in the right order.
Required prerequisites now fail the run instead of being treated as green skips.

### With Session Password
```bash
export GHOSTHUB_SESSION_PASSWORD="your_session_password"
./run_all_tests.sh
```

Or:
```bash
./run_all_tests.sh --session-password "your_session_password"
```

`--password` is kept only as a legacy alias for `--session-password`.
It is not an admin password.

### With Admin Claim
Some workloads create uploads or test profiles and must be admin so they can
clean up safely. Provide the admin password separately:

```bash
./run_all_tests.sh \
  --session-password "your_session_password" \
  --admin-password "your_admin_password"
```

Or via env:

```bash
export GHOSTHUB_SESSION_PASSWORD="your_session_password"
export GHOSTHUB_ADMIN_PASSWORD="your_admin_password"
./run_all_tests.sh
```

If an admin-required workload cannot claim admin, it is recorded as `SKIPPED`
instead of running halfway and leaving files/profiles behind.

### Quick Mode (Skip Long Tests)
```bash
./run_all_tests.sh --quick
```

---

## What Gets Tested

The master test suite (`run_all_tests.sh`) runs **ALL** these tests:

### Phase 1: Critical Limits ⚠️ (MUST PASS)
- ✅ 16GB upload limit enforcement
- ✅ Rate limiting (50 Mbps/client, 100 Mbps global)
- ✅ Memory leak detection
- ✅ SQLite write contention (30+ concurrent writes)

### Phase 2: Upload Stress
- ✅ Large file upload (500MB)
- ✅ Concurrent uploads (5 files simultaneously)
- ✅ Upload resume after network drops
- ✅ Disk full handling

### Phase 3: Network Resilience
- ✅ Network drop recovery (uploads)
- ✅ WebSocket reconnection

### Phase 4: WebSocket Stress
- ✅ Connection stress testing
- ✅ WebSocket broadcast validation

### Phase 5: Worst Case
- ✅ Everything running at once

### Phase 6: Stability
- ✅ 15 minute continuous operation (default)
- ✅ 4 hour test (with `--full` flag)

---

## Individual Test Files

All these are run by `run_all_tests.sh`:

| File | What It Tests | Run Standalone |
|------|---------------|----------------|
| `critical_limits_test.py` | Upload limits, rate limiting, memory, SQLite | `python3 critical_limits_test.py --help` |
| `enhanced_upload_stress_test.py` | Large uploads, concurrent, resume | `python3 enhanced_upload_stress_test.py --help` |
| `disk_full_test.py` | Disk full handling | `python3 disk_full_test.py --help` |
| `network_drop_recovery_test.py` | Network resilience | `python3 network_drop_recovery_test.py --help` |
| `websocket_stress_test.py` | WebSocket stress | `python3 websocket_stress_test.py --help` |
| `worst_case_scenario.py` | Everything at once | `python3 worst_case_scenario.py --help` |
| `multi_hour_stability_test.py` | Long-running stability | `python3 multi_hour_stability_test.py --help` |

---

## Test Modes

### Quick Mode (~30 minutes)
```bash
./run_all_tests.sh --quick
```
- Skips 4-hour stability test
- Runs 6-minute stability instead
- Perfect for rapid validation

### Default Mode (~1-2 hours)
```bash
./run_all_tests.sh
```
- Runs all critical tests
- 15-minute stability test
- Recommended before release validation

### Full Mode (~5+ hours)
```bash
./run_all_tests.sh --full
```
- Everything in default mode
- Plus 4-hour stability test
- For final validation before major releases

---

## Results

All results saved to `results/run_YYYYMMDD_HHMMSS/`:
- `SUMMARY.txt` - Read this first!
- `*.log` - Individual test logs
- `*.json` - Structured test results

Important:
- `READY FOR RELEASE` means required hardware phases actually ran and passed.
- Missing prerequisites such as a mounted test drive, a required session password, or `python-socketio` will fail or skip according to the workload's safety rules.
- Admin-only setup/cleanup work must be run with `--admin-password`; otherwise those workloads skip.

### Check Release Readiness
```bash
cat results/run_*/SUMMARY.txt | grep Status
```

You'll see either:
- `READY FOR RELEASE` - All required tests passed
- `ISSUES FOUND` - Fix failures first

---

## Dependencies

Install required packages:
```bash
pip3 install -r requirements.txt
```

Required:
- `requests` - HTTP client
- `psutil` - System monitoring
- `python-socketio` - WebSocket client

---

## Troubleshooting

### "Cannot connect to GhostHub"
Make sure GhostHub is running:
```bash
python ghosthub.py
# OR
systemctl status ghosthub
```

### "Session password required"
Set the password:
```bash
export GHOSTHUB_SESSION_PASSWORD="your_session_password"
```

If `SESSION_PASSWORD` is active on the target device, the release suite fails unless you provide the password.

### "Admin is required"
Pass the admin password separately:
```bash
export GHOSTHUB_ADMIN_PASSWORD="your_admin_password"
```

Do not use `--password` for admin. `--password`/`GHOSTHUB_PASSWORD` is legacy
session-password compatibility only.

### "No USB drive detected"
Disk-full validation is required for hardware certification. Mount a writable USB/media drive first, then rerun the suite.

### Tests fail on Pi but pass locally
Check RAM tier; tests scale based on available memory.

---

## Other Scripts (Optional)

These are standalone utilities, NOT run by default:

- `quick_test.sh` - Bash-only smoke test (no Python required)
- `network_test.sh` - Network throughput testing
- `verify_tests.py` - Verify test infrastructure
- `generate_report.py` - Generate HTML reports from results

Standalone auth rules:
- `critical_limits_test.py`: `--session-password` and `--admin-password`
- `enhanced_upload_stress_test.py`: `--session-password` and `--admin-password`
- `network_drop_recovery_test.py`: `--session-password` and `--admin-password`
- `worst_case_scenario.py`: `--session-password` and `--admin-password`
- `disk_full_test.py`: `--password` is session password only
- `load_simulator.py`: `--password` is legacy session password; prefer `--session-password` plus `--admin-password`
- `quick_test.sh`: reads `GHOSTHUB_SESSION_PASSWORD` and `GHOSTHUB_ADMIN_PASSWORD`

Old scripts (archived):
- `_OLD_run_pre_launch_tests.sh` - Replaced by `run_all_tests.sh`
- `_OLD_run_stress_tests.sh` - Replaced by `run_all_tests.sh`
- `_OLD_run_all.sh` - Replaced by `run_all_tests.sh`

---

## Pre-Ship Checklist

Run this checklist:

1. ✅ **Code complete** - All features implemented
2. ✅ **Unit tests pass** - `python scripts/run_all_tests.py`
3. ✅ **Stress tests pass** - `./run_all_tests.sh` ← **DO THIS**
4. ✅ **Review results** - Check `SUMMARY.txt`
5. ✅ **Create package** - `python scripts/ghostpack.py --zip`
6. ✅ **Ship it!** 🚀

---

**TL;DR: Run `./run_all_tests.sh`, fix any prerequisite failures, and only trust `READY FOR RELEASE` after the required hardware phases actually ran.**
