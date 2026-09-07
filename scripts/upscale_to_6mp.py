"""
ArticulAIT — 6MP Image Upscaler Tool
Upscales photos or extracted video frames to 6MP (3000x2000px) to satisfy high-resolution pipeline standards.
"""

import os
import sys
from PIL import Image


def upscale_images(input_dir: str, output_dir: str, target_w: int = 3000, target_h: int = 2000):
    os.makedirs(output_dir, exist_ok=True)
    valid_exts = ('.png', '.jpg', '.jpeg', '.webp')
    files = sorted([f for f in os.listdir(input_dir) if f.lower().endswith(valid_exts)])

    if not files:
        print(f"No image files found in '{input_dir}'")
        return

    print(f"Upscaling {len(files)} images to 6MP ({target_w}x{target_h})...")
    for idx, f in enumerate(files):
        src_path = os.path.join(input_dir, f)
        dst_path = os.path.join(output_dir, f)
        try:
            with Image.open(src_path) as img:
                img_rgb = img.convert("RGB")
                img_resized = img_rgb.resize((target_w, target_h), Image.Resampling.LANCZOS)
                img_resized.save(dst_path, quality=95)
            print(f" [{idx+1}/{len(files)}] Upscaled {f} -> {target_w}x{target_h}")
        except Exception as e:
            print(f"Error processing {f}: {e}")

    print(f"\n[OK] Upscaling complete! 6MP photos saved to: {os.path.abspath(output_dir)}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        in_path = sys.argv[1]
        out_path = sys.argv[2] if len(sys.argv) > 2 else "data/sample_6mp_photos"
    else:
        in_path = "data/project_1/images"  # fallback default
        out_path = "data/sample_6mp_photos"

    if os.path.exists(in_path):
        upscale_images(in_path, out_path)
    else:
        print(f"Input path '{in_path}' does not exist.")
