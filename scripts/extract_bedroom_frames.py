"""
ArticulAIT — Extract High Clarity Bedroom Frames
Extracts 75 to 100 sharp frames from NOT_DRONE_SHOT_I_just_need_D.mp4 for 3DGS training.
"""
import cv2
import os
import sys

def extract_frames(video_path: str, output_dir: str, target_count: int = 80):
    if not os.path.exists(video_path):
        print(f"Error: Video file not found: {video_path}")
        return False

    os.makedirs(output_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 0:
        print(f"Error: Could not read frames from {video_path}")
        return False

    interval = max(1, total_frames // target_count)
    saved_count = 0
    frame_idx = 0

    print(f"Extracting ~{target_count} frames from {total_frames} total frames (step interval: {interval})...")

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_idx % interval == 0 and saved_count < target_count:
            out_file = os.path.join(output_dir, f"frame_{saved_count:03d}.jpg")
            cv2.imwrite(out_file, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            saved_count += 1

        frame_idx += 1

    cap.release()
    print(f"[OK] Successfully extracted {saved_count} frames to {output_dir}")
    return True

if __name__ == "__main__":
    video_path = sys.argv[1] if len(sys.argv) > 1 else "NOT_DRONE_SHOT_I_just_need_D.mp4"
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "data/project_19_highres/images"
    extract_frames(video_path, output_dir, target_count=80)
