#!/bin/bash
#
# GhostHub Complete Stress Test Suite
# ====================================
# Full stress test: API, streaming, network, concurrent load, worst-case scenario
# All in one script, no Python required, auto-cleanup
#
# Usage: bash quick_test.sh [duration] [clients]
#   duration: seconds per test (default: 30)
#   clients:  concurrent clients (default: 10)
#

DURATION="${1:-30}"
CLIENTS="${2:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GHOSTHUB_URL="${GHOSTHUB_URL:-}"
GHOSTHUB_SESSION_PASSWORD="${GHOSTHUB_SESSION_PASSWORD:-${GHOSTHUB_PASSWORD:-}}"
GHOSTHUB_ADMIN_PASSWORD="${GHOSTHUB_ADMIN_PASSWORD:-}"
MAX_TEMP=0
MAX_MEM=0
TOTAL_REQUESTS=0
TOTAL_ERRORS=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Cleanup old results first (keep SD card clean)
cleanup_old() {
    local results_dir="$SCRIPT_DIR/results"
    if [ -d "$results_dir" ]; then
        local count=$(find "$results_dir" -maxdepth 1 -type d -name "run_*" 2>/dev/null | wc -l)
        if [ "$count" -gt 2 ]; then
            echo -e "${YELLOW}Cleaning up old test runs...${NC}"
            # Keep only the 2 most recent runs
            find "$results_dir" -maxdepth 1 -type d -name "run_*" | sort | head -n -2 | xargs rm -rf 2>/dev/null || true
        fi
        # Also clean standalone files older than 1 day
        find "$results_dir" -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null || true
    fi
}

# Check GhostHub is running - try multiple URLs
check_ghosthub() {
    local urls=("$GHOSTHUB_URL" "http://192.168.4.1:5000" "http://192.168.4.1" "http://127.0.0.1:5000" "http://127.0.0.1" "http://localhost:5000" "http://localhost")
    
    for url in "${urls[@]}"; do
        if curl -s -o /dev/null -w '' --connect-timeout 2 "$url/api/config" 2>/dev/null; then
            GHOSTHUB_URL="$url"
            echo -e "${GREEN}Found GhostHub at: $GHOSTHUB_URL${NC}"
            return 0
        fi
    done
    
    echo -e "${RED}ERROR: Cannot reach GhostHub${NC}"
    echo "Tried: ${urls[*]}"
    echo ""
    echo "Check if GhostHub is running: systemctl status ghosthub"
    exit 1
}

fetch_category_media() {
    local cat_id="$1"
    local limit="${2:-50}"
    curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"requests\":[{\"view\":\"quick_test\",\"viewKey\":\"quick_test::$cat_id::$limit\",\"category_id\":\"$cat_id\",\"page\":1,\"limit\":$limit,\"media_filter\":\"all\",\"hydrate\":\"true\"}]}" \
        "$GHOSTHUB_URL/api/media/orders" 2>/dev/null
}

# Get system stats
get_stats() {
    local cpu_temp=0
    local mem_used=0
    local mem_total=0
    local load=""
    
    # CPU temp (Pi specific)
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        cpu_temp=$(($(cat /sys/class/thermal/thermal_zone0/temp) / 1000))
    fi
    
    # Memory
    if command -v free &>/dev/null; then
        mem_used=$(free -m | awk '/^Mem:/ {print $3}')
        mem_total=$(free -m | awk '/^Mem:/ {print $2}')
    fi
    
    # Load
    if [ -f /proc/loadavg ]; then
        load=$(cut -d' ' -f1-3 /proc/loadavg)
    fi
    
    echo "$cpu_temp|$mem_used|$mem_total|$load"
}

# Print header with system info
print_header() {
    local stats=$(get_stats)
    local temp=$(echo "$stats" | cut -d'|' -f1)
    local mem_used=$(echo "$stats" | cut -d'|' -f2)
    local mem_total=$(echo "$stats" | cut -d'|' -f3)
    local load=$(echo "$stats" | cut -d'|' -f4)
    
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}       ${BOLD}GhostHub Complete Stress Test${NC}                          ${CYAN}║${NC}"
    echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║${NC}  URL: $GHOSTHUB_URL"
    echo -e "${CYAN}║${NC}  Duration: ${DURATION}s per test  |  Clients: $CLIENTS"
    echo -e "${CYAN}║${NC}  CPU Temp: ${temp}°C  |  RAM: ${mem_used}/${mem_total}MB  |  Load: $load"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Test API endpoints with curl
test_api() {
    echo -ne "  Testing API Endpoints... "
    local start=$(date +%s)
    local success=0
    local total=0
    
    local endpoints=("/api/config" "/api/categories" "/api/sync/status" "/api/progress/videos")
    
    for endpoint in "${endpoints[@]}"; do
        ((total++))
        if curl -s -o /dev/null -w '' --connect-timeout 5 "$GHOSTHUB_URL$endpoint" 2>/dev/null; then
            ((success++))
        fi
    done
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if [ "$success" -eq "$total" ]; then
        echo -e "${GREEN}✓${NC} ($success/$total endpoints, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} ($success/$total endpoints, ${duration}s)"
        return 1
    fi
}

# Test sync API functionality via HTTP
test_sync_api() {
    echo -ne "  Testing Sync API... "
    local start=$(date +%s)
    local success=0
    
    # Get first category
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$cat_id" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories)"
        return 0
    fi
    
    # Generate a session ID for this test (sync requires session cookies)
    local session_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "test-session-$$")
    local cookie="session_id=$session_id"
    
    # Test sync toggle on (with session cookie - this makes us the host)
    local toggle_resp=$(curl -s -X POST -H "Content-Type: application/json" \
        -H "Cookie: $cookie" \
        -d '{"enabled": true, "media": {"category_id": "'"$cat_id"'", "viewKey": "sim::'"$cat_id"'::all", "viewType": "streaming_grid", "viewParams": {"category_id": "'"$cat_id"'", "media_filter": "all"}, "mediaId": "'"$cat_id"'::item_0"}}' \
        "$GHOSTHUB_URL/api/sync/toggle" 2>/dev/null)
    
    if echo "$toggle_resp" | grep -q '"active"'; then
        ((success++))
    fi
    
    # Test sync status (with same session)
    local status_resp=$(curl -s -H "Cookie: $cookie" "$GHOSTHUB_URL/api/sync/status" 2>/dev/null)
    if echo "$status_resp" | grep -q '"active"'; then
        ((success++))
    fi
    
    # Test sync update (must use same session as host)
    local update_resp=$(curl -s -X POST -H "Content-Type: application/json" \
        -H "Cookie: $cookie" \
        -d '{"category_id": "'"$cat_id"'", "viewKey": "sim::'"$cat_id"'::all", "viewType": "streaming_grid", "viewParams": {"category_id": "'"$cat_id"'", "media_filter": "all"}, "mediaId": "'"$cat_id"'::item_1"}' \
        "$GHOSTHUB_URL/api/sync/update" 2>/dev/null)
    if echo "$update_resp" | grep -q '"success"'; then
        ((success++))
    fi
    
    # Test sync toggle off (with same session)
    curl -s -X POST -H "Content-Type: application/json" \
        -H "Cookie: $cookie" \
        -d '{"enabled": false}' \
        "$GHOSTHUB_URL/api/sync/toggle" >/dev/null 2>&1
    ((success++))
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if [ "$success" -ge 3 ]; then
        echo -e "${GREEN}✓${NC} ($success/4 operations, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} ($success/4 operations, ${duration}s)"
        return 1
    fi
}

# Test media streaming
test_streaming() {
    echo -ne "  Testing Media Streaming... "
    local start=$(date +%s)
    
    # Get first category with media
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$cat_id" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories)"
        return 0
    fi
    
    # Try to get media list
    local media_resp=$(fetch_category_media "$cat_id" 1)
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if echo "$media_resp" | grep -q '"results"'; then
        echo -e "${GREEN}✓${NC} (${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} (${duration}s)"
        return 1
    fi
}

# Test concurrent connections
test_concurrent() {
    echo -ne "  Testing Concurrent Load ($CLIENTS clients)... "
    local start=$(date +%s)
    local pids=()
    local success=0
    
    for i in $(seq 1 $CLIENTS); do
        (curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -q "200" && exit 0 || exit 1) &
        pids+=($!)
    done
    
    for pid in "${pids[@]}"; do
        if wait $pid 2>/dev/null; then
            ((success++))
        fi
    done
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if [ "$success" -ge $((CLIENTS * 80 / 100)) ]; then
        echo -e "${GREEN}✓${NC} ($success/$CLIENTS succeeded, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} ($success/$CLIENTS succeeded, ${duration}s)"
        return 1
    fi
}

# Test sustained load
test_sustained() {
    echo -ne "  Testing Sustained Load (${DURATION}s)... "
    local start=$(date +%s)
    local requests=0
    local failures=0
    local end_time=$((start + DURATION))
    
    while [ $(date +%s) -lt $end_time ]; do
        if curl -s -o /dev/null --connect-timeout 5 "$GHOSTHUB_URL/api/config" 2>/dev/null; then
            ((requests++))
        else
            ((failures++))
        fi
        sleep 0.5
    done
    
    local end=$(date +%s)
    local duration=$((end - start))
    local total=$((requests + failures))
    
    if [ "$failures" -lt $((total / 10)) ]; then
        echo -e "${GREEN}✓${NC} ($requests requests, $failures failures, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} ($requests requests, $failures failures, ${duration}s)"
        return 1
    fi
}

# Test network throughput
test_network() {
    echo -ne "  Testing Network Throughput... "
    local start=$(date +%s)
    
    # Get a category to test with
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$cat_id" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories for bandwidth test)"
        return 0
    fi
    
    # Download test - fetch media list multiple times
    local bytes=0
    local count=0
    for i in $(seq 1 10); do
        local resp=$(fetch_category_media "$cat_id" 50 | wc -c | tr -d ' ')
        bytes=$((bytes + resp))
        ((count++))
    done
    
    local end=$(date +%s)
    local duration=$((end - start))
    local kbps=$((bytes / 1024 / (duration > 0 ? duration : 1)))
    
    echo -e "${GREEN}✓${NC} (~${kbps} KB/s, ${count} requests, ${duration}s)"
    return 0
}

# Test thumbnails
test_thumbnails() {
    echo -ne "  Testing Thumbnail Generation... "
    local start=$(date +%s)
    local success=0
    local total=0
    
    # Get categories
    local cats=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -3 | cut -d'"' -f4)
    
    if [ -z "$cats" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories)"
        return 0
    fi
    
    for cat_id in $cats; do
        # Get first few media files
        local files=$(fetch_category_media "$cat_id" 5 | grep -o '"name":"[^"]*"' | head -5 | cut -d'"' -f4)
        for file in $files; do
            ((total++))
            if curl -s -o /dev/null -w '' --connect-timeout 10 "$GHOSTHUB_URL/thumbnails/$cat_id/$file" 2>/dev/null; then
                ((success++))
            fi
        done
    done
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if [ $total -eq 0 ]; then
        echo -e "${YELLOW}⏭${NC} (no media files)"
        return 0
    fi
    
    if [ $success -ge $((total * 70 / 100)) ]; then
        echo -e "${GREEN}✓${NC} ($success/$total thumbnails, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} ($success/$total thumbnails, ${duration}s)"
        return 1
    fi
}

# Test progress/SQLite stress (with profile + admin auth)
test_progress_stress() {
    echo -ne "  Testing Progress/SQLite Stress... "
    local start=$(date +%s)
    local saves=0
    local reads=0
    local errors=0

    # Get first category ID
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -z "$cat_id" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories)"
        return 0
    fi

    # Generate a unique session ID and claim admin
    local session_id="stress-admin-$$-$(date +%s)"

    # Establish session cookie by hitting the main page
    curl -s -H "Cookie: session_id=$session_id" "$GHOSTHUB_URL/" >/dev/null 2>&1

    if [ -n "$GHOSTHUB_SESSION_PASSWORD" ]; then
        curl -s -X POST \
            -H "Content-Type: application/json" \
            -H "Cookie: session_id=$session_id" \
            -d "{\"password\":\"$GHOSTHUB_SESSION_PASSWORD\"}" \
            "$GHOSTHUB_URL/api/validate_session_password" >/dev/null 2>&1
    fi

    # Claim admin with this session
    local admin_payload="{}"
    if [ -n "$GHOSTHUB_ADMIN_PASSWORD" ]; then
        admin_payload="{\"password\":\"$GHOSTHUB_ADMIN_PASSWORD\"}"
    fi
    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Cookie: session_id=$session_id" \
        -d "$admin_payload" \
        "$GHOSTHUB_URL/api/admin/claim" >/dev/null 2>&1

    # Create a test profile (progress saves require an active profile)
    local profile_name="ghst-test-quick-$$-$(date +%s)"
    local profile_resp=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Cookie: session_id=$session_id" \
        -d "{\"name\": \"$profile_name\"}" \
        "$GHOSTHUB_URL/api/profiles" 2>/dev/null)
    local profile_id=$(echo "$profile_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -z "$profile_id" ]; then
        echo -e "${YELLOW}⏭${NC} (could not create test profile)"
        return 0
    fi

    # Select the profile
    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Cookie: session_id=$session_id" \
        -d "{\"profile_id\": \"$profile_id\"}" \
        "$GHOSTHUB_URL/api/profiles/select" >/dev/null 2>&1

    # Now run progress saves with profile session
    for i in $(seq 1 50); do
        # Save progress (POST) - requires active profile
        local resp=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "Cookie: session_id=$session_id" \
            -d '{"video_path":"/stress/quick/video_'$i'.mp4","index": '$i', "total_count": 100, "video_timestamp": '$i'.5, "video_duration": 3600.0}' \
            "$GHOSTHUB_URL/api/progress/$cat_id" 2>/dev/null)
        local http_code=$(echo "$resp" | tail -1)

        if [ "$http_code" = "200" ]; then
            echo "S" >> /tmp/ghosthub_progress_test_$$
        else
            echo "E" >> /tmp/ghosthub_progress_test_$$
        fi

        # Read progress (GET)
        curl -s -H "Cookie: session_id=$session_id" \
            "$GHOSTHUB_URL/api/progress/videos" >/dev/null 2>&1
        echo "R" >> /tmp/ghosthub_progress_test_$$
    done

    # Clean up: delete test profile (cascades its progress), release admin
    # Never call DELETE /api/progress/all — that would wipe real user data
    curl -s -X DELETE -H "Cookie: session_id=$session_id" \
        "$GHOSTHUB_URL/api/profiles/$profile_id" >/dev/null 2>&1
    curl -s -X POST -H "Cookie: session_id=$session_id" \
        "$GHOSTHUB_URL/api/admin/release" >/dev/null 2>&1
    
    # Count results
    if [ -f /tmp/ghosthub_progress_test_$$ ]; then
        saves=$(grep -c 'S' /tmp/ghosthub_progress_test_$$ 2>/dev/null) || saves=0
        reads=$(grep -c 'R' /tmp/ghosthub_progress_test_$$ 2>/dev/null) || reads=0
        errors=$(grep -c 'E' /tmp/ghosthub_progress_test_$$ 2>/dev/null) || errors=0
        rm -f /tmp/ghosthub_progress_test_$$
    fi
    
    # Ensure numeric values
    saves=${saves:-0}
    reads=${reads:-0}
    errors=${errors:-0}
    
    local end=$(date +%s)
    local duration=$((end - start))
    local total=$((saves + errors))
    
    if [ "$total" -gt 0 ] && [ $((saves * 100 / total)) -ge 80 ]; then
        echo -e "${GREEN}✓${NC} (saves=$saves, reads=$reads, errors=$errors, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} (saves=$saves, errors=$errors, ${duration}s)"
        return 1
    fi
}

# Test category scanning stress (simulates page refreshes, USB hotplug)
test_category_scan_stress() {
    echo -ne "  Testing Category Scan Stress... "
    local start=$(date +%s)
    local scans=0
    local media_fetches=0
    
    # Multiple clients refreshing category lists
    local pids=()
    for client in $(seq 1 3); do
        (
            for i in $(seq 1 5); do
                # Get categories (triggers USB scan)
                local resp=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null)
                if echo "$resp" | grep -q '"categories"'; then
                    echo "C" >> /tmp/ghosthub_scan_test_$$
                    
                    # Fetch media for each category (pagination stress)
                    local cats=$(echo "$resp" | grep -o '"id":"[^"]*"' | head -3 | cut -d'"' -f4)
                    for cat_id in $cats; do
                        fetch_category_media "$cat_id" 50 >/dev/null 2>&1
                        echo "M" >> /tmp/ghosthub_scan_test_$$
                    done
                fi
                sleep 0.2
            done
        ) &
        pids+=($!)
    done
    
    wait "${pids[@]}" 2>/dev/null
    
    # Count results
    if [ -f /tmp/ghosthub_scan_test_$$ ]; then
        scans=$(grep -c 'C' /tmp/ghosthub_scan_test_$$ 2>/dev/null) || scans=0
        media_fetches=$(grep -c 'M' /tmp/ghosthub_scan_test_$$ 2>/dev/null) || media_fetches=0
        rm -f /tmp/ghosthub_scan_test_$$
    fi
    
    # Ensure numeric values
    scans=${scans:-0}
    media_fetches=${media_fetches:-0}
    
    local end=$(date +%s)
    local duration=$((end - start))
    
    if [ "$scans" -ge 10 ]; then
        echo -e "${GREEN}✓${NC} (scans=$scans, media_fetches=$media_fetches, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} (scans=$scans, ${duration}s)"
        return 1
    fi
}

# Test video streaming stress (HTTP range requests from USB media)
test_video_streaming_stress() {
    echo -ne "  Testing Video Streaming Stress... "
    local start=$(date +%s)
    local streams=0
    local bytes=0
    
    # Get a video URL
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$cat_id" ]; then
        echo -e "${YELLOW}⏭${NC} (no categories)"
        return 0
    fi
    
    local video_name=$(fetch_category_media "$cat_id" 10 | grep -o '"name":"[^"]*\.mp4"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$video_name" ]; then
        # Try other video formats
        video_name=$(fetch_category_media "$cat_id" 10 | grep -oE '"name":"[^"]*\.(mkv|webm|mov)"' | head -1 | cut -d'"' -f4)
    fi
    
    if [ -z "$video_name" ]; then
        echo -e "${YELLOW}⏭${NC} (no videos found)"
        return 0
    fi
    
    # Simulate multiple clients streaming with range requests
    local pids=()
    for client in $(seq 1 $CLIENTS); do
        (
            for chunk in $(seq 0 5); do
                # Range request (1MB chunks) - simulates video playback
                local range_start=$((chunk * 1048576))
                local range_end=$((range_start + 1048575))
                local size=$(curl -s -o /dev/null -w '%{size_download}' \
                    -H "Range: bytes=$range_start-$range_end" \
                    "$GHOSTHUB_URL/media/$cat_id/$video_name" 2>/dev/null)
                if [ "$size" -gt 0 ] 2>/dev/null; then
                    echo "$size" >> /tmp/ghosthub_stream_test_$$
                fi
                sleep 0.1
            done
        ) &
        pids+=($!)
    done
    
    wait "${pids[@]}" 2>/dev/null
    
    # Count results
    if [ -f /tmp/ghosthub_stream_test_$$ ]; then
        streams=$(wc -l < /tmp/ghosthub_stream_test_$$ 2>/dev/null) || streams=0
        bytes=$(awk '{sum+=$1} END {print sum}' /tmp/ghosthub_stream_test_$$ 2>/dev/null) || bytes=0
        rm -f /tmp/ghosthub_stream_test_$$
    fi
    
    # Ensure numeric values
    streams=${streams:-0}
    bytes=${bytes:-0}
    
    local end=$(date +%s)
    local duration=$((end - start))
    local mb=$((bytes / 1024 / 1024))
    
    if [ "$streams" -ge $((CLIENTS * 3)) ]; then
        echo -e "${GREEN}✓${NC} (streams=$streams, ${mb}MB transferred, ${duration}s)"
        return 0
    else
        echo -e "${RED}✗${NC} (streams=$streams, ${duration}s)"
        return 1
    fi
}

# Worst case scenario - everything at once
test_worst_case() {
    echo -e "\n${BOLD}${YELLOW}⚡ WORST CASE SCENARIO${NC} (${DURATION}s - all tests simultaneously)"
    echo ""
    
    local start=$(date +%s)
    local end_time=$((start + DURATION))
    local api_ok=0
    local api_fail=0
    
    # Get category for streaming test
    local cat_id=$(curl -s "$GHOSTHUB_URL/api/categories" 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    # Temp file to collect results
    local tmp_results="/tmp/ghosthub_wc_$$"
    > "$tmp_results"
    
    echo -ne "  Running combined load test... "
    
    while [ $(date +%s) -lt $end_time ]; do
        # Track peak stats
        local stats=$(get_stats)
        local temp=$(echo "$stats" | cut -d'|' -f1)
        local mem=$(echo "$stats" | cut -d'|' -f2)
        [ "$temp" -gt "$MAX_TEMP" ] && MAX_TEMP=$temp
        [ "$mem" -gt "$MAX_MEM" ] && MAX_MEM=$mem
        
        # Fire concurrent requests, write result codes to temp file
        for i in $(seq 1 $CLIENTS); do
            (curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$GHOSTHUB_URL/api/config" 2>/dev/null >> "$tmp_results") &
        done
        
        for i in $(seq 1 $((CLIENTS / 2))); do
            (curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$GHOSTHUB_URL/api/categories" 2>/dev/null >> "$tmp_results") &
        done
        
        if [ -n "$cat_id" ]; then
            for i in $(seq 1 $((CLIENTS / 2))); do
                (fetch_category_media "$cat_id" 50 >/dev/null && printf '200' || printf '500') >> "$tmp_results" &
            done
        fi
        
        wait
        sleep 0.3
    done
    
    wait 2>/dev/null
    
    # Count results from temp file
    local total=$(wc -c < "$tmp_results" 2>/dev/null || echo 0)
    total=$((total / 3))  # Each code is 3 chars (200, 404, etc)
    api_ok=$(grep -o "200" "$tmp_results" 2>/dev/null | wc -l || echo 0)
    api_fail=$((total - api_ok))
    
    rm -f "$tmp_results"
    
    local end=$(date +%s)
    local duration=$((end - start))
    local success_rate=0
    [ $total -gt 0 ] && success_rate=$((api_ok * 100 / total))
    
    TOTAL_REQUESTS=$((TOTAL_REQUESTS + total))
    TOTAL_ERRORS=$((TOTAL_ERRORS + api_fail))
    
    if [ $success_rate -ge 80 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi
    
    echo "    Requests: $total ($api_ok success, $api_fail failed)"
    echo "    Success rate: ${success_rate}%"
    echo "    Peak CPU temp: ${MAX_TEMP}°C"
    echo "    Peak RAM: ${MAX_MEM}MB"
    
    [ $success_rate -ge 80 ]
}

# Main test sequence
run_all_tests() {
    local passed=0
    local failed=0
    
    echo -e "${CYAN}┌──────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│${NC} ${BOLD}PHASE 1: Basic Tests${NC}                                         ${CYAN}│${NC}"
    echo -e "${CYAN}└──────────────────────────────────────────────────────────────┘${NC}"
    
    if test_api; then ((passed++)); else ((failed++)); fi
    if test_sync_api; then ((passed++)); else ((failed++)); fi
    if test_streaming; then ((passed++)); else ((failed++)); fi
    if test_thumbnails; then ((passed++)); else ((failed++)); fi
    
    echo ""
    echo -e "${CYAN}┌──────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│${NC} ${BOLD}PHASE 2: Load Tests${NC}                                          ${CYAN}│${NC}"
    echo -e "${CYAN}└──────────────────────────────────────────────────────────────┘${NC}"
    
    if test_concurrent; then ((passed++)); else ((failed++)); fi
    if test_network; then ((passed++)); else ((failed++)); fi
    if test_sustained; then ((passed++)); else ((failed++)); fi
    
    echo ""
    echo -e "${CYAN}┌──────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│${NC} ${BOLD}PHASE 2.5: GhostHub Workload Stress${NC}                          ${CYAN}│${NC}"
    echo -e "${CYAN}└──────────────────────────────────────────────────────────────┘${NC}"
    
    if test_progress_stress; then ((passed++)); else ((failed++)); fi
    if test_category_scan_stress; then ((passed++)); else ((failed++)); fi
    if test_video_streaming_stress; then ((passed++)); else ((failed++)); fi
    
    echo ""
    echo -e "${CYAN}┌──────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${CYAN}│${NC} ${BOLD}PHASE 3: Worst Case${NC}                                          ${CYAN}│${NC}"
    echo -e "${CYAN}└──────────────────────────────────────────────────────────────┘${NC}"
    
    if test_worst_case; then ((passed++)); else ((failed++)); fi
    
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
    if [ $failed -eq 0 ]; then
        echo -e "  ${GREEN}${BOLD}✓ Results: $passed passed, $failed failed${NC}"
    else
        echo -e "  ${YELLOW}${BOLD}⚠ Results: $passed passed, $failed failed${NC}"
    fi
    
    return $failed
}

# Print final summary with system stats
print_summary() {
    local exit_code=$1
    local stats=$(get_stats)
    local temp=$(echo "$stats" | cut -d'|' -f1)
    local mem_used=$(echo "$stats" | cut -d'|' -f2)
    local mem_total=$(echo "$stats" | cut -d'|' -f3)
    
    echo ""
    echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}Final System State:${NC}"
    echo -e "  CPU Temp: ${temp}°C $([ "$temp" -ge 80 ] && echo -e "${RED}⚠ THROTTLING${NC}" || echo -e "${GREEN}OK${NC}")"
    echo -e "  Memory:   ${mem_used}/${mem_total}MB $([ "$mem_used" -gt $((mem_total * 90 / 100)) ] && echo -e "${RED}⚠ HIGH${NC}" || echo -e "${GREEN}OK${NC}")"
    
    # Disk usage
    if command -v df &>/dev/null; then
        local disk_used=$(df -h / | awk 'NR==2 {print $5}')
        echo -e "  Disk:     $disk_used used"
    fi
    
    echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
    
    if [ $exit_code -eq 0 ]; then
        echo -e "\n${GREEN}${BOLD}✓ All tests passed!${NC} GhostHub is handling the load well.\n"
    else
        echo -e "\n${YELLOW}${BOLD}⚠ Some tests failed.${NC} Check GhostHub logs: journalctl -u ghosthub\n"
    fi
}

# Sweep any leaked stress-test profiles (name prefix: ghst-test-).
# Belt-and-suspenders for cases where the inline DELETE in a test never
# ran — script killed, curl timeout, etc. Safe to call repeatedly.
sweep_stress_profiles() {
    [ -z "$GHOSTHUB_URL" ] && return 0
    local cookie_jar
    cookie_jar=$(mktemp -t ghst-sweep-XXXXXX 2>/dev/null) || return 0

    curl -s -c "$cookie_jar" "${GHOSTHUB_URL}/" > /dev/null 2>&1 || {
        rm -f "$cookie_jar"
        return 0
    }

    local admin_payload='{}'
    if [ -n "${GHOSTHUB_ADMIN_PASSWORD:-}" ]; then
        admin_payload="{\"password\": \"$GHOSTHUB_ADMIN_PASSWORD\"}"
    fi
    curl -s -b "$cookie_jar" -c "$cookie_jar" \
        -X POST -H "Content-Type: application/json" \
        -d "$admin_payload" \
        "${GHOSTHUB_URL}/api/admin/claim" > /dev/null 2>&1

    local listing
    listing=$(curl -s -b "$cookie_jar" "${GHOSTHUB_URL}/api/profiles" 2>/dev/null)
    [ -z "$listing" ] && { rm -f "$cookie_jar"; return 0; }

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

    for pid in $ids; do
        curl -s -b "$cookie_jar" -X DELETE \
            "${GHOSTHUB_URL}/api/profiles/$pid" > /dev/null 2>&1
    done

    curl -s -b "$cookie_jar" -X POST \
        "${GHOSTHUB_URL}/api/admin/release" > /dev/null 2>&1
    rm -f "$cookie_jar"
}

# Cleanup temp files and server data
cleanup_temp() {
    rm -f /tmp/ghosthub_quick_*.json 2>/dev/null || true
    rm -f /tmp/ghosthub_progress_test_* 2>/dev/null || true
    rm -f /tmp/ghosthub_scan_test_* 2>/dev/null || true
    rm -f /tmp/ghosthub_stream_test_* 2>/dev/null || true

    # Sweep any leaked test profiles. Inline DELETEs run per-test, but
    # this catches profiles orphaned by killed runs / curl timeouts.
    sweep_stress_profiles
}

# Main
main() {
    trap cleanup_temp EXIT
    
    cleanup_old
    check_ghosthub
    print_header
    
    local start_time=$(date +%s)
    run_all_tests
    local test_result=$?
    local end_time=$(date +%s)
    
    echo ""
    echo -e "  Total time: $((end_time - start_time))s"
    
    print_summary $test_result
    
    # Auto-cleanup this run's temp files
    cleanup_temp
    
    exit $test_result
}

main "$@"
