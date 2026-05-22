#!/bin/bash
set -e

# ==== 1. GLOBAL CONFIGURATION ====
GHOSTHUB_VERSION="5.3.0"
GITHUB_REPO="${GITHUB_REPO:-BleedingXiko/GhostHub}"
ZIP_FILE="Ghosthub_pi_github.zip"
APP_DIR="/home/ghost/ghosthub"
BACKUP_DIR="$HOME/ghosthub_backup_$(date +%Y%m%d_%H%M%S)"
PORT=5000
SSID="GhostHub"
PASSPHRASE="ghost123"

# State Tracking
REBOOT_REQUIRED=false
REBOOT_REASONS=()
INSTALL_MODE=true
KEEP_INSTALLER=false
LOCAL_MODE=false
FORCE_UPDATE=false
LOCAL_ONLY=false
EXPLICIT_UPDATE=false
EXPLICIT_INSTALL=false
REQUESTED_VERSION=""
LOCAL_ZIP_PATH=""

# Resolve script path
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
INSTALL_LOCK_DIR="/tmp/ghosthub-install.lock"

# ==== 2. SHARED UTILITIES ====

fix_apt_mirrors() {
    sudo sed -i 's|http://mirror.web-ster.com/raspbian/raspbian|http://raspbian.raspberrypi.org/raspbian|g' /etc/apt/sources.list 2>/dev/null || true
    sudo sed -i 's|http://mirror.web-ster.com/raspbian/raspbian|http://raspbian.raspberrypi.org/raspbian|g' /etc/apt/sources.list.d/*.list 2>/dev/null || true
}

apt_install_robust() {
    local pkgs=("$@")
    fix_apt_mirrors
    sudo apt-get update -o Acquire::Retries=3
    if ! sudo apt-get install -y --fix-missing "${pkgs[@]}"; then
        fix_apt_mirrors
        sudo apt-get clean || true
        sudo apt-get update -o Acquire::Retries=3
        sudo apt-get install -y --fix-missing "${pkgs[@]}"
    fi
}

mark_reboot_required() {
    local reason="$1"
    REBOOT_REQUIRED=true
    REBOOT_REASONS+=("$reason")
    echo "[!] Reboot will be required: $reason"
}

file_was_modified() {
    local file="$1"
    local hash_before="$2"
    local hash_after=$(md5sum "$file" 2>/dev/null | cut -d' ' -f1)
    [ "$hash_before" != "$hash_after" ]
}

cleanup_old_backups() {
    echo "[*] Cleaning up old backups..."
    ls -d $HOME/ghosthub_backup_* 2>/dev/null | sort -r | tail -n +2 | xargs -r rm -rf
}

ensure_python_runtime() {
    local requirements_hash="$1"
    local needs_bootstrap=false

    if [ ! -x "$APP_DIR/venv/bin/python" ] || [ ! -x "$APP_DIR/venv/bin/pip" ]; then
        needs_bootstrap=true
    fi

    # Check gunicorn is actually importable, not just that the entry-point script exists.
    # A system Python upgrade can leave the binary in place while breaking the module.
    if [ ! -x "$APP_DIR/venv/bin/gunicorn" ] || ! "$APP_DIR/venv/bin/python" -c "import gunicorn" 2>/dev/null; then
        needs_bootstrap=true
    fi

    if $needs_bootstrap; then
        echo "[*] Python runtime missing or incomplete, rebuilding virtualenv..."
        rm -rf "$APP_DIR/venv"
        python3 -m venv "$APP_DIR/venv"
        "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --upgrade pip setuptools wheel toml
        echo "$requirements_hash" > "$APP_DIR/.requirements_hash"
        return 0
    fi

    return 1
}

self_delete_installer() {
    if $KEEP_INSTALLER; then return 0; fi
    [ -f "$SCRIPT_PATH" ] && rm -f "$SCRIPT_PATH" || true
}

# ==== 3. MODULAR SETUP FUNCTIONS ====

setup_base_dependencies() {
    echo "[*] Installing system dependencies..."
    echo iptables-persistent iptables-persistent/autosave_v4 boolean true | sudo debconf-set-selections
    echo iptables-persistent iptables-persistent/autosave_v6 boolean true | sudo debconf-set-selections
    apt_install_robust python3 python3-pip python3-venv python3-dev git ffmpeg avahi-daemon udevil hostapd dnsmasq netfilter-persistent iptables-persistent rfkill udisks2 unzip curl libjpeg-dev zlib1g-dev libfreetype6-dev liblcms2-dev libopenjp2-7-dev libtiff5-dev libwebp-dev mpv alsa-utils tailscale cec-utils python3-cec libudev-dev
}

setup_sqlite_tmpfs() {
    echo "[*] Configuring tmpfs for SQLite..."
    sudo mkdir -p /tmp/ghosthub_sqlite
    if ! grep -q "/tmp/ghosthub_sqlite" /etc/fstab; then
        echo "tmpfs /tmp/ghosthub_sqlite tmpfs size=64M,mode=1777 0 0" | sudo tee -a /etc/fstab
        sudo mount /tmp/ghosthub_sqlite 2>/dev/null || true
    fi
}

setup_sudoers() {
    echo "[*] Configuring detailed sudoers for ghost user..."
    sudo tee /etc/sudoers.d/ghosthub > /dev/null <<EOF
# Allow ghost user to remount USB drives without password (fixes read-only USB issues)
ghost ALL=(ALL) NOPASSWD: /bin/mount -o remount\,rw *
ghost ALL=(ALL) NOPASSWD: /bin/umount /media/*
# GitHub Releases update and system management
ghost ALL=(ALL) NOPASSWD: /usr/bin/bash $APP_DIR/install_ghosthub.sh *
ghost ALL=(ALL) NOPASSWD: /usr/bin/systemd-run *
ghost ALL=(ALL) NOPASSWD: /sbin/shutdown
ghost ALL=(ALL) NOPASSWD: /sbin/reboot
ghost ALL=(ALL) NOPASSWD: /bin/systemctl *
ghost ALL=(ALL) NOPASSWD: /sbin/ip *
ghost ALL=(ALL) NOPASSWD: /usr/sbin/hostapd_cli *
ghost ALL=(ALL) NOPASSWD: /usr/bin/wg*
ghost ALL=(ALL) NOPASSWD: $APP_DIR/headscale *
ghost ALL=(ALL) NOPASSWD: /usr/bin/tailscale *
ghost ALL=(ALL) NOPASSWD: /usr/bin/pkill *
ghost ALL=(ALL) NOPASSWD: /bin/cp /tmp/hostapd_temp.conf /etc/hostapd/hostapd.conf
EOF
    sudo chmod 440 /etc/sudoers.d/ghosthub
    sudo visudo -c -f /etc/sudoers.d/ghosthub || echo "[!] Warning: sudoers syntax check failed"
}

setup_tailscale() {
    if [ -f /etc/apt/sources.list.d/tailscale.list ] && ! $FORCE_UPDATE; then
        return 0
    fi
    echo "[*] Adding Tailscale repository..."
    # Detect distribution - defaulting to bullseye as per environment logs
    local DISTRO="bullseye"
    if [ -f /etc/os-release ]; then
        DISTRO=$(grep VERSION_CODENAME /etc/os-release | cut -d= -f2)
        [ -z "$DISTRO" ] && DISTRO=$(grep PRETTY_NAME /etc/os-release | grep -o 'bullseye' || echo "bullseye")
    fi
    
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/${DISTRO}.noarmor.gpg" | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/${DISTRO}.tailscale-keyring.list" | sudo tee /etc/apt/sources.list.d/tailscale.list
}

setup_display_system() {
    echo "[*] Configuring display subsystem via raspi-config..."
    
    # 1. Force Fake KMS (vc4-fkms-v3d)
    # DIAGNOSIS: vc4-kms-v3d (Full KMS) is failing to load /dev/dri on this device.
    # We are switching to Fake KMS which is often more stable on Bullseye Lite.
    local CFG="/boot/config.txt"
    [ ! -f "$CFG" ] && [ -f "/boot/firmware/config.txt" ] && CFG="/boot/firmware/config.txt"

    echo "[*] Enforcing Fake KMS (vc4-fkms-v3d) driver..."
    
    # Remove Full KMS if present
    if grep -q "dtoverlay=vc4-kms-v3d" "$CFG"; then
        sudo sed -i '/dtoverlay=vc4-kms-v3d/d' "$CFG"
    fi
    
    # Add Fake KMS if not present
    if ! grep -q "dtoverlay=vc4-fkms-v3d" "$CFG"; then
        echo "dtoverlay=vc4-fkms-v3d" | sudo tee -a "$CFG"
    fi
    
    # 2. Aggressive Cleanup and Customizations
    # We still need this to ensure other GhostHub-specific display settings are set
    echo "[*] Refining display optimizations in $CFG..."
    sudo sed -i '/disable_overscan=/d; /overscan_/d; /hdmi_force_hotplug=/d; /hdmi_drive=/d; /gpu_mem=/d; /max_framebuffers=/d; /config_hdmi_boost=/d; /disable_splash=/d' "$CFG"
    
    # Final verification
    if ! grep -q "dtoverlay=vc4-fkms-v3d" "$CFG"; then
        echo "dtoverlay=vc4-fkms-v3d" | sudo tee -a "$CFG"
    fi

    cat << EOF | sudo tee -a "$CFG"
disable_overscan=1
dtparam=audio=on
gpu_mem=256
max_framebuffers=2
disable_splash=1
EOF

    # 3. Ensure kernel modules aren't blacklisted (Common in some hardened images)
    echo "[*] Checking for module blacklists..."
    for f in /etc/modprobe.d/*.conf; do
        if [ -f "$f" ]; then
            sudo sed -i 's/^blacklist vc4/#blacklist vc4/g' "$f"
            sudo sed -i 's/^blacklist drm/#blacklist drm/g' "$f"
        fi
    done

    mark_reboot_required "Display subsystem reconfigured via raspi-config"
}

setup_audio_system() {
    echo "[*] Configuring persistent audio..."
    local CARD=$(aplay -l 2>/dev/null | grep -E "card [0-9]:.*(HDMI|vc4)" | head -1 | cut -d' ' -f2 | tr -d ':')
    [ -z "$CARD" ] && CARD=0
    
    cat << EOF | sudo tee /etc/asound.conf
defaults.pcm.card $CARD; defaults.ctl.card $CARD
pcm.!default { type hw card $CARD device 0 }
ctl.!default { type hw card $CARD }
EOF

    # Robust volume setting
    set_card_volume() {
        local c=$1; local v=$2
        for ctrl in 'Master' 'PCM' 'HDMI' 'Digital' 'Headphone'; do
            amixer -c $c sset "$ctrl" ${v}% unmute 2>/dev/null || true
        done
        amixer -c $c cset numid=1 ${v}% 2>/dev/null || true
    }
    set_card_volume $CARD 100
    [ "$CARD" != "0" ] && set_card_volume 0 100
    sudo alsactl store || true

    # Audio persistence service
    sudo tee /etc/systemd/system/ghosthub-audio.service > /dev/null <<'EOF'
[Unit]
Description=GhostHub Audio Persistence
After=sound.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 2 && for c in 0 1 2; do for ctrl in Master PCM HDMI Digital; do amixer -c $$c sset "$$ctrl" 100%% unmute 2>/dev/null || true; done; done && alsactl restore 2>/dev/null || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload && sudo systemctl enable ghosthub-audio.service
}

setup_silent_boot() {
    echo "[*] Configuring silent boot..."
    sudo apt-get install -y plymouth
    [ -f /boot/cmdline.txt ] && ! grep -q "quiet" /boot/cmdline.txt && sudo sed -i '1s/$/ quiet splash loglevel=3 logo.nologo vt.global_cursor_default=0/' /boot/cmdline.txt
    sudo update-initramfs -u || true
}

setup_console_lock() {
    echo "[*] Locking local console..."
    # Create the lock script
    sudo tee /usr/local/bin/ghosthub_console_lock.sh > /dev/null <<'EOF'
#!/bin/bash
if [ -z "$SSH_CONNECTION" ] && [ "$(tty)" = "/dev/tty1" ]; then
  clear
  printf '\e[2J\e[H'  # Clear screen and move cursor to top
  printf '\e[1;36m'   # Bright cyan
  cat << 'BANNER'
 ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗██╗  ██╗██╗   ██╗██████╗ 
██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝██║  ██║██║   ██║██╔══██╗
██║  ███╗███████║██║   ██║███████╗   ██║   ███████║██║   ██║██████╔╝
██║   ██║██╔══██║██║   ██║╚════██║   ██║   ██╔══██║██║   ██║██╔══██╗
╚██████╔╝██║  ██║╚██████╔╝███████║   ██║   ██║  ██║╚██████╔╝██████╔╝
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ 
BANNER
  printf '\e[0m'      # Reset color
  printf '\e[1;37m'   # Bright white
  printf '   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  printf '\e[0m'
  printf '\e[1;35m'   # Bright magenta
  printf '                     Your Personal Media Hub\n'
  printf '\e[0m\n'
  printf '\e[1;32m'   # Bright green
  printf '   ●  Ready to Cast\n'
  printf '\e[0m'
  printf '\e[90m'     # Dark gray
  printf '      Access \e[1;36mghosthub.local\e[0m and cast to TV\n\n'
  printf '\e[0m'
  stty -echo -icanon time 0 min 0; trap '' INT QUIT TSTP HUP
  while true; do sleep 3600; done
fi
EOF
    sudo chmod +x /usr/local/bin/ghosthub_console_lock.sh
    echo "/usr/local/bin/ghosthub_console_lock.sh" | sudo tee /etc/profile.d/ghosthub_console_lock.sh > /dev/null
    for TTY in 2 3 4 5 6 7; do sudo systemctl mask getty@tty${TTY}.service 2>/dev/null || true; done
}

configure_kiosk_and_hdmi() {
    echo "[*] Configuring GhostHub TV Kiosk..."
    
    # Auto-login setup
    sudo systemctl set-default multi-user.target
    sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
    sudo tee /etc/systemd/system/getty@tty1.service.d/override.conf > /dev/null <<EOL
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ghost --noclear %I $TERM
EOL

    # Ensure the runtime entry point is ready
    if [ ! -f "$APP_DIR/tv_runtime.py" ]; then
        # If ghostpack hasn't created a compiled entry point, link to source (Dev mode)
        ln -sf "$APP_DIR/app/services/system/display/native_tv_runtime.py" "$APP_DIR/tv_runtime.py"
    fi

    # GhostHub Kiosk Service (Formal systemd service)
    # This runs the entry point (ghostpacked or symlinked) which handles bytecode loading
    sudo tee /etc/systemd/system/ghosthub-kiosk.service > /dev/null <<EOF
[Unit]
Description=GhostHub TV Kiosk
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=$APP_DIR
Environment=GHOSTHUB_LOG_LEVEL=INFO
Environment=PYTHONUNBUFFERED=1
Environment=XDG_RUNTIME_DIR=/tmp
# Force switch to TTY7 to ensure visibility (standard RPi path)
ExecStartPre=-/bin/chvt 7
# Traditional TTY setup for DRM/VT control
StandardInput=tty
TTYPath=/dev/tty7
StandardOutput=journal
StandardError=journal
TTYReset=yes
TTYVTDisallocate=yes
# Launch the entry point wrapper
ExecStart=$APP_DIR/venv/bin/python $APP_DIR/tv_runtime.py
# Clean up mpv on stop and switch back to TTY1
ExecStopPost=-/usr/bin/pkill -u root -x mpv
ExecStopPost=-/usr/bin/chvt 1
Restart=on-failure
RestartSec=5
EOF

    # DRM Permissions for hardware acceleration
    sudo usermod -aG video ghost
    sudo usermod -aG render ghost 2>/dev/null || true
    sudo usermod -aG input ghost 2>/dev/null || true
    
    sudo tee /etc/udev/rules.d/50-drm.rules > /dev/null <<'EOF'
SUBSYSTEM=="drm", GROUP="video", MODE="0660"
KERNEL=="card[0-9]*", SUBSYSTEM=="drm", GROUP="video", MODE="0660"
KERNEL=="renderD*", SUBSYSTEM=="drm", GROUP="render", MODE="0660"
EOF
    
    # HDMI Hotplug (Simplified to just trigger server refresh if it wants)
    echo "[*] Setting up HDMI hotplug rules..."
    sudo tee /usr/local/bin/hdmi-handler.sh > /dev/null <<'EOF'
#!/bin/bash
# HDMI event detected, notify systemd if needed or just let the app handle it via udev
logger "GhostHub: HDMI hotplug event detected"
EOF
    sudo chmod +x /usr/local/bin/hdmi-handler.sh
    echo 'SUBSYSTEM=="drm", ACTION=="change", RUN+="/usr/local/bin/hdmi-handler.sh"' | sudo tee /etc/udev/rules.d/99-hdmi.rules
    
    sudo udevadm control --reload-rules && sudo udevadm trigger
    sudo systemctl daemon-reload
    # GhostHub Kiosk is managed manually by the application (UI Cast Button)
    sudo systemctl disable ghosthub-kiosk.service 2>/dev/null || true
}

handle_downloads() {
    if $LOCAL_MODE; then
        echo "[*] Skipping cloud downloads (Local Mode)"
        if [ ! -x "$APP_DIR/headscale" ]; then
            echo "[!] Local Mode: headscale binary is missing or not executable at $APP_DIR/headscale"
        fi
        return 0
    fi

    echo "[*] Handling binary downloads (cloudflared, headscale)..."
    # Always download binaries - they're required for the appliance to work
    local ARCH=$(uname -m)
    local CF_ARCH="arm"
    local DPKG_ARCH_CF=""
    DPKG_ARCH_CF=$(dpkg --print-architecture 2>/dev/null || echo "")
    if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
        CF_ARCH="arm64"
    elif [[ "$DPKG_ARCH_CF" == "armhf" || "$ARCH" == "armv7l" ]]; then
        CF_ARCH="armhf"
    fi
    
    local CF_BIN="$APP_DIR/cloudflared"
    if [ ! -f "$CF_BIN" ] || $FORCE_UPDATE; then
        echo "[*] Downloading cloudflared..."
        curl -L -o "$CF_BIN" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
        chmod +x "$CF_BIN"
        sudo ln -sf "$CF_BIN" /usr/local/bin/cloudflared
    fi

    local HS_VERSION="0.22.3"
    local HS_BIN="$APP_DIR/headscale"
    local HS_VER_FILE="$APP_DIR/.headscale_version"
    local hs_candidates=()
    local DPKG_ARCH
    DPKG_ARCH=$(dpkg --print-architecture 2>/dev/null || echo "")

    _hs_append_candidate() {
        local candidate="$1"
        [ -z "$candidate" ] && return 0
        for existing in "${hs_candidates[@]}"; do
            if [ "$existing" = "$candidate" ]; then
                return 0
            fi
        done
        hs_candidates+=("$candidate")
    }

    _hs_binary_works() {
        local bin="$1"
        [ -f "$bin" ] || return 1
        chmod +x "$bin" 2>/dev/null || true
        "$bin" version >/dev/null 2>&1
    }

    _hs_stage_from_asset() {
        local asset="$1"
        local src_file="$2"
        local stage_file="$3"
        local unpack_dir=""
        local extracted=""

        rm -f "$stage_file"

        if [[ "$asset" == *.deb ]]; then
            unpack_dir=$(mktemp -d)
            if ! dpkg-deb -x "$src_file" "$unpack_dir" >/dev/null 2>&1; then
                rm -rf "$unpack_dir"
                return 1
            fi
            for extracted in \
                "$unpack_dir/usr/bin/headscale" \
                "$unpack_dir/usr/local/bin/headscale"
            do
                if [ -f "$extracted" ]; then
                    cp "$extracted" "$stage_file"
                    break
                fi
            done
            rm -rf "$unpack_dir"
        elif [[ "$asset" == *.tar.gz ]] || [[ "$asset" == *.tgz ]]; then
            unpack_dir=$(mktemp -d)
            if ! tar -xzf "$src_file" -C "$unpack_dir" >/dev/null 2>&1; then
                rm -rf "$unpack_dir"
                return 1
            fi
            extracted=$(find "$unpack_dir" -type f -name headscale | head -n 1)
            [ -n "$extracted" ] && cp "$extracted" "$stage_file"
            rm -rf "$unpack_dir"
        else
            cp "$src_file" "$stage_file"
        fi

        [ -f "$stage_file" ] || return 1
        chmod +x "$stage_file" 2>/dev/null || true
        return 0
    }

    # Seed candidates for known naming patterns.
    case "$ARCH" in
        aarch64|arm64)
            _hs_append_candidate "headscale_${HS_VERSION}_linux_arm64.deb"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_arm64"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_arm64.tar.gz"
            ;;
        armv7l|armv6l|armhf)
            _hs_append_candidate "headscale_${HS_VERSION}_linux_armhf.deb"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_armv7.deb"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_armhf"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_armv7"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_arm"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_arm.tar.gz"
            ;;
        x86_64|amd64)
            _hs_append_candidate "headscale_${HS_VERSION}_linux_amd64.deb"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_amd64"
            _hs_append_candidate "headscale_${HS_VERSION}_linux_amd64.tar.gz"
            ;;
        *)
            _hs_append_candidate "headscale_${HS_VERSION}_linux_${ARCH}"
            ;;
    esac

    # Query the release API to get the exact asset names for this tag.
    local hs_api_json=""
    hs_api_json=$(curl -fsSL "https://api.github.com/repos/juanfont/headscale/releases/tags/v${HS_VERSION}" 2>/dev/null || true)
    if [ -n "$hs_api_json" ]; then
        local hs_arch_tokens=()
        case "$ARCH:$DPKG_ARCH" in
            aarch64:*|arm64:*|*:arm64)
                hs_arch_tokens=("arm64" "aarch64")
                ;;
            armv7l:*|armv6l:*|armhf:*|*:armhf)
                hs_arch_tokens=("armhf" "armv7" "armv6" "arm")
                ;;
            x86_64:*|amd64:*|*:amd64)
                hs_arch_tokens=("amd64" "x86_64")
                ;;
            *)
                hs_arch_tokens=("$ARCH")
                ;;
        esac

        local hs_asset=""
        while IFS= read -r hs_asset; do
            [[ "$hs_asset" == headscale_${HS_VERSION}_linux_* ]] || continue

            local token=""
            local token_match=false
            for token in "${hs_arch_tokens[@]}"; do
                if [[ "$hs_asset" == *"${token}"* ]]; then
                    token_match=true
                    break
                fi
            done

            if $token_match; then
                _hs_append_candidate "$hs_asset"
            fi
        done < <(printf '%s\n' "$hs_api_json" | grep -o '"name":[[:space:]]*"[^"]*"' | sed -E 's/"name":[[:space:]]*"([^"]*)"/\1/')
    fi

    local hs_current_version=""
    hs_current_version="$(cat "$HS_VER_FILE" 2>/dev/null || true)"
    local hs_current_valid=false
    if _hs_binary_works "$HS_BIN"; then
        hs_current_valid=true
    fi

    # Skip download when already on desired, runnable binary (unless forced).
    if $hs_current_valid && [ "$hs_current_version" = "$HS_VERSION" ] && ! $FORCE_UPDATE; then
        echo "[*] headscale already installed (v$HS_VERSION)"
        return 0
    fi

    local hs_candidate=""
    local hs_downloaded=false
    local hs_tmp=""
    local hs_stage_bin=""
    local hs_source=""

    for hs_candidate in "${hs_candidates[@]}"; do
        hs_tmp=$(mktemp)
        hs_stage_bin=$(mktemp)
        hs_source="https://github.com/juanfont/headscale/releases/download/v${HS_VERSION}/${hs_candidate}"

        echo "[*] Trying headscale asset: $hs_candidate"
        if ! curl -fL -o "$hs_tmp" "$hs_source"; then
            rm -f "$hs_tmp" "$hs_stage_bin"
            continue
        fi

        if ! _hs_stage_from_asset "$hs_candidate" "$hs_tmp" "$hs_stage_bin"; then
            rm -f "$hs_tmp" "$hs_stage_bin"
            continue
        fi

        if _hs_binary_works "$hs_stage_bin"; then
            command install -m 755 "$hs_stage_bin" "$HS_BIN"
            echo "$HS_VERSION" > "$HS_VER_FILE"
            sudo ln -sf "$HS_BIN" /usr/local/bin/headscale
            echo "[+] headscale downloaded successfully from $hs_candidate"
            hs_downloaded=true
            rm -f "$hs_tmp" "$hs_stage_bin"
            break
        fi

        echo "[!] WARNING: Asset $hs_candidate downloaded but is not runnable on this device."
        rm -f "$hs_tmp" "$hs_stage_bin"
    done

    if ! $hs_downloaded; then
        echo "[!] WARNING: Failed to download headscale v$HS_VERSION for ARCH=$ARCH DPKG_ARCH=$DPKG_ARCH"
        echo "[!] Attempted assets: ${hs_candidates[*]}"
        if $hs_current_valid; then
            echo "[!] Keeping existing runnable headscale binary at $HS_BIN (version marker: ${hs_current_version:-unknown})"
        else
            rm -f "$HS_BIN" "$HS_VER_FILE"
        fi
    fi
}

download_app_update() {
    if $LOCAL_MODE; then return 0; fi

    if [ -n "$LOCAL_ZIP_PATH" ]; then
        echo "[*] Using local ZIP: $LOCAL_ZIP_PATH"
        [ -f "$LOCAL_ZIP_PATH" ] && cp "$LOCAL_ZIP_PATH" "$ZIP_FILE" || { echo "[!] ZIP not found: $LOCAL_ZIP_PATH"; exit 1; }
    elif [ "$LOCAL_ONLY" == "true" ]; then
        echo "[*] Local only mode: expecting ZIP in /tmp/ghosthub_deploy.zip"
        [ -f "/tmp/ghosthub_deploy.zip" ] && cp "/tmp/ghosthub_deploy.zip" "$ZIP_FILE" || { echo "[!] ZIP not found"; exit 1; }
    else
        local RELEASE_PATH="latest/download"
        if [ -n "$REQUESTED_VERSION" ]; then
            RELEASE_PATH="download/$REQUESTED_VERSION"
            echo "[*] Downloading GhostHub $REQUESTED_VERSION from GitHub Releases..."
        else
            echo "[*] Downloading latest GhostHub from GitHub Releases..."
        fi
        local URL="https://github.com/${GITHUB_REPO}/releases/${RELEASE_PATH}/${ZIP_FILE}"
        curl -L -o "$ZIP_FILE" "$URL"
    fi

    if ! unzip -t "$ZIP_FILE" > /dev/null 2>&1; then
        echo "[!] Error: Invalid ZIP archive downloaded."
        exit 1
    fi
}

extract_app_update() {
    echo "[*] Extracting files to $APP_DIR..."
    local TMP_DIR=$(mktemp -d)
    unzip -o "$ZIP_FILE" -d "$TMP_DIR"

    if $INSTALL_MODE; then
        # Fresh install: clean wipe, preserve nothing
        echo "[*] Fresh install: wiping $APP_DIR before extraction..."
        find "$APP_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        if [ -d "$TMP_DIR/Ghosthub_pi_github" ]; then
            cp -a "$TMP_DIR/Ghosthub_pi_github/." "$APP_DIR/"
        else
            cp -a "$TMP_DIR/." "$APP_DIR/"
        fi
    elif [ -d "$TMP_DIR/Ghosthub_pi_github" ]; then
        # Update: preserve binaries, venv, and instance from previous install.
        for f in "$APP_DIR/headscale" "$APP_DIR/cloudflared" "$APP_DIR/.headscale_version"; do
            [ -f "$f" ] && mv "$f" "$TMP_DIR/Ghosthub_pi_github/" 2>/dev/null || true
        done
        [ -d "$APP_DIR/venv" ] && mv "$APP_DIR/venv" "$TMP_DIR/Ghosthub_pi_github/" 2>/dev/null || true
        echo "[*] Clearing stale app files before copying fresh package..."
        find "$APP_DIR" -mindepth 1 -maxdepth 1 \
            ! -name 'venv' ! -name 'instance' ! -name '.requirements_hash' \
            ! -name 'cloudflared' ! -name 'headscale' ! -name '.headscale_version' \
            -exec rm -rf {} +
        cp -a "$TMP_DIR/Ghosthub_pi_github/." "$APP_DIR/"
    else
        find "$APP_DIR" -mindepth 1 -maxdepth 1 \
            ! -name 'venv' ! -name 'instance' ! -name '.requirements_hash' \
            ! -name 'cloudflared' ! -name 'headscale' ! -name '.headscale_version' \
            -exec rm -rf {} +
        cp -a "$TMP_DIR/." "$APP_DIR/"
    fi
    rm -rf "$TMP_DIR"
    rm -f "$ZIP_FILE"
}

setup_services() {
    echo "[*] Configuring GhostHub services with stability hooks..."

    # Advanced Gunicorn Configuration
    sudo tee $APP_DIR/gunicorn_config.py > /dev/null <<'EOF'
"""Default Gunicorn config for GhostHub production deployments."""

# CRITICAL: Patch gevent ssl in the master process BEFORE Gunicorn imports the worker class.
#
# Gunicorn resolves `worker_class` at config-parse time in the master, which imports
# geventwebsocket.gunicorn.workers -> geventwebsocket.handler -> ssl (C extension).
# If ssl is imported unpatched in the master, every forked worker inherits that
# unpatched C-level OpenSSL state. When the worker's init_process() then calls
# monkey.patch_all(), it tries to patch an already-initialized ssl object — on
# ARM/Raspberry Pi this is not fork-safe and causes an immediate SIGSEGV.
from gevent import monkey as _gevent_monkey
if not _gevent_monkey.is_module_patched('ssl'):
    _gevent_monkey.patch_ssl()

import gevent
import logging
import os
import sys
import warnings

warnings.filterwarnings('ignore', message='.*after_fork_in_child.*')

_default_unraisablehook = sys.unraisablehook


def _ghosthub_unraisablehook(unraisable):
    """Ignore known gevent unraisable assertions emitted after fork."""
    obj = getattr(unraisable, 'object', None)
    exc_type = getattr(unraisable, 'exc_type', None)
    obj_repr = repr(obj)
    if (
        exc_type is AssertionError
        and "_ForkHooks.after_fork_in_child" in obj_repr
    ):
        return
    _default_unraisablehook(unraisable)


sys.unraisablehook = _ghosthub_unraisablehook

# Single worker is required for Socket.IO without Redis/sticky sessions.
workers = 1
worker_class = "geventwebsocket.gunicorn.workers.GeventWebSocketWorker"
worker_connections = 1000
timeout = 300
bind = "0.0.0.0:" + str(os.getenv("PORT", 5000))
accesslog = "-"
errorlog = "-"
loglevel = "info"
preload_app = False


def pre_fork(server, worker):
    os.environ['GHOSTHUB_WORKER_INITIALIZED'] = 'false'


def post_fork(server, worker):
    # Reinitialize gevent hub in each worker after fork so it starts with a
    # clean event loop regardless of any hub state inherited from the master.
    gevent.reinit()
    os.environ['GHOSTHUB_WORKER_INITIALIZED'] = 'true'


def worker_abort(worker):
    logging.error(
        "Worker %s ABORTED - check native code crashes (ffmpeg/Pillow)",
        worker.pid,
    )
EOF
    sudo chown ghost:ghost $APP_DIR/gunicorn_config.py

    # Service Definition
    sudo tee /etc/systemd/system/ghosthub.service > /dev/null <<EOF
[Unit]
Description=GhostHub Media Server (Native)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment="PORT=$PORT"
Environment="FLASK_CONFIG=production"
ExecStart=$APP_DIR/venv/bin/python -m gunicorn -c $APP_DIR/gunicorn_config.py wsgi:app
Restart=always
User=ghost
Group=ghost

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable ghosthub
}

setup_network_infrastructure() {
    echo "[*] Configuring AP Network with recovery services..."
    sudo rfkill unblock wifi
    sudo ip link set wlan0 up
    
    # Set Hostname for ghosthub.local broadcast
    echo "[*] Setting hostname to ghosthub..."
    sudo hostnamectl set-hostname ghosthub
    sudo sed -i "s/127.0.1.1.*/127.0.1.1\tghosthub/g" /etc/hosts
    
    # Preserve the rest of the device's networking config and only own wlan0 AP settings.
    DHCPCD_TMP="$(mktemp)"
    if [ -f /etc/dhcpcd.conf ]; then
        sudo awk '
            BEGIN { skip = 0 }
            /^denyinterfaces[[:space:]]+wlan0([[:space:]]|$)/ { next }
            /^interface[[:space:]]+wlan0([[:space:]]|$)/ { skip = 1; next }
            skip && /^interface[[:space:]]+/ { skip = 0 }
            skip { next }
            { print }
            END {
                print ""
                print "interface wlan0"
                print "    static ip_address=192.168.4.1/24"
                print "    nohook wpa_supplicant"
                print "denyinterfaces wlan0"
            }
        ' /etc/dhcpcd.conf > "$DHCPCD_TMP"
    else
        cat > "$DHCPCD_TMP" <<EOF
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
denyinterfaces wlan0
EOF
    fi
    sudo install -m 644 "$DHCPCD_TMP" /etc/dhcpcd.conf
    rm -f "$DHCPCD_TMP"

    # dnsmasq.conf
    sudo tee /etc/dnsmasq.conf > /dev/null <<EOF
interface=wlan0
listen-address=127.0.0.1,192.168.4.1
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h
domain=local
address=/ghosthub.local/192.168.4.1
EOF

    # hostapd.conf
    sudo mkdir -p /etc/hostapd
    sudo tee /etc/hostapd/hostapd.conf > /dev/null <<EOF
interface=wlan0
driver=nl80211
ssid=$SSID
hw_mode=g
channel=1
wmm_enabled=1
ieee80211n=1
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=$PASSPHRASE
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF
    # hostapd.conf configuration path
    if grep -q "DAEMON_CONF=" /etc/default/hostapd 2>/dev/null; then
        sudo sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
    else
        echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' | sudo tee -a /etc/default/hostapd
    fi

    # IP Forwarding & NAT
    echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/routed-ap.conf
    sudo sysctl -p /etc/sysctl.d/routed-ap.conf
    sudo iptables -t nat -C POSTROUTING -o eth0 -j MASQUERADE 2>/dev/null || \
        sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE || true
    # Port 80 -> 5000 redirection for easy access
    echo "[*] Configuring Port 80 to 5000 redirection..."
    sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 5000 2>/dev/null || \
        sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 5000 || true
    sudo netfilter-persistent save
    
    # Restoration of the 3-service stack
    setup_recovery_services
    echo "[*] Force unmasking and enabling networking services..."
    sudo systemctl unmask hostapd hostapd.service avahi-daemon 2>/dev/null || true
    sudo systemctl enable hostapd dnsmasq avahi-daemon 2>/dev/null || true
    sudo systemctl restart hostapd dnsmasq avahi-daemon 2>/dev/null || true
}

setup_recovery_services() {
    echo "[*] Setting up high-availability network services..."
    sudo tee /usr/local/bin/fix-ap-mode.sh > /dev/null <<'EOF'
#!/bin/bash
set -euo pipefail

TARGET_IP="192.168.4.1/24"
AP_IFACE="wlan0"
TARGET_HOSTNAME="ghosthub"

sudo rfkill unblock wifi

CURRENT_HOSTNAME="$(hostnamectl --static 2>/dev/null || hostname)"
if [ "$CURRENT_HOSTNAME" != "$TARGET_HOSTNAME" ]; then
    sudo hostnamectl set-hostname "$TARGET_HOSTNAME" || true
fi

if grep -q '^127\.0\.1\.1' /etc/hosts 2>/dev/null; then
    sudo sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1\t$TARGET_HOSTNAME/" /etc/hosts || true
else
    printf '127.0.1.1\t%s\n' "$TARGET_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null
fi

if ! systemctl is-active --quiet avahi-daemon; then
    sudo systemctl restart avahi-daemon
fi

# Re-assert port 80 -> 5000 redirect so ghosthub.local works without :5000 even if
# /etc/iptables/rules.v4 was lost, flushed, or never saved on this boot.
if ! sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 5000 2>/dev/null; then
    sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 5000 || true
    sudo netfilter-persistent save 2>/dev/null || true
fi

# Preserve AP stability: avoid tearing down wlan0 and avoid restarting dhcpcd unless absolutely necessary.
if ! ip link show "$AP_IFACE" >/dev/null 2>&1; then
    exit 0
fi

if ! ip addr show "$AP_IFACE" | grep -q "192.168.4.1"; then
    sudo ip addr add "$TARGET_IP" dev "$AP_IFACE" 2>/dev/null || true
fi

if ! systemctl is-active --quiet hostapd; then
    sudo systemctl restart hostapd
fi

if ! systemctl is-active --quiet dnsmasq; then
    sudo systemctl restart dnsmasq
fi

EOF
    sudo chmod +x /usr/local/bin/fix-ap-mode.sh

    # Service 1: Early unblock
    sudo tee /etc/systemd/system/unblock-wifi.service > /dev/null <<'EOF'
[Unit]
Description=Early WiFi Unblock
Before=network.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/rfkill unblock wifi

[Install]
WantedBy=sysinit.target
EOF

    # Service 2: Recovery Fix
    sudo tee /etc/systemd/system/ghosthub-ap-fix.service > /dev/null <<'EOF'
[Unit]
Description=GhostHub AP Fix
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fix-ap-mode.sh

[Install]
WantedBy=multi-user.target
EOF

    # Service 3: Health Monitor (requires repeated failures before recovery to avoid flapping)
    sudo tee /etc/systemd/system/ghosthub-ap-monitor.service > /dev/null <<'EOF'
[Unit]
Description=GhostHub AP Monitor

[Service]
ExecStart=/bin/bash -c '
fail_count=0
while true; do
  ap_ok=true
  hostnamectl --static 2>/dev/null | grep -qx "ghosthub" || hostname | grep -qx "ghosthub" || ap_ok=false
  systemctl is-active --quiet avahi-daemon || ap_ok=false
  if ip link show wlan0 >/dev/null 2>&1; then
    ip addr show wlan0 | grep -q "192.168.4.1" || ap_ok=false
    systemctl is-active --quiet hostapd || ap_ok=false
    systemctl is-active --quiet dnsmasq || ap_ok=false
  fi

  if [ "$ap_ok" = false ]; then
    fail_count=$((fail_count + 1))
  else
    fail_count=0
  fi

  if [ "$fail_count" -ge 3 ]; then
    /usr/local/bin/fix-ap-mode.sh
    fail_count=0
    sleep 10
  fi

  sleep 20
done'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable unblock-wifi.service ghosthub-ap-fix.service ghosthub-ap-monitor.service
}

setup_usb_system() {
    echo "[*] Setting up robust USB automount system..."
    
    # Ensure necessary drivers are installed for NTFS/exFAT support
    # We check common system paths explicitly because command -v depends on the environment's PATH
    IS_NTFS_INSTALLED=false
    IS_EXFAT_INSTALLED=false
    
    if command -v mount.ntfs >/dev/null 2>&1 || [ -x /sbin/mount.ntfs ] || [ -x /usr/sbin/mount.ntfs ]; then
        IS_NTFS_INSTALLED=true
    fi
    
    if command -v mount.exfat >/dev/null 2>&1 || [ -x /sbin/mount.exfat ] || [ -x /usr/sbin/mount.exfat ] || [ -x /sbin/mount.exfat-fuse ]; then
        IS_EXFAT_INSTALLED=true
    fi

    if [ "$IS_NTFS_INSTALLED" = false ] || [ "$IS_EXFAT_INSTALLED" = false ]; then
        echo "[*] Storage drivers missing, installing (this may take a minute)..."
        sudo apt-get update && sudo apt-get install -y ntfs-3g exfat-fuse
    fi

    # Create the media base if it doesn't exist
    sudo mkdir -p /media/ghost
    sudo chown ghost:ghost /media/ghost
    sudo chmod 777 /media/ghost

    # The robust mount script
    sudo tee /usr/local/bin/ghosthub-usb-mount.sh > /dev/null <<'EOF'
#!/bin/bash
ACTION="$1"; DEVNAME="$2"; LOG="/var/log/ghosthub-usb.log"
shopt -s nullglob
if [ "$ACTION" = "add" ] && [ -n "$DEVNAME" ]; then
    # Skip base disk if partitions exist (e.g. sda if sda1 exists)
    if [[ "$DEVNAME" =~ ^/dev/sd[a-z]$ ]]; then
        if ls "${DEVNAME}"[0-9]* 1>/dev/null 2>&1; then
            echo "[*] Skipping base disk $DEVNAME because partitions exist" >> "$LOG"
            exit 0
        fi
    fi

    # Small delay for kernel to settle
    mount | grep -q "^$DEVNAME " && exit 0
    
    # Improve LABEL detection - handle empty labels or whitespace
    LABEL=$(blkid -s LABEL -o value "$DEVNAME" 2>/dev/null)
    if [ -z "$LABEL" ]; then
        # Fallback to a short consistent name using UUID (e.g., USB-1A2B)
        UUID=$(blkid -s UUID -o value "$DEVNAME" 2>/dev/null)
        if [ -n "$UUID" ]; then
            LABEL="USB-${UUID:0:4}"
        fi
    fi
    [ -z "$LABEL" ] && LABEL=$(basename "$DEVNAME")
    # Sanitize: convert spaces to underscores, remove special chars
    LABEL=$(echo "$LABEL" | tr ' ' '_' | tr -cd '[:alnum:]_-')
    # Final safety: if sanitization made it empty, use the devname
    [ -z "$LABEL" ] && LABEL=$(basename "$DEVNAME")
    
    MOUNT_POINT="/media/ghost/$LABEL"
    # Collision avoidance (e.g. if sda1 and sdb1 have same label)
    i=1; while mountpoint -q "$MOUNT_POINT" 2>/dev/null; do MOUNT_POINT="/media/ghost/${LABEL}_$i"; i=$((i+1)); done
    
    # Ensure base directory and specific mount point exist
    mkdir -p "/media/ghost" 2>/dev/null
    mkdir -p "$MOUNT_POINT" && touch "$MOUNT_POINT/.mounting" && chmod 777 "$MOUNT_POINT"
    
    echo "[*] Attempting to mount $DEVNAME to $MOUNT_POINT" >> "$LOG"
    MOUNTED=0
    
    # Try different options based on FSTYPE
    for FSTYPE in ntfs-3g exfat vfat ext4 auto; do
        OPTS="rw"
        # Only use ownership options for non-linux filesystems
        # IMPORTANT: ntfs-3g needs 'force' if the drive was dirty/hibernated
        if [ "$FSTYPE" = "ntfs-3g" ]; then
            OPTS="$OPTS,uid=ghost,gid=ghost,umask=000,force"
        elif [[ "$FSTYPE" =~ ^(vfat|exfat)$ ]]; then
            OPTS="$OPTS,uid=ghost,gid=ghost,umask=000"
        fi
        
        if mount -t "$FSTYPE" -o "$OPTS" "$DEVNAME" "$MOUNT_POINT" 2>> "$LOG"; then
            MOUNTED=1
            echo "[+] Successfully mounted $DEVNAME as $FSTYPE" >> "$LOG"
            break
        fi
    done
    
    rm -f "$MOUNT_POINT/.mounting"
    if [ "$MOUNTED" = "0" ]; then
        echo "[X] Failed to mount $DEVNAME" >> "$LOG"
        rmdir "$MOUNT_POINT" 2>/dev/null
    fi
elif [ "$ACTION" = "remove" ]; then
    echo "[*] Processing remove event for potentially unplugged drives" >> "$LOG"
    for dir in /media/ghost/*; do
        [ -d "$dir" ] || continue
        # Don't cleanup if currently mounting
        [ -f "$dir/.mounting" ] && continue
        
        if mountpoint -q "$dir"; then
            SRC=$(findmnt -n -o SOURCE --target "$dir" 2>/dev/null)
            if [ -n "$SRC" ] && [[ "$SRC" == /dev/* ]] && [ ! -e "$SRC" ]; then
                echo "[*] Cleaning up stale mount point: $dir (source $SRC missing)" >> "$LOG"
                # Lazy unmount to avoid hanging
                umount -l "$dir" 2>/dev/null && rmdir "$dir" 2>/dev/null
            fi
        else 
            # Only remove if it's an empty directory and not just created
            if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
                rmdir "$dir" 2>/dev/null
            fi
        fi
    done
fi
EOF
    sudo chmod +x /usr/local/bin/ghosthub-usb-mount.sh

    # Systemd services for USB
    sudo tee /etc/systemd/system/ghosthub-usb-mount@.service > /dev/null <<'EOF'
[Unit]
Description=GhostHub USB Mount %i

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ghosthub-usb-mount.sh add /dev/%i
EOF

    sudo tee /etc/systemd/system/ghosthub-usb-cleanup.service > /dev/null <<'EOF'
[Unit]
Description=GhostHub USB Cleanup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ghosthub-usb-mount.sh remove
EOF

    sudo tee /etc/systemd/system/ghosthub-usb-cleanup.timer > /dev/null <<'EOF'
[Unit]
Description=USB Cleanup Timer

[Timer]
OnBootSec=10s
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
EOF

    # Udev Rule (All USB block devices)
    echo 'ACTION=="add", SUBSYSTEM=="block", KERNEL=="sd[a-z]*", TAG+="systemd", ENV{SYSTEMD_WANTS}="ghosthub-usb-mount@%k.service"' | sudo tee /etc/udev/rules.d/99-ghosthub-usb.rules > /dev/null
    echo 'ACTION=="remove", SUBSYSTEM=="block", KERNEL=="sd[a-z]*", RUN+="/bin/systemctl start ghosthub-usb-cleanup.service"' | sudo tee -a /etc/udev/rules.d/99-ghosthub-usb.rules > /dev/null

    sudo systemctl daemon-reload
    sudo systemctl enable --now ghosthub-usb-cleanup.timer
    sudo udevadm control --reload-rules
    sudo udevadm trigger --subsystem-match=block --action=add
}

# ==== MIGRATION SCRATCH PAD ====
# Edit this function for each release with one-time migration tasks
# Comment out old migrations when no longer needed
migrate() {
    echo "[*] Running custom migrations..."

    # EXAMPLE: Uncomment and edit as needed for each release
    setup_sudoers              # New commands added with features
    setup_services             # Service definitions change
    configure_kiosk_and_hdmi   # Service updates (refactored to be lightweight)

    # Install new system package
    # apt_install_robust new-package-name

    # Move/rename files
    # mv "$APP_DIR/old_file" "$APP_DIR/new_file" 2>/dev/null || true

    # Apply one-time config changes
    # sed -i 's/old_value/new_value/' /etc/some.conf

    # Fix permissions
    # chown -R ghost:ghost "$APP_DIR/some_folder"

    # Database migrations (if needed)
    # "$APP_DIR/venv/bin/python" "$APP_DIR/scripts/migrate_db.py"

    # Trigger reboot if needed
    # mark_reboot_required "Migration XYZ requires reboot"

    echo "[*] Migrations complete"
}

# ==== 4. ORCHESTRATORS ====

install() {
    echo "[*] STARTING FULL GHOSTHUB INSTALLATION"
    setup_tailscale
    setup_base_dependencies
    setup_sqlite_tmpfs
    setup_sudoers
    setup_audio_system
    setup_display_system
    setup_silent_boot
    setup_console_lock

    download_app_update
    extract_app_update
    configure_kiosk_and_hdmi

    local INSTALL_HASH
    INSTALL_HASH=$(md5sum "$APP_DIR/requirements.txt" | cut -d' ' -f1)
    ensure_python_runtime "$INSTALL_HASH" || {
        "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" --upgrade pip setuptools wheel toml
        echo "$INSTALL_HASH" > "$APP_DIR/.requirements_hash"
    }
    
    handle_downloads
    setup_services
    setup_network_infrastructure
    setup_usb_system
    
    chown -R ghost:ghost "$APP_DIR"
    # Success marker to prevent update mode trigger on failed installs
    touch "$APP_DIR/.install_complete"
    # Fresh installs touch enough subsystems (display, audio, sudoers, network,
    # USB udev rules, systemd units) that a reboot is required to land cleanly.
    # Mark it explicitly here so the reboot doesn't depend on any single setup_*
    # step happening to flip the flag.
    mark_reboot_required "Fresh install requires reboot to finalize system services"
    echo ""
    echo "✅ GHOSTHUB INSTALLATION COMPLETE"
    echo "→ Access at: http://ghosthub.local"
}

update() {
    echo "[*] STARTING GHOSTHUB UPDATE"

    # 1. Backup and stop services
    mkdir -p "$BACKUP_DIR"
    sudo pkill -9 gunicorn 2>/dev/null || true

    # Ensure Tailscale repo is present even on updates
    setup_tailscale

    # 2. Download and extract new code
    download_app_update
    extract_app_update

    [ -d "$BACKUP_DIR/instance" ] && rsync -a "$BACKUP_DIR/instance/" "$APP_DIR/instance/"

    # 3. Run custom migrations (NEW - runs after code extraction)
    migrate
    
    # Ensure network infrastructure is configured (Hostname, Port 80 redirect, AP configs)
    setup_network_infrastructure
    
    setup_usb_system           # Ensure USB rules and scripts are current

    # 5. Smart dependency updates (hash-based)
    local NEW_HASH=$(md5sum "$APP_DIR/requirements.txt" | cut -d' ' -f1)
    local OLD_HASH=$(cat "$APP_DIR/.requirements_hash" 2>/dev/null || echo "")
    # ensure_python_runtime rebuilds the venv if it's missing or corrupt (returns 0).
    # If the venv is healthy but requirements changed, install the updated deps.
    if ensure_python_runtime "$NEW_HASH"; then
        echo "[*] Venv was rebuilt — dependencies already installed."
    elif [ "$NEW_HASH" != "$OLD_HASH" ]; then
        echo "[*] requirements.txt changed, updating Python dependencies..."
        "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"
        echo "$NEW_HASH" > "$APP_DIR/.requirements_hash"
    fi

    # 6. Update binaries (version-checked)
    handle_downloads

    # 7. Restart services
    chown -R ghost:ghost "$APP_DIR"
    sudo systemctl restart ghosthub
    if systemctl is-active --quiet ghosthub-kiosk; then
        sudo systemctl stop ghosthub-kiosk
    fi

    cleanup_old_backups
    touch "$APP_DIR/.install_complete"
    echo ""
    echo "✅ GHOSTHUB UPDATE COMPLETE"
}

# ==== 5. MAIN ENTRY POINT ====

# Argument parsing
while [[ $# -gt 0 ]]; do
  case $1 in
    --local) LOCAL_MODE=true; shift ;;
    --local-only) LOCAL_ONLY=true; shift ;;
    --local-zip)
        LOCAL_ZIP_PATH="$2"
        shift 2
        ;;
    --version)
        REQUESTED_VERSION="$2"
        [[ "$REQUESTED_VERSION" != v* ]] && REQUESTED_VERSION="v$REQUESTED_VERSION"
        shift 2
        ;;
    --update) EXPLICIT_UPDATE=true; shift ;;
    --install) EXPLICIT_INSTALL=true; shift ;;
    --force-update) FORCE_UPDATE=true; shift ;;
    --keep-installer) KEEP_INSTALLER=true; shift ;;
    *) shift ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then echo "[!] Run as root"; exit 1; fi

if ! mkdir "$INSTALL_LOCK_DIR" 2>/dev/null; then
    echo "[!] Another GhostHub install/update is already running."
    exit 1
fi
trap 'rmdir "$INSTALL_LOCK_DIR" 2>/dev/null || true' EXIT

# Resolve install vs update mode. Explicit CLI flags win over marker detection.
if $EXPLICIT_INSTALL && $EXPLICIT_UPDATE; then
    echo "[!] Cannot use --install and --update together"
    exit 1
fi

if $EXPLICIT_INSTALL; then
    INSTALL_MODE=true
    mkdir -p "$APP_DIR"
elif $EXPLICIT_UPDATE; then
    INSTALL_MODE=false
    mkdir -p "$APP_DIR"
else
    # Use success marker for detection instead of venv
    [ -f "$APP_DIR/.install_complete" ] && INSTALL_MODE=false || mkdir -p "$APP_DIR"
fi

if $INSTALL_MODE; then install; else update; fi

if $REBOOT_REQUIRED; then 
    echo "[!] Reboot will be required (scheduled in 2 seconds)..."
    (sleep 2; sudo reboot) &
    exit 0
fi
