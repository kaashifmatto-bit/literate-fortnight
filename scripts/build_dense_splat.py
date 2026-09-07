import os
import sys
import json
import math
import numpy as np
import cv2

def quat_to_rot_matrix(q):
    """Convert quaternion [qw, qx, qy, qz] to 3x3 rotation matrix (Camera to World)."""
    qw, qx, qy, qz = q
    norm = math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) + 1e-8
    qw, qx, qy, qz = qw/norm, qx/norm, qy/norm, qz/norm
    
    R = np.array([
        [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw), 2*(qx*qz + qy*qw)],
        [2*(qx*qy + qz*qw), 1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
        [2*(qx*qz - qy*qw), 2*(qy*qz + qx*qw), 1 - 2*(qx*qx + qy*qy)]
    ], dtype=np.float32)
    return R

def write_3dgs_ply(filename, points, colors):
    """Write binary 3DGS PLY file with position, spherical harmonic color, scale, and opacity."""
    num_points = len(points)
    if num_points == 0:
        return

    print(f"Computing KNN scale coverage for {num_points:,} 3D surface splats...")
    from scipy.spatial import KDTree
    sample_sub = max(1, num_points // 25000)
    tree = KDTree(points[::sample_sub])
    dists, _ = tree.query(points, k=2)
    knn_d = dists[:, 1] if dists.ndim > 1 and dists.shape[1] > 1 else dists.ravel()

    # Ultra-sharp surface covering scale (clamped between 0.9cm and 2.4cm) for razor-sharp solid 3D surfaces
    scales = np.clip(knn_d * 0.60, 0.009, 0.024).astype(np.float32)
    log_scales = np.log(scales)
    opacities = np.full(num_points, 3.2, dtype=np.float32) # Opacity ~ 0.96 (Solid Opaque Surface)

    SH_C0 = 0.28209479177387814
    f_dc = ((colors.astype(np.float32) / 255.0) - 0.5) / SH_C0

    header = f"""ply
format binary_little_endian 1.0
element vertex {num_points}
property float x
property float y
property float z
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
"""
    ply_dtype = np.dtype([
        ('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
        ('f_dc_0', '<f4'), ('f_dc_1', '<f4'), ('f_dc_2', '<f4'),
        ('opacity', '<f4'),
        ('scale_0', '<f4'), ('scale_1', '<f4'), ('scale_2', '<f4'),
        ('rot_0', '<f4'), ('rot_1', '<f4'), ('rot_2', '<f4'), ('rot_3', '<f4')
    ])

    ply_data = np.empty(num_points, dtype=ply_dtype)
    ply_data['x'] = points[:, 0]
    ply_data['y'] = points[:, 1]
    ply_data['z'] = points[:, 2]
    ply_data['f_dc_0'] = f_dc[:, 0]
    ply_data['f_dc_1'] = f_dc[:, 1]
    ply_data['f_dc_2'] = f_dc[:, 2]
    ply_data['opacity'] = opacities
    ply_data['scale_0'] = log_scales
    ply_data['scale_1'] = log_scales
    ply_data['scale_2'] = log_scales
    ply_data['rot_0'] = np.ones(num_points, dtype=np.float32)
    ply_data['rot_1'] = np.zeros(num_points, dtype=np.float32)
    ply_data['rot_2'] = np.zeros(num_points, dtype=np.float32)
    ply_data['rot_3'] = np.zeros(num_points, dtype=np.float32)

    with open(filename, "wb") as f:
        f.write(header.encode("latin-1"))
        f.write(ply_data.tobytes())
    print(f"[OK] Saved {num_points:,} solid 3DGS surface points to {filename}")

def build_dense_splat_for_project(project_id):
    proj_dir = f"d:/articulait/data/project_{project_id}"
    poses_path = os.path.join(proj_dir, "poses.json")
    images_dir = os.path.join(proj_dir, "images")
    depths_dir = os.path.join(proj_dir, "depths")

    if not os.path.exists(poses_path):
        print(f"Error: {poses_path} not found!")
        return

    with open(poses_path, "r", encoding="utf-8") as f:
        poses_data = json.load(f)

    poses = poses_data.get("poses", {})
    print(f"Loaded {len(poses)} camera poses for Project #{project_id}")

    all_pts = []
    all_cols = []

    for img_name, pose_info in poses.items():
        img_path = os.path.join(images_dir, img_name)
        base_name = os.path.splitext(img_name)[0]
        depth_path = os.path.join(depths_dir, f"{base_name}.npy")
        if not os.path.exists(depth_path):
            depth_path = os.path.join(depths_dir, f"{base_name}.png")

        if not os.path.exists(img_path) or not os.path.exists(depth_path):
            continue

        img_bgr = cv2.imread(img_path)
        if img_bgr is None:
            continue
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        h, w, _ = img_rgb.shape

        if depth_path.endswith(".npy"):
            depth_raw = np.load(depth_path).astype(np.float32)
        else:
            depth_img = cv2.imread(depth_path, cv2.IMREAD_GRAYSCALE)
            depth_raw = depth_img.astype(np.float32)

        if depth_raw.shape[:2] != (h, w):
            depth_raw = cv2.resize(depth_raw, (w, h), interpolation=cv2.INTER_LINEAR)

        # Convert disparity (0..255) to true inverse metric depth Z:
        # Near objects (desk/people at 255) -> ~0.9m
        # Far objects (walls/ceiling at 0)   -> ~5.0m
        inv_d = np.clip(depth_raw / 255.0, 0.0, 1.0)
        z_map = 1.0 / (0.18 + 0.82 * inv_d)

        fx = 1.15 * max(w, h)
        fy = fx
        cx = w / 2.0
        cy = h / 2.0

        # Dense grid sampling (step=3 -> ~50,000 points per frame)
        step = 3
        y_indices, x_indices = np.mgrid[0:h:step, 0:w:step]
        z_vals = z_map[y_indices, x_indices]

        valid_mask = (z_vals > 0.5) & (z_vals < 6.0)
        x_valid = x_indices[valid_mask]
        y_valid = y_indices[valid_mask]
        z_valid = z_vals[valid_mask]

        if len(z_valid) == 0:
            continue

        # Correct camera space backprojection:
        # +X right, -Y up (converting image row index to 3D Y), +Z forward
        x_cam = (x_valid - cx) * z_valid / fx
        y_cam = -(y_valid - cy) * z_valid / fy
        pts_cam = np.stack([x_cam, y_cam, z_valid], axis=-1)

        pos = pose_info["position"]
        t_c2w = np.array([pos["x"], pos["y"], pos["z"]], dtype=np.float32)
        quat = pose_info.get("quaternion", [1, 0, 0, 0])
        R_c2w = quat_to_rot_matrix(quat)

        pts_world = (R_c2w @ pts_cam.T).T + t_c2w
        colors_rgb = img_rgb[y_valid, x_valid]

        all_pts.append(pts_world)
        all_cols.append(colors_rgb)

    if not all_pts:
        print("No valid points generated!")
        return

    pts_arr = np.vstack(all_pts)
    cols_arr = np.vstack(all_cols)

    out_ply = os.path.join(proj_dir, "scene_clean.ply")
    out_ply2 = os.path.join(proj_dir, "scene.ply")
    write_3dgs_ply(out_ply, pts_arr, cols_arr)
    write_3dgs_ply(out_ply2, pts_arr, cols_arr)

    out_splat = os.path.join(proj_dir, "scene.splat")
    from scripts.convert_ply_to_splat import convert_ply_to_splat
    try:
        convert_ply_to_splat(out_ply, out_splat)
        print(f"[OK] Successfully converted to {out_splat}")
    except Exception as e:
        print(f"Splat conversion warning: {e}")

if __name__ == "__main__":
    build_dense_splat_for_project(110)
