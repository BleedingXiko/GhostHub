#!/bin/bash
#
# GhostHub Network Throughput Test
# ================================
# Measures network performance for both LAN and AP mode
# specifically for GhostHub media streaming workloads.
#

GHOSTHUB_URL="${GHOSTHUB_URL:-}"
OUTPUT_DIR="${OUTPUT_DIR:-./results}"
DURATION="${DURATION:-30}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[NET]${NC} $1"
}

# Auto-detect GhostHub URL
detect_ghosthub() {
    local urls=("$GHOSTHUB_URL" "http://192.168.4.1:5000" "http://192.168.4.1" "http://127.0.0.1:5000" "http://127.0.0.1" "http://localhost:5000" "http://localhost")
    
    for url in "${urls[@]}"; do
        [ -z "$url" ] && continue
        if curl -s -o /dev/null -w '' --connect-timeout 2 "$url/api/config" 2>/dev/null; then
            GHOSTHUB_URL="$url"
            log "Found GhostHub at: $GHOSTHUB_URL"
            return 0
        fi
    done
    
    echo -e "${RED}ERROR: Cannot reach GhostHub${NC}"
    exit 1
}

detect_ghosthub

mkdir -p "$OUTPUT_DIR"
RESULTS_FILE="$OUTPUT_DIR/network_test_$(date +%Y%m%d_%H%M%S).json"

echo "{"  > "$RESULTS_FILE"
echo '  "timestamp": "'$(date -Iseconds)'",' >> "$RESULTS_FILE"
echo '  "tests": {' >> "$RESULTS_FILE"

# Test 1: API Response Time
log "Testing API response times..."
API_TIMES=()
for i in $(seq 1 20); do
    TIME=$(curl -o /dev/null -s -w '%{time_total}' "$GHOSTHUB_URL/api/config")
    API_TIMES+=("$TIME")
done
AVG_API=$(echo "${API_TIMES[@]}" | tr ' ' '\n' | awk '{sum+=$1} END {print sum/NR}')
log "  Average API response: ${AVG_API}s"

echo '    "api_response": {' >> "$RESULTS_FILE"
echo "      \"avg_seconds\": $AVG_API," >> "$RESULTS_FILE"
echo "      \"samples\": 20" >> "$RESULTS_FILE"
echo '    },' >> "$RESULTS_FILE"

# Test 2: Download Throughput
log "Testing download throughput..."

# Get a video URL from categories
CATEGORY_ID=$(curl -s "$GHOSTHUB_URL/api/categories" | python3 -c "
import sys, json
data = json.load(sys.stdin)
cats = data.get('categories', [])
for cat in cats:
    if cat.get('containsVideo'):
        print(cat['id'])
        break
" 2>/dev/null)

if [ -n "$CATEGORY_ID" ]; then
    # Get first video
    VIDEO_INFO=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"requests\":[{\"view\":\"network_test\",\"viewKey\":\"network_test::$CATEGORY_ID\",\"category_id\":\"$CATEGORY_ID\",\"page\":1,\"limit\":20,\"media_filter\":\"video\",\"hydrate\":\"true\"}]}" \
        "$GHOSTHUB_URL/api/media/orders" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', [])
files = list((results[0].get('records') or {}).values()) if results else []
for f in files:
    if f.get('type') == 'video':
        print(f.get('url') or f.get('media_url') or '')
        break
" 2>/dev/null)
    
    if [ -n "$VIDEO_INFO" ]; then
        # Download test (first 50MB)
        log "  Downloading 50MB sample..."
        START_TIME=$(date +%s)
        curl -s -o /dev/null -r 0-52428800 "$GHOSTHUB_URL$VIDEO_INFO" 2>/dev/null
        END_TIME=$(date +%s)
        DURATION=$((END_TIME - START_TIME))
        [ "$DURATION" -eq 0 ] && DURATION=1
        DL_SPEED=$((50 / DURATION))
        log "  Download speed: ${DL_SPEED} MB/s"
        
        echo '    "download": {' >> "$RESULTS_FILE"
        echo "      \"speed_mbps\": $DL_SPEED," >> "$RESULTS_FILE"
        echo "      \"bytes_tested\": 52428800" >> "$RESULTS_FILE"
        echo '    },' >> "$RESULTS_FILE"
    else
        log "  No video found for download test"
        echo '    "download": { "error": "no_video_found" },' >> "$RESULTS_FILE"
    fi
else
    log "  No video category found"
    echo '    "download": { "error": "no_category_found" },' >> "$RESULTS_FILE"
fi

# Test 3: Concurrent Connection Test
log "Testing concurrent connections..."
PIDS=()
SUCCESS=0
for i in $(seq 1 20); do
    (curl -s -o /dev/null -w '%{http_code}' "$GHOSTHUB_URL/api/config" | grep -q "200" && echo "1" || echo "0") &
    PIDS+=($!)
done

for pid in "${PIDS[@]}"; do
    wait $pid
    if [ $? -eq 0 ]; then
        ((SUCCESS++))
    fi
done
log "  Concurrent success: $SUCCESS/20"

echo '    "concurrent": {' >> "$RESULTS_FILE"
echo "      \"successful\": $SUCCESS," >> "$RESULTS_FILE"
echo "      \"total\": 20" >> "$RESULTS_FILE"
echo '    },' >> "$RESULTS_FILE"

# Test 4: WebSocket Latency (if python-socketio available)
if python3 -c "import socketio" 2>/dev/null; then
    log "Testing WebSocket latency..."
    WS_LATENCY=$(python3 -c "
import socketio
import time

sio = socketio.Client()
latencies = []

@sio.event
def connect():
    pass

try:
    sio.connect('$GHOSTHUB_URL', transports=['websocket'], wait_timeout=5)
    for _ in range(10):
        start = time.time()
        sio.emit('join_chat')
        time.sleep(0.1)
        latencies.append((time.time() - start) * 1000)
    sio.disconnect()
    print(f'{sum(latencies)/len(latencies):.1f}')
except:
    print('0')
" 2>/dev/null)
    
    log "  WebSocket latency: ${WS_LATENCY}ms"
    echo '    "websocket_latency_ms": '"$WS_LATENCY"',' >> "$RESULTS_FILE"
else
    echo '    "websocket_latency_ms": null,' >> "$RESULTS_FILE"
fi

# Test 5: Network Interface Info
log "Collecting network interface info..."

# Get active interface
ACTIVE_IF=$(ip route | grep default | awk '{print $5}' | head -1)
if [ -n "$ACTIVE_IF" ]; then
    IP_ADDR=$(ip -4 addr show $ACTIVE_IF | grep inet | awk '{print $2}' | head -1)
    
    # Check if it's AP mode (hostapd running)
    if pgrep hostapd > /dev/null 2>&1; then
        NET_MODE="ap_mode"
    else
        NET_MODE="lan_mode"
    fi
    
    echo '    "network_info": {' >> "$RESULTS_FILE"
    echo "      \"interface\": \"$ACTIVE_IF\"," >> "$RESULTS_FILE"
    echo "      \"ip_address\": \"$IP_ADDR\"," >> "$RESULTS_FILE"
    echo "      \"mode\": \"$NET_MODE\"" >> "$RESULTS_FILE"
    echo '    }' >> "$RESULTS_FILE"
else
    echo '    "network_info": { "error": "no_interface" }' >> "$RESULTS_FILE"
fi

echo '  }' >> "$RESULTS_FILE"
echo '}' >> "$RESULTS_FILE"

echo ""
echo -e "${GREEN}Network test complete!${NC}"
echo "Results saved to: $RESULTS_FILE"
