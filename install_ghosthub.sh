#!/bin/bash
set -e

# ==== CONFIGURATION ====
REPO_URL="https://github.com/BleedingXiko/GhostHub.git"
BRANCH="pi"
APP_DIR="$HOME/ghosthub"
PORT=5000
SSID="GhostHub"
PASSPHRASE="ghost123"   # Change if you want

# ==== UPDATE & DEPENDENCIES ====
echo "[*] Updating system..."
sudo apt update && sudo apt upgrade -y

echo "[*] Installing core dependencies..."
sudo apt install -y python3 python3-pip git avahi-daemon udevil hostapd dnsmasq netfilter-persistent iptables-persistent

# ==== ACCESS POINT MODE ====
echo "[*] Configuring static IP for wlan0..."
sudo tee /etc/dhcpcd.conf > /dev/null <<EOF
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
EOF

echo "[*] Creating dnsmasq config..."
sudo tee /etc/dnsmasq.conf > /dev/null <<EOF
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h
EOF

echo "[*] Creating hostapd config..."
sudo tee /etc/hostapd/hostapd.conf > /dev/null <<EOF
interface=wlan0
driver=nl80211
ssid=$SSID
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=$PASSPHRASE
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

sudo sed -i 's|#DAEMON_CONF="".*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

echo "[*] Enabling IP forwarding and NAT..."
sudo tee /etc/sysctl.d/routed-ap.conf > /dev/null <<EOF
net.ipv4.ip_forward=1
EOF

sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo netfilter-persistent save

echo "[*] Enabling AP and network services on boot..."
sudo systemctl unmask hostapd
sudo systemctl enable hostapd
sudo systemctl enable dnsmasq

# ==== CLONE GHOSTHUB ====
echo "[*] Cloning GhostHub Pi branch..."
if [ -d "$APP_DIR" ]; then
    echo "[*] GhostHub directory already exists, pulling latest..."
    cd $APP_DIR && git fetch origin $BRANCH && git checkout $BRANCH && git pull
else
    git clone --branch $BRANCH $REPO_URL $APP_DIR
fi

# ==== DOWNLOAD CLOUDFLARED TUNNEL BINARY (ARM64) ====
CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
CF_BIN="$APP_DIR/cloudflared"
if [ ! -f "$CF_BIN" ]; then
    echo "[*] Downloading cloudflared tunnel binary (for public sharing)..."
    curl -L "$CF_URL" -o "$CF_BIN"
    chmod +x "$CF_BIN"
    echo "[*] cloudflared downloaded to $CF_BIN (for public tunnel support)"
else
    echo "[*] cloudflared already present in $APP_DIR, skipping download."
fi

# ==== INSTALL PYTHON DEPENDENCIES ====
echo "[*] Installing Python dependencies from requirements.txt..."
cd $APP_DIR
pip3 install -r requirements.txt

# ==== SYSTEMD SERVICE FOR GHOSTHUB ====
echo "[*] Creating systemd service for GhostHub..."
sudo tee /etc/systemd/system/ghosthub.service > /dev/null <<EOF
[Unit]
Description=GhostHub Media Server (Native)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/ghosthub.py
Restart=always
User=$USER
Environment=PORT=$PORT
Environment=FLASK_CONFIG=production

[Install]
WantedBy=multi-user.target
EOF

echo "[*] Enabling and starting GhostHub service..."
sudo systemctl daemon-reexec
sudo systemctl enable ghosthub
sudo systemctl start ghosthub

# ==== AVAHI FOR .LOCAL ACCESS ====
echo "[*] Enabling Avahi daemon for ghosthub.local..."
sudo systemctl enable avahi-daemon
sudo systemctl start avahi-daemon

echo ""
echo "***************************************************************"
echo "✅ All done!"
echo "→ After reboot, connect to Wi-Fi SSID: $SSID (password: $PASSPHRASE)"
echo "→ Then visit: http://192.168.4.1:5000 OR http://ghosthub.local:5000"
echo "→ Plug in any USB drive; it will auto-mount and show up in GhostHub!"
echo "***************************************************************"
echo ""

sudo reboot