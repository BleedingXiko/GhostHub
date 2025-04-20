# Media Directory for Docker

This directory is a placeholder for mounting media files when using Docker.

## How it works

1. In the `docker-compose.yml` file, this directory is mounted to `/media` in the container
2. You can add your media files to this directory, or mount specific media directories as subdirectories of `/media`
3. The Docker container will automatically create media categories for all subdirectories of `/media`

## Windows Path Format in Docker

When using Docker on Windows, you need to use the correct path format:

### Docker Desktop (Windows)
```yaml
volumes:
  - ./instance:/app/instance
  - ./media:/media
  - C:/Users/username/Pictures:/media/pictures
  - C:/Users/username/Videos:/media/videos
```

### WSL2 or Git Bash
```yaml
volumes:
  - ./instance:/app/instance
  - ./media:/media
  - /c/Users/username/Pictures:/media/pictures
  - /c/Users/username/Videos:/media/videos
```

## Example

If you have media files in:
- `C:/Users/username/Pictures`
- `C:/Users/username/Videos`

You can mount them in `docker-compose.yml` like this:

```yaml
volumes:
  - ./instance:/app/instance
  - ./media:/media
  - C:/Users/username/Pictures:/media/pictures
  - C:/Users/username/Videos:/media/videos
```

The Docker container will automatically create media categories for:
- `/media/pictures`
- `/media/videos`

## Docker Environment Variables

GhostHub Docker container supports the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Port to run the server on | 5000 |
| FLASK_CONFIG | Flask configuration (development/production) | development |
| USE_CLOUDFLARE_TUNNEL | Enable Cloudflare Tunnel (y/n) | n |

You can set these in the `docker-compose.yml` file:

```yaml
environment:
  - PORT=5000
  - FLASK_CONFIG=production
  - USE_CLOUDFLARE_TUNNEL=y  # Set to 'y' to enable Cloudflare Tunnel
```

## Troubleshooting

If you get an error like:
```
Error response from daemon: invalid mount config for type "volume": invalid mount path: 'C:/Users/...' mount path must be absolute
```

Make sure:
1. You're using the correct path format for your Docker environment
2. You've specified both the source and destination paths (e.g., `C:/path:/media/category`)
3. The destination path starts with `/media/` for automatic category creation

## Note

This directory is only used when running GhostHub with Docker. It is not used when running GhostHub as a Python script or executable.
