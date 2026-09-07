import os
import struct
import numpy as np

def convert_colmap_txt_to_splat(points3d_txt: str, ply_out: str, splat_out: str):
    """Converts COLMAP points3D.txt into clean 3DGS scene.ply and scene.splat files."""
    if not os.path.exists(points3d_txt):
        print(f"[Warning] {points3d_txt} does not exist.")
        return False

    pts, rgb = [], []
    with open(points3d_txt, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 7:
                pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
                rgb.append([int(parts[4]), int(parts[5]), int(parts[6])])

    if not pts:
        print(f"[convert_colmap_txt_to_splat] No points found in {points3d_txt}.")
        return False

    pts = np.array(pts, dtype=np.float32)
    rgb = np.array(rgb, dtype=np.uint8)
    num_pts = len(pts)

    print(f"[convert_colmap_txt_to_splat] Converting {num_pts:,} unified 3D points from {points3d_txt}...")

    # Calculate smooth surface-covering scale per Gaussian from k-nearest neighbor distance
    from scipy.spatial import KDTree
    sample_sub = max(1, num_pts // 20000)
    tree = KDTree(pts[::sample_sub])
    # Calculate anisotropic per-axis (dx, dy, dz) neighbor distances to prevent vertical needle stretching
    dists, indices = tree.query(pts, k=4)
    dx = np.mean([np.abs(pts[:, 0] - pts[indices[:, i], 0]) for i in range(1, 4)], axis=0)
    dy = np.mean([np.abs(pts[:, 1] - pts[indices[:, i], 1]) for i in range(1, 4)], axis=0)
    dz = np.mean([np.abs(pts[:, 2] - pts[indices[:, i], 2]) for i in range(1, 4)], axis=0)

    # Anisotropic per-axis scale clamping (tight 4.5cm vertical ceiling on scale_y prevents needle spikes)
    scale_x = np.clip(dx * 0.75, 0.030, 0.070).astype(np.float32)
    scale_y = np.clip(dy * 0.75, 0.020, 0.045).astype(np.float32)
    scale_z = np.clip(dz * 0.75, 0.030, 0.070).astype(np.float32)

    # Generate scale log-values & opacities
    log_scale_x = np.log(scale_x)
    log_scale_y = np.log(scale_y)
    log_scale_z = np.log(scale_z)
    opacities = np.full(num_pts, 3.2, dtype=np.float32) # Opacity ~ 0.96 (Solid Surface)
    
    # Quaternions: identity (1.0, 0.0, 0.0, 0.0)
    qw = np.ones(num_pts, dtype=np.float32)
    qx = qy = qz = np.zeros(num_pts, dtype=np.float32)

    # 1. Write PLY file
    SH_C0 = 0.28209479177387814
    f_dc = ((rgb.astype(np.float32) / 255.0) - 0.5) / SH_C0

    ply_header = f"""ply
format binary_little_endian 1.0
element vertex {num_pts}
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
    
    ply_data = np.empty(num_pts, dtype=ply_dtype)
    ply_data['x'] = pts[:, 0]
    ply_data['y'] = pts[:, 1]
    ply_data['z'] = pts[:, 2]
    ply_data['f_dc_0'] = f_dc[:, 0]
    ply_data['f_dc_1'] = f_dc[:, 1]
    ply_data['f_dc_2'] = f_dc[:, 2]
    ply_data['opacity'] = opacities
    ply_data['scale_0'] = log_scale_x
    ply_data['scale_1'] = log_scale_y
    ply_data['scale_2'] = log_scale_z
    ply_data['rot_0'] = qw
    ply_data['rot_1'] = qx
    ply_data['rot_2'] = qy
    ply_data['rot_3'] = qz

    with open(ply_out, "wb") as f:
        f.write(ply_header.encode("latin-1"))
        f.write(ply_data.tobytes())

    # 2. Write SPLAT file (packed binary format)
    splat_dtype = np.dtype([
        ('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
        ('s0', '<f4'), ('s1', '<f4'), ('s2', '<f4'),
        ('r', 'u1'), ('g', 'u1'), ('b', 'u1'), ('a', 'u1'),
        ('q0', 'u1'), ('q1', 'u1'), ('q2', 'u1'), ('q3', 'u1')
    ])
    splat_data = np.empty(num_pts, dtype=splat_dtype)
    splat_data['x'] = pts[:, 0]
    splat_data['y'] = pts[:, 1]
    splat_data['z'] = pts[:, 2]
    splat_data['s0'] = scale_x
    splat_data['s1'] = scale_y
    splat_data['s2'] = scale_z
    splat_data['r'] = rgb[:, 0]
    splat_data['g'] = rgb[:, 1]
    splat_data['b'] = rgb[:, 2]
    splat_data['a'] = np.full(num_pts, 240, dtype=np.uint8)
    splat_data['q0'] = np.full(num_pts, 128, dtype=np.uint8) # qx = 0.0 -> 128
    splat_data['q1'] = np.full(num_pts, 128, dtype=np.uint8) # qy = 0.0 -> 128
    splat_data['q2'] = np.full(num_pts, 128, dtype=np.uint8) # qz = 0.0 -> 128
    splat_data['q3'] = np.full(num_pts, 255, dtype=np.uint8) # qw = 1.0 -> 255

    with open(splat_out, "wb") as f:
        f.write(splat_data.tobytes())

    print(f"[OK] Successfully saved unified scene to {ply_out} & {splat_out} ({num_pts:,} Gaussians)")
    return True

def convert_ply_to_splat(ply_path: str, splat_path: str):
    """Fast, memory-efficient 3DGS PLY to standard packed .splat converter."""
    if not os.path.exists(ply_path):
        print(f"[Warning] {ply_path} does not exist.")
        return

    with open(ply_path, "rb") as f:
        header = ""
        while True:
            line = f.readline().decode("latin-1")
            header += line
            if line.strip() == "end_header":
                break

        num_pts = 0
        props = []
        is_ascii = "format ascii" in header
        for line in header.splitlines():
            line = line.strip()
            if line.startswith("element vertex"):
                num_pts = int(line.split()[-1])
            elif line.startswith("property") and "list" not in line:
                parts = line.split()
                if len(parts) >= 3:
                    props.append((parts[1], parts[2]))

        if num_pts == 0:
            print(f"[convert_ply_to_splat] No vertices found in {ply_path}.")
            return

        print(f"[convert_ply_to_splat] Parsing {num_pts:,} Gaussians from {ply_path} (ASCII={is_ascii})...")

        offsets = {}
        if not is_ascii:
            type_sizes = {'float': 4, 'double': 8, 'uchar': 1, 'int': 4, 'uint': 4, 'float32': 4, 'float64': 8, 'uint8': 1, 'int32': 4}
            curr_offset = 0
            for ptype, pname in props:
                offsets[pname] = curr_offset
                curr_offset += type_sizes.get(ptype, 4)
            stride = curr_offset

            body_bytes = f.read(num_pts * stride)
            if len(body_bytes) < num_pts * stride:
                num_pts = len(body_bytes) // max(1, stride)
            data = np.frombuffer(body_bytes[:num_pts * stride], dtype=np.uint8).reshape(num_pts, stride)
        else:
            # ASCII parsing
            prop_names = [p[1] for p in props]
            for idx, pname in enumerate(prop_names):
                offsets[pname] = idx
            ascii_lines = []
            for _ in range(num_pts):
                l = f.readline().decode("latin-1").strip()
                if l:
                    parts = [float(val) for val in l.split()]
                    ascii_lines.append(parts)
            num_pts = len(ascii_lines)
            ascii_arr = np.array(ascii_lines, dtype=np.float32)

    def get_float(pname, default=0.0):
        if pname in offsets:
            if not is_ascii:
                off = offsets[pname]
                return data[:, off:off+4].view('<f4').reshape(-1)
            else:
                col_idx = offsets[pname]
                if col_idx < ascii_arr.shape[1]:
                    return ascii_arr[:, col_idx]
        return np.full(num_pts, default, dtype=np.float32)

    x, y, z = get_float('x'), get_float('y'), get_float('z')
    s0_raw, s1_raw, s2_raw = get_float('scale_0', -3.0), get_float('scale_1', -3.0), get_float('scale_2', -3.0)

    s0, s1, s2 = np.exp(np.clip(s0_raw, -10.0, 5.0)), np.exp(np.clip(s1_raw, -10.0, 5.0)), np.exp(np.clip(s2_raw, -10.0, 5.0))
    max_s = np.maximum(np.maximum(s0, s1), s2)
    max_s_clamped = np.minimum(0.035, max_s)
    min_allowed = np.maximum(0.002, max_s_clamped / 3.5)

    s0 = np.clip(s0, min_allowed, 0.035)
    s1 = np.clip(s1, min_allowed, 0.035)
    s2 = np.clip(s2, min_allowed, 0.035)

    op_raw = get_float('opacity', 2.0)
    op = 1.0 / (1.0 + np.exp(-np.clip(op_raw, -10.0, 10.0)))

    valid_mask = np.isfinite(x) & np.isfinite(y) & np.isfinite(z) & np.isfinite(s0) & np.isfinite(s1) & np.isfinite(s2) & np.isfinite(op) & (op >= 0.005)
    num_clean = int(np.sum(valid_mask))

    if num_clean == 0:
        print("[convert_ply_to_splat] Warning: 0 Gaussians passed strict filtering. Relaxing mask to all finite 3D coordinates.")
        valid_mask = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
        num_clean = int(np.sum(valid_mask))
        if num_clean == 0:
            print("[convert_ply_to_splat] Error: No valid 3D points found in PLY file.")
            return

    print(f"[convert_ply_to_splat] Retained {num_clean:,}/{num_pts:,} Gaussians ({num_clean/max(1,num_pts)*100:.1f}%)")

    SH_C0 = 0.28209479177387814
    if 'f_dc_0' in offsets:
        f0 = get_float('f_dc_0')[valid_mask]
        f1 = get_float('f_dc_1')[valid_mask]
        f2 = get_float('f_dc_2')[valid_mask]
        r = np.clip((0.5 + SH_C0 * f0) * 255, 0, 255).astype(np.uint8)
        g = np.clip((0.5 + SH_C0 * f1) * 255, 0, 255).astype(np.uint8)
        b = np.clip((0.5 + SH_C0 * f2) * 255, 0, 255).astype(np.uint8)
    elif 'red' in offsets:
        if not is_ascii:
            r = data[valid_mask, offsets['red']].astype(np.uint8)
            g = data[valid_mask, offsets['green']].astype(np.uint8)
            b = data[valid_mask, offsets['blue']].astype(np.uint8)
        else:
            r = np.clip(ascii_arr[valid_mask, offsets['red']], 0, 255).astype(np.uint8)
            g = np.clip(ascii_arr[valid_mask, offsets['green']], 0, 255).astype(np.uint8)
            b = np.clip(ascii_arr[valid_mask, offsets['blue']], 0, 255).astype(np.uint8)
    else:
        r = g = b = np.full(num_clean, 200, dtype=np.uint8)

    alpha = np.clip(op[valid_mask] * 255, 0, 255).astype(np.uint8)

    qw = get_float('rot_0', 1.0)[valid_mask]
    qx = get_float('rot_1', 0.0)[valid_mask]
    qy = get_float('rot_2', 0.0)[valid_mask]
    qz = get_float('rot_3', 0.0)[valid_mask]

    norm = np.sqrt(qw**2 + qx**2 + qy**2 + qz**2) + 1e-8
    qw, qx, qy, qz = qw/norm, qx/norm, qy/norm, qz/norm

    q0_u8 = np.clip((qw * 128 + 128), 0, 255).astype(np.uint8) # q0 = qw at byte 28
    q1_u8 = np.clip((qx * 128 + 128), 0, 255).astype(np.uint8) # q1 = qx at byte 29
    q2_u8 = np.clip((qy * 128 + 128), 0, 255).astype(np.uint8) # q2 = qy at byte 30
    q3_u8 = np.clip((qz * 128 + 128), 0, 255).astype(np.uint8) # q3 = qz at byte 31

    dtype = np.dtype([
        ('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
        ('s0', '<f4'), ('s1', '<f4'), ('s2', '<f4'),
        ('r', 'u1'), ('g', 'u1'), ('b', 'u1'), ('a', 'u1'),
        ('q0', 'u1'), ('q1', 'u1'), ('q2', 'u1'), ('q3', 'u1')
    ])

    data_out = np.empty(num_clean, dtype=dtype)
    data_out['x'] = x[valid_mask]
    data_out['y'] = y[valid_mask]
    data_out['z'] = z[valid_mask]
    data_out['s0'] = s0[valid_mask]
    data_out['s1'] = s1[valid_mask]
    data_out['s2'] = s2[valid_mask]
    data_out['r'] = r
    data_out['g'] = g
    data_out['b'] = b
    data_out['a'] = alpha
    data_out['q0'] = q0_u8
    data_out['q1'] = q1_u8
    data_out['q2'] = q2_u8
    data_out['q3'] = q3_u8

    with open(splat_path, "wb") as f:
        f.write(data_out.tobytes())

    print(f"[OK] Saved fast compact .splat to {splat_path} ({os.path.getsize(splat_path):,} bytes, {num_clean:,} Gaussians)")

def clean_3dgs_post_training(
    ply_path: str,
    output_ply_path: str = None,
    opacity_threshold: float = 0.01,
    sor_k: int = 20,
    sor_std_ratio: float = 2.5
) -> dict:
    """
    Post-training cleanup pass for 3DGS reconstructions:
    (1) Opacity Thresholding: Filter out Gaussians with opacity < opacity_threshold.
    (2) Statistical Outlier Removal (SOR): Strip floating artifacts ("floaters") whose k-NN mean
        distance exceeds global mean + sor_std_ratio * std_dev.
    """
    if not os.path.exists(ply_path):
        print(f"[Warning] {ply_path} does not exist for cleanup.")
        return {"retained": 0, "removed": 0}

    if output_ply_path is None:
        output_ply_path = ply_path

    print(f"\n---> Starting Post-Training Cleanup Pass on {ply_path}...")
    print(f"  - Opacity Threshold: {opacity_threshold}")
    print(f"  - SOR k-neighbors: {sor_k}, std_ratio: {sor_std_ratio}")

    with open(ply_path, "rb") as f:
        header = ""
        while True:
            line = f.readline().decode("latin-1")
            header += line
            if line.strip() == "end_header":
                break

        num_pts = 0
        props = []
        for line in header.splitlines():
            line = line.strip()
            if line.startswith("element vertex"):
                num_pts = int(line.split()[-1])
            elif line.startswith("property"):
                parts = line.split()
                props.append((parts[1], parts[2]))

        if num_pts == 0:
            print(f"[clean_3dgs_post_training] No vertices in {ply_path}.")
            return {"retained": 0, "removed": 0}

        type_sizes = {'float': 4, 'double': 8, 'uchar': 1, 'int': 4, 'uint': 4}
        offsets = {}
        curr_offset = 0
        for ptype, pname in props:
            offsets[pname] = curr_offset
            curr_offset += type_sizes.get(ptype, 4)
        stride = curr_offset

        body_bytes = f.read(num_pts * stride)
        data = np.frombuffer(body_bytes, dtype=np.uint8).reshape(num_pts, stride)

    def get_float(pname, default=0.0):
        if pname in offsets:
            off = offsets[pname]
            return data[:, off:off+4].view('<f4').reshape(-1)
        return np.full(num_pts, default, dtype=np.float32)

    x, y, z = get_float('x'), get_float('y'), get_float('z')
    op_raw = get_float('opacity', 2.0)
    op = 1.0 / (1.0 + np.exp(-op_raw)) if (op_raw > 15.0).sum() < num_pts / 2 else op_raw

    # 1. Opacity Filtering
    op_mask = (op >= opacity_threshold) & np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
    print(f"  - Opacity filter: retained {op_mask.sum():,}/{num_pts:,} Gaussians")

    # 2. Statistical Outlier Removal (SOR) on points passing opacity filter
    candidate_indices = np.where(op_mask)[0]
    pts = np.vstack([x[candidate_indices], y[candidate_indices], z[candidate_indices]]).T

    if len(pts) > sor_k:
        from scipy.spatial import KDTree
        tree = KDTree(pts)
        dists, _ = tree.query(pts, k=min(sor_k + 1, len(pts)))
        knn_mean_dists = dists[:, 1:].mean(axis=1) if dists.ndim > 1 and dists.shape[1] > 1 else dists.ravel()

        mu = float(np.mean(knn_mean_dists))
        sigma = float(np.std(knn_mean_dists))
        sor_thresh = mu + sor_std_ratio * sigma

        sor_inliers_mask = knn_mean_dists <= sor_thresh
        final_valid_indices = candidate_indices[sor_inliers_mask]
        num_sor_removed = len(candidate_indices) - len(final_valid_indices)
        print(f"  - SOR floater filter: pruned {num_sor_removed:,} floaters (dist threshold={sor_thresh:.4f}m, mean={mu:.4f}m, std={sigma:.4f}m)")
    else:
        final_valid_indices = candidate_indices

    clean_mask = np.zeros(num_pts, dtype=bool)
    clean_mask[final_valid_indices] = True
    num_retained = len(final_valid_indices)
    num_removed = num_pts - num_retained

    # Re-write PLY with retained vertices
    clean_data = data[clean_mask]

    header_lines = []
    for line in header.splitlines():
        if line.startswith("element vertex"):
            header_lines.append(f"element vertex {num_retained}")
        else:
            header_lines.append(line)
    new_header = "\n".join(header_lines) + "\n"

    with open(output_ply_path, "wb") as f:
        f.write(new_header.encode("latin-1"))
        f.write(clean_data.tobytes())

    print(f"[OK] Cleanup Complete: Retained {num_retained:,} Gaussians, Stripped {num_removed:,} floaters/low-opacity Gaussians. Saved to {output_ply_path}")
    return {"retained": num_retained, "removed": num_removed}

if __name__ == "__main__":
    convert_colmap_txt_to_splat("data/project_22/sparse/0/points3D.txt", "data/project_22/scene.ply", "data/project_22/scene.splat")

