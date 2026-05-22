"""
Media Utility Functions
----------------------
Utilities for media file handling, type detection, and thumbnail generation.
"""
# app/utils/media_utils.py
import os
import logging
import time
import re
import mimetypes
import subprocess
import traceback
import gc
import psutil
import threading
import shutil
import shlex
from urllib.parse import quote
from functools import lru_cache

from app.services.core.runtime_config_service import (
    get_runtime_config_value,
    get_runtime_instance_path,
)

logger = logging.getLogger(__name__)

# Set process priority and CPU affinity
try:
    p = psutil.Process()
    # Only attempt to set high priority if we have sufficient privileges
    # (Usually requires being root or having CAP_SYS_NICE)
    is_root = os.geteuid() == 0 if hasattr(os, 'geteuid') else False
    if is_root:
        os.nice(-10) # Set process priority to high
        if hasattr(p, 'ionice'):
            p.ionice(psutil.IOPRIO_CLASS_BE, value=0)

    # Setting CPU affinity is usually allowed for own processes even if not root
    p.cpu_affinity(list(range(os.cpu_count() or 1)))
except (PermissionError, OSError) as e:
    # Quietly log if not permitted, this is normal for non-root users
    logger.debug(f"Process priority/affinity adjustment limited: {e}")
except Exception as e:
    logger.warning(f"Unexpected error setting process priority/affinity: {e}")

# Constants for Pi optimization
PROCESS_TIMEOUT = 30  # Timeout for ffmpeg
# Thumbnail size constants - optimized for Pi 4 speed
THUMBNAIL_SIZE = (240, 240)
THUMBNAIL_SIZE_PI = (240, 135)  # Smaller = faster generation on Pi
MAX_THREADS = max(1, os.cpu_count() - 1)  # Leave one core free
FFMPEG_CMD = shutil.which('ffmpeg') or '/usr/bin/ffmpeg'
FFPROBE_CMD = shutil.which('ffprobe') or '/usr/bin/ffprobe'

# Initialize hardware acceleration detection
HW_ACCEL = "none"

# Memory optimization
GC_THRESHOLD = 50 * 1024 * 1024  # 50MB threshold for garbage collection

# Maximum thumbnail generation attempts before permanent failure
MAX_THUMBNAIL_ATTEMPTS = 5

# Minimum image file size to generate a thumbnail (skip files smaller than this)
IMAGE_THUMBNAIL_MIN_SIZE = 2 * 1024 * 1024  # 2 MB

# Placeholder thumbnail path (GhostHub logo used as fallback)
PLACEHOLDER_THUMBNAIL = 'static/icons/Ghosthub192.png'

# Global cache for config values
_MEDIA_EXTS = None
_IMAGE_EXTS = None
_VIDEO_EXTS = None
_MIME_TYPES_MAP = None

def _ensure_config_cache():
    """Lazy load config values into module-level sets/dicts for performance."""
    global _MEDIA_EXTS, _IMAGE_EXTS, _VIDEO_EXTS, _MIME_TYPES_MAP
    if _MEDIA_EXTS is None:
        try:
            _MEDIA_EXTS = set(get_runtime_config_value('MEDIA_EXTENSIONS', []))
            _IMAGE_EXTS = set(get_runtime_config_value('IMAGE_EXTENSIONS', []))
            _VIDEO_EXTS = set(get_runtime_config_value('VIDEO_EXTENSIONS', []))
            
            _MIME_TYPES_MAP = {}
            for media_type, info in get_runtime_config_value('MEDIA_TYPES', {}).items():
                for ext in info['mime_types']:
                     _MIME_TYPES_MAP[ext] = info['mime_types'][ext]
        except Exception:
            # Fallback if called outside application context (should rare/never happen in prod)
            return False
    return True

def is_media_file(filename):
    """Check if a file has a supported media extension."""
    if _ensure_config_cache():
        _, ext = os.path.splitext(filename)
        return ext.lower() in _MEDIA_EXTS

    # Fallback
    _, ext = os.path.splitext(filename)
    return ext.lower() in get_runtime_config_value('MEDIA_EXTENSIONS', [])

def is_video_file(filename):
    """Check if a file is a video."""
    media_type = get_media_type(filename)
    return media_type == 'video'

def get_media_type(filename):
    """Determine if a file is an image, video, or unknown type."""
    _, ext = os.path.splitext(filename)
    ext_lower = ext.lower()

    if _ensure_config_cache():
        if ext_lower in _IMAGE_EXTS:
            return 'image'
        elif ext_lower in _VIDEO_EXTS:
            return 'video'
        else:
            return 'unknown'
            
    # Fallback
    if ext_lower in get_runtime_config_value('IMAGE_EXTENSIONS', []):
        return 'image'
    elif ext_lower in get_runtime_config_value('VIDEO_EXTENSIONS', []):
        return 'video'
    else:
        return 'unknown'

def get_mime_type(filename):
    """Get the MIME type for a file based on its extension."""
    _, ext = os.path.splitext(filename)
    ext_lower = ext.lower()

    if _ensure_config_cache():
        return _MIME_TYPES_MAP.get(ext_lower)
        
    # Fallback
    for media_type, info in get_runtime_config_value('MEDIA_TYPES', {}).items():
        if ext_lower in info['mime_types']:
            return info['mime_types'][ext_lower]

    logger.warning(f"MIME type not found for extension: {ext_lower}")
    return None

# Thumbnail Generation Constants

THUMBNAIL_DIR_NAME = "thumbnails"
GHOSTHUB_DIR_NAME = ".ghosthub"
# THUMBNAIL_SIZE removed to avoid duplication (defined at top)
THUMBNAIL_FORMAT = "JPEG" # Use JPEG for good compression/quality balance

def _detect_hardware_acceleration():
    """
    Detect available hardware acceleration on Raspberry Pi.
    Sets the global HW_ACCEL variable with the detected acceleration method.
    """
    global HW_ACCEL
    
    try:
        # Check for V4L2 M2M (Raspberry Pi 4)
        result = subprocess.run(
            [FFMPEG_CMD, '-hide_banner', '-hwaccels'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if 'v4l2m2m' in result.stdout.lower():
            HW_ACCEL = 'v4l2m2m'
            logger.info("Detected V4L2 M2M hardware acceleration")
        # Check for MMAL (older Pis)
        elif os.path.exists('/opt/vc/bin/vcgencmd'):
            HW_ACCEL = 'mmal'
            logger.info("Detected MMAL hardware acceleration")
        else:
            HW_ACCEL = 'none'
            logger.info("No hardware acceleration detected, using software encoding")
            
    except Exception as e:
        HW_ACCEL = 'none'
        logger.warning(f"Hardware acceleration detection failed, falling back to software: {e}")
    
    return HW_ACCEL

# Initialize hardware acceleration
_detect_hardware_acceleration()

def _get_ffmpeg_cmd(media_path, output_path, size, seek_time='2'):
    """
    Generate optimized ffmpeg command for fast thumbnail extraction on Pi.
    
    Optimizations for Pi 4 2GB:
    - -ss before -i: Seek before opening (fast)
    - -t 1: Only read 1 second of video (limits I/O)
    - -an: Skip audio decoding entirely
    - -map 0:v:0: Only process first video stream
    - -sws_flags fast_bilinear: Fastest scaling algorithm
    - -frames:v 1: Stop after first frame
    - -f mjpeg: Direct JPEG output (faster than auto-detect)
    
    Args:
        media_path: Input file path
        output_path: Output file path
        size: Tuple (width, height)
        seek_time: Seek time in seconds
        
    Returns:
        list: Command arguments for subprocess
    """
    width, height = size
    seek_time_str = str(int(float(seek_time)))
    
    # Optimized base command for Pi
    # -ss BEFORE -i = fast seek (doesn't decode everything before seek point)
    # -t 3 = read 3 seconds after seek (ensures we get a valid frame)
    # -an = no audio processing
    base_opts = [
        FFMPEG_CMD,
        '-y',                          # Overwrite output
        '-ss', seek_time_str,          # Seek BEFORE input (fast seek)
        '-t', '3',                      # Read 3 seconds to ensure valid frame
        '-i', media_path,
        '-an',                          # No audio
    ]
    
    # Fast scaling filter with bilinear (much faster than default bicubic)
    scale_filter = f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=fast_bilinear"
    
    # Hardware specific options
    if HW_ACCEL == 'v4l2m2m':
        cmd = base_opts + [
            "-c:v", "h264_v4l2m2m",
            "-vf", f"scale_v4l2m2m={width}:{height}",
            "-frames:v", "1",
            "-q:v", "5",
            output_path
        ]
    elif HW_ACCEL == 'mmal':
        cmd = base_opts + [
            '-hwaccel', 'mmal',
            '-vf', scale_filter,
            '-frames:v', '1',
            '-q:v', '5',
            output_path
        ]
    else:
        # Software - most common on Pi 4 and desktop
        cmd = base_opts + [
            "-vf", scale_filter,
            "-frames:v", "1",
            "-q:v", "5",                # Quality (2-31, lower=better)
            output_path
        ]

    return cmd

def get_video_duration(video_path):
    """
    Get video duration in seconds using ffprobe.

    Args:
        video_path: Path to video file

    Returns:
        float: Duration in seconds, or None if unable to determine
    """
    try:
        cmd = [
            FFPROBE_CMD,
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            video_path
        ]

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5
        )

        if result.returncode == 0:
            duration_str = result.stdout.decode('utf-8').strip()
            return float(duration_str)
        return None
    except Exception as e:
        logger.warning(f"Failed to get duration for {os.path.basename(video_path)}: {e}")
        return None

def _has_video_stream(video_path):
    """
    Check if a file contains at least one video stream using ffprobe.
    Catches stub/fake MP4s that have valid container headers but no actual
    video data (e.g. stress-test files, corrupt downloads).

    Returns:
        bool: True if the file has a decodable video stream, False otherwise.
    """
    try:
        cmd = [
            FFPROBE_CMD,
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'csv=p=0',
            video_path
        ]
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5
        )
        output = result.stdout.decode('utf-8').strip()
        return result.returncode == 0 and 'video' in output
    except Exception as e:
        logger.debug(f"ffprobe stream check failed for {os.path.basename(video_path)}: {e}")
        # If ffprobe isn't available or errors out, let ffmpeg try anyway
        return True


def _default_thumbnail_path(original_media_path):
    """Compute the default thumbnail save path for a media file."""
    filename = os.path.basename(original_media_path)
    thumbnail_dir = os.path.join(get_runtime_instance_path(), THUMBNAIL_DIR_NAME)
    return os.path.join(thumbnail_dir, get_thumbnail_filename(filename))


def _create_permanent_failure_marker(thumbnail_path, reason='max_attempts'):
    """Create a failure marker that will never be retried."""
    import json
    failed_marker = thumbnail_path + ".failed"
    try:
        os.makedirs(os.path.dirname(failed_marker), exist_ok=True)
        with open(failed_marker, 'w') as f:
            json.dump({
                'attempts': MAX_THUMBNAIL_ATTEMPTS + 1,
                'last_failed': time.time(),
                'permanent': True,
                'reason': reason
            }, f)
        try:
            os.chmod(failed_marker, 0o666)
        except Exception:
            pass
    except Exception as e:
        logger.debug(f"Failed to create permanent failure marker: {e}")


def is_thumbnail_permanently_failed(thumbnail_path):
    """Check if a thumbnail has been marked as permanently failed."""
    failed_marker = thumbnail_path + ".failed"
    if not os.path.exists(failed_marker):
        return False
    try:
        import json
        with open(failed_marker, 'r') as f:
            data = json.load(f)
        return data.get('permanent', False) or data.get('attempts', 0) > MAX_THUMBNAIL_ATTEMPTS
    except Exception:
        return False


def should_retry_thumbnail(thumbnail_path, media_path):
    """
    Check if a thumbnail should be retried based on failure markers and backoff.
    
    Returns:
        bool: True if we should try generating, False if we should skip due to cooldown.
    """
    failed_marker = thumbnail_path + ".failed"
    if not os.path.exists(failed_marker):
        return True
        
    try:
        import json
        with open(failed_marker, 'r') as f:
            failure_data = json.load(f)

        # Permanent failures are never retried (file_too_small, max_attempts exceeded)
        if failure_data.get('permanent', False):
            return False

        attempts = failure_data.get('attempts', 1)
        last_failed = failure_data.get('last_failed', 0)

        # If max attempts exceeded, mark permanent and stop retrying
        if attempts > MAX_THUMBNAIL_ATTEMPTS:
            failure_data['permanent'] = True
            try:
                with open(failed_marker, 'w') as f:
                    json.dump(failure_data, f)
            except Exception:
                pass
            return False

        # If media file changed since last failure, try again immediately
        try:
            media_mtime = os.path.getmtime(media_path)
            if media_mtime > last_failed:
                return True
        except OSError:
            pass

        # Cooldown logic (seconds): 2m, 10m, 30m, 1h, 4h
        cooldowns = [120, 600, 1800, 3600, 14400]
        cooldown = cooldowns[min(attempts - 1, len(cooldowns) - 1)]

        if time.time() - last_failed >= cooldown:
            return True

        return False
    except Exception:
        # If marker is corrupt, retry anyway
        return True

def generate_thumbnail(original_media_path, thumbnail_save_path=None, force_refresh=False, size=None):
    """
    Generate a thumbnail for an image or video file using ffmpeg with hardware acceleration.
    Args:
        original_media_path: Path to input file
        thumbnail_save_path: Path to save thumbnail
        force_refresh: Redo even if exists
        size: Tuple (width, height)
    """
    if size is None:
        size = THUMBNAIL_SIZE_PI

    # Verify input exists
    if not os.path.exists(original_media_path):
        logger.error(f"Original media file does not exist: {original_media_path}")
        return False

    # Default output path if none provided
    if not thumbnail_save_path:
        filename = os.path.basename(original_media_path)
        thumbnail_dir = os.path.join(get_runtime_instance_path(), THUMBNAIL_DIR_NAME)
        thumbnail_save_path = os.path.join(thumbnail_dir, get_thumbnail_filename(filename))

    # Check if exists and not force refresh
    if not force_refresh:
        if os.path.exists(thumbnail_save_path):
            return True

        # Centralized retry/backoff logic
        if not should_retry_thumbnail(thumbnail_save_path, original_media_path):
            return False

    # Validate the file has a real video stream before wasting CPU on ffmpeg
    if not _has_video_stream(original_media_path):
        logger.debug(f"No video stream found, skipping thumbnail: {os.path.basename(original_media_path)}")
        _create_permanent_failure_marker(thumbnail_save_path, 'no_video_stream')
        return False

    # Ensure directory exists with proper permissions
    thumbnail_dir = os.path.dirname(thumbnail_save_path)
    if not os.path.exists(thumbnail_dir):
        os.makedirs(thumbnail_dir, exist_ok=True)
        try:
            os.chmod(thumbnail_dir, 0o777)
        except Exception:
            pass

    # Check memory before starting (Pi optimization)
    try:
        if psutil.virtual_memory().available < 50 * 1024 * 1024:
            gc.collect()
            if psutil.virtual_memory().available < 25 * 1024 * 1024:
                logger.warning("Extremely low memory, skipping thumbnail generation")
                return False
    except Exception:
        pass

    try:
        # Get duration for smart seeking (skips intros/black frames)
        duration = get_video_duration(original_media_path)
        
        if duration:
            if duration > 600:      # >10 mins
                seek_times = [min(duration * 0.15, 600), 120, 30, 5, 0]
            elif duration > 120:    # 2-10 mins
                seek_times = [duration * 0.20, 30, 5, 0]
            elif duration > 30:     # 30s-2mins
                seek_times = [duration * 0.25, 5, 0]
            else:                   # <30s
                seek_times = [duration * 0.10, 0]
        else:
            seek_times = [120, 30, 5, 0] # Fallback if duration unknown

        # Try each seek time until success
        for seek_time in seek_times:
            # Skip seek times beyond duration
            if duration and seek_time > duration:
                continue
                
            cmd = _get_ffmpeg_cmd(original_media_path, thumbnail_save_path, size, seek_time)
            
            try:
                result = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=PROCESS_TIMEOUT
                )
                
                if result.returncode == 0 and os.path.exists(thumbnail_save_path):
                    if os.path.getsize(thumbnail_save_path) > 100: # Ensure not an empty file
                        try:
                            os.chmod(thumbnail_save_path, 0o666)
                        except Exception:
                            pass
                        logger.info(f"Thumb generated for {os.path.basename(original_media_path)} at {seek_time:.1f}s")
                        return True
                    else:
                        logger.debug(f"Generated thumbnail too small at {seek_time}s, trying next...")
            except subprocess.TimeoutExpired:
                logger.warning(f"ffmpeg timed out at {seek_time}s for {os.path.basename(original_media_path)}")
                continue

        logger.warning(f"All seek times failed for {os.path.basename(original_media_path)}")
        
        # Create/Update failure marker with exponential backoff data
        try:
            import json
            failed_marker = thumbnail_save_path + ".failed"
            attempts = 1
            if os.path.exists(failed_marker):
                try:
                    with open(failed_marker, 'r') as f:
                        old_data = json.load(f)
                        attempts = old_data.get('attempts', 0) + 1
                except Exception:
                    pass

            is_permanent = attempts >= MAX_THUMBNAIL_ATTEMPTS
            with open(failed_marker, 'w') as f:
                json.dump({
                    'attempts': attempts,
                    'last_failed': time.time(),
                    'permanent': is_permanent,
                    'reason': 'max_attempts' if is_permanent else 'generation_failed'
                }, f)
            try:
                os.chmod(failed_marker, 0o666)
            except Exception:
                pass
            if is_permanent:
                logger.info(f"Thumbnail permanently failed after {attempts} attempts: {os.path.basename(original_media_path)}")
        except Exception as e:
            logger.debug(f"Failed to create failure marker: {e}")
            
        return False

    except Exception as e:
        logger.error(f"Error generating thumbnail for {original_media_path}: {str(e)}")
        return False

def generate_image_thumbnail(source_path, thumbnail_save_path, size=None):
    """
    Generate a thumbnail for an image file using PIL (no ffmpeg needed).
    Much faster than video thumbnail generation on Pi hardware.

    Args:
        source_path: Path to source image
        thumbnail_save_path: Where to save the resized JPEG
        size: Tuple (width, height) — defaults to THUMBNAIL_SIZE_PI

    Returns:
        bool: True on success, False on failure
    """
    if size is None:
        size = THUMBNAIL_SIZE_PI

    if not os.path.exists(source_path):
        logger.error(f"Image source does not exist: {source_path}")
        return False

    if not thumbnail_save_path:
        filename = os.path.basename(source_path)
        thumbnail_dir = os.path.join(get_runtime_instance_path(), THUMBNAIL_DIR_NAME)
        thumbnail_save_path = os.path.join(thumbnail_dir, get_thumbnail_filename(filename))

    if os.path.exists(thumbnail_save_path):
        return True

    if not should_retry_thumbnail(thumbnail_save_path, source_path):
        return False

    thumbnail_dir = os.path.dirname(thumbnail_save_path)
    if not os.path.exists(thumbnail_dir):
        os.makedirs(thumbnail_dir, exist_ok=True)
        try:
            os.chmod(thumbnail_dir, 0o777)
        except Exception:
            pass

    try:
        from PIL import Image
        with Image.open(source_path) as img:
            img = img.convert('RGB')
            img.thumbnail(size, Image.LANCZOS)
            img.save(thumbnail_save_path, 'JPEG', quality=85, optimize=True)
        try:
            os.chmod(thumbnail_save_path, 0o666)
        except Exception:
            pass
        logger.info(f"Image thumbnail generated: {os.path.basename(source_path)}")
        return True
    except Exception as e:
        logger.warning(f"Image thumbnail failed for {os.path.basename(source_path)}: {e}")
        _create_permanent_failure_marker(thumbnail_save_path, 'pil_error')
        return False


def get_thumbnail_filename(original_filename):
    """
    Normalize a filename for thumbnail storage (replace special chars, add .jpg).
    Ensures consistent naming between thumbnail generation and retrieval.
    
    Preserves relative path structure to avoid collisions when same filename
    exists in different subfolders (e.g., video.mp4 vs subfolder/video.mp4).
    """
    # Normalize path separators and remove extension
    # Keep relative path to avoid collisions: subfolder/video.mp4 -> subfolder_video.jpeg
    normalized = original_filename.replace('\\', '/').replace('/', '_')
    base_name, _ = os.path.splitext(normalized)
    
    # Optimized replacement using translate
    # Map special chars to '_'
    special_chars = '?&%#\'!$"()[]{}+=, ;'
    trans_table = str.maketrans({c: '_' for c in special_chars})
    base_name = base_name.translate(trans_table)
    
    return f"{base_name}.{THUMBNAIL_FORMAT.lower()}"

def get_thumbnail_url(category_id, original_filename):
    """
    Construct the URL for a thumbnail.
    """
    thumbnail_filename = get_thumbnail_filename(original_filename)
    encoded_thumbnail_filename = quote(thumbnail_filename)
    return f"/thumbnails/{category_id}/{encoded_thumbnail_filename}"

def get_media_item_thumbnail_url(category_id, rel_path, item_type, size=0):
    """Return the thumbnail URL API payloads should expose for one media item."""
    if item_type == 'video':
        return get_thumbnail_url(category_id, rel_path)
    if item_type == 'image':
        try:
            file_size = int(size or 0)
        except (TypeError, ValueError):
            file_size = 0
        if file_size >= IMAGE_THUMBNAIL_MIN_SIZE:
            return get_thumbnail_url(category_id, rel_path)
        return f"/media/{category_id}/{quote(rel_path)}"
    return None

def find_thumbnail(category_path, category_id, category_name, media_files=None, allow_queue=True):
    """
    Find or generate a thumbnail for a category directory.

    Args:
        category_path (str): Full path to category directory
        category_id (str): Category ID for URL generation
        category_name (str): Category name for logging
        media_files (list|None): Pre-scanned list to avoid re-scanning

    Returns:
        Tuple[int, str|None, bool]: (media_count, thumbnail_url, contains_video)
    """
    thumbnail_url = None
    contains_video = False
    media_count = 0

    try:
        if not os.path.isdir(category_path):
            logger.warning(f"find_thumbnail called with non-directory path: {category_path}")
            return 0, None, False

        # If media_files not provided, scan recursively
        if media_files is None:
            temp_media_files = []
            try:
                # Limit depth or just take first few files for performance
                for root, dirs, files in os.walk(category_path):
                    # Skip hidden
                    dirs[:] = [d for d in dirs if not d.startswith('.') and d.lower() not in ['.ghosthub', '.ghosthub_uploads', '$recycle.bin', 'system volume information']]
                    for f in files:
                        if not f.startswith('.') and is_media_file(f):
                            # Store relative path for thumbnail generation consistency
                            rel_path = os.path.relpath(os.path.join(root, f), category_path).replace('\\', '/')
                            temp_media_files.append(rel_path)
                            if len(temp_media_files) >= 50: # Stop scan once we have enough options
                                break
                    if len(temp_media_files) >= 50:
                        break
                media_files = temp_media_files
            except OSError as e:
                logger.warning(f"Error scanning directory {category_path}: {e}")
                return 0, None, False

        media_count = len(media_files)
        if media_count == 0:
            # No media found in quick scan
            return 0, None, False

        _ensure_config_cache()

        preferred_formats = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
        img_exts = _IMAGE_EXTS if _IMAGE_EXTS else set(
            get_runtime_config_value('IMAGE_EXTENSIONS', []),
        )
        vid_exts = _VIDEO_EXTS if _VIDEO_EXTS else set(
            get_runtime_config_value('VIDEO_EXTENSIONS', []),
        )

        images = []
        videos = []

        # ... (hidden file filtering) ...
        try:
            from app.services.media.hidden_content_service import is_file_hidden
            from flask import has_request_context
            from app.utils.auth import get_show_hidden_flag
            show_hidden = get_show_hidden_flag() if has_request_context() else False
        except Exception:
            show_hidden = False

        for name in media_files:
            _, ext = os.path.splitext(name)
            ext_lower = ext.lower()
            file_path = os.path.join(category_path, name)
            
            if not show_hidden and is_file_hidden(file_path):
                continue

            if ext_lower in img_exts:
                images.append(name)
            elif ext_lower in vid_exts:
                videos.append(name)
                contains_video = True
        
        # Recalculate count after filtering hidden
        media_count = len(images) + len(videos)
        if media_count == 0:
            return 0, None, False

        # 1. Use preferred image format
        images.sort()
        for img in images:
            _, ext = os.path.splitext(img)
            if ext.lower() in preferred_formats:
                thumbnail_url = get_thumbnail_url(category_id, img)
                return media_count, thumbnail_url, contains_video

        # 2. Use any image
        if images:
            thumbnail_url = get_thumbnail_url(category_id, images[0])
            return media_count, thumbnail_url, contains_video

        # 3. Use video thumbnail if present
        if videos:
            videos.sort()
            vid_name = videos[0]
            thumb_name = get_thumbnail_filename(vid_name)

            # Check if thumbnail exists (always stored in category root .ghosthub)
            ghosthub_dir = os.path.join(category_path, GHOSTHUB_DIR_NAME)
            thumbnail_dir = os.path.join(ghosthub_dir, THUMBNAIL_DIR_NAME)
            thumb_path = os.path.join(thumbnail_dir, thumb_name)

            if os.path.exists(thumb_path):
                thumbnail_url = f"/thumbnails/{category_id}/{quote(thumb_name)}"
                return media_count, thumbnail_url, contains_video

            # Queue thumbnail generation (optional)
            if allow_queue:
                try:
                    from specter import registry

                    registry.require('thumbnail_runtime').queue_thumbnail(
                        category_path,
                        category_id,
                        {'name': vid_name},
                        force_refresh=False,
                    )
                except Exception as e:
                    logger.warning(f"Failed to queue thumbnail for {vid_name}: {e}")

        return media_count, None, contains_video

    except Exception as e:
        logger.error(f"Error finding/generating thumbnail for '{category_name}': {str(e)}")
        return media_count, None, False
