"""
ArticulAIT — Upload Validation Service (v2)
Automated capture-to-splat quality validation prior to COLMAP / 3DGS reconstruction.
"""
import os
import cv2
import numpy as np

HARD_REJECT_BELOW = 1
WARN_BELOW = 20

# Threshold lowered to 2.5 (from 100.0) due to overlap in Laplacian variance between 
# perfectly sharp "blank walls" (~3.7) and genuinely blurry images (~8.4). 
# WebP/JPEG compression artifacts also artificially inflate blur scores. 
# 2.5 is permissive enough to allow featureless walls while catching extreme motion blur.
BLUR_THRESHOLD_LAPLACIAN = 2.5
MIN_ORB_MATCHES = 80

def check_image_blur(image_path: str) -> dict:
    """Calculate Laplacian variance score to detect motion blur or out-of-focus images."""
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            try:
                from PIL import Image as PILImage
                import numpy as np
                pil_img = PILImage.open(image_path).convert('L')
                img = np.array(pil_img)
            except Exception as e:
                return {"score": 0.0, "is_blurry": True, "error": f"Could not read image: {e}"}

        h, w = img.shape
        if max(h, w) > 1024:
            scale = 1024.0 / max(h, w)
            img = cv2.resize(img, (int(w * scale), int(h * scale)))

        laplacian_var = cv2.Laplacian(img, cv2.CV_64F).var()
        return {
            "score": round(float(laplacian_var), 2),
            "is_blurry": laplacian_var < BLUR_THRESHOLD_LAPLACIAN,
            "error": None
        }
    except Exception as e:
        return {"score": 0.0, "is_blurry": False, "error": str(e)}

def estimate_pair_overlap(img_path1: str, img_path2: str) -> int:
    """Estimate spatial feature overlap between consecutive image pairs using ORB."""
    try:
        img1 = cv2.imread(img_path1, cv2.IMREAD_GRAYSCALE)
        img2 = cv2.imread(img_path2, cv2.IMREAD_GRAYSCALE)
        if img1 is None or img2 is None:
            try:
                from PIL import Image as PILImage
                import numpy as np
                if img1 is None:
                    img1 = np.array(PILImage.open(img_path1).convert('L'))
                if img2 is None:
                    img2 = np.array(PILImage.open(img_path2).convert('L'))
            except Exception:
                return 0

        h1, w1 = img1.shape
        if max(h1, w1) > 640:
            s1 = 640.0 / max(h1, w1)
            img1 = cv2.resize(img1, (int(w1 * s1), int(h1 * s1)))
        
        h2, w2 = img2.shape
        if max(h2, w2) > 640:
            s2 = 640.0 / max(h2, w2)
            img2 = cv2.resize(img2, (int(w2 * s2), int(h2 * s2)))

        orb = cv2.ORB_create(nfeatures=500)
        kp1, des1 = orb.detectAndCompute(img1, None)
        kp2, des2 = orb.detectAndCompute(img2, None)

        if des1 is None or des2 is None or len(des1) < 5 or len(des2) < 5:
            return 0

        bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        matches = bf.match(des1, des2)
        
        good_matches = [m for m in matches if m.distance < 50.0]
        return len(good_matches)
    except Exception:
        return 0

def validate_upload_batch(image_paths: list[str]) -> dict:
    total_images = len(image_paths)
    blurry_files = []
    
    # 1. Blur analysis (Sample max 50 images for speed on large video extractions)
    sample_step_blur = max(1, total_images // 50)
    sampled_paths = image_paths[::sample_step_blur]
    
    for path in sampled_paths:
        fname = os.path.basename(path)
        blur_res = check_image_blur(path)
        if blur_res["is_blurry"]:
            blurry_files.append({"filename": fname, "score": blur_res["score"]})

    # Extrapolate usable count based on sampled failure rate
    failure_rate = len(blurry_files) / len(sampled_paths) if sampled_paths else 0
    usable_image_count = int(total_images * (1 - failure_rate))
    
    status = "passed"
    recommendation = "Validation passed."
    
    # 2. Check hard reject thresholds
    if usable_image_count < HARD_REJECT_BELOW:
        status = "rejected"
        recommendation = f"Recapture with at least 150 sharp, overlapping images. Found {usable_image_count} usable images."
    elif usable_image_count < WARN_BELOW:
        status = "warning"
        recommendation = f"Usable images ({usable_image_count}) is below recommended {WARN_BELOW}. Re-capture is suggested for best results."

    # 3. Overlap / Coverage gap check across sample pairs
    low_overlap_pairs = []
    if total_images >= 2:
        sample_step = max(1, total_images // 30)
        sample_indices = list(range(0, total_images - 1, sample_step))

        for i in sample_indices:
            p1 = image_paths[i]
            p2 = image_paths[i + 1]
            matches = estimate_pair_overlap(p1, p2)
            if matches < MIN_ORB_MATCHES:
                low_overlap_pairs.append({
                    "pair": (os.path.basename(p1), os.path.basename(p2)),
                    "matches": matches
                })

        if low_overlap_pairs and status != "rejected":
            status = "warning"
            if recommendation == "Validation passed.":
                recommendation = f"Potential coverage gap detected: {len(low_overlap_pairs)} frame transitions have low feature overlap (<{MIN_ORB_MATCHES} matches)."

    return {
        "status": status,
        "usable_image_count": usable_image_count,
        "blur_failures": blurry_files,
        "low_overlap_pairs": low_overlap_pairs,
        "recommendation": recommendation,
    }
