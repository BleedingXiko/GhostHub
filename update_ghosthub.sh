#!/bin/bash
set -e

# ==== CONFIGURATION ====
REPO_URL="https://github.com/BleedingXiko/GhostHub.git"
BRANCH="pi"
APP_DIR="$HOME/ghosthub"
BACKUP_DIR="$HOME/ghosthub_backup_$(date +%Y%m%d_%H%M%S)"

echo "======================================"
echo "GhostHub Update Script"
echo "======================================"

# Check if GhostHub is installed
if [ ! -d "$APP_DIR" ]; then
    echo "[!] Error: GhostHub directory not found at $APP_DIR"
    echo "[!] Please run the install_ghosthub.sh script first."
    exit 1
fi

# ==== BACKUP CURRENT INSTALLATION ====
echo "[*] Creating backup of current installation..."
mkdir -p "$BACKUP_DIR"

# Backup instance folder (contains ghosthubconfig.json and other user data)
if [ -d "$APP_DIR/instance" ]; then
    echo "[*] Backing up instance folder..."
    cp -r "$APP_DIR/instance" "$BACKUP_DIR/instance"
else
    echo "[!] No instance directory found to backup."
fi

echo "[*] Backup created at $BACKUP_DIR"

# ==== STOP GHOSTHUB SERVICE ====
echo "[*] Stopping GhostHub service..."
sudo systemctl stop ghosthub || echo "[!] Warning: Could not stop GhostHub service."

# ==== UPDATE SYSTEM ====
echo "[*] Updating system packages..."
sudo apt update && sudo apt upgrade -y

# ==== UPDATE GHOSTHUB ====
echo "[*] Updating GhostHub from repository..."
cd "$APP_DIR"
git fetch origin "$BRANCH"
CURRENT_COMMIT=$(git rev-parse HEAD)
LATEST_COMMIT=$(git rev-parse origin/$BRANCH)

if [ "$CURRENT_COMMIT" = "$LATEST_COMMIT" ]; then
    echo "[*] GhostHub is already up to date."
else
    echo "[*] New updates found. Updating GhostHub..."
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
    
    # ==== UPDATE DEPENDENCIES ====
    echo "[*] Updating Python dependencies..."
    pip3 install -r requirements.txt --upgrade
    
    echo "[*] Update completed successfully."
fi

# ==== RESTORE DATA ====
echo "[*] Restoring user data if needed..."

# Restore instance folder (contains ghosthubconfig.json)
if [ -d "$BACKUP_DIR/instance" ]; then
    echo "[*] Restoring instance folder..."
    mkdir -p "$APP_DIR/instance"
    cp -r "$BACKUP_DIR/instance/"* "$APP_DIR/instance/" 2>/dev/null || echo "[!] No instance files to restore."
fi

# ==== RESTART GHOSTHUB SERVICE ====
echo "[*] Restarting GhostHub service..."
sudo systemctl daemon-reexec
sudo systemctl restart ghosthub

# ==== CHECK SERVICE STATUS ====
echo "[*] Checking GhostHub service status..."
sleep 3
if systemctl is-active --quiet ghosthub; then
    echo "[✓] GhostHub service is running."
else
    echo "[!] Warning: GhostHub service failed to start."
    echo "[!] Check logs with: sudo journalctl -u ghosthub -n 50"
fi

echo ""
echo "***************************************************************"
echo "✅ GhostHub update completed!"
echo "→ Your GhostHub is now running the latest version."
echo "→ Access it at: http://192.168.4.1:5000 OR http://ghosthub.local:5000"
echo "→ A backup of your data was created at: $BACKUP_DIR"
echo "***************************************************************"
echo ""

echo "Would you like to reboot the system now? (recommended) [y/N]"
read -r REBOOT
if [[ "$REBOOT" =~ ^[Yy]$ ]]; then
    echo "[*] Rebooting system..."
    sudo reboot
else
    echo "[*] Skipping reboot. You can reboot manually later with: sudo reboot"
fi
