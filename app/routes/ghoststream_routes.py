"""
GhostStream Routes
------------------
API endpoints for GhostStream transcoding integration.
"""

import logging
from flask import Blueprint, jsonify, request, current_app
from app.services.ghoststream_service import ghoststream_service
from app.services.category_service import CategoryService

logger = logging.getLogger(__name__)
ghoststream_bp = Blueprint('ghoststream', __name__)


@ghoststream_bp.route('/status', methods=['GET'])
def get_status():
    """Get GhostStream service status and available servers."""
    return jsonify(ghoststream_service.get_status_summary())


@ghoststream_bp.route('/test-connection', methods=['POST'])
def test_connection():
    """Test connection to a GhostStream server directly."""
    import urllib.request
    import urllib.error
    import json as json_lib
    import sys
    
    data = request.get_json() or {}
    server_url = data.get('server_url', '').strip()
    
    if not server_url:
        server_url = current_app.config.get('GHOSTSTREAM_SERVER', '')
    
    if not server_url:
        return jsonify({"success": False, "error": "No server URL provided"})
    
    # Normalize URL
    if server_url.startswith("http://"):
        server_url = server_url[7:]
    elif server_url.startswith("https://"):
        server_url = server_url[8:]
    server_url = server_url.rstrip("/")
    
    # Parse host:port
    if ":" in server_url:
        host, port_str = server_url.rsplit(":", 1)
        try:
            port = int(port_str)
        except ValueError:
            return jsonify({"success": False, "error": f"Invalid port: {port_str}"})
    else:
        host = server_url
        port = 8765
    
    full_url = f"http://{host}:{port}/api/health"
    
    # Use urllib instead of httpx to avoid recursion issues
    try:
        req = urllib.request.Request(full_url, method='GET')
        req.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(req, timeout=10) as resp:
            response_data = json_lib.loads(resp.read().decode('utf-8'))
            
            # Configure the ghoststream_service with this server
            ghoststream_service.configure(
                enabled=True,
                server_url=f"{host}:{port}"
            )
            logger.info(f"GhostStream service configured with {host}:{port} via test-connection")
            
            return jsonify({
                "success": True,
                "url": full_url,
                "response": response_data
            })
    except urllib.error.HTTPError as e:
        return jsonify({
            "success": False,
            "url": full_url,
            "status_code": e.code,
            "error": f"Server returned {e.code}"
        })
    except urllib.error.URLError as e:
        return jsonify({
            "success": False,
            "url": full_url,
            "error": f"Connection failed: {e.reason}",
            "error_type": "URLError"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "url": full_url,
            "error": str(e),
            "error_type": type(e).__name__
        })


@ghoststream_bp.route('/health', methods=['GET'])
def health_check():
    """Check if GhostStream server is healthy."""
    if not ghoststream_service.is_enabled():
        return jsonify({
            "available": False,
            "reason": "GhostStream is not enabled in settings"
        })
    
    server = ghoststream_service.get_server()
    if not server:
        # Check why no server
        server_url = current_app.config.get('GHOSTSTREAM_SERVER', '')
        if not server_url:
            return jsonify({
                "available": False,
                "reason": "No server URL configured (set GHOSTSTREAM_SERVER in settings)"
            })
        return jsonify({
            "available": False,
            "reason": f"Server configured ({server_url}) but not registered - check URL format"
        })
    
    healthy = ghoststream_service.health_check()
    
    if not healthy:
        return jsonify({
            "available": False,
            "reason": f"Cannot connect to {server.host}:{server.port} - is GhostStream running?",
            "server": {
                "name": server.name,
                "host": server.host,
                "port": server.port
            }
        })
    
    return jsonify({
        "available": True,
        "server": {
            "name": server.name,
            "host": server.host,
            "port": server.port,
            "has_hw_accel": server.has_hw_accel
        }
    })


@ghoststream_bp.route('/capabilities', methods=['GET'])
def get_capabilities():
    """Get GhostStream server capabilities."""
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    caps = ghoststream_service.get_capabilities()
    if caps:
        return jsonify(caps)
    return jsonify({"error": "Failed to get capabilities"}), 500


def _build_source_url(category_id: str, filename: str) -> str:
    """Build the source URL that GhostStream can access."""
    from flask import request as flask_request
    host = flask_request.host
    scheme = "https" if flask_request.is_secure else "http"
    
    # Check if we're behind a tunnel and use appropriate URL
    tunnel_url = current_app.config.get('TUNNEL_URL')
    if tunnel_url:
        return f"{tunnel_url}/media/{category_id}/{filename}"
    return f"{scheme}://{host}/media/{category_id}/{filename}"


@ghoststream_bp.route('/transcode/start', methods=['POST'])
def start_transcode():
    """
    Start a transcoding job.
    
    Request body:
    {
        "category_id": "abc123",
        "filename": "video.mkv",
        "mode": "stream",  // "stream", "abr", or "batch"
        "format": "hls",  // "hls", "mp4", "webm", "mkv"
        "resolution": "1080p",
        "video_codec": "h264",
        "audio_codec": "aac",
        "bitrate": "auto",
        "hw_accel": "auto",
        "start_time": 0,
        "tone_map": true,
        "two_pass": false,
        "max_audio_channels": 2
    }
    """
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing request body"}), 400
    
    category_id = data.get("category_id")
    filename = data.get("filename")
    
    if not category_id or not filename:
        return jsonify({"error": "category_id and filename are required"}), 400
    
    source_url = _build_source_url(category_id, filename)
    
    # Get transcoding settings with defaults from config
    # Force stream mode - ABR has issues
    mode = "stream"
    
    # Determine format based on mode
    if mode == "batch":
        output_format = data.get("format", "mp4")
    else:
        output_format = "hls"  # HLS for streaming modes
    
    resolution = data.get("resolution", current_app.config.get('GHOSTSTREAM_DEFAULT_RESOLUTION', '1080p'))
    video_codec = data.get("video_codec", current_app.config.get('GHOSTSTREAM_DEFAULT_CODEC', 'h264'))
    audio_codec = data.get("audio_codec", "aac")
    bitrate = data.get("bitrate", "auto")
    hw_accel = data.get("hw_accel", "auto")
    start_time = data.get("start_time", 0)
    tone_map = data.get("tone_map", True)
    two_pass = data.get("two_pass", False)
    max_audio_channels = data.get("max_audio_channels", 2)
    
    logger.info(f"Starting GhostStream transcode: {filename} -> {mode}/{output_format}/{resolution}/{video_codec}")
    
    job = ghoststream_service.start_transcode(
        source=source_url,
        mode=mode,
        format=output_format,
        video_codec=video_codec,
        audio_codec=audio_codec,
        resolution=resolution,
        bitrate=bitrate,
        hw_accel=hw_accel,
        start_time=start_time,
        tone_map=tone_map,
        two_pass=two_pass,
        max_audio_channels=max_audio_channels
    )
    
    if not job:
        return jsonify({"error": "Failed to start transcoding"}), 500
    
    return jsonify({
        "job_id": job.job_id,
        "status": job.status.value,
        "mode": job.mode,
        "progress": job.progress,
        "stream_url": job.stream_url,
        "download_url": job.download_url,
        "hw_accel_used": job.hw_accel_used
    })


@ghoststream_bp.route('/transcode/<job_id>/status', methods=['GET'])
def get_job_status(job_id):
    """Get the status of a transcoding job."""
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    job = ghoststream_service.get_job_status(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    
    return jsonify({
        "job_id": job.job_id,
        "status": job.status.value,
        "mode": job.mode,
        "progress": job.progress,
        "stream_url": job.stream_url,
        "download_url": job.download_url,
        "error_message": job.error_message,
        "hw_accel_used": job.hw_accel_used,
        "eta_seconds": job.eta_seconds,
        "current_time": job.current_time,
        "duration": job.duration
    })


@ghoststream_bp.route('/transcode/<job_id>/cancel', methods=['POST'])
def cancel_job(job_id):
    """Cancel a transcoding job."""
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    success = ghoststream_service.cancel_job(job_id)
    if success:
        return jsonify({"status": "cancelled", "job_id": job_id})
    return jsonify({"error": "Failed to cancel job"}), 500


@ghoststream_bp.route('/transcode/<job_id>', methods=['DELETE'])
def delete_job(job_id):
    """Delete a transcoding job and clean up resources."""
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    success = ghoststream_service.delete_job(job_id)
    if success:
        return jsonify({"status": "deleted", "job_id": job_id})
    return jsonify({"error": "Failed to delete job"}), 500


@ghoststream_bp.route('/transcode/wait/<job_id>', methods=['GET'])
def wait_for_ready(job_id):
    """
    Wait for a job to be ready (blocking call with timeout).
    
    Query params:
        timeout: Max seconds to wait (default: 30)
    """
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    timeout = request.args.get('timeout', 30, type=float)
    timeout = min(timeout, 60)  # Cap at 60 seconds
    
    job = ghoststream_service.wait_for_ready(job_id, timeout=timeout)
    if not job:
        return jsonify({"error": "Timeout or job not found"}), 408
    
    return jsonify({
        "job_id": job.job_id,
        "status": job.status.value,
        "progress": job.progress,
        "stream_url": job.stream_url,
        "download_url": job.download_url,
        "error_message": job.error_message,
        "hw_accel_used": job.hw_accel_used
    })


@ghoststream_bp.route('/settings', methods=['GET'])
def get_settings():
    """Get current GhostStream settings."""
    return jsonify({
        "enabled": current_app.config.get('GHOSTSTREAM_ENABLED', False),
        "server": current_app.config.get('GHOSTSTREAM_SERVER', ''),
        "auto_transcode": current_app.config.get('GHOSTSTREAM_AUTO_TRANSCODE', True),
        "default_resolution": current_app.config.get('GHOSTSTREAM_DEFAULT_RESOLUTION', '1080p'),
        "default_codec": current_app.config.get('GHOSTSTREAM_DEFAULT_CODEC', 'h264'),
        "prefer_abr": current_app.config.get('GHOSTSTREAM_PREFER_ABR', False)
    })


@ghoststream_bp.route('/batch/start', methods=['POST'])
def start_batch_transcode():
    """
    Start batch transcoding for all videos in a category that need it.
    
    Request body:
    {
        "category_id": "abc123",
        "resolution": "1080p",
        "video_codec": "h264",
        "format": "mp4"
    }
    """
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing request body"}), 400
    
    category_id = data.get("category_id")
    if not category_id:
        return jsonify({"error": "category_id is required"}), 400
    
    # Get category details to find all videos
    category = CategoryService.get_category_by_id(category_id)
    if not category:
        return jsonify({"error": "Category not found"}), 404
    
    # Video extensions that need transcoding
    transcode_extensions = {'.mkv', '.avi', '.wmv', '.flv', '.m4v', '.mov', 
                           '.ts', '.m2ts', '.vob', '.mpg', '.mpeg', '.mts',
                           '.divx', '.asf', '.rm', '.rmvb', '.3gp'}
    
    # Also transcode videos with HEVC indicators in name
    hevc_indicators = ['hevc', 'h265', 'x265']
    
    # Find videos that need transcoding
    videos_to_transcode = []
    category_path = category.get('path', '')
    
    if category_path:
        import os
        for filename in os.listdir(category_path):
            ext = os.path.splitext(filename)[1].lower()
            name_lower = filename.lower()
            
            # Check if it's a video that needs transcoding
            needs_transcode = ext in transcode_extensions
            if not needs_transcode:
                needs_transcode = any(ind in name_lower for ind in hevc_indicators)
            
            if needs_transcode:
                # Check if already transcoded
                transcoded_path = os.path.join(category_path, '.ghosthub', 'transcoded', 
                                               os.path.splitext(filename)[0] + '.mp4')
                if not os.path.exists(transcoded_path):
                    videos_to_transcode.append(filename)
    
    if not videos_to_transcode:
        return jsonify({
            "message": "No videos need transcoding",
            "queued": 0
        })
    
    # Start batch jobs
    resolution = data.get("resolution", current_app.config.get('GHOSTSTREAM_DEFAULT_RESOLUTION', '1080p'))
    video_codec = data.get("video_codec", current_app.config.get('GHOSTSTREAM_DEFAULT_CODEC', 'h264'))
    output_format = data.get("format", "mp4")
    
    jobs = []
    for filename in videos_to_transcode:
        source_url = _build_source_url(category_id, filename)
        
        job = ghoststream_service.start_transcode(
            source=source_url,
            mode="batch",
            format=output_format,
            video_codec=video_codec,
            audio_codec="aac",
            resolution=resolution,
            hw_accel="auto",
            tone_map=True,
            two_pass=False,
            max_audio_channels=2
        )
        
        if job:
            jobs.append({
                "job_id": job.job_id,
                "filename": filename,
                "status": job.status.value
            })
    
    return jsonify({
        "message": f"Started batch transcoding for {len(jobs)} videos",
        "queued": len(jobs),
        "total_found": len(videos_to_transcode),
        "jobs": jobs
    })


@ghoststream_bp.route('/batch/status/<category_id>', methods=['GET'])
def get_batch_status(category_id):
    """Get status of batch transcoding for a category."""
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    # Get all active jobs for this category
    active_jobs = ghoststream_service.get_active_jobs_for_category(category_id)
    
    return jsonify({
        "category_id": category_id,
        "jobs": active_jobs
    })


@ghoststream_bp.route('/batch/download/<job_id>', methods=['POST'])
def download_transcoded(job_id):
    """
    Download a completed batch transcode and save it to the category folder.
    """
    if not ghoststream_service.is_available():
        return jsonify({"error": "GhostStream not available"}), 503
    
    data = request.get_json() or {}
    category_id = data.get("category_id")
    original_filename = data.get("original_filename")
    
    if not category_id or not original_filename:
        return jsonify({"error": "category_id and original_filename required"}), 400
    
    # Get job status
    job = ghoststream_service.get_job_status(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    
    if job.status.value != "ready":
        return jsonify({"error": f"Job not ready: {job.status.value}"}), 400
    
    if not job.download_url:
        return jsonify({"error": "No download URL available"}), 400
    
    # Get category path
    category = CategoryService.get_category_by_id(category_id)
    if not category:
        return jsonify({"error": "Category not found"}), 404
    
    category_path = category.get('path', '')
    if not category_path:
        return jsonify({"error": "Category path not found"}), 404
    
    import os
    import urllib.request
    
    # Create transcoded folder
    transcoded_dir = os.path.join(category_path, '.ghosthub', 'transcoded')
    os.makedirs(transcoded_dir, exist_ok=True)
    
    # Download the file
    output_filename = os.path.splitext(original_filename)[0] + '.mp4'
    output_path = os.path.join(transcoded_dir, output_filename)
    
    try:
        urllib.request.urlretrieve(job.download_url, output_path)
        logger.info(f"Downloaded transcoded file to {output_path}")
        
        return jsonify({
            "success": True,
            "saved_to": output_path,
            "filename": output_filename
        })
    except Exception as e:
        logger.error(f"Failed to download transcoded file: {e}")
        return jsonify({"error": f"Download failed: {str(e)}"}), 500


@ghoststream_bp.route('/transcoded/<category_id>/<filename>', methods=['GET'])
def get_transcoded_video(category_id, filename):
    """Check if a transcoded version exists and return its path."""
    category = CategoryService.get_category_by_id(category_id)
    if not category:
        return jsonify({"exists": False})
    
    import os
    category_path = category.get('path', '')
    transcoded_filename = os.path.splitext(filename)[0] + '.mp4'
    transcoded_path = os.path.join(category_path, '.ghosthub', 'transcoded', transcoded_filename)
    
    if os.path.exists(transcoded_path):
        return jsonify({
            "exists": True,
            "filename": transcoded_filename,
            "url": f"/media/{category_id}/.ghosthub/transcoded/{transcoded_filename}"
        })
    
    return jsonify({"exists": False})
