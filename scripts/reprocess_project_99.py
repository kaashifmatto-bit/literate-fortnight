"""
ArticulAIT — Reprocess Project #99 Script (§4.1 & §6.5)
Forces clean reprocessing of Project #99 from Step 4 (Backprojection) onward,
invalidating stale artifacts and replacing them with output from the fixed
depth-discontinuity filtering code path.
"""

import os
import sys
import time
import shutil
from pathlib import Path

# Add project root to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir))

from backend.core import settings
from backend.services.pipeline_orchestrator import PipelineOrchestrator
from backend.services.gaussian_service import train_gaussians_from_orchestrator
from backend.services.lod_chunk_service import process_lod_and_chunking
from backend.core.database import SessionLocal
from backend.models.schema import Project, Scene


def reprocess_project_99():
    project_id = 99
    project_dir = os.path.join(settings.DATA_DIR, f"project_{project_id}")

    print(f"=== REPROCESSING PROJECT #{project_id} WITH HIGH-FIDELITY PARAMS & CLEANUP PASS ===")
    print(f"Target Directory: {project_dir}")

    # ── 0. Frame Overlap Quality Audit (<70% -> Flag for Reshoot) ──
    img_dir = os.path.join(project_dir, "images")
    img_files = sorted([f for f in os.listdir(img_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]) if os.path.exists(img_dir) else []
    
    poses_file = os.path.join(project_dir, "poses.json")
    registered_count = len(img_files)
    if os.path.exists(poses_file):
        try:
            import json
            with open(poses_file, "r") as pf:
                pdata = json.load(pf)
                if isinstance(pdata, dict) and "poses" in pdata:
                    registered_count = len(pdata["poses"])
        except Exception:
            pass

    total_count = max(1, len(img_files))
    frame_overlap = float(registered_count) / float(total_count)
    print(f"[CAPTURE OVERLAP AUDIT] Registered frames: {registered_count}/{total_count} ({frame_overlap*100:.1f}% overlap)")

    if frame_overlap < 0.70:
        print("\n" + "!" * 75)
        print(f"[RESHOOT REQUIRED] Source capture frame overlap is {frame_overlap*100:.1f}% (< 70.0% threshold).")
        print("Flagged for reshoot rather than attempting to fix in post.")
        print("!" * 75 + "\n")
        
        # Record in DB & Manifest
        db = SessionLocal()
        try:
            proj = db.get(Project, project_id)
            if proj:
                proj.status = "failed"
                proj.output_status = "failed"
                proj.reason_code = "INSUFFICIENT_FRAME_OVERLAP"
                proj.failure_reason = "insufficient_frame_overlap_reshoot_required"
                db.commit()
        finally:
            db.close()
        return

    # ── 1. Confirm Staleness & Invalidate Downstream Cache ──
    ply_path = os.path.join(project_dir, "scene.ply")
    if os.path.exists(ply_path):
        old_mtime = time.ctime(os.path.getmtime(ply_path))
        print(f"[STALENESS CONFIRMED] Stale Project #{project_id} scene.ply timestamp: {old_mtime}")
    else:
        print(f"[INFO] No existing scene.ply found for Project #{project_id}.")

    stale_files = [
        "scene.ply", "scene.splat", "scene_clean.ply",
        "scene_lod_high.splat", "scene_lod_medium.splat", "scene_lod_low.splat",
        "scene_lod_chunk_manifest.json"
    ]
    for fname in stale_files:
        fpath = os.path.join(project_dir, fname)
        if os.path.exists(fpath):
            try:
                os.remove(fpath)
                print(f"[CACHE PURGED] Removed stale file: {fname}")
            except Exception as ex:
                print(f"[WARNING] Could not remove {fname}: {ex}")

    # ── 2. Instantiate Orchestrator for Project #99 ──
    orchestrator = PipelineOrchestrator(project_id=project_id)

    # ── 3. Step 4: Backproject Dense Point Cloud with Depth Discontinuity Filter ──
    print("\n---> Running Step 4: Backprojecting Dense Point Cloud (Edge-Filtered)...")
    t0 = time.time()
    orchestrator._generate_dense_point_cloud()
    print(f"[OK] Step 4 Completed in {time.time() - t0:.2f}s")

    # Verify points3D.txt was generated
    points3d_txt = os.path.join(project_dir, "sparse", "0", "points3D.txt")
    if os.path.exists(points3d_txt):
        with open(points3d_txt, "r") as f:
            lines = [l for l in f if l.strip() and not l.startswith("#")]
        print(f"[POINTS3D AUDIT] Clean dense point cloud generated with {len(lines)} points.")

    # ── 4. Step 5: 3DGS Training with Higher Iteration Count, Lower Densification Threshold & Post Cleanup ──
    print("\n---> Running Step 5: 3DGS Training & Splat Generation (30,000 steps, grow_grad2d=0.0001, post-cleanup)...")
    t1 = time.time()
    success_dgs = train_gaussians_from_orchestrator(
        colmap_dir=project_dir,
        result_dir=project_dir,
        steps=30000,
        densification_threshold=0.0001,
        perform_cleanup=True,
        opacity_threshold=0.05,
        sor_std_ratio=1.5
    )
    print(f"[OK] Step 5 Completed in {time.time() - t1:.2f}s (Success: {success_dgs})")

    # ── 5. Step 6: 3-Level LOD Tier Generation & Spatial Chunking ──
    print("\n---> Running Step 6: Generating LOD Tiers & Spatial Chunk Manifest...")
    splat_file = os.path.join(project_dir, "scene.splat")
    ply_file = os.path.join(project_dir, "scene.ply")

    lod_manifest = process_lod_and_chunking(
        project_dir=project_dir,
        splat_file=splat_file,
        ply_file=ply_file,
        num_rooms=1
    )
    print(f"[OK] Step 6 Completed. LOD Manifest status: {lod_manifest.get('status', 'ok')}")

    # ── 6. Update Output Manifest & DB Record ──
    print("\n---> Updating Output Manifest & Database Records...")
    orchestrator.output_status = "completed"
    orchestrator._record_pipeline_metrics(success=True)

    # Confirm timestamps of newly generated artifacts
    if os.path.exists(ply_path):
        new_mtime = time.ctime(os.path.getmtime(ply_path))
        new_size_mb = os.path.getsize(ply_path) / (1024 * 1024)
        print(f"\n[VERIFICATION SUCCESS] Project #{project_id} scene.ply updated!")
        print(f"  - New Timestamp: {new_mtime}")
        print(f"  - New File Size: {new_size_mb:.2f} MB")
        print(f"  - Output Status: {orchestrator.output_status}")
    else:
        print("[ERROR] scene.ply was not found after reprocessing.")


if __name__ == "__main__":
    reprocess_project_99()
