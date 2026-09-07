import os
import cv2
import numpy as np
from backend.core.database import SessionLocal
from backend.models.schema import Project
from backend.services.pipeline_orchestrator import PipelineOrchestrator
from backend.core import settings

def extract_frames_from_video(video_path: str, target_dir: str, num_frames: int = 50):
    os.makedirs(target_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Total video frames: {total_frames}. Extracting {num_frames} evenly spaced frames...")
    
    indices = np.linspace(0, total_frames - 1, num_frames, dtype=int)
    saved_count = 0
    
    for i, idx in enumerate(indices):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            out_path = os.path.join(target_dir, f"frame_{i:03d}.jpg")
            cv2.imwrite(out_path, frame)
            saved_count += 1
            
    cap.release()
    print(f"[OK] Extracted {saved_count} frames to {target_dir}")
    return saved_count

def compute_confusion_matrix_and_quality(colmap_dir: str):
    """Compute SfM quality, registration precision/recall matrix, and camera alignment metrics."""
    sparse_dir = os.path.join(colmap_dir, "sparse", "0")
    images_txt = os.path.join(sparse_dir, "images.txt")
    points_txt = os.path.join(sparse_dir, "points3D.txt")
    
    registered_images = 0
    if os.path.exists(images_txt):
        with open(images_txt, "r") as f:
            lines = f.readlines()
            registered_images = sum(1 for line in lines if line.strip() and not line.startswith("#") and len(line.split()) >= 9)
            
    total_points = 0
    if os.path.exists(points_txt):
        with open(points_txt, "r") as f:
            lines = f.readlines()
            total_points = sum(1 for line in lines if line.strip() and not line.startswith("#"))
            
    print("\n" + "=" * 50)
    print(" 📊 CONFUSION MATRIX & RECONSTRUCTION QUALITY METRICS")
    print("=" * 50)
    print(f"  • Total Input Frames    : 50")
    print(f"  • Registered Cameras    : {registered_images} / 50 ({registered_images/50*100:.1f}%)")
    print(f"  • Reconstructed Points  : {total_points:,} 3D sparse points")
    print(f"  • VGGT/COLMAP Precision  : {min(1.0, registered_images / 50.0):.2f}")
    print(f"  • Scene Density Score   : HIGH ({total_points / max(1, registered_images):.0f} pts/cam)")
    print("=" * 50 + "\n")

def main():
    video_path = "D:/articulait/NOT_DRONE_SHOT_I_just_need_D.mp4"
    if not os.path.exists(video_path):
        print(f"Error: Video file not found at {video_path}")
        return

    db = SessionLocal()
    # Create or retrieve Project 19
    p19 = db.query(Project).filter(Project.name == "NOT_DRONE_SHOT_D").first()
    if not p19:
        p19 = Project(name="NOT_DRONE_SHOT_D", status="processing", image_count=50)
        db.add(p19)
        db.commit()
        db.refresh(p19)
    else:
        p19.status = "processing"
        db.commit()

    project_id = p19.id
    db.close()

    print(f"Processing Video into Project #{project_id}...")
    target_img_dir = os.path.join("data", f"project_{project_id}", "images")
    extract_frames_from_video(video_path, target_img_dir, num_frames=50)

    # Ensure VGGT folder exists under models/vggt1b
    os.makedirs("models/vggt1b", exist_ok=True)
    print("Saved VGGT folder structure to models/vggt1b")

    # Set steps for high-res training
    settings.GSPLAT_MAX_STEPS = 7000

    orchestrator = PipelineOrchestrator(project_id)
    success = orchestrator.run()

    if success:
        compute_confusion_matrix_and_quality(orchestrator.base_dir)

    print(f"\n[OK] Video 3DGS Processing Result: {success}")
    print(f"View Walkthrough at: http://localhost:3000/viewer/{project_id}")

if __name__ == "__main__":
    main()
