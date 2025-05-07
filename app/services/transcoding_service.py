"""
Transcoding Service
-------------------
Handles on-the-fly video transcoding using FFMPEG.
"""
# app/services/transcoding_service.py
import os
import subprocess
import logging
import time
import traceback
from flask import current_app, Response # Added Response for streaming

logger = logging.getLogger(__name__)

class TranscodingService:
    """
    Service for managing video transcoding operations.
    """

    @staticmethod
    def get_or_create_transcoded_video(original_media_path, category_path):
        """
        Checks for an existing transcoded video or creates a new one.
        Returns the path to the transcoded video file.
        If transcoding fails or is not needed, may return the original path or None.
        """
        try:
            if not os.path.exists(original_media_path):
                logger.error(f"Original media file not found for transcoding: {original_media_path}")
                return None

            # Determine paths for .ghosthub and .transcoded subdirectories
            base_ghosthub_dir = os.path.join(category_path, current_app.config['GHOSTHUB_SUBDIR_NAME'])
            transcode_target_dir = os.path.join(base_ghosthub_dir, current_app.config['TRANSCODED_SUBDIR_NAME'])

            # Ensure the target directories exist
            os.makedirs(transcode_target_dir, exist_ok=True)
            logger.info(f"Ensured transcoding directory exists at: {transcode_target_dir}")

            # Construct the target filename for the transcoded video
            original_filename_base = os.path.basename(original_media_path)
            transcoded_filename = (
                original_filename_base +
                current_app.config['TRANSCODED_FILE_SUFFIX'] +
                '.' +
                current_app.config['DEFAULT_TRANSCODE_TARGET_FORMAT']
            )
            transcoded_file_path = os.path.join(transcode_target_dir, transcoded_filename)

            # Check if a valid transcoded file already exists
            # A file is valid if it exists and is newer than the original
            if os.path.exists(transcoded_file_path):
                try:
                    original_mtime = os.path.getmtime(original_media_path)
                    transcoded_mtime = os.path.getmtime(transcoded_file_path)
                    logger.debug(f"Original mtime: {original_mtime}, Transcoded mtime: {transcoded_mtime} for {transcoded_file_path}")
                    if transcoded_mtime >= original_mtime:
                        logger.info(f"Found valid existing transcoded file (newer or same age as original): {transcoded_file_path}")
                        return transcoded_file_path
                    else:
                        logger.info(f"Stale transcoded file found (older than original), will re-transcode: {transcoded_file_path}")
                except OSError as e:
                    logger.warning(f"Could not get mtime for original or transcoded file, proceeding with re-transcode. Error: {e}. Original: {original_media_path}, Transcoded: {transcoded_file_path}")
            else:
                logger.info(f"No existing transcoded file found at {transcoded_file_path}. Proceeding with new transcoding.")


            logger.info(f"Attempting transcoding for: {original_media_path} -> {transcoded_file_path}")

            # Construct FFMPEG command
            ffmpeg_path = current_app.config['FFMPEG_PATH']
            
            # Get pre-transcoding settings from config
            vcodec = current_app.config['DEFAULT_TRANSCODE_VIDEO_CODEC']
            acodec = current_app.config['DEFAULT_TRANSCODE_AUDIO_CODEC']
            preset = current_app.config['DEFAULT_TRANSCODE_PRESET']
            crf = current_app.config.get('DEFAULT_TRANSCODE_CRF', 23) # .get for safety if key somehow missing
            video_bitrate = current_app.config.get('DEFAULT_TRANSCODE_VIDEO_BITRATE', "")
            audio_bitrate = current_app.config.get('DEFAULT_TRANSCODE_AUDIO_BITRATE', "128k")

            command = [
                ffmpeg_path,
                '-i', original_media_path,
                '-y',  # Overwrite output files without asking
                '-c:v', vcodec,
                '-preset', preset,
                '-c:a', acodec,
                '-b:a', audio_bitrate,
                '-movflags', '+faststart', # Optimize for web streaming
                '-hide_banner', # Suppress version and build information
                '-loglevel', 'error', # Only log errors
            ]

            # Add CRF or video bitrate
            if video_bitrate and video_bitrate != "0":
                command.extend(['-b:v', video_bitrate])
                # If a specific video bitrate is set, CRF might be ignored by ffmpeg or behave differently.
                # Some encoders might allow both, but typically one is primary.
                # For simplicity, if b:v is set, we don't explicitly add CRF here.
                # If you want to force CRF even with b:v, you could add it.
            elif crf is not None: # Check for None explicitly if using .get with a default that could be None
                command.extend(['-crf', str(crf)])
            
            command.append(transcoded_file_path)

            logger.info(f"Pre-transcoding {original_media_path} with: vcodec={vcodec}, acodec={acodec}, preset={preset}, crf={crf}, vbr={video_bitrate}, abr={audio_bitrate}")
            logger.debug(f"Executing FFMPEG command: {' '.join(command)}")
            
            start_time = time.time()
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = process.communicate()
            end_time = time.time()
            
            duration = end_time - start_time
            logger.info(f"FFMPEG process finished in {duration:.2f} seconds for {original_filename_base}.")

            if process.returncode == 0:
                if os.path.exists(transcoded_file_path) and os.path.getsize(transcoded_file_path) > 0:
                    logger.info(f"Successfully transcoded: {transcoded_file_path}")
                    return transcoded_file_path
                else:
                    logger.error(f"FFMPEG reported success, but output file is missing or empty: {transcoded_file_path}")
                    if stdout: logger.error(f"FFMPEG STDOUT: {stdout.decode(errors='ignore')}")
                    if stderr: logger.error(f"FFMPEG STDERR: {stderr.decode(errors='ignore')}")
                    return None # Indicate failure
            else:
                logger.error(f"FFMPEG transcoding failed for {original_media_path}. Return code: {process.returncode}")
                if stdout: logger.error(f"FFMPEG STDOUT: {stdout.decode(errors='ignore')}")
                if stderr: logger.error(f"FFMPEG STDERR: {stderr.decode(errors='ignore')}")
                # Attempt to remove potentially corrupted/incomplete transcoded file
                if os.path.exists(transcoded_file_path):
                    try:
                        os.remove(transcoded_file_path)
                        logger.info(f"Removed failed/incomplete transcoded file: {transcoded_file_path}")
                    except Exception as e_remove:
                        logger.error(f"Error removing failed transcoded file {transcoded_file_path}: {e_remove}")
                return None # Indicate failure

        except Exception as e:
            logger.error(f"Unexpected error in TranscodingService for {original_media_path}: {str(e)}")
            logger.debug(traceback.format_exc(), exc_info=True) # Added for detailed debugging
            return None # Indicate failure

    @staticmethod
    def stream_transcoded_video_on_the_fly(original_media_path):
        """
        Streams video by transcoding it on the fly using FFMPEG.
        Outputs directly to the client without saving to a file first.
        """
        if not os.path.exists(original_media_path):
            logger.error(f"Original media file not found for on-the-fly transcoding: {original_media_path}")
            # In a real scenario, you might return a 404 Response here or raise an exception
            # For now, logging and returning None, route will handle it.
            return None

        ffmpeg_path = current_app.config['FFMPEG_PATH']
        # Use specific on-the-fly settings from config, falling back to defaults if necessary
        vcodec = current_app.config.get('TRANSCODE_ON_THE_FLY_VIDEO_CODEC', current_app.config['DEFAULT_TRANSCODE_VIDEO_CODEC'])
        acodec = current_app.config.get('TRANSCODE_ON_THE_FLY_AUDIO_CODEC', current_app.config['DEFAULT_TRANSCODE_AUDIO_CODEC'])
        preset = current_app.config.get('TRANSCODE_ON_THE_FLY_PRESET', current_app.config['DEFAULT_TRANSCODE_PRESET'])
        target_format = current_app.config['DEFAULT_TRANSCODE_TARGET_FORMAT'] # Target container format for output
        
        # On-the-fly specific parameters
        target_height = current_app.config.get('TRANSCODE_ON_THE_FLY_TARGET_HEIGHT', 720)
        video_bitrate = current_app.config.get('TRANSCODE_ON_THE_FLY_VIDEO_BITRATE', "2000k")
        audio_bitrate = current_app.config.get('TRANSCODE_ON_THE_FLY_AUDIO_BITRATE', "128k")
        crf = current_app.config.get('TRANSCODE_ON_THE_FLY_CRF', 26)
        tune = current_app.config.get('TRANSCODE_ON_THE_FLY_TUNE', "zerolatency") # Changed to zerolatency for better streaming
        h264_level = current_app.config.get('TRANSCODE_ON_THE_FLY_H264_LEVEL', "3.1") # New config option

        command = [
            ffmpeg_path,
            '-i', original_media_path,
            '-c:v', vcodec,
        ]
        
        # Add H.264 specific profile and level for better compatibility if libx264 is used
        if vcodec == 'libx264':
            command.extend([
                '-profile:v', 'baseline',
                '-level:v', h264_level,
                '-pix_fmt', 'yuv420p'
            ]) # Use baseline profile with mobile-friendly settings

        command.extend([
            '-preset', preset,
            '-tune', tune,
            '-vf', f'scale=-2:{target_height}',
            '-pix_fmt', 'yuv420p', # Common pixel format for compatibility
        ])

        # Logic for CRF vs Bitrate for on-the-fly
        if video_bitrate and video_bitrate != "0":
            command.extend([
                '-b:v', video_bitrate,
                '-maxrate', video_bitrate, # Often same as -b:v for streaming
                '-bufsize', str(int(video_bitrate.replace('k','000').replace('M','000000')) * 2) # Typical bufsize is 2x bitrate
            ])
            # If a specific video bitrate is set, CRF might be used as a quality constraint by some encoders,
            # or ignored. For simplicity, if b:v is set, we don't *also* add CRF unless specifically desired
            # and understood how the encoder handles both. Some might prefer to add it:
            # command.extend(['-crf', str(crf)])
        else:
            # video_bitrate is '0' or empty, so CRF is the primary quality control
            command.extend(['-crf', str(crf)])
        
        # Add audio and output options
        command.extend([
            '-c:a', acodec,
            '-b:a', audio_bitrate,
            '-ar', '44100',           # Audio sample rate (common for web)
            '-ac', '2',               # Stereo audio channels
            
            # Mobile-friendly streaming flags
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof', # Fragmented MP4 for streaming
            '-frag_duration', '1000', # Create fragments every 1 second for smoother streaming
            '-f', target_format,      # Output format (e.g., mp4)
            '-flush_packets', '1',    # Attempt to force flush packets for better initial chunk delivery
            '-hide_banner',
            '-loglevel', 'error',
            'pipe:1'                  # Output to stdout
        ])


        logger.info(f"Starting on-the-fly transcoding for: {original_media_path} to {target_height}p, VBitrate: {video_bitrate}, ABitrate: {audio_bitrate}, CRF: {crf}, Tune: {tune}")
        logger.debug(f"Executing FFMPEG command for streaming: {' '.join(command)}")

        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            def generate_chunks():
                first_chunk_logged = False
                try:
                    # Read and yield chunks from FFMPEG's stdout
                    for chunk in iter(lambda: process.stdout.read(4096), b''):
                        if not first_chunk_logged:
                            logger.info(f"Yielding first chunk for on-the-fly stream: {original_media_path}")
                            first_chunk_logged = True
                        yield chunk
                finally:
                    # Robustly ensure resources are cleaned up. Prioritize communicate() for output.
                    # pylint: disable=used-before-assignment
                    stdout_final_data, stderr_final_data_bytes = None, None # Hold final pipe data
                    return_code = process.poll() # Check if process already exited

                    if return_code is None: # Process still running or finished stdout but not exited
                        logger.debug(f"FFMPEG process for {original_media_path} entering final communication/cleanup phase.")
                        try:
                            # Communicate will wait for the process to complete if it's still running.
                            # It reads all data from stdout and stderr until EOF is reached.
                            stdout_final_data, stderr_final_data_bytes = process.communicate(timeout=60) # Increased timeout for finalization
                            return_code = process.returncode
                        except subprocess.TimeoutExpired:
                            logger.warning(f"FFMPEG process for {original_media_path} timed out during communicate(). Attempting to kill.")
                            process.kill()
                            # Try a short communicate again to get any output after kill
                            try:
                                stdout_final_data, stderr_final_data_bytes = process.communicate(timeout=5)
                            except subprocess.TimeoutExpired:
                                logger.error(f"FFMPEG process for {original_media_path} unresponsive even after kill during final communicate.")
                            except Exception as e_final_comm_kill:
                                logger.error(f"Exception during final communicate after kill for {original_media_path}: {e_final_comm_kill}")
                            return_code = process.returncode if process.returncode is not None else -9 # Mark as killed
                        except Exception as e_comm:
                            logger.error(f"Exception during FFMPEG communicate() for {original_media_path}: {e_comm}")
                            # If communicate fails, check poll again and kill if necessary
                            if process.poll() is None:
                                logger.warning(f"FFMPEG process for {original_media_path} may still be running after communicate() error. Killing.")
                                process.kill()
                                try:
                                    process.wait(timeout=5) # Wait for kill to take effect
                                except subprocess.TimeoutExpired:
                                     logger.error(f"FFMPEG process for {original_media_path} did not terminate after kill following communicate error.")
                            return_code = process.returncode if process.returncode is not None else -1 # Generic error
                    
                    stderr_data_decoded = stderr_final_data_bytes.decode(errors='ignore') if stderr_final_data_bytes else "N/A"

                    if return_code != 0:
                        logger.error(f"FFMPEG (on-the-fly) process for {original_media_path} exited with code {return_code}. STDERR: {stderr_data_decoded}")
                    else:
                        logger.info(f"FFMPEG (on-the-fly) process for {original_media_path} completed successfully with code {return_code}.")

                    # stdout/stderr pipes are closed by communicate().
                    # No need for explicit close unless communicate() itself failed catastrophically
                    # and pipes might still be open, which is unlikely if Popen object is still valid.
            
            # Determine MIME type based on the target format
            # This is a simplified way; a more robust method might be needed
            mime_type = f"video/{target_format}" 
            if target_format == "webm":
                mime_type = "video/webm"
            elif target_format == "ogv":
                 mime_type = "video/ogg"

            logger.info(f"Returning streaming Response object for on-the-fly: {original_media_path}")
            response = Response(generate_chunks(), mimetype=mime_type)
            
            # Add mobile-friendly headers
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['X-Play-Immediately'] = 'true'
            response.headers['Content-Disposition'] = f'inline; filename="{os.path.basename(original_media_path)}"'
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept'
            
            return response

        except Exception as e:
            logger.error(f"Error starting or streaming FFMPEG (on-the-fly) for {original_media_path}: {str(e)}")
            logger.debug(traceback.format_exc(), exc_info=True)
            return None # Indicate failure to the caller (route)

    @staticmethod
    def cleanup_transcoded_files(category_path, max_age_days=7):
        """
        Removes old transcoded files from the category's .ghosthub/.transcoded directory.
        Not automatically called; intended for periodic maintenance if desired.
        """
        try:
            base_ghosthub_dir = os.path.join(category_path, current_app.config['GHOSTHUB_SUBDIR_NAME'])
            transcode_target_dir = os.path.join(base_ghosthub_dir, current_app.config['TRANSCODED_SUBDIR_NAME'])

            if not os.path.isdir(transcode_target_dir):
                logger.info(f"Transcoded directory not found, no cleanup needed: {transcode_target_dir}")
                return 0

            cutoff_time = time.time() - (max_age_days * 24 * 60 * 60)
            files_removed = 0
            
            logger.info(f"Starting cleanup of transcoded files older than {max_age_days} days in {transcode_target_dir}")

            for filename in os.listdir(transcode_target_dir):
                if filename.endswith(current_app.config['TRANSCODED_FILE_SUFFIX'] + '.' + current_app.config['DEFAULT_TRANSCODE_TARGET_FORMAT']):
                    file_path = os.path.join(transcode_target_dir, filename)
                    try:
                        if os.path.isfile(file_path): # Ensure it's a file
                            file_mtime = os.path.getmtime(file_path)
                            if file_mtime < cutoff_time:
                                os.remove(file_path)
                                files_removed += 1
                                logger.info(f"Removed old transcoded file: {file_path}")
                    except Exception as e_file:
                        logger.error(f"Error processing file {file_path} during cleanup: {e_file}")
            
            logger.info(f"Transcoded files cleanup complete. Removed {files_removed} files from {transcode_target_dir}.")
            return files_removed

        except Exception as e:
            logger.error(f"Error during transcoded files cleanup for {category_path}: {str(e)}")
            return 0
