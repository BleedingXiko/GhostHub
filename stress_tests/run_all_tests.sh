#!/bin/bash
#
# GhostHub Master Test Suite
# ==========================
# Runs ALL stress tests in the correct order for release validation
#
# Usage:
#   ./run_all_tests.sh                 # Run everything with smart defaults
#   ./run_all_tests.sh --quick         # Skip long-running tests
#   ./run_all_tests.sh --password pass # With session password
#

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Configuration
GHOSTHUB_URL="${GHOSTHUB_URL:-http://localhost:5000}"
GHOSTHUB_SESSION_PASSWORD="${GHOSTHUB_SESSION_PASSWORD:-${GHOSTHUB_PASSWORD:-}}"
GHOSTHUB_ADMIN_PASSWORD="${GHOSTHUB_ADMIN_PASSWORD:-}"
RESULTS_DIR="./results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RUN_DIR="${RESULTS_DIR}/run_${TIMESTAMP}"
STATUS_FILE="${RUN_DIR}/status.tsv"
MODE="full"
DURATION_HOURS=0.25  # 15 minutes for stability test

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --password) GHOSTHUB_SESSION_PASSWORD="$2"; shift 2 ;;
        --session-password) GHOSTHUB_SESSION_PASSWORD="$2"; shift 2 ;;
        --admin-password) GHOSTHUB_ADMIN_PASSWORD="$2"; shift 2 ;;
        --url) GHOSTHUB_URL="$2"; shift 2 ;;
        --quick) MODE="quick"; DURATION_HOURS=0.1; shift ;;
        --full) MODE="full"; DURATION_HOURS=4; shift ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --password PASS    Legacy alias for --session-password"
            echo "  --session-password PASS"
            echo "                     Session password for password-protected devices"
            echo "  --admin-password PASS"
            echo "                     Admin password for admin-only cleanup/tests"
            echo "  --url URL          GhostHub URL (default: http://localhost:5000)"
            echo "  --quick            Skip long tests (~30 min total)"
            echo "  --full             Run full suite including 4h stability (~5+ hours)"
            echo "  --help             Show this help"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Auto-install requirements if needed. This runs after --help handling so help
# remains safe on offline targets.
if [ -f "${SCRIPT_DIR}/requirements.txt" ]; then
    echo "Checking test dependencies..."
    if ! python3 -c "import requests, socketio, psutil" 2>/dev/null; then
        echo "Installing test requirements..."
        pip3 install -q -r "${SCRIPT_DIR}/requirements.txt" || {
            echo "Warning: Failed to install requirements. Tests may fail."
        }
    fi
fi

# Helper functions
log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

# Sweep any leaked stress-test profiles (name prefix: ghst-test-).
# Every stress test in this directory tags its created profiles with that
# prefix so this single sweep catches leaks from killed runs, crashed tests,
# or any test whose own finally/cleanup didn't fire. Runs once before the
# suite (cleans prior runs) and again on EXIT (cleans this run).
sweep_stress_profiles() {
    local cookie_jar
    cookie_jar=$(mktemp -t ghst-sweep-XXXXXX 2>/dev/null) || return 0

    # Establish a session cookie
    curl -s -c "$cookie_jar" "${GHOSTHUB_URL}/" > /dev/null 2>&1 || {
        rm -f "$cookie_jar"
        return 0
    }

    # Claim admin so we can delete profiles owned by any session.
    local admin_payload='{}'
    if [ -n "$GHOSTHUB_ADMIN_PASSWORD" ]; then
        admin_payload="{\"password\": \"$GHOSTHUB_ADMIN_PASSWORD\"}"
    fi
    curl -s -b "$cookie_jar" -c "$cookie_jar" \
        -X POST -H "Content-Type: application/json" \
        -d "$admin_payload" \
        "${GHOSTHUB_URL}/api/admin/claim" > /dev/null 2>&1

    local listing
    listing=$(curl -s -b "$cookie_jar" "${GHOSTHUB_URL}/api/profiles" 2>/dev/null)
    if [ -z "$listing" ]; then
        rm -f "$cookie_jar"
        return 0
    fi

    # Extract {"id":"…","name":"ghst-test-…"} pairs without needing jq.
    local ids
    ids=$(python3 - "$listing" <<'PY' 2>/dev/null
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
for profile in (data.get('profiles') or []):
    name = profile.get('name') or ''
    pid = profile.get('id')
    if pid and name.startswith('ghst-test-'):
        print(pid)
PY
    )

    local deleted=0
    for pid in $ids; do
        if curl -s -b "$cookie_jar" -X DELETE \
            "${GHOSTHUB_URL}/api/profiles/$pid" > /dev/null 2>&1; then
            deleted=$((deleted + 1))
        fi
    done

    curl -s -b "$cookie_jar" -X POST \
        "${GHOSTHUB_URL}/api/admin/release" > /dev/null 2>&1
    rm -f "$cookie_jar"

    if [ "$deleted" -gt 0 ]; then
        log "Swept ${deleted} leaked stress-test profile(s)"
    fi
}

# Create results directory
mkdir -p "${RUN_DIR}"
: > "${STATUS_FILE}"

# Track results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

fail_prereq() {
    local name="$1"
    local reason="$2"
    local log_file="${RUN_DIR}/$(echo "$name" | tr ' (),/' '_____' | tr '[:upper:]' '[:lower:]').log"

    ((TOTAL_TESTS++))
    ((SKIPPED_TESTS++))
    printf '%s\n' "$reason" > "$log_file"
    printf '%s\t%s\t%s\n' "$name" "SKIPPED" "$log_file" >> "${STATUS_FILE}"
    warn "${name} SKIPPED (prerequisite missing)"
    warn "${reason}"
    warn "Full log saved to: $log_file"
}

run_test() {
    local name="$1"
    local cmd="$2"
    # Sanitize filename: replace spaces, parentheses, commas, slashes with underscores
    local log_file="${RUN_DIR}/$(echo $name | tr ' (),/' '_____' | tr '[:upper:]' '[:lower:]').log"

    ((TOTAL_TESTS++))
    echo ""
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    log "Test ${TOTAL_TESTS}: ${BOLD}${name}${NC}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # Run command, show output in real-time AND save to log
    # Use PIPESTATUS to get exit code from command, not tee
    set +e  # Don't exit on error
    eval "$cmd" 2>&1 | tee "$log_file"
    local exit_code=${PIPESTATUS[0]}
    local output_file
    output_file=$(printf '%s\n' "$cmd" | sed -n 's/.*--output \([^ ]*\).*/\1/p')
    local json_skipped=0
    if [ -n "$output_file" ] && [ -f "$output_file" ]; then
        json_skipped=$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(int(bool(data.get("skipped")) or any(t.get("skipped") for t in data.get("tests", []))))' "$output_file" 2>/dev/null || echo 0)
    fi
    # Note: We keep 'set +e' active so the script continues even if tests fail

    echo ""
    if [ "$json_skipped" -eq 1 ]; then
        warn "${name} SKIPPED"
        ((SKIPPED_TESTS++))
        printf '%s\t%s\t%s\n' "$name" "SKIPPED" "$log_file" >> "${STATUS_FILE}"
        return 0
    elif [ $exit_code -eq 0 ]; then
        success "${name} PASSED"
        ((PASSED_TESTS++))
        printf '%s\t%s\t%s\n' "$name" "PASSED" "$log_file" >> "${STATUS_FILE}"
        return 0
    else
        error "${name} FAILED (exit code: $exit_code)"
        error "Full log saved to: $log_file"
        ((FAILED_TESTS++))
        printf '%s\t%s\t%s\n' "$name" "FAILED" "$log_file" >> "${STATUS_FILE}"
        return 1
    fi
}

# Password flags for tests that need them.
SESSION_FLAG=""
ADMIN_FLAG=""
LEGACY_SESSION_FLAG=""
[[ -n "$GHOSTHUB_SESSION_PASSWORD" ]] && SESSION_FLAG="--session-password \"$GHOSTHUB_SESSION_PASSWORD\""
[[ -n "$GHOSTHUB_SESSION_PASSWORD" ]] && LEGACY_SESSION_FLAG="--password \"$GHOSTHUB_SESSION_PASSWORD\""
[[ -n "$GHOSTHUB_ADMIN_PASSWORD" ]] && ADMIN_FLAG="--admin-password \"$GHOSTHUB_ADMIN_PASSWORD\""
CRITICAL_FLAGS="${SESSION_FLAG} ${ADMIN_FLAG}"
ENHANCED_FLAGS="${SESSION_FLAG} ${ADMIN_FLAG}"
NETWORK_FLAGS="${SESSION_FLAG} ${ADMIN_FLAG}"
DISK_FLAGS="${LEGACY_SESSION_FLAG}"
WORST_FLAGS="${SESSION_FLAG} ${ADMIN_FLAG}"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║            GhostHub Complete Test Suite                   ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
log "Mode: ${MODE}"
log "URL: ${GHOSTHUB_URL}"
log "Session Password: $([ -n "$GHOSTHUB_SESSION_PASSWORD" ] && echo "Yes" || echo "No")"
log "Admin Password: $([ -n "$GHOSTHUB_ADMIN_PASSWORD" ] && echo "Yes" || echo "No")"
log "Results: ${RUN_DIR}"
echo ""

# Check GhostHub is running
log "Checking GhostHub connectivity..."
if ! curl -s -f "${GHOSTHUB_URL}/api/config" > /dev/null 2>&1; then
    error "Cannot connect to GhostHub at ${GHOSTHUB_URL}"
    error "Make sure it's running: python ghosthub.py"
    exit 1
fi
success "GhostHub is running"
echo ""

# Clean any leaked stress-test profiles from prior runs, and register a
# matching post-run sweep so EVERY exit path (success, failure, Ctrl-C,
# uncaught error) leaves the device with zero ghst-test-* profiles.
sweep_stress_profiles
trap 'sweep_stress_profiles' EXIT

# ============================================================================
# PHASE 1: Critical Limits (MUST PASS TO SHIP)
# ============================================================================
echo -e "${CYAN}${BOLD}PHASE 1: Critical Limits${NC} (required for release)"
echo "────────────────────────────────────────────────────────────"

run_test "16GB Upload Limit" \
    "python3 ${SCRIPT_DIR}/critical_limits_test.py --url ${GHOSTHUB_URL} ${CRITICAL_FLAGS} --test upload_limit --output ${RUN_DIR}/01_upload_limit.json"

run_test "Rate Limiting (50 Mbps/client, 100 Mbps global)" \
    "python3 ${SCRIPT_DIR}/critical_limits_test.py --url ${GHOSTHUB_URL} ${CRITICAL_FLAGS} --test rate_limit --duration 30 --output ${RUN_DIR}/02_rate_limit.json"

run_test "Memory Leak Detection" \
    "python3 ${SCRIPT_DIR}/critical_limits_test.py --url ${GHOSTHUB_URL} ${CRITICAL_FLAGS} --test memory_leak --output ${RUN_DIR}/03_memory_leak.json"

run_test "SQLite Write Contention" \
    "python3 ${SCRIPT_DIR}/critical_limits_test.py --url ${GHOSTHUB_URL} ${CRITICAL_FLAGS} --test sqlite_contention --duration 30 --output ${RUN_DIR}/04_sqlite.json"

echo ""

# ============================================================================
# PHASE 2: Upload Stress Tests
# ============================================================================
echo -e "${CYAN}${BOLD}PHASE 2: Upload Stress Tests${NC}"
echo "────────────────────────────────────────────────────────────"

run_test "Large File Upload (500MB)" \
    "python3 ${SCRIPT_DIR}/enhanced_upload_stress_test.py --url ${GHOSTHUB_URL} ${ENHANCED_FLAGS} --test large_file --size 500 --output ${RUN_DIR}/05_large_upload.json"

run_test "Concurrent Uploads (5 files)" \
    "python3 ${SCRIPT_DIR}/enhanced_upload_stress_test.py --url ${GHOSTHUB_URL} ${ENHANCED_FLAGS} --test concurrent --output ${RUN_DIR}/06_concurrent.json"

run_test "Upload Resume After Drops" \
    "python3 ${SCRIPT_DIR}/enhanced_upload_stress_test.py --url ${GHOSTHUB_URL} ${ENHANCED_FLAGS} --test resume --output ${RUN_DIR}/07_resume.json"

# Disk full test (if USB drive available)
if [ -d "/media/ghost" ] || [ -d "/media/usb" ] || [ -d "/mnt" ]; then
    TEST_DRIVE=$(find /media/ghost /media/usb /mnt -maxdepth 1 -type d ! -path /media/ghost ! -path /media/usb ! -path /mnt 2>/dev/null | head -n 1)
    if [ -n "$TEST_DRIVE" ]; then
        run_test "Disk Full Handling" \
            "python3 ${SCRIPT_DIR}/disk_full_test.py --url ${GHOSTHUB_URL} ${DISK_FLAGS} --test-drive ${TEST_DRIVE} --test all --output ${RUN_DIR}/08_disk_full.json"
    else
        fail_prereq "Disk Full Handling" "No writable test drive detected. Mount a USB/media drive before running release validation."
    fi
else
    fail_prereq "Disk Full Handling" "No eligible mount points found for disk-full validation."
fi

echo ""

# ============================================================================
# PHASE 3: Network Resilience
# ============================================================================
echo -e "${CYAN}${BOLD}PHASE 3: Network Resilience${NC}"
echo "────────────────────────────────────────────────────────────"

run_test "Network Drop Recovery (Uploads)" \
    "python3 ${SCRIPT_DIR}/network_drop_recovery_test.py --url ${GHOSTHUB_URL} ${NETWORK_FLAGS} --test upload_drop --drops 5 --output ${RUN_DIR}/09_net_upload.json"

run_test "WebSocket Reconnection" \
    "python3 ${SCRIPT_DIR}/network_drop_recovery_test.py --url ${GHOSTHUB_URL} ${NETWORK_FLAGS} --test websocket --drops 5 --output ${RUN_DIR}/10_websocket.json"

echo ""

# ============================================================================
# PHASE 4: WebSocket Stress
# ============================================================================
echo -e "${CYAN}${BOLD}PHASE 4: WebSocket Stress${NC}"
echo "────────────────────────────────────────────────────────────"

run_test "WebSocket Connection Stress" \
    "python3 ${SCRIPT_DIR}/websocket_stress_test.py --url ${GHOSTHUB_URL} --test all --output ${RUN_DIR}/11_ws_stress.json"

echo ""

# ============================================================================
# PHASE 5: Worst Case Scenario
# ============================================================================
echo -e "${CYAN}${BOLD}PHASE 5: Worst Case Scenario${NC}"
echo "────────────────────────────────────────────────────────────"

run_test "Worst Case (Everything at Once)" \
    "python3 ${SCRIPT_DIR}/worst_case_scenario.py --url ${GHOSTHUB_URL} ${WORST_FLAGS} --duration 60 --output ${RUN_DIR}/12_worst_case.json"

echo ""

# ============================================================================
# PHASE 6: Stability Test (Optional for quick mode)
# ============================================================================
if [ "$MODE" = "full" ]; then
    echo -e "${CYAN}${BOLD}PHASE 6: Long-Running Stability${NC}"
    echo "────────────────────────────────────────────────────────────"

    run_test "Stability Test (${DURATION_HOURS}h)" \
        "python3 ${SCRIPT_DIR}/multi_hour_stability_test.py --url ${GHOSTHUB_URL} --duration ${DURATION_HOURS} --output ${RUN_DIR}/13_stability.json"

    echo ""
elif [ "$MODE" = "quick" ]; then
    warn "Skipping long stability test (use --full to include)"
    echo ""
else
    echo -e "${CYAN}${BOLD}PHASE 6: Stability Test${NC}"
    echo "────────────────────────────────────────────────────────────"

    run_test "Quick Stability (15 min)" \
        "python3 ${SCRIPT_DIR}/multi_hour_stability_test.py --url ${GHOSTHUB_URL} --duration ${DURATION_HOURS} --output ${RUN_DIR}/13_stability.json"

    echo ""
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                      TEST SUMMARY                          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Tests:  ${TOTAL_TESTS}"
success "Passed:       ${PASSED_TESTS}"
warn "Skipped:      ${SKIPPED_TESTS}"
if [ $FAILED_TESTS -gt 0 ]; then
    error "Failed:       ${FAILED_TESTS}"
else
    echo -e "${GREEN}Failed:       0${NC}"
fi
echo ""
echo "Results saved to: ${RUN_DIR}"
echo ""

# Create summary file
if command -v python3 >/dev/null 2>&1; then
    DURATION_TEXT=$(python3 -c 'import sys; s=int(sys.argv[1]); print(f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}")' "$SECONDS" 2>/dev/null || echo "Unknown")
else
    DURATION_TEXT="Unknown"
fi

cat > "${RUN_DIR}/SUMMARY.txt" <<EOF
GhostHub Complete Test Suite
=================================
Run Date: $(date)
Mode: ${MODE}
Duration: ${DURATION_TEXT}

Configuration:
  URL: ${GHOSTHUB_URL}
  Session Password: $([ -n "$GHOSTHUB_SESSION_PASSWORD" ] && echo "Yes" || echo "No")
  Admin Password: $([ -n "$GHOSTHUB_ADMIN_PASSWORD" ] && echo "Yes" || echo "No")

Results:
  Total:  ${TOTAL_TESTS}
  Passed: ${PASSED_TESTS}
  Failed: ${FAILED_TESTS}
  Skipped: ${SKIPPED_TESTS}

Status: $([ $FAILED_TESTS -eq 0 ] && echo "READY FOR RELEASE" || echo "ISSUES FOUND")

Tests Run:
----------
1. Critical Limits
   - 16GB Upload Limit
   - Rate Limiting (50 Mbps/client, 100 Mbps global)
   - Memory Leak Detection
   - SQLite Write Contention

2. Upload Stress
   - Large File Upload (500MB)
   - Concurrent Uploads (5 files)
   - Upload Resume After Drops
   - Disk Full Handling (if USB drive available)

3. Network Resilience
   - Network Drop Recovery
   - WebSocket Reconnection

4. WebSocket Stress
   - Connection stress testing

5. Worst Case
   - Everything running simultaneously

6. Stability
   - $([ "$MODE" = "full" ] && echo "${DURATION_HOURS}h continuous operation" || echo "15 minute stability test")

$([ $FAILED_TESTS -gt 0 ] && echo "Failed Tests:" && awk -F '\t' '$2 == "FAILED" { print "  - " $1 " (" $3 ")" }' "${STATUS_FILE}")

Next Steps:
-----------
$([ $FAILED_TESTS -eq 0 ] && echo "All tests passed. Release packaging can be run from the project root with: ./venv/bin/python scripts/ghostpack.py --zip" || echo "Fix failing tests before release. Check logs in: ${RUN_DIR}")
EOF

cat "${RUN_DIR}/SUMMARY.txt"

# Final status
echo ""
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}${BOLD}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║  ALL TESTS PASSED - READY FOR RELEASE ║${NC}"
    echo -e "${GREEN}${BOLD}╚════════════════════════════════════════╝${NC}"
    echo ""
    log "Next: python scripts/ghostpack.py --zip"
    echo ""
    exit 0
else
    echo -e "${RED}${BOLD}╔════════════════════════════════════════╗${NC}"
    echo -e "${RED}${BOLD}║  SOME TESTS FAILED - NOT READY       ║${NC}"
    echo -e "${RED}${BOLD}╚════════════════════════════════════════╝${NC}"
    echo ""
    error "Fix failures before release"
    echo ""
    exit 1
fi
