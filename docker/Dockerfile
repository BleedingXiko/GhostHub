FROM python:3.9-slim-buster

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    tk \
    python3-tk \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libglib2.0-0 \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY ../requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Ensure we have the correct versions of critical packages
RUN pip install --no-cache-dir "numpy<2.0.0" "Flask-SocketIO==5.1.1" "python-socketio==5.4.0" "python-engineio==4.2.1"

# Download and install cloudflared
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Copy application files
COPY .. .

# Create symbolic links to required executables in the app directory
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared
RUN ln -sf /usr/local/bin/cloudflared /app/cloudflared.exe

# Create media directory for mounting volumes
RUN mkdir -p /media

# Make the initialization script executable
RUN chmod +x /app/scripts/docker-init.py

# Expose the port
EXPOSE 5000

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:0
ENV DOCKER_ENV=true

# Set environment variables for Cloudflare Tunnel
ENV USE_CLOUDFLARE_TUNNEL=n

# Run the initialization script and then start the application
CMD python /app/scripts/docker-init.py && python /app/scripts/docker-media-server.py
