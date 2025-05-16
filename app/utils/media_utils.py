"""
Media Utility Functions
----------------------
Utilities for media file handling, type detection, and thumbnail generation.
"""
# app/utils/media_utils.py
import os
import logging
import traceback
from flask import current_app
from PIL import Image
from urllib.parse import quote
import threading # Use standard threading instead of eventlet

logger = logging.getLogger(__name__)

# Try to import OpenCV, but provide a fallback if it's not available
try:
    import cv2
    import numpy as np
    OPENCV_AVAILABLE = True
    logger.info("OpenCV is available for video thumbnail generation")
except ImportError:
    OPENCV_AVAILABLE = False
    logger.warning("OpenCV is not available. Video thumbnail generation will be disabled.")

def is_media_file(filename):
    """Check if a file has a supported media extension."""
    _, ext = os.path.splitext(filename)
    return ext.lower() in current_app.config['MEDIA_EXTENSIONS']

def get_media_type(filename):
    """Determine if a file is an image, video, or unknown type."""
    _, ext = os.path.splitext(filename)
    ext_lower = ext.lower()

    if ext_lower in current_app.config['IMAGE_EXTENSIONS']:
        return 'image'
    elif ext_lower in current_app.config['VIDEO_EXTENSIONS']:
        return 'video'
    else:
        return 'unknown'

def get_mime_type(filename):
    """Get the MIME type for a file based on its extension."""
    _, ext = os.path.splitext(filename)
    ext_lower = ext.lower()

    for media_type, info in current_app.config['MEDIA_TYPES'].items():
        if ext_lower in info['mime_types']:
            return info['mime_types'][ext_lower]

    # Default MIME type if not found
    logger.warning(f"MIME type not found for extension: {ext_lower}")
    return None

# Thumbnail Generation Constants

THUMBNAIL_DIR_NAME = "thumbnails"
GHOSTHUB_DIR_NAME = ".ghosthub"
THUMBNAIL_SIZE = (256, 256)
THUMBNAIL_FORMAT = "JPEG" # Use JPEG for good compression/quality balance

def generate_thumbnail(original_media_path, thumbnail_save_path, size=THUMBNAIL_SIZE):
    """
    Generate a thumbnail for an image or video file.
    
    Returns True if successful, False otherwise.
    """
    media_type = get_media_type(os.path.basename(original_media_path))
    logger.info(f"Attempting thumbnail generation for {media_type}: {original_media_path} -> {thumbnail_save_path}")

    def _generate():
        """Process thumbnail generation (runs in thread)."""
        try:
            if media_type == 'image':
                with Image.open(original_media_path) as img:
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    img.thumbnail(size)
                    img.save(thumbnail_save_path, THUMBNAIL_FORMAT, quality=85)
                logger.info(f"Successfully generated IMAGE thumbnail: {thumbnail_save_path}")
                return True
            elif media_type == 'video':
                # Check if OpenCV is available
                if not OPENCV_AVAILABLE:
                    logger.warning(f"OpenCV not available, skipping video thumbnail generation for {original_media_path}")
                    return False
                
                try:
                    # Open the video file
                    cap = cv2.VideoCapture(original_media_path)
                    if not cap.isOpened():
                        logger.error(f"Could not open video file: {original_media_path}")
                        return False
                    
                    # Get video properties
                    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                    fps = cap.get(cv2.CAP_PROP_FPS)
                    duration = total_frames / fps if fps > 0 else 0
                    
                    # Determine frame to extract (same logic as before)
                    time_to_extract = 1.0 if duration > 2.0 else (duration / 2.0 if duration > 0 else 0)
                    frame_to_extract = int(time_to_extract * fps) if fps > 0 else 0
                    
                    # Set the frame position
                    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_to_extract)
                    
                    # Read the frame
                    ret, frame = cap.read()
                    if not ret:
                        logger.error(f"Failed to read frame from video: {original_media_path}")
                        cap.release()
                        return False
                    
                    # Convert BGR to RGB (OpenCV uses BGR by default)
                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    
                    # Create PIL Image from the frame
                    img = Image.fromarray(frame_rgb)
                    
                    # Resize and save as before
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    img.thumbnail(size)
                    img.save(thumbnail_save_path, THUMBNAIL_FORMAT, quality=85)
                    
                    # Release the video capture object
                    cap.release()
                    
                    logger.info(f"Successfully generated VIDEO thumbnail: {thumbnail_save_path}")
                    return True
                except Exception as video_err:
                    logger.error(f"OpenCV error generating video thumbnail for {original_media_path}: {video_err}")
                    logger.debug(traceback.format_exc())
                    return False
            else:
                logger.warning(f"Unsupported media type for thumbnail generation: {media_type} for file {original_media_path}")
                return False
        except FileNotFoundError:
             logger.error(f"Original media file not found during generation: {original_media_path}")
             return False
        except Exception as e:
            logger.error(f"Generic error during thumbnail generation for {original_media_path}: {str(e)}")
            logger.debug(traceback.format_exc())
            # Attempt to remove potentially corrupted thumbnail file
            if os.path.exists(thumbnail_save_path):
                try:
                    os.remove(thumbnail_save_path)
                    logger.info(f"Removed potentially corrupted thumbnail file: {thumbnail_save_path}")
                except Exception as remove_e:
                    logger.error(f"Error removing corrupted thumbnail file {thumbnail_save_path}: {remove_e}")
            return False

    try:
        # Ensure the thumbnail directory exists (this is quick, no need to offload)
        thumbnail_dir = os.path.dirname(thumbnail_save_path)
        os.makedirs(thumbnail_dir, exist_ok=True)

        # Execute the blocking generation logic in a separate thread
        thread = threading.Thread(target=lambda: None)
        thread.result = None
        
        def run_in_thread():
            thread.result = _generate()
        
        thread_obj = threading.Thread(target=run_in_thread)
        thread_obj.daemon = True
        thread_obj.start()
        thread_obj.join()
        
        return thread.result

    except Exception as e:
        # Catch potential errors from tpool itself or directory creation
        logger.error(f"Error in tpool execution or directory creation for {original_media_path}: {str(e)}")
        logger.debug(traceback.format_exc())
        return False
    except Exception as e:
        logger.error(f"Error generating thumbnail for {original_media_path}: {str(e)}")
        logger.debug(traceback.format_exc())
        # Attempt to remove potentially corrupted thumbnail file if save started but failed
        if os.path.exists(thumbnail_save_path):
            try:
                os.remove(thumbnail_save_path)
                logger.info(f"Removed potentially corrupted thumbnail file: {thumbnail_save_path}")
            except Exception as remove_e:
                logger.error(f"Error removing corrupted thumbnail file {thumbnail_save_path}: {remove_e}")
        return False

def get_thumbnail_url(category_id, original_filename):
    """
    Construct the URL for a thumbnail.
    
    Args:
        category_id (str): The category ID.
        original_filename (str): The original filename.
        
    Returns:
        str: The URL path for the thumbnail.
    """
    thumbnail_filename = original_filename + '.' + THUMBNAIL_FORMAT.lower()
    encoded_thumbnail_filename = quote(thumbnail_filename)
    return f"/thumbnails/{category_id}/{encoded_thumbnail_filename}"

def process_category_thumbnails(category_path, all_files_metadata, force_refresh=False):
    """
    Process thumbnails for a category based on its content.
    
    For video-heavy categories:
    - Generate thumbnails for all videos
    - Generate one image thumbnail if available (for category preview)
    
    For image-heavy categories:
    - Generate thumbnails for all videos
    - Generate only one image thumbnail (for category preview)
    
    Args:
        category_path (str): Path to the category directory.
        all_files_metadata (list): List of file metadata dictionaries.
        force_refresh (bool): Whether to force regeneration of existing thumbnails.
        
    Returns:
        tuple: (image_count, video_count, thumbnails_generated)
    """
    if not all_files_metadata:
        logger.warning(f"No files to process thumbnails for in {category_path}")
        return 0, 0, 0
    
    # Ensure ghosthub directory exists
    ghosthub_dir = os.path.join(category_path, GHOSTHUB_DIR_NAME)
    os.makedirs(ghosthub_dir, exist_ok=True)
    
    # Ensure thumbnail directory exists inside ghosthub directory
    thumbnail_dir = os.path.join(ghosthub_dir, THUMBNAIL_DIR_NAME)
    os.makedirs(thumbnail_dir, exist_ok=True)
    
    # Count image and video files
    image_count = 0
    video_count = 0
    image_files = []
    video_files = []
    
    for file_meta in all_files_metadata:
        filename = file_meta['name']
        file_type = get_media_type(filename)
        
        if file_type == 'image':
            image_count += 1
            image_files.append(filename)
        elif file_type == 'video':
            video_count += 1
            video_files.append(filename)
    
    total_files = image_count + video_count
    if total_files == 0:
        logger.warning(f"No media files found in {category_path}")
        return 0, 0, 0
    
    # Determine if category is image-heavy (>90% images)
    is_image_heavy = (image_count > 0) and (image_count / total_files > 0.9)
    logger.info(f"Category {category_path} has {image_count} images, {video_count} videos. Image-heavy: {is_image_heavy}")
    
    thumbnails_generated = 0
    
    # Always generate thumbnails for all videos
    for video_filename in video_files:
        original_file_path = os.path.join(category_path, video_filename)
        thumbnail_filename = video_filename + '.' + THUMBNAIL_FORMAT.lower()
        thumbnail_save_path = os.path.join(thumbnail_dir, thumbnail_filename)
        
        # Check if thumbnail exists or needs refresh
        if not os.path.exists(thumbnail_save_path) or force_refresh:
            logger.info(f"Generating thumbnail for video: {video_filename}")
            if generate_thumbnail(original_file_path, thumbnail_save_path):
                thumbnails_generated += 1
    
    # For image-heavy categories, generate only one image thumbnail (for category preview)
    # For video-heavy categories, still generate one image thumbnail if available
    if image_files:
        # Sort image files for consistency
        image_files.sort()
        
        # Use the first image as the category preview
        preview_image = image_files[0]
        original_file_path = os.path.join(category_path, preview_image)
        thumbnail_filename = preview_image + '.' + THUMBNAIL_FORMAT.lower()
        thumbnail_save_path = os.path.join(thumbnail_dir, thumbnail_filename)
        
        # Check if thumbnail exists or needs refresh
        if not os.path.exists(thumbnail_save_path) or force_refresh:
            logger.info(f"Generating thumbnail for category preview image: {preview_image}")
            if generate_thumbnail(original_file_path, thumbnail_save_path):
                thumbnails_generated += 1
    
    logger.info(f"Processed thumbnails for {category_path}: {thumbnails_generated} generated/updated")
    return image_count, video_count, thumbnails_generated

# Thumbnail Finding

def find_thumbnail(category_path, category_id, category_name):
    """
    Find a suitable thumbnail for a category from its media files.
    
    Returns (media_count, thumbnail_url, contains_video) tuple.
    """
    thumbnail_url = None
    media_count = 0
    contains_video = False # Initialize contains_video flag

    try:
        # Validate path
        if not os.path.exists(category_path):
            logger.warning(f"Path not found for thumbnail search: {category_path}")
            return 0, None, False # Return 3 values

        if not os.path.isdir(category_path):
            logger.warning(f"Path is not a directory for thumbnail search: {category_path}")
            return 0, None, False # Return 3 values

        # List files and filter media files
        try:
            files = os.listdir(category_path)
        except PermissionError:
            logger.warning(f"Permission denied when accessing directory for thumbnail: {category_path}")
            return 0, None, False # Return 3 values
        except Exception as e:
            logger.error(f"Error listing directory {category_path} for thumbnail: {str(e)}")
            return 0, None, False # Return 3 values

        media_files = [f for f in files if is_media_file(f)]
        media_count = len(media_files)

        if not media_files:
            logger.info(f"No media files found in {category_path} for thumbnail")
            return 0, None, False # Return False for contains_video

        # Check if any video files exist in the list BEFORE selecting thumbnail source
        video_extensions = current_app.config['VIDEO_EXTENSIONS']
        contains_video = any(os.path.splitext(f)[1].lower() in video_extensions for f in media_files)
        logger.debug(f"Category '{category_name}' contains video: {contains_video}")

        # --- Thumbnail source selection logic remains the same ---
        thumbnail_url = None # Initialize thumbnail_url

        # Priority order for thumbnails: preferred images, any image, then any video.
        preferred_formats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'] # Added webp
        image_extensions = current_app.config['IMAGE_EXTENSIONS']
        video_extensions = current_app.config['VIDEO_EXTENSIONS'] # Use video extensions now

        candidate_found = False
        # Add videos to the list of sources to try
        for file_list, description in [
            ([f for f in media_files if os.path.splitext(f)[1].lower() in preferred_formats], "preferred image format"),
            ([f for f in media_files if os.path.splitext(f)[1].lower() in image_extensions], "any image"),
            ([f for f in media_files if os.path.splitext(f)[1].lower() in video_extensions], "any video") # Added video list
        ]:
            if file_list:
                file_list.sort()  # Sort for consistency
                for original_filename in file_list:
                    original_file_path = os.path.join(category_path, original_filename)

                    # Check if original file exists and is readable
                    if not os.path.exists(original_file_path) or not os.access(original_file_path, os.R_OK):
                        logger.warning(f"Original file {original_file_path} not accessible, skipping.")
                        continue

                    # Determine thumbnail path and filename
                    thumbnail_filename = original_filename + '.' + THUMBNAIL_FORMAT.lower()
                    ghosthub_dir = os.path.join(category_path, GHOSTHUB_DIR_NAME)
                    thumbnail_save_path = os.path.join(ghosthub_dir, THUMBNAIL_DIR_NAME, thumbnail_filename)

                    # Check if thumbnail exists or generate it
                    thumbnail_exists = os.path.exists(thumbnail_save_path)
                    thumbnail_generated = False

                    if not thumbnail_exists:
                        logger.info(f"Thumbnail {thumbnail_save_path} not found, attempting generation.")
                        # Attempt generation for both image and video types now
                        thumbnail_generated = generate_thumbnail(original_file_path, thumbnail_save_path)
                        # No need to check type here, generate_thumbnail handles it

                    # If thumbnail exists or was successfully generated, create the URL
                    if thumbnail_exists or thumbnail_generated:
                        # URL encode the generated thumbnail filename
                        encoded_thumbnail_filename = quote(thumbnail_filename)
                        thumbnail_url = f"/thumbnails/{category_id}/{encoded_thumbnail_filename}"
                        # Log the source type, but we don't need to return it anymore
                        source_type = get_media_type(original_filename)
                        logger.info(f"Using {description} thumbnail (source type: {source_type}) for '{category_name}': {thumbnail_url} (Source: {original_filename})")
                        candidate_found = True
                        break # Found a suitable thumbnail, stop searching this list
                    else:
                         logger.warning(f"Failed to find or generate thumbnail for {original_filename} in {category_path}")

                if candidate_found:
                    break # Found a suitable thumbnail, stop searching other lists (e.g., don't look for 'any image' if 'preferred' worked)

        if not candidate_found:
             logger.warning(f"No suitable thumbnail could be found or generated for category '{category_name}' in {category_path}")

    except Exception as e:
        logger.error(f"Error finding/generating thumbnail for '{category_name}': {str(e)}")
        logger.debug(traceback.format_exc())

    # Return media_count, the generated thumbnail_url (if any), and the contains_video flag
    return media_count, thumbnail_url, contains_video
