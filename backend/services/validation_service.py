"""
ArticulAIT — Upload Validation Service
Automated capture-to-splat quality validation prior to COLMAP / 3DGS reconstruction.
Performs:
1. Image count validation
2. Laplacian variance blur detection (filters unsharp frames)
3. ORB feature overlap & coverage gap estimation
"""

import os
import cv2
import numpy as np

# Thresholds
MIN_RECOMMENDED_IMAGES = 20
OPTIMAL_IMAGES_ROOM = 150
BLUR_THRESHOLD_LAPLACIAN = 70.0  # Images below this score are flagged as blurry
MIN_PAIR_MATCHES = 25           # Minimum ORB inlier matches for sufficient overlap


def check_image_blur(image_path: str) -> dict:
    """
    Calculate Laplacian variance score to detect motion blur or out-of-focus images.
    Returns score and blur classification.
    """
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return {"score": 0.0, "is_blurry": True, "error": "Could not read image"}

        # Resize if image is extremely high res to speed up computation
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
    """
    Estimate spatial feature overlap between consecutive image pairs using ORB feature matching.
    Returns the count of good feature matches.
    """
    try:
        img1 = cv2.imread(img_path1, cv2.IMREAD_GRAYSCALE)
        img2 = cv2.imread(img_path2, cv2.IMREAD_GRAYSCALE)
        if img1 is None or img2 is None:
            return 0

        # Downscale for fast feature matching
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
        
        # Sort matches by distance
        good_matches = [m for m in matches if m.distance < 50.0]
        return len(good_matches)
    except Exception:
        return 0


def validate_upload_batch(image_paths: list[str]) -> dict:
    """
    Comprehensive pre-reconstruction validation pipeline.
    Checks total count, blur, and overlap consistency.
    """
    total_images = len(image_paths)
    warnings = []
    blurry_files = []
    blur_scores = []

    # 1. Image count check
    if total_images < MIN_RECOMMENDED_IMAGES:
        warnings.append(
            f"Low image count ({total_images} photos uploaded). At least {MIN_RECOMMENDED_IMAGES} photos are recommended for room reconstruction."
        )

    # 2. Blur analysis on uploaded files
    for path in image_paths:
        fname = os.path.basename(path)
        blur_res = check_image_blur(path)
        blur_scores.append(blur_res["score"])
        if blur_res["is_blurry"]:
            blurry_files.append({"filename": fname, "score": blur_res["score"]})

    if blurry_files:
        blurry_pct = (len(blurry_files) / total_images) * 100
        if blurry_pct > 20.0:
            warnings.append(
                f"{len(blurry_files)} out of {total_images} photos ({blurry_pct:.1f}%) were flagged as blurry or unsharp."
            )

    # 3. Overlap / Coverage gap check across sample pairs
    overlap_scores = []
    low_overlap_gaps = 0

    if total_images >= 2:
        # Sample up to 30 consecutive pairs to keep pre-validation ultra-fast (<2 seconds)
        sample_step = max(1, total_images // 30)
        sample_indices = list(range(0, total_images - 1, sample_step))

        for i in sample_indices:
            p1 = image_paths[i]
            p2 = image_paths[i + 1]
            matches = estimate_pair_overlap(p1, p2)
            overlap_scores.append(matches)
            if matches < MIN_PAIR_MATCHES:
                low_overlap_gaps += 1

        if low_overlap_gaps > 0:
            warnings.append(
                f"Potential coverage gap detected: {low_overlap_gaps} frame transitions have low feature overlap (<{MIN_PAIR_MATCHES} matches)."
            )

    avg_overlap = float(np.mean(overlap_scores)) if overlap_scores else 0.0
    avg_blur = float(np.mean(blur_scores)) if blur_scores else 0.0

    # Determine validation quality tier
    if total_images >= 50 and len(blurry_files) == 0 and low_overlap_gaps == 0:
        quality_tier = "optimal"
    elif total_images >= MIN_RECOMMENDED_IMAGES and (len(blurry_files) / max(1, total_images)) < 0.25:
        quality_tier = "acceptable"
    else:
        quality_tier = "suboptimal"

    return {
        "pass_validation": True,
        "total_images": total_images,
        "blurry_count": len(blurry_files),
        "blurry_files": blurry_files,
        "avg_blur_score": round(avg_blur, 2),
        "avg_overlap_matches": round(avg_overlap, 1),
        "low_overlap_gaps": low_overlap_gaps,
        "quality_tier": quality_tier,
        "warnings": warnings,
    }
