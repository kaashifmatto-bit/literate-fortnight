"""
ArticulAIT — Depth Service
Estimates dense depth maps using Depth-Anything-V2-Small-hf.
Runs efficiently on low-VRAM GPUs (e.g. RTX 3050 4GB) using FP16.
"""
import os
import torch
import numpy as np
from PIL import Image
# pyrefly: ignore [missing-import]
from transformers import pipeline

class DepthService:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32
        self._pipe = None

    def _get_pipeline(self):
        """Lazy load the pipeline to save VRAM when not in use."""
        if self._pipe is None:
            print(f"Loading Depth Anything V2 Small on {self.device} ({self.dtype})...")
            # We use the official HF transformers integrated Depth Anything V2 model
            self._pipe = pipeline(
                task="depth-estimation",
                model="depth-anything/Depth-Anything-V2-Small-hf",
                device=self.device,
                model_kwargs={"torch_dtype": self.dtype}
            )
        return self._pipe

    def estimate_depth(self, image_path: str, output_npy_path: str, output_vis_path: str = None) -> np.ndarray:
        """Estimate depth for a single image, saving the raw map (.npy) and optional visualization (.png)."""
        pipe = self._get_pipeline()
        
        # Open image and resize to max 512px for fast, low-memory CPU depth inference
        img = Image.open(image_path).convert("RGB")
        width, height = img.size
        
        max_dim = 512
        if max(width, height) > max_dim:
            scale = max_dim / float(max(width, height))
            target_w, target_h = int(width * scale), int(height * scale)
            img_infer = img.resize((target_w, target_h), Image.Resampling.BILINEAR)
        else:
            img_infer = img
        
        # Run inference
        result = pipe(img_infer)
        depth_pil = result["depth"]
        
        # Resize back to original image resolution to match pixels
        depth_pil = depth_pil.resize((width, height), Image.Resampling.BILINEAR)
        depth_arr = np.array(depth_pil).astype(np.float32)
        
        # Save raw depth values as numpy array
        np.save(output_npy_path, depth_arr)
        
        # Save visualization (grayscale normalized depth)
        if output_vis_path:
            # Normalize to 0-255 range for display
            depth_min, depth_max = depth_arr.min(), depth_arr.max()
            if depth_max > depth_min:
                depth_norm = ((depth_arr - depth_min) / (depth_max - depth_min) * 255.0).astype(np.uint8)
            else:
                depth_norm = np.zeros_like(depth_arr, dtype=np.uint8)
            
            # Save visual image
            vis_img = Image.fromarray(depth_norm)
            vis_img.save(output_vis_path)
            
        return depth_arr

    def process_images(self, image_dir: str, output_dir: str, progress_callback=None):
        """Process all images in a directory, estimating depth maps."""
        os.makedirs(output_dir, exist_ok=True)
        
        from backend.core.utils import natural_sort_key
        # Get all image files
        valid_exts = ('.jpg', '.jpeg', '.png', '.webp')
        filenames = sorted(
            [f for f in os.listdir(image_dir) if f.lower().endswith(valid_exts)],
            key=natural_sort_key
        )
        total = len(filenames)
        
        print(f"Starting dense depth mapping for {total} images...")
        
        for idx, fname in enumerate(filenames):
            image_path = os.path.join(image_dir, fname)
            
            # Output paths
            base_name, _ = os.path.splitext(fname)
            npy_path = os.path.join(output_dir, f"{base_name}.npy")
            vis_path = os.path.join(output_dir, f"{base_name}_depth.png")
            
            self.estimate_depth(image_path, npy_path, vis_path)
            
            # Report progress
            if progress_callback:
                progress_callback(idx + 1, total, fname)
                
            # Clear CUDA cache periodically to stay under 4GB limit
            if self.device == "cuda" and (idx + 1) % 5 == 0:
                torch.cuda.empty_cache()
                
        # Final clean up
        if self.device == "cuda":
            torch.cuda.empty_cache()
        print("Dense depth mapping completed successfully.")

# Global instance for easy access
depth_service = DepthService()
