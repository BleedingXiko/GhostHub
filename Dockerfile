FROM python:3.9-slim-buster

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    openssh-client \
    libjpeg-dev \
    zlib1g-dev \
    libpng-dev \
    libavcodec-dev \
    libavformat-dev \
    libswscale-dev \
    libv4l-dev \
    libxvidcore-dev \
    libx264-dev \
    && rm -rf /var/lib/apt/lists/*

# Create required directories with proper permissions
RUN mkdir -p /app/instance/thumbnails && \
    chmod 777 /app/instance/thumbnails


# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Ensure critical version locking
RUN pip install --no-cache-dir "numpy<2.0.0" "Flask-SocketIO==5.1.1" "python-socketio==5.4.0" "python-engineio==4.2.1"

# Install cloudflared (auto-detect arch: amd64 or arm64)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/') && \
    curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Copy application files
COPY app/ ./app/
COPY static/ ./static/
COPY templates/ ./templates/
COPY scripts/ ./scripts/
COPY wsgi.py .
COPY docker-media-server.py .
COPY ghosthub.py .

# Symlinks to make cloudflared accessible from app root
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared.exe

# Create volume mount point
RUN mkdir -p /media

# Make init script executable
RUN chmod +x /app/scripts/docker-init.py

# Expose app port
EXPOSE 5000

# Environment setup
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:0
ENV DOCKER_ENV=true

# Start server
CMD python /app/scripts/docker-init.py && python /app/docker-media-server.py
