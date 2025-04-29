"""
Category Service
--------------
Manages media categories, including CRUD operations and metadata retrieval.
"""
# app/services/category_service.py
import os
import uuid
import logging
import traceback
from flask import current_app
from app.utils.file_utils import load_categories, save_categories
from app.utils.media_utils import find_thumbnail

logger = logging.getLogger(__name__)

class CategoryService:
    """Service for managing media categories and their metadata."""

    @staticmethod
    def get_all_categories_with_details():
        """
        Get all categories with media count, thumbnail URL, and video flag.
        
        Returns list of enriched category dictionaries.
        """
        categories = load_categories()
        categories_with_details = []

        for category in categories:
            try:
                # Now unpacks three values: count, url, contains_video flag
                media_count, thumbnail_url, contains_video = find_thumbnail(
                    category['path'],
                    category['id'],
                    category['name']
                )
                categories_with_details.append({
                    **category,
                    'mediaCount': media_count,
                    'thumbnailUrl': thumbnail_url,
                    'containsVideo': contains_video # Add the containsVideo flag
                })
            except Exception as e:
                logger.error(f"Error processing category '{category.get('name', 'N/A')}' (ID: {category.get('id', 'N/A')}): {str(e)}")
                logger.debug(traceback.format_exc())
                # Add category even if details fail, with default values
                categories_with_details.append({
                    **category,
                    'mediaCount': 0,
                    'thumbnailUrl': None,
                    'containsVideo': False, # Default containsVideo on error
                    'error': f"Failed to process details: {str(e)}" # Add error info
                })

        return categories_with_details

    @staticmethod
    def get_category_by_id(category_id):
        """
        Find a category by ID.
        
        Returns category dict or None if not found.
        """
        categories = load_categories()
        return next((c for c in categories if c.get('id') == category_id), None)

    @staticmethod
    def add_category(name, path):
        """
        Add a new category with validation.
        
        Returns (new_category, error_message) tuple.
        """
        if not name or not path:
            return None, "Category name and path are required."

        # Basic path validation (more robust validation might be needed)
        if not os.path.exists(path):
            logger.warning(f"Attempting to add category with non-existent path: {path}")
            # Allow adding but log warning - adjust if strict validation is needed
        elif not os.path.isdir(path):
            logger.error(f"Attempting to add category where path is not a directory: {path}")
            return None, "The specified path is not a directory."

        logger.info(f"Attempting to add category: Name='{name}', Path='{path}'")
        categories = load_categories()

        # Check for duplicate path
        if any(c.get('path') == path for c in categories):
            logger.warning(f"Attempt to add category with duplicate path: {path}")
            return None, "A category with this path already exists."

        # Check for duplicate name (optional, decide if names must be unique)
        # if any(c.get('name') == name for c in categories):
        #     logger.warning(f"Attempt to add category with duplicate name: {name}")
        #     return None, "A category with this name already exists."

        new_category = {
            'id': str(uuid.uuid4()),
            'name': name,
            'path': path
        }
        categories.append(new_category)

        if save_categories(categories):
            logger.info(f"Successfully added category: ID={new_category['id']}, Name='{name}'")
            
            # Start indexing and transcoding for the new category
            try:
                category_id = new_category['id']
                logger.info(f"Starting indexing and transcoding for new category: {name} (ID: {category_id})")
                
                # Use MediaService to start async indexing, which will also trigger transcoding
                from app.services.media_service import MediaService
                MediaService.start_async_indexing(
                    category_id,
                    path,
                    name,
                    force_refresh=True  # Force refresh since it's a new category
                )
                
                # Add indexing status to the response
                new_category['indexing_started'] = True
                
            except Exception as index_error:
                logger.error(f"Error starting indexing for new category {name}: {index_error}")
                logger.debug(traceback.format_exc())
                # Don't fail the whole request if indexing fails to start
                new_category['indexing_started'] = False
                new_category['indexing_error'] = str(index_error)
            
            return new_category, None
        else:
            logger.error(f"Failed to save categories after attempting to add: Name='{name}'")
            return None, "Failed to save the new category."

    @staticmethod
    def delete_category(category_id):
        """
        Delete a category by ID.
        
        Returns (success, error_message) tuple.
        """
        logger.info(f"Attempting to delete category with ID: {category_id}")
        categories = load_categories()
        original_count = len(categories)
        categories = [c for c in categories if c.get('id') != category_id]

        if len(categories) == original_count:
            logger.warning(f"Category with ID {category_id} not found for deletion.")
            return False, "Category not found"

        # Optionally clear related cache entries here if caching is implemented at this level

        if save_categories(categories):
            logger.info(f"Successfully deleted category with ID: {category_id}")
            return True, None
        else:
            logger.error(f"Failed to save categories after deleting ID: {category_id}")
            return False, "Failed to save categories after deletion"
