FROM python:3.9-slim-buster

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ffmpeg \
    tk \
    python3-tk \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Explicitly install moviepy and its dependencies
RUN pip install --no-cache-dir moviepy decorator imageio imageio-ffmpeg numpy proglog tqdm

# Download and install cloudflared
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Copy application files
COPY . .

# Create symbolic links to required executables in the app directory
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared.exe
RUN ln -sf /usr/bin/ffmpeg /app/ffmpeg.exe
RUN ln -sf /usr/bin/ffprobe /app/ffprobe.exe

# Create media directory for mounting volumes
RUN mkdir -p /media

# Make the initialization script executable
RUN chmod +x /app/docker-init.py

# Expose the port
EXPOSE 5000

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:0

# Set environment variables for Cloudflare Tunnel
ENV USE_CLOUDFLARE_TUNNEL=n

# Run the initialization script and then start the application
CMD python /app/docker-init.py && python /app/docker-media-server.py
