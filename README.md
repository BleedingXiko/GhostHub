# 👻 GhostHub

**GhostHub** is a lightweight, modular media server that lets you swipe through your local videos and images in a sleek, mobile-friendly interface — with real-time chat, optional host sync, and easy Cloudflare Tunnel sharing.

Runs as a **Python script**, **one-click Windows `.exe`**, or **Docker container** — no install, no accounts, no cloud.

---

## 🚀 Features

- 📁 Add custom folders and browse your media
- 🎞️ TikTok-style swipe navigation for images & videos
- 🔁 Optional host sync — like a private watch party
- 💬 Built-in real-time chat (ephemeral, anonymous)
- 📱 Fully mobile and desktop optimized
- 🌐 Optional public sharing via Cloudflare Tunnel
- 🖥️ Portable `.exe` with no dependencies or setup
- 🐳 Docker support for cross-platform compatibility
- 💾 External config (`media_categories.json`) so you keep your folders

---

## ⚙️ How to Run GhostHub

### 🔧 Option 1: Standalone Executable (Windows)

The `.exe` contains everything — no setup needed.

1. Run `GhostHub.exe`
2. You'll be prompted:
   - Whether to enable Cloudflare Tunnel
   - The public link (if enabled) will auto-copy to clipboard
3. Open your browser and go to: [http://localhost:5000](http://localhost:5000) (manually — it doesn't auto-launch)

> 📌 `media_categories.json` is saved in the same folder — you can edit this to manage your categories.
>
> ✅ No need for `cloudflared.exe` — it's bundled inside the `.exe`

---

### 💻 Option 2: Python (Manual / Development Mode)

1. Install **Python 3.7+**

2. **Required:** Download and place this executable in the project root:
   - [`cloudflared.exe`](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation)

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Start the server:
   ```bash
   python media_server.py
   ```
   Or use the helper:
   ```bash
   start_server.bat
   ```

5. Open your browser manually to: [http://localhost:5000](http://localhost:5000)

> 💡 Tunnel will prompt automatically if cloudflared.exe is present

---

### 🐳 Option 3: Docker (Cross-Platform)

Run GhostHub in a Docker container for easy deployment on any platform.

1. Install [Docker](https://www.docker.com/products/docker-desktop)

2. Add your media directories to `docker-compose.yml`:
   ```yaml
   volumes:
     - ./instance:/app/instance
     - ./media:/media
     # Windows paths (Docker Desktop):
     - C:/Users/username/Pictures:/media/pictures
     - C:/Users/username/Videos:/media/videos
     # Linux/macOS paths:
     # - /home/user/Pictures:/media/pictures
     # - /home/user/Videos:/media/videos
   ```

3. Build and start the container:
   ```bash
   docker-compose up -d
   ```

4. Open your browser to: [http://localhost:5000](http://localhost:5000)

> 📌 **Automatic Media Categories**: The Docker container automatically creates media categories for all directories mounted under `/media`. No need to manually add them in the UI!
>
> 📂 **Media Organization**: Mount your media directories as subdirectories of `/media` (e.g., `/media/pictures`, `/media/videos`) for better organization.
>
> 🌐 **Cloudflare Tunnel** is fully supported in the Docker container.
>
> ⚠️ **Windows Path Format**: When using Docker on Windows, make sure to use the correct path format:
>   - Docker Desktop: `C:/Users/username/path:/media/category`
>   - WSL2/Git Bash: `/c/Users/username/path:/media/category`

#### Docker Commands

```bash
# Start the container
docker-compose up -d

# Stop the container
docker-compose down

# View logs
docker-compose logs -f

# Rebuild the container (after changes)
docker-compose build

# Enable Cloudflare Tunnel
# Edit docker-compose.yml and set USE_CLOUDFLARE_TUNNEL=y
```

#### Docker Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Port to run the server on | 5000 |
| FLASK_CONFIG | Flask configuration (development/production) | development |
| USE_CLOUDFLARE_TUNNEL | Enable Cloudflare Tunnel (y/n) | n |

---

## 🛠️ Building the Executable

Use `build_exe.bat` to automate the process.

📦 What it does:
- Checks for Python and PyInstaller
- Installs any missing packages (including dnspython for eventlet)
- Asks if you want debug mode
- Builds a clean .exe using ghosthub.spec

Build Instructions:
```bash
build_exe.bat
```

Output appears in the `/dist` folder as `GhostHub.exe`

---

## 📁 Media Categories

1. Click "Add Category" in the UI
2. Name it and select a folder path
3. It will persist in media_categories.json

---

## 🎥 Supported Formats

**Images**: jpg, jpeg, png, gif, bmp, tiff, svg, webp, heic, raw, psd, xcf, etc.

**Videos**: mp4, webm, mov, avi, mkv, wmv, flv, m4v, ts, mpg, ogv, etc.

---

## 🧪 Troubleshooting

- Media not loading? Check your paths and file types
- Tunnel not starting? Ensure cloudflared.exe is present (for .bat/Python mode)
- Chat or sync buggy? Refresh — GhostHub is resilient and stateless
- Crashes? Run from terminal for logs:
  ```bash
  cd dist
  GhostHub.exe
  ```

---

## ⚠️ Known Issues

- **Mobile Chat Limitation**: On mobile devices, you may need to view new media in a category before the chat becomes active again after viewing in fullscreen.
- **iOS Fullscreen**: Some iOS devices may require tapping the video twice to enter fullscreen mode.
- **Video Loading**: Very large video files may take a moment to buffer before playing smoothly.

## 💬 Final Notes

GhostHub is meant to be light, fast, and ephemeral — like a digital campfire. Spin it up, invite a few ghosts, and shut it down when you're done.

No setup. No tracking. No trace.

Ghost on, my friend. 👻
