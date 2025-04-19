# 👻 GhostHub

**GhostHub** is a lightweight, modular media server that lets you swipe through your local videos and images in a sleek, mobile-friendly interface — with real-time chat, optional host sync, and easy Cloudflare Tunnel sharing.

Runs as a **Python script** or **one-click Windows `.exe`** — no install, no accounts, no cloud.

---

## 🚀 Features

- 📁 Add custom folders and browse your media
- 🎞️ TikTok-style swipe navigation for images & videos
- 🔁 Optional host sync — like a private watch party
- 💬 Built-in real-time chat (ephemeral, anonymous)
- 📱 Fully mobile and desktop optimized
- 🌐 Optional public sharing via Cloudflare Tunnel
- 🖥️ Portable `.exe` with no dependencies or setup
- 💾 External config (`media_categories.json`) so you keep your folders

---

## ⚙️ How to Run GhostHub

### 🔧 Option 1: Standalone Executable (Windows)

The `.exe` contains everything — no setup needed.

1. Run `GhostHub.exe`
2. You'll be prompted:
   - Whether to enable Cloudflare Tunnel
   - The public link (if enabled) will auto-copy to clipboard
3. Open your browser and go to: [http://localhost:5000](http://localhost:5000) (manually — it doesn’t auto-launch)

> 📌 `media_categories.json` is saved in the same folder — you can edit this to manage your categories.
>
> ✅ No need for `cloudflared.exe` — it's bundled inside the `.exe`

---

### 💻 Option 2: Python (Manual / Development Mode)

1. Install **Python 3.7+**
2. **Required:** Download and place these 3 executables in the project root:
   - [`ffmpeg.exe`](https://ffmpeg.org/download.html)
   - `ffprobe.exe` (comes with ffmpeg)
   - [`cloudflared.exe`](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation)
3. Install dependencies:
   ```bash
   pip install -r requirements.txt

	4.	Start the server:

python media_server.py

Or use the helper:

start_server.bat


	5.	Open your browser manually to: http://localhost:5000

💡 Tunnel will prompt automatically if cloudflared.exe is present

⸻

🛠️ Building the Executable

Use build_exe.bat to automate the process.

📦 What it does:
	•	Checks for Python and PyInstaller
	•	Installs any missing packages (including dnspython for eventlet)
	•	Asks if you want debug mode
	•	Builds a clean .exe using ghosthub.spec

↺ Build Instructions:

build_exe.bat

Output appears in the /dist folder as GhostHub.exe

⸻

📁 Media Categories
	1.	Click “Add Category” in the UI
	2.	Name it and select a folder path
	3.	It will persist in media_categories.json

⸻

🎥 Supported Formats

Images: jpg, jpeg, png, gif, bmp, tiff, svg, webp, heic, raw, psd, xcf, etc.
Videos: mp4, webm, mov, avi, mkv, wmv, flv, m4v, ts, mpg, ogv, etc.

⸻

🧪 Troubleshooting
	•	Media not loading? Check your paths and file types
	•	Tunnel not starting? Ensure cloudflared.exe is present (for .bat/Python mode)
	•	Chat or sync buggy? Refresh — GhostHub is resilient and stateless
	•	Crashes? Run from terminal for logs:

cd dist
GhostHub.exe



⸻

💬 Final Notes

GhostHub is meant to be light, fast, and ephemeral — like a digital campfire. Spin it up, invite a few ghosts, and shut it down when you’re done.

No setup. No tracking. No trace.

Ghost on, my friend. 👻

Let me know if you want this turned into a `README.md` file and committed via a branch + PR structure.