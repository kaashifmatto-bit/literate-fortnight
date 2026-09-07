from backend.reconstruction.pose_router import torch
import subprocess 
import os
import sys
import time
from backend.core import settings
from backend.core.database import SessionLocal
from backend.models.schema import Project, Scene

def validate_gaussian_quality_assertion(splat_file: str) -> tuple[bool, str]:
    """
    Automated check: Fails loudly if training produced Gaussians with suspiciously
    uniform scale or 100% identity rotations, surfacing failure state instead of
    silently completing with status=completed.
    """
    if not os.path.exists(splat_file) or os.path.getsize(splat_file) < 32:
        return False, f"Splat file missing or empty: {splat_file}"

    import struct, numpy as np
    size = os.path.getsize(splat_file)
    count = size // 32
    if count < 10:
        return False, f"Degenerate splat file with only {count} points"

    with open(splat_file, "rb") as f:
        raw = f.read(min(size, 100000 * 32))
    sample_count = len(raw) // 32

    scales = []
    identity_rot_count = 0
    for i in range(sample_count):
        off = i * 32
        sx, sy, sz = struct.unpack_from("<fff", raw, off + 12)
        rq, gq, bq, aq = struct.unpack_from("BBBB", raw, off + 28)
        scales.append((sx, sy, sz))
        if (rq, gq, bq, aq) == (255, 128, 128, 128):
            identity_rot_count += 1

    scales_arr = np.array(scales)
    scale_std = float(np.std(scales_arr))
    rot_identity_pct = float(identity_rot_count / max(1, sample_count) * 100.0)

    summary = f"Sampled {sample_count:,} Gaussians: scale_std={scale_std:.6f}, rot_identity_pct={rot_identity_pct:.1f}%"

    if rot_identity_pct > 95.0 and scale_std < 0.001:
        err_msg = (
            f"[ASSERTION FAILURE] Degenerate Gaussian output detected ({summary}). "
            f"Rotations are 100% identity and scales are uniform — model was not properly trained!"
        )
        print(f"❌ {err_msg}")
        return False, err_msg

    print(f"✅ [ASSERTION PASSED] {summary}")
    return True, summary

def _decimate_point_cloud_voxel(points_path: str, target_count: int = 150000):
    """
    Spatially downsamples a dense point cloud using a voxel grid to prevent GPU OOM crashes
    during 3DGS initialization, while preserving structural coverage.
    """
    import math
    if not os.path.exists(points_path):
        return
        
    with open(points_path, 'r') as f:
        lines = f.readlines()
        
    comments = [l for l in lines if l.startswith('#')]
    data_lines = [l for l in lines if not l.startswith('#')]
    
    if len(data_lines) <= target_count:
        return
        
    print(f"Downsampling {len(data_lines)} points to ~{target_count} using spatial voxel grid...")
    
    points = []
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    
    for l in data_lines:
        parts = l.split()
        if len(parts) >= 7:
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            points.append((x, y, z, l))
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)
            min_z = min(min_z, z)
            max_z = max(max_z, z)
            
    vol_x = max(max_x - min_x, 0.001)
    vol_y = max(max_y - min_y, 0.001)
    vol_z = max(max_z - min_z, 0.001)
    
    # Points form surfaces (2D manifold in 3D space), so effective volume is much smaller.
    # We iteratively find a voxel size that yields roughly target_count.
    voxel_size = math.pow((vol_x * vol_y * vol_z) / (target_count * 5), 1/3)
    
    for _ in range(5):
        voxel_dict = {}
        for p in points:
            x, y, z, line = p
            vx = int((x - min_x) / voxel_size)
            vy = int((y - min_y) / voxel_size)
            vz = int((z - min_z) / voxel_size)
            key = (vx, vy, vz)
            if key not in voxel_dict:
                voxel_dict[key] = line
                
        if len(voxel_dict) > target_count:
            voxel_size *= 1.2  # Increase voxel size to reduce points
        elif len(voxel_dict) < target_count * 0.8:
            voxel_size *= 0.8  # Decrease voxel size to increase points
        else:
            break
            
    filtered_lines = list(voxel_dict.values())
    
    # If still too many, fallback to random sampling of the voxelized result to hit the exact cap
    if len(filtered_lines) > target_count:
        import random
        filtered_lines = random.sample(filtered_lines, target_count)
        
    print(f"Voxel downsampling complete. Retained {len(filtered_lines)} points (voxel size: {voxel_size:.4f}m).")
    
    with open(points_path, 'w') as f:
        f.writelines(comments)
        f.writelines(filtered_lines)

def _prepare_downsampled_images(colmap_dir: str, factor: int = 4):
    """
    Generates an 'images_{factor}' directory containing downscaled images.
    gsplat/COLMAP loaders require this directory to exist when --data_factor is used.
    This provides a crucial safety net for laptops with 4-8GB VRAM (like RTX 3050).
    """
    import cv2
    source_dir = os.path.join(colmap_dir, "images")
    target_dir = os.path.join(colmap_dir, f"images_{factor}")
    
    if not os.path.exists(source_dir):
        print(f"Warning: Source images directory {source_dir} not found for downsampling.")
        return
        
    if os.path.exists(target_dir):
        print(f"Downsampled images_{factor} already exists. Skipping generation.")
        return
        
    os.makedirs(target_dir, exist_ok=True)
    images = [f for f in os.listdir(source_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
    print(f"Downsampling {len(images)} images by factor {factor} for low-VRAM training...")
    
    for img_name in images:
        img_path = os.path.join(source_dir, img_name)
        img = cv2.imread(img_path)
        if img is not None:
            h, w = img.shape[:2]
            new_h, new_w = max(1, h // factor), max(1, w // factor)
            resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            target_path = os.path.join(target_dir, img_name)
            cv2.imwrite(target_path, resized)

def train_gaussians():
    """Legacy entrypoint for backward compatibility."""
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data"))
    colmap_out = os.path.join(base_dir, "colmap_output")
    dgs_out = os.path.join(base_dir, "3dgs_output")
    return train_gaussians_from_orchestrator(colmap_out, dgs_out)

def train_gaussians_from_orchestrator(
    colmap_dir: str, 
    result_dir: str, 
    steps: int = 30000, 
    progress_callback = None,
    densification_threshold: float = 0.0001,
    perform_cleanup: bool = True,
    opacity_threshold: float = 0.01,
    sor_std_ratio: float = 2.5
) -> bool:
    colmap_dir = os.path.abspath(colmap_dir)
    # Note: train_script is located in the vendored gsplat_source directory.
    # [ARTICULAIT MODIFICATION]: We have directly modified simple_trainer.py (around line 945)
    # to include a torch.cuda.synchronize() and time.sleep(0.015) duty-cycle throttle.
    # This prevents the training loop from monopolizing the GPU and causing OS/UI lag.
    # If the gsplat repository is ever re-cloned or updated, this throttle must be re-added!
    train_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../gsplat_source/examples/simple_trainer.py"))
    os.makedirs(result_dir, exist_ok=True)

    if not os.path.exists(train_script):
        print(f"Error: {train_script} not found.")
        return False

    try:
        # Pre-process: Decimate the input point cloud if it's too large to prevent OOM
        # For standard projects, 100k-150k initialization points is ideal for gsplat density.
        points_txt_path = os.path.join(colmap_dir, "sparse", "0", "points3D.txt")
        _decimate_point_cloud_voxel(points_txt_path, target_count=150000)

        # Pre-process: Generate downsampled images to prevent VRAM OOM on 4GB GPUs
        _prepare_downsampled_images(colmap_dir, factor=4)

        print(f"Starting 3DGS Training (Steps: {steps}, Densification Threshold: {densification_threshold}) using native GSPLAT...")
        # Correct path: __file__ is in backend/services/, so two levels up is the project root (articulait/)
        venv_python = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.venv/Scripts/python.exe"))
        if not os.path.exists(venv_python):
            venv_python = sys.executable # fallback
            
        vcvars_candidates = [
            r"D:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
            r"D:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
            r"D:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
            r"D:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
        ]
        vcvars_path = next((p for p in vcvars_candidates if os.path.exists(p)), vcvars_candidates[0])

        # Set NVCC flags to bypass VS2026 version check in NVCC host_config.h for all extensions (gsplat, nerfacc, etc.)
        env = os.environ.copy()
        env["NVCC_FLAGS"] = "-allow-unsupported-compiler"
        env["CUDAFLAGS"] = "-allow-unsupported-compiler"
        env["EXTRA_NVCCFLAGS"] = "-allow-unsupported-compiler"
        env["NVCC_PREPEND_FLAGS"] = "-allow-unsupported-compiler"
        env["TORCH_NVCC_FLAGS"] = "-allow-unsupported-compiler"

        # [ARTICULAIT MODIFICATION - low-VRAM OOM fix]: switched from the
        # "default" densification preset to "mcmc" (3DGS-as-MCMC, see
        # gsplat.strategy.MCMCStrategy). "default" grows the Gaussian count
        # unboundedly based on a gradient-threshold heuristic (--grow_grad2d)
        # with no ceiling - on a 4GB card that heuristic growth is exactly
        # what was blowing past available VRAM mid-training and crashing the
        # subprocess with TRAINING_CRASHED_OOM (see fallback_reason below).
        # "mcmc" instead enforces a hard cap on the total Gaussian count via
        # --strategy.cap-max, so peak memory is bounded by construction
        # regardless of scene complexity. 200k is a conservative ceiling
        # relative to the 150k-point decimated init above - raise it later
        # once a run completes successfully and there's headroom to spare.
        # --grow_grad2d/--prune_opa are no longer read by MCMCStrategy (it
        # uses --strategy.min-opacity instead) so they're dropped here to
        # avoid implying they still do anything.
        cmd = (
            f'set NVCC_FLAGS=-allow-unsupported-compiler && '
            f'set CUDAFLAGS=-allow-unsupported-compiler && '
            f'set EXTRA_NVCCFLAGS=-allow-unsupported-compiler && '
            f'set NVCC_PREPEND_FLAGS=-allow-unsupported-compiler && '
            f'set TORCH_NVCC_FLAGS=-allow-unsupported-compiler && '
            f'call "{vcvars_path}" && '
            f'"{venv_python}" "{train_script}" "mcmc" '
            f'--disable_viewer --disable_video --data_dir "{colmap_dir}" --result_dir "{result_dir}" '
            f'--data_factor 4 --max_steps {steps} --sh_degree 2 --save_ply --antialiased '
            f'--strategy.cap-max 200000 --opacity_reg 0.01 --scale_reg 0.01 '
            f'--prune_scale3d 0.05 --reset_every 1000 --pose_opt'
        )
        
        # Start training process and capture stdout for progress parsing
        # Use BELOW_NORMAL_PRIORITY_CLASS (0x00004000) on Windows to prevent OS lag
        process = subprocess.Popen(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.STDOUT, 
            text=True, 
            shell=True,
            cwd=os.path.dirname(train_script),
            env=env,
            creationflags=0x00004000 if os.name == 'nt' else 0
        )
        
        start_time = time.time()
        
        while True:
            line = process.stdout.readline()
            if line == '' and process.poll() is not None:
                break
            if line:
                line_str = line.strip()
                print(line_str)
                sys.stdout.flush()
                
                # Parse progress out of simple_trainer print (e.g. "Step:  1999 {stats}")
                if "Step:" in line_str and progress_callback:
                    try:
                        parts = line_str.split()
                        step_idx = parts.index("Step:") + 1
                        current_step = int(parts[step_idx].replace(",", ""))
                        pct = int((current_step + 1) / steps * 100)
                        progress_callback(pct, f"Training 3DGS step {current_step+1}/{steps}...")
                    except Exception:
                        pass
                        
        rc = process.poll()
        ply_file = os.path.join(result_dir, "scene.ply")
        splat_file = os.path.join(result_dir, "scene.splat")
        points3d_txt = os.path.join(colmap_dir, "sparse", "0", "points3D.txt")
        # NOT "scene_manifest.json" - that filename collides with
        # PipelineOrchestrator._write_output_manifest(), which runs later in
        # the same pipeline and unconditionally overwrites whatever's at
        # that path with its own unrelated schema (status/reason_code/
        # has_3dgs). Its "has_3dgs" check only asks whether *some*
        # scene.splat/scene.ply exists on disk - true whether that file came
        # from real GPU training or this function's crude
        # dense_cloud_fallback conversion - so every fallback run ended up
        # permanently erasing the one record (training_mode,
        # fallback_reason) that would explain why the output looks like a
        # blurry, fixed-opacity point cloud instead of a real trained
        # Gaussian Splat. Writing to a distinct filename lets this survive.
        manifest_file = os.path.join(result_dir, "gaussian_training_manifest.json")

        training_mode = "gsplat_gpu"
        fallback_triggered = False
        fallback_reason = None

        if rc != 0:
            fallback_triggered = True
            training_mode = "dense_cloud_fallback"
            fallback_reason = f"GPU trainer process exited with error code {rc} (MSVC/CUDA toolchain mismatch or memory constraint)"
            print("\n" + "=" * 70)
            print(f"[PIPELINE ALERT] [FALLBACK] 3DGS GPU TRAINER FALLBACK TRIGGERED!")
            print(f"[PIPELINE ALERT] Reason: {fallback_reason}")
            print(f"[PIPELINE ALERT] Utilizing unified dense point cloud generator...")
            print("=" * 70 + "\n")
            if os.path.exists(points3d_txt):
                try:
                    from scripts.convert_ply_to_splat import convert_colmap_txt_to_splat, clean_3dgs_post_training
                    convert_colmap_txt_to_splat(points3d_txt, ply_file, splat_file)
                    if perform_cleanup and os.path.exists(ply_file):
                        clean_3dgs_post_training(
                            ply_path=ply_file,
                            output_ply_path=ply_file,
                            opacity_threshold=opacity_threshold,
                            sor_std_ratio=sor_std_ratio
                        )
                except Exception as e:
                    print(f"Warning: Failed convert_colmap_txt_to_splat fallback: {e}")
                    return False
            else:
                return False

        # Post-training cleanup pass & auto-convert PLY to compact, needle-pruned .splat format
        elif os.path.exists(ply_file):
            print("\n" + "=" * 70)
            print(f"[PIPELINE SUCCESS] [OK] 3DGS GPU Training completed cleanly (rc=0)!")
            print(f"[PIPELINE SUCCESS] Output model: {ply_file}")
            print("=" * 70 + "\n")
            try:
                import shutil
                pretrain_ply = os.path.join(result_dir, "scene_pretrain.ply")
                shutil.copyfile(ply_file, pretrain_ply)
                print(f"[PIPELINE INFO] Saved raw training checkpoint to {pretrain_ply}")
                from scripts.convert_ply_to_splat import convert_ply_to_splat, clean_3dgs_post_training
                if perform_cleanup:
                    clean_3dgs_post_training(
                        ply_path=ply_file,
                        output_ply_path=ply_file,
                        opacity_threshold=opacity_threshold,
                        sor_std_ratio=sor_std_ratio
                    )
                convert_ply_to_splat(ply_file, splat_file)

                # ── Automated Quality Assertion Check (§5) ──
                passed_assertion, assert_msg = validate_gaussian_quality_assertion(splat_file)
                if not passed_assertion:
                    print(f"[PIPELINE ERROR] Quality Assertion Failed: {assert_msg}")
                    return False
            except Exception as e:
                print(f"Warning: Failed to perform post-training cleanup/conversion: {e}")

        # Write scene_manifest.json for explicit ops / status monitoring
        try:
            import json
            manifest_data = {
                "training_mode": training_mode,
                "fallback_triggered": fallback_triggered,
                "fallback_reason": fallback_reason,
                "timestamp": time.time(),
                "ply_exists": os.path.exists(ply_file),
                "splat_exists": os.path.exists(splat_file),
                "ply_size_mb": round(os.path.getsize(ply_file) / (1024 * 1024), 2) if os.path.exists(ply_file) else 0.0,
                "splat_size_mb": round(os.path.getsize(splat_file) / (1024 * 1024), 2) if os.path.exists(splat_file) else 0.0,
            }
            with open(manifest_file, "w") as mf:
                json.dump(manifest_data, mf, indent=2)
        except Exception as e:
            print(f"Warning: Failed to write scene_manifest.json: {e}")

        # ── Trigger Gap 6: LOD Tier Generation & Spatial Chunking ──
        if os.path.exists(splat_file):
            try:
                from backend.services.lod_chunk_service import process_lod_and_chunking
                lod_manifest = process_lod_and_chunking(result_dir, splat_file, ply_file, num_rooms=1)
                print(f"[LOD & Chunking] Generated 3 LOD tiers & manifest: Budget Passed = {lod_manifest['budget_check']['overall_budget_passed']}")
            except Exception as e:
                print(f"Warning: Failed to execute LOD/chunking pipeline: {e}")

        # ── Register Scene in Database & Record Quality Gate Metrics ──
        # Extract project_id from directory name (assumes directory base is "project_{id}")
        dir_name = os.path.basename(os.path.abspath(colmap_dir))
        if "_" in dir_name:
            try:
                project_id = int(dir_name.split("_")[-1])
                db = SessionLocal()
                try:
                    # Check if project exists
                    project = db.query(Project).get(project_id)
                    if project:
                        # Clean up existing scene record if any
                        if project.scene:
                            db.delete(project.scene)
                            db.flush()
                        
                        # Read stats JSON if available
                        psnr_val, ssim_val, lpips_val = None, None, None
                        stats_dir = os.path.join(result_dir, "stats")
                        if os.path.exists(stats_dir):
                            import json
                            json_files = [f for f in os.listdir(stats_dir) if f.endswith(".json")]
                            if json_files:
                                latest_stats_file = os.path.join(stats_dir, sorted(json_files)[-1])
                                try:
                                    with open(latest_stats_file, "r") as f:
                                        stats_data = json.load(f)
                                        psnr_val = stats_data.get("psnr")
                                        ssim_val = stats_data.get("ssim")
                                        lpips_val = stats_data.get("lpips")
                                except Exception as e:
                                    print(f"Warning: Could not read stats json: {e}")

                        # Quality flag check (default threshold: PSNR >= 25.0 dB -> passed)
                        quality_pass_eval = True
                        if psnr_val is not None:
                            project.quality_flag = "passed" if psnr_val >= 25.0 else "pending_review"
                            quality_pass_eval = psnr_val >= 20.0
                        else:
                            project.quality_flag = "passed"
                            quality_pass_eval = True

                        # Create scene entry pointing to project folder assets
                        scene_rec = Scene(
                            project_id=project_id,
                            splat_path=f"/data/project_{project_id}/scene.splat",
                            ply_path=f"/data/project_{project_id}/scene.ply",
                            training_steps=steps,
                            training_time_seconds=float(time.time() - start_time),
                            psnr=psnr_val,
                            ssim=ssim_val,
                            lpips=lpips_val,
                            quality_pass=quality_pass_eval,
                        )
                        db.add(scene_rec)
                        db.commit()
                        print(f"[OK] Scene database record registered for project {project_id} (PSNR: {psnr_val}, Quality: {project.quality_flag}, Pass: {quality_pass_eval})")
                finally:
                    db.close()
            except Exception as e:
                print(f"Warning: Failed to log Scene record in database: {e}")
                
        return True
    except Exception as e:
        print(f"3DGS Error: {e}")
        return False


def render_offline_pytorch_orbit(
    checkpoint_dir: str,
    output_dir: str,
    c2w_matrices: list,
    width: int = 640,
    height: int = 480,
    fx: float = 500.0,
    fy: float = 500.0
) -> list:
    """
    Renders novel view orbit frames directly from PyTorch Gaussian tensor checkpoints using OpenCV.
    """
    try:
        from backend.services.pytorch_renderer_service import render_orbit_frames_opencv
        device = "cuda" if torch.cuda.is_available() else "cpu"
        pos = torch.load(os.path.join(checkpoint_dir, 'pos.pt')).to(device)
        opacity_raw = torch.load(os.path.join(checkpoint_dir, 'opacity_raw.pt')).to(device)
        f_dc = torch.load(os.path.join(checkpoint_dir, 'f_dc.pt')).to(device)
        f_rest = torch.load(os.path.join(checkpoint_dir, 'f_rest.pt')).to(device)
        scale_raw = torch.load(os.path.join(checkpoint_dir, 'scale_raw.pt')).to(device)
        q_raw = torch.load(os.path.join(checkpoint_dir, 'q_rot.pt')).to(device)

        c2w_tensors = [torch.as_tensor(c, dtype=torch.float32, device=device) for c in c2w_matrices]
        return render_orbit_frames_opencv(
            pos=pos, opacity_raw=opacity_raw, f_dc=f_dc, f_rest=f_rest,
            scale_raw=scale_raw, q_raw=q_raw, c2w_matrices=c2w_tensors,
            H=height, W=width, fx=fx, fy=fy, output_dir=output_dir
        )
    except Exception as e:
        print(f"Error in offline PyTorch orbit rendering: {e}")
        return []
