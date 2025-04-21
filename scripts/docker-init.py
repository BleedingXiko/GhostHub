#!/usr/bin/env python3
"""
Docker Initialization Script for GhostHub
----------------------------------------
Automatically configures GhostHub in Docker by detecting mounted media volumes
and creating category entries in media_categories.json.

Features:
- Auto-detects directories in /media
- Preserves existing configuration on container restarts
- Creates unique IDs for each media directory

Usage: Add media by mounting volumes to /media in docker-compose.yml
"""

import os
import json
import sys
import uuid

# Configuration paths
INSTANCE_DIR = '/app/instance'
CATEGORIES_FILE = os.path.join(INSTANCE_DIR, 'media_categories.json')
MEDIA_DIR = '/media'

def ensure_instance_dir():
    """Ensure the instance directory exists for persistent configuration."""
    if not os.path.exists(INSTANCE_DIR):
        print(f"Creating instance directory: {INSTANCE_DIR}")
        os.makedirs(INSTANCE_DIR, exist_ok=True)

def get_media_directories():
    """
    Scan /media for subdirectories and create category entries.
    
    Returns:
        list: Category entries with id, name, and path
    """
    media_dirs = []
    
    # Check if the media directory exists
    if not os.path.exists(MEDIA_DIR):
        print(f"Media directory {MEDIA_DIR} does not exist. Creating it...")
        os.makedirs(MEDIA_DIR, exist_ok=True)
        return media_dirs
    
    # Get all immediate subdirectories of the media directory
    for item in os.listdir(MEDIA_DIR):
        item_path = os.path.join(MEDIA_DIR, item)
        if os.path.isdir(item_path):
            media_dirs.append({
                "id": str(uuid.uuid4()),
                "name": item.capitalize(),
                "path": item_path
            })
    
    return media_dirs

def create_categories_file(media_dirs):
    """
    Create or update the media_categories.json file, preserving existing entries.
    
    Args:
        media_dirs: List of category dictionaries
    
    Returns:
        bool: Success or failure
    """
    # Check if the file already exists
    if os.path.exists(CATEGORIES_FILE):
        try:
            with open(CATEGORIES_FILE, 'r') as f:
                existing_categories = json.load(f)
            
            # Check if we need to add any new directories
            existing_paths = [cat['path'] for cat in existing_categories]
            for media_dir in media_dirs:
                if media_dir['path'] not in existing_paths:
                    existing_categories.append(media_dir)
                    print(f"Adding new media directory: {media_dir['name']} ({media_dir['path']})")
            
            categories = existing_categories
        except Exception as e:
            print(f"Error reading existing categories file: {e}")
            print("Creating new categories file...")
            categories = media_dirs
    else:
        categories = media_dirs
    
    # Write the categories file
    try:
        with open(CATEGORIES_FILE, 'w') as f:
            json.dump(categories, f, indent=2)
        print(f"Categories file created/updated at {CATEGORIES_FILE}")
        print(f"Total media categories: {len(categories)}")
        for cat in categories:
            print(f"  - {cat['name']}: {cat['path']}")
    except Exception as e:
        print(f"Error writing categories file: {e}")
        return False
    
    return True

def main():
    """
    Main initialization function that sets up the Docker environment.
    
    Exit codes: 0=Success, 1=Failed to create categories file
    """
    print("Starting GhostHub Docker initialization...")
    
    # Ensure the instance directory exists
    ensure_instance_dir()
    
    # Get all media directories
    media_dirs = get_media_directories()
    
    if not media_dirs:
        print("No media directories found in /media.")
        print("You can add media directories by mounting them to /media/your_directory_name")
        print("Example: - /path/to/your/media:/media/your_media")
        
        # Create an empty categories file if it doesn't exist
        if not os.path.exists(CATEGORIES_FILE):
            with open(CATEGORIES_FILE, 'w') as f:
                json.dump([], f, indent=2)
            print(f"Created empty categories file at {CATEGORIES_FILE}")
    else:
        # Create or update the categories file
        if create_categories_file(media_dirs):
            print("Media categories initialization complete!")
        else:
            print("Media categories initialization failed!")
            sys.exit(1)
    
    print("Docker initialization complete!")

if __name__ == "__main__":
    main()
