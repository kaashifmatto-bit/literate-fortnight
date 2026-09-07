"""
Test script to run VGGT-1B Confidence-Gated Router on a 240-image dataset.
Evaluates model loading, inference speed, confidence score, and routing output.
"""

import os
import glob
import time
from backend.reconstruction.pose_router import estimate_poses

def test_240_image_batch():
    # Search for candidate image directories with ~240 images
    candidates = [
        r"d:\articulait\data\project_19\images",
        r"d:\articulait\data\raw_images_dji",
        r"d:\articulait\data\raw_images_downsampled",
        r"d:\articulait\data\raw_images",
    ]

    selected_dir = None
    image_paths = []
    for cand in candidates:
        if os.path.exists(cand):
            imgs = sorted([
                os.path.join(cand, f) for f in os.listdir(cand)
                if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))
            ])
            if len(imgs) > len(image_paths):
                image_paths = imgs
                selected_dir = cand

    if not image_paths:
        print("[ERROR] No image dataset found in data directory.")
        return

    # Cap to 240 images for the user's test
    test_batch = image_paths[:240]
    print(f"\n=======================================================")
    print(f"  VGGT-1B ROUTER TEST ON {len(test_batch)} IMAGES")
    print(f"  Dataset Directory: {selected_dir}")
    print(f"=======================================================\n")

    start_time = time.time()
    result = estimate_poses(image_paths=test_batch, threshold=0.6)
    elapsed = time.time() - start_time

    print(f"\n-------------------------------------------------------")
    print(f"  TEST RESULTS SUMMARY")
    print(f"-------------------------------------------------------")
    print(f"  Total Images Tested     : {len(test_batch)}")
    print(f"  Execution Time          : {elapsed:.2f} seconds")
    print(f"  Estimator Source        : {result.source.upper()}")
    print(f"  Evaluated Confidence    : {result.confidence:.2f} / 1.00")
    print(f"  Threshold Target        : 0.60")
    print(f"  Total Poses Generated   : {len(result.poses)}")
    print(f"-------------------------------------------------------")

    if result.poses:
        first_fn = list(result.poses.keys())[0]
        last_fn = list(result.poses.keys())[-1]
        print(f"  Sample Pose [First - {first_fn}]:")
        print(f"    Position : {result.poses[first_fn]['position']}")
        print(f"    Target   : {result.poses[first_fn]['target']}")
        print(f"    Quaternion: {result.poses[first_fn]['quaternion']}")
        print(f"  Sample Pose [Last - {last_fn}]:")
        print(f"    Position : {result.poses[last_fn]['position']}")
        print(f"    Target   : {result.poses[last_fn]['target']}")
        print(f"=======================================================\n")

if __name__ == "__main__":
    test_240_image_batch()
