"""
Generate PWA icons and Windows ICO from the original Ghosthub1024.png icon.
Optimized for sharp small and medium sizes in Windows EXE.
"""
from PIL import Image, ImageFilter
import os

def optimize_and_resize(img, size):
    """Resize and sharpen for tiny icons."""
    if size <= 24:
        base = img.resize((128, 128), Image.LANCZOS)
        base = base.filter(ImageFilter.UnsharpMask(radius=2.0, percent=200, threshold=1))
        return base.resize((size, size), Image.LANCZOS)
    elif size <= 64:
        temp = img.resize((size, size), Image.LANCZOS)
        return temp.filter(ImageFilter.UnsharpMask(radius=1.5, percent=150, threshold=1))
    else:
        return img.resize((size, size), Image.LANCZOS)

def generate_windows_ico(source_icon):
    print("Generating sharp .ico file using Pillow (fully supported way)...")
    sizes = [256, 128, 64, 48, 32, 24, 16]
    output_path = "../static/icons/Ghosthub.ico"

    try:
        with Image.open(source_icon) as img:
            # Must pass sizes; Pillow internally resizes
            img.save(output_path, format='ico', sizes=[(s, s) for s in sizes])
        print(f"Saved basic .ico with sizes: {sizes}")
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

def generate_pwa_icons(source_icon):
    print("Generating PWA icons...")
    sizes = [512, 192, 180]

    try:
        with Image.open(source_icon) as img:
            for size in sizes:
                output_path = f"../static/icons/Ghosthub{size}.png"
                resized = img.resize((size, size), Image.LANCZOS)
                resized.save(output_path, optimize=True)
                print(f"Created {output_path}")
        return True
    except Exception as e:
        print(f"Error generating PWA icons: {e}")
        return False

def generate_icons():
    source_icon = "../static/icons/Ghosthub1024.png"
    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found at {source_icon}")
        return False

    os.makedirs("../static/icons", exist_ok=True)
    pwa_ok = generate_pwa_icons(source_icon)

    # Reload 512 for better sharpness base
    if os.path.exists("../static/icons/Ghosthub512.png"):
        source_icon = "../static/icons/Ghosthub512.png"

    ico_ok = generate_windows_ico(source_icon)
    return pwa_ok and ico_ok

if __name__ == "__main__":
    generate_icons()
