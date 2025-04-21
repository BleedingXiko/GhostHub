"""
Generate PWA icons from the original Ghosthub1024.png icon.
This script creates the required icon sizes for the PWA.
"""

from PIL import Image
import os

def generate_icons():
    """Generate PWA icons in different sizes from the original icon."""
    print("Generating PWA icons...")
    
    # Source icon path
    source_icon = "../static/icons/Ghosthub1024.png"
    
    # Check if source icon exists
    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found at {source_icon}")
        return False
    
    # Target sizes
    sizes = [512, 192, 180]
    
    try:
        # Open the source image
        with Image.open(source_icon) as img:
            # Create each size
            for size in sizes:
                output_path = f"../static/icons/Ghosthub{size}.png"
                # Resize the image (using LANCZOS for high-quality downsampling)
                resized_img = img.resize((size, size), Image.LANCZOS)
                # Save the resized image
                resized_img.save(output_path)
                print(f"Created {output_path}")
        
        print("Icon generation complete!")
        return True
    except Exception as e:
        print(f"Error generating icons: {e}")
        return False

if __name__ == "__main__":
    generate_icons()
