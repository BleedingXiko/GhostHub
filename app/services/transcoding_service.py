# app/services/transcoding_service.py
import os
import time
import logging
import threading
import concurrent.futures
import subprocess 
import json       
from functools import partial
from flask import current_app
from app.services.storage_service import StorageService
from app.utils.server_utils import find_ffmpeg_executable

logger = logging.getLogger(__name__)

# --- Thread Pool Executor Setup (Lazy Initialization) ---
_thread_executor = None
_thread_executor_lock = threading.Lock()

def get_thread_executor():
    """Lazily initializes and returns the ThreadPoolExecutor."""
    global _thread_executor
    if _thread_executor is None:
        with _thread_executor_lock:
            if _thread_executor is None: # Double-check locking
                try:
                    num_workers = current_app.config['TRANSCODING_WORKERS']
                except Exception as e:
                    logger.warning(f"Failed to get TRANSCODING_WORKERS from app config ({e}), using default calculation.")
                    num_workers = max(1, (os.cpu_count() or 2) // 2)

                logger.info(f"Initializing ThreadPoolExecutor with {num_workers} workers for transcoding.")
                _thread_executor = concurrent.futures.ThreadPoolExecutor(max_workers=num_workers, thread_name_prefix='TranscodeWorker')
    return _thread_executor
# --- End Executor Setup ---


# --- Transcoding Function (runs in a worker thread
def _transcode_in_thread(original_path, output_path, video_bitrate, audio_bitrate, crf, preset, target_resolution):
    """
    Core transcoding logic.
    """
    filename = os.path.basename(original_path)
    thread_name = threading.current_thread().name
    logger.info(f"[{thread_name}] Starting transcoding: {filename} -> {output_path}")
    start_time = time.time()

    try:
        # Find ffmpeg executable
        ffmpeg_path = find_ffmpeg_executable("ffmpeg")

        # Create output directory if needed
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # This is slightly redundant with should_transcode, but ensures the worker has the info
        # and handles cases where should_transcode might be bypassed or fails.
        input_width = 0
        input_height = 0
        try:
            ffprobe_path = find_ffmpeg_executable("ffprobe")
            probe_command = [
                ffprobe_path,
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "json",
                original_path
            ]
            probe_result = subprocess.run(probe_command, capture_output=True, text=True, check=True)
            probe_data = json.loads(probe_result.stdout)
            if probe_data and 'streams' in probe_data and len(probe_data['streams']) > 0:
                input_width = probe_data['streams'][0].get('width', 0)
                input_height = probe_data['streams'][0].get('height', 0)
            if not input_width or not input_height:
                 raise ValueError("Could not determine input resolution via ffprobe.")
        except FileNotFoundError:
             raise # Re-raise FileNotFoundError for ffprobe
        except subprocess.CalledProcessError as e:
            logger.error(f"[{thread_name}] ffprobe failed for {filename}: {e.stderr}")
            raise ValueError(f"ffprobe failed: {e.stderr}")
        except Exception as e:
            logger.error(f"[{thread_name}] Error probing {filename} in worker: {e}")
            raise ValueError(f"Error probing file: {e}")


        # --- Construct ffmpeg Command ---
        command = [
            ffmpeg_path,
            "-y",  # Overwrite output files without asking
            "-i", original_path,
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            "-maxrate", str(video_bitrate),
            "-bufsize", str(video_bitrate * 2),
            "-pix_fmt", "yuv420p",
            "-profile:v", "high",
            "-level:v", "4.0", # Consider adjusting based on resolution if needed
            "-c:a", "aac",
            "-b:a", str(audio_bitrate),
            "-profile:a", "aac_low",
            "-movflags", "+faststart", # Optimize for web streaming
            "-threads", "0", # Use optimal number of threads
        ]

        # --- Add Scaling Filter if Needed ---
        output_width = input_width
        output_height = input_height
        aspect_ratio = input_width / input_height if input_height else 16/9

        if target_resolution > 0 and input_height > target_resolution:
            # Check against min scaling resolution is done in should_transcode
            output_height = target_resolution
            output_width = int(output_height * aspect_ratio)
            # Ensure width is even
            if output_width % 2 != 0: output_width += 1
            logger.info(f"[{thread_name}] Applying scaling filter: {input_width}x{input_height} -> {output_width}x{output_height}")
            command.extend(["-vf", f"scale={output_width}:{output_height}"])
        else:
             # Explicitly copy if no scaling (though ffmpeg might do this implicitly)
             # command.extend(["-vf", "copy"]) # Not needed, ffmpeg handles this
             pass

        command.append(output_path)

        logger.debug(f"[{thread_name}] Executing ffmpeg command: {' '.join(command)}")

        # Execute ffmpeg command
        result = subprocess.run(command, capture_output=True, text=True)

        if result.returncode != 0:
            # Log stderr for debugging
            logger.error(f"[{thread_name}] ffmpeg failed for {filename}. Return code: {result.returncode}")
            logger.error(f"[{thread_name}] ffmpeg stderr: {result.stderr}")
            raise subprocess.CalledProcessError(result.returncode, command, output=result.stdout, stderr=result.stderr)

        elapsed_time = time.time() - start_time
        logger.info(f"[{thread_name}] Transcoding complete (ffmpeg): {filename} in {elapsed_time:.2f} seconds")
        return {"status": "complete", "error": None}

    except FileNotFoundError as e:
         # Specifically handle missing ffmpeg/ffprobe
         error_message = f"Executable not found: {e}. Ensure ffmpeg/ffprobe are correctly placed."
         logger.error(f"[{thread_name}] {error_message}")
         return {"status": "error", "error": error_message}
    except Exception as e:
        error_type = type(e).__name__
        error_message = f"Error during transcoding {filename} (Type: {error_type}): {str(e)}"
        logger.error(f"[{thread_name}] {error_message}", exc_info=True) # Log full traceback

        # Clean up potentially incomplete output file
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
                logger.info(f"[{thread_name}] Removed incomplete output file: {output_path}")
        except Exception as cleanup_err:
            logger.error(f"[{thread_name}] Error during cleanup for {output_path}: {cleanup_err}")

        return {"status": "error", "error": error_message} # Return simplified error message
# --- End Transcoding Function ---


class TranscodingService:
    """
    Service for video transcoding using ffmpeg command-line tool.
    """
    # Config defaults remain the same
    DEFAULT_VIDEO_BITRATE = 2500000
    DEFAULT_AUDIO_BITRATE = 192000
    DEFAULT_CRF = 23
    DEFAULT_PRESET = 'fast' # Keep 'fast' as default after user feedback
    DEFAULT_TARGET_RESOLUTION = 0
    DEFAULT_MIN_BITRATE_SAVING_RATIO = 1.5
    DEFAULT_MIN_RESOLUTION_FOR_SCALING = 720
    MIN_FILE_SIZE_FOR_TRANSCODING = 2 * 1024 * 1024

    _active_jobs = {}
    _lock = threading.Lock()

    # Config getter methods remain the same
    @staticmethod
    def is_enabled():
        return current_app.config.get('ENABLE_TRANSCODING', True)
    @staticmethod
    def get_video_bitrate():
        return current_app.config.get('TRANSCODING_VIDEO_BITRATE', TranscodingService.DEFAULT_VIDEO_BITRATE)
    @staticmethod
    def get_audio_bitrate():
        return current_app.config.get('TRANSCODING_AUDIO_BITRATE', TranscodingService.DEFAULT_AUDIO_BITRATE)
    @staticmethod
    def get_crf():
        return current_app.config.get('TRANSCODING_CRF', TranscodingService.DEFAULT_CRF)
    @staticmethod
    def get_preset():
        return current_app.config.get('TRANSCODING_PRESET', TranscodingService.DEFAULT_PRESET)
    @staticmethod
    def get_target_resolution():
        return current_app.config.get('TRANSCODING_TARGET_RESOLUTION', TranscodingService.DEFAULT_TARGET_RESOLUTION)
    @staticmethod
    def get_min_bitrate_saving_ratio():
        return current_app.config.get('TRANSCODING_MIN_BITRATE_SAVING_RATIO', TranscodingService.DEFAULT_MIN_BITRATE_SAVING_RATIO)
    @staticmethod
    def get_min_resolution_for_scaling():
        return current_app.config.get('TRANSCODING_MIN_RESOLUTION_FOR_SCALING', TranscodingService.DEFAULT_MIN_RESOLUTION_FOR_SCALING)
    @staticmethod
    def get_min_size_for_transcoding():
        return current_app.config.get('TRANSCODING_MIN_SIZE', TranscodingService.MIN_FILE_SIZE_FOR_TRANSCODING)

    @staticmethod
    def should_transcode(filepath):
        """
        Determine if a file should be transcoded using ffprobe.
        """
        filename = os.path.basename(filepath)

        # 1. Basic Checks (Enabled, Type, Size) - Remain the same
        if not TranscodingService.is_enabled():
            logger.debug(f"Skipping '{filename}': Transcoding disabled.")
            return False
        from app.utils.media_utils import get_media_type
        if get_media_type(filename) != 'video':
            logger.debug(f"Skipping '{filename}': Not a video file.")
            return False
        min_size = TranscodingService.get_min_size_for_transcoding()
        try:
            file_size = StorageService.get_file_size(filepath)
            if file_size < min_size:
                logger.debug(f"Skipping '{filename}': File size {file_size} < {min_size}.")
                return False
        except FileNotFoundError:
            logger.error(f"Cannot check size for '{filename}': File not found at {filepath}.")
            return False
        except Exception as e:
            logger.error(f"Error getting size for '{filename}': {e}")
            return False

        # 2. Media Info Check (Bitrate, Resolution using ffprobe)
        original_bitrate = 0
        original_height = 0
        try:
            ffprobe_path = find_ffmpeg_executable("ffprobe")
            command = [
                ffprobe_path,
                "-v", "error",
                "-select_streams", "v:0", # Assume first video stream
                "-show_entries", "stream=width,height,bit_rate:format=bit_rate", # Get stream/format bitrates
                "-of", "json",
                filepath
            ]
            logger.debug(f"Running ffprobe for {filename}: {' '.join(command)}")
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)

            # Get height from video stream
            if 'streams' in data and len(data['streams']) > 0:
                original_height = data['streams'][0].get('height', 0)
                stream_bit_rate = data['streams'][0].get('bit_rate')
                if stream_bit_rate and stream_bit_rate != 'N/A':
                    original_bitrate = int(stream_bit_rate)

            # Use format bit_rate if stream bit_rate is unavailable or N/A
            if original_bitrate == 0 and 'format' in data:
                format_bit_rate = data['format'].get('bit_rate')
                if format_bit_rate and format_bit_rate != 'N/A':
                    original_bitrate = int(format_bit_rate)

            if not original_bitrate or not original_height:
                 logger.warning(f"Could not determine original bitrate or height for '{filename}' via ffprobe. Skipping.")
                 return False

        except FileNotFoundError as e:
             logger.error(f"ffprobe executable not found: {e}. Cannot check media info.")
             return False # Cannot proceed without ffprobe
        except subprocess.CalledProcessError as e:
            logger.error(f"ffprobe failed for '{filename}': {e.stderr}")
            return False # Skip if ffprobe fails
        except Exception as e:
            logger.error(f"Error inspecting '{filename}' with ffprobe: {e}")
            return False # Skip on other errors

        # 3. Decision Logic - Remains the same
        target_video_bitrate = TranscodingService.get_video_bitrate()
        target_audio_bitrate = TranscodingService.get_audio_bitrate()
        target_total_bitrate = target_video_bitrate + target_audio_bitrate
        min_ratio = TranscodingService.get_min_bitrate_saving_ratio()
        target_resolution = TranscodingService.get_target_resolution()
        min_scale_resolution = TranscodingService.get_min_resolution_for_scaling()

        bitrate_saving_expected = original_bitrate > (target_total_bitrate * min_ratio)
        if bitrate_saving_expected:
             logger.info(f"Transcoding '{filename}': Original bitrate ({original_bitrate/1000:.0f} kbps) > Target ({target_total_bitrate/1000:.0f} kbps) * Ratio ({min_ratio}).")
             return True

        resolution_scaling_applicable = (
            target_resolution > 0 and
            original_height > target_resolution and
            original_height >= min_scale_resolution
        )
        if resolution_scaling_applicable:
            logger.info(f"Transcoding '{filename}': Resolution scaling from {original_height}p to {target_resolution}p is applicable.")
            return True

        logger.info(f"Skipping '{filename}': No significant bitrate saving ({original_bitrate/1000:.0f} kbps vs target {target_total_bitrate/1000:.0f} kbps, ratio {min_ratio}) and no resolution scaling applicable (original {original_height}p, target {target_resolution}p, min scale {min_scale_resolution}p).")
        return False

    @staticmethod
    def has_transcoded_version(category_path, filename):
        """Check if a transcoded version exists."""
        # Use category_path instead of category_id
        transcoded_path = StorageService.get_transcoded_path(category_path, filename)
        if not os.path.exists(transcoded_path):
            return False

        # Optional: More robust check using ffprobe to see if it's a valid media file
        try:
            ffprobe_path = find_ffmpeg_executable("ffprobe")
            command = [ffprobe_path, "-v", "error", transcoded_path]
            subprocess.run(command, check=True, capture_output=True)
            return True # ffprobe ran without error, assume valid
        except FileNotFoundError:
             logger.error("ffprobe not found, cannot validate existing transcoded file.")
             return os.path.exists(transcoded_path) # Fallback to simple existence check
        except subprocess.CalledProcessError:
            logger.warning(f"Invalid or incomplete transcoded file detected by ffprobe: {transcoded_path}")
            try:
                os.remove(transcoded_path)
                logger.info(f"Removed invalid transcoded file: {transcoded_path}")
            except OSError as remove_err:
                logger.error(f"Failed to remove invalid transcoded file {transcoded_path}: {remove_err}")
            return False
        except Exception as e:
             logger.error(f"Error validating transcoded file {transcoded_path} with ffprobe: {e}")
             return False # Treat as invalid on error

    # get_transcoding_status and _update_job_status remain largely the same,
    # as they deal with the future/job tracking, not the execution method.
    @staticmethod
    def get_transcoding_status(filepath):
        with TranscodingService._lock:
            return TranscodingService._active_jobs.get(filepath, {}).copy()

    @staticmethod
    def _update_job_status(future, original_path):
        filename = os.path.basename(original_path)
        with TranscodingService._lock:
            if original_path not in TranscodingService._active_jobs:
                logger.warning(f"Job {filename} not found in active jobs during callback. Future cancelled? {future.cancelled()}")
                return

            job_info = TranscodingService._active_jobs[original_path]
            try:
                result = future.result()
                job_info.update({
                    "status": result["status"],
                    "error": result.get("error"),
                    "progress": 100,
                    "completed_at": time.time()
                })
                status_log = f"Transcoding job {filename} finished with status: {result['status']}"
                if result.get("error"):
                    status_log += f" (See worker logs for details)"
                logger.info(status_log)

            except concurrent.futures.CancelledError:
                 logger.warning(f"Transcoding job {filename} was cancelled.")
                 job_info.update({
                    "status": "cancelled",
                    "error": "Job was cancelled during execution.",
                    "completed_at": time.time()
                 })
            except Exception as e:
                logger.error(f"Error processing transcoding result callback for {filename}: {e}", exc_info=True)
                job_info.update({
                    "status": "error",
                    "error": f"Callback/Result error: {str(e)}",
                    "completed_at": time.time()
                })

    @staticmethod
    def transcode_video(category_path, original_path, filename):
        """
        Submit video transcoding job using ffmpeg to the thread pool executor.
        
        Args:
            category_path: Path to the category directory (used for output path)
            original_path: Full path to the original video file
            filename: Name of the file (without path)
        """
        if not os.path.exists(original_path):
            logger.error(f"Original video not found for transcoding: {original_path}")
            return False

        with TranscodingService._lock:
            if original_path in TranscodingService._active_jobs:
                status = TranscodingService._active_jobs[original_path]["status"]
                if status in ["processing", "queued", "complete"]:
                    logger.debug(f"Transcoding job for {filename} already exists with status: {status}")
                    return True

        output_path = StorageService.get_transcoded_path(category_path, filename)

        try:
            video_bitrate = TranscodingService.get_video_bitrate()
            audio_bitrate = TranscodingService.get_audio_bitrate()
            crf = TranscodingService.get_crf()
            preset = TranscodingService.get_preset()
            target_resolution = TranscodingService.get_target_resolution()
        except Exception as config_err:
             logger.error(f"Failed to get transcoding config settings for {filename}: {config_err}", exc_info=True)
             with TranscodingService._lock:
                 TranscodingService._active_jobs[original_path] = {
                     "status": "error", "progress": 0, "output_path": output_path,
                     "error": f"Config error: {str(config_err)}", "started_at": time.time()
                 }
             return False

        job_status = {
            "status": "queued", "progress": 0, "started_at": time.time(),
            "output_path": output_path, "error": None
        }

        try:
            current_executor = get_thread_executor()
            future = current_executor.submit(
                _transcode_in_thread, # Use the ffmpeg-based worker function
                original_path, output_path, video_bitrate, audio_bitrate,
                crf, preset, target_resolution
            )
            future.add_done_callback(
                partial(TranscodingService._update_job_status, original_path=original_path)
            )
            job_status["status"] = "processing"
            with TranscodingService._lock:
                TranscodingService._active_jobs[original_path] = job_status
            logger.info(f"Submitted transcoding job (ffmpeg) for {filename} to thread pool.")
            return True

        except Exception as e:
            logger.error(f"Failed to submit transcoding job {filename} to thread pool: {e}", exc_info=True)
            job_status.update({"status": "error", "error": f"Submission failed: {str(e)}"})
            with TranscodingService._lock:
                 TranscodingService._active_jobs[original_path] = job_status
            return False
