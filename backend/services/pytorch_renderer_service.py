"""
ArticulAIT — Pure PyTorch 3D Gaussian Splatting (3DGS) Offline Renderer
Provides standalone, hardware-independent GPU/CPU novel view rendering and frame generation.
Uses OpenCV (cv2) for high-performance image encoding, disk saving, and video frame export.
"""

import os
import time
import torch
import numpy as np
import cv2
import logging
from typing import Dict, Any, Tuple, Optional, List

logger = logging.getLogger("articulait.pytorch_renderer_service")

# ── Spherical Harmonics Constants (Degree 0 to 3) ──
SH_C0 = 0.28209479177387814
SH_C1_x = 0.4886025119029199
SH_C1_y = 0.4886025119029199
SH_C1_z = 0.4886025119029199
SH_C2_xy = 1.0925484305920792
SH_C2_xz = 1.0925484305920792
SH_C2_yz = 1.0925484305920792
SH_C2_zz = 0.31539156525252005
SH_C2_xx_yy = 0.5462742152960396
SH_C3_yxx_yyy = 0.5900435899266435
SH_C3_xyz = 2.890611442640554
SH_C3_yzz_yxx_yyy = 0.4570457994644658
SH_C3_zzz_zxx_zyy = 0.3731763325901154
SH_C3_xzz_xxx_xyy = 0.4570457994644658
SH_C3_zxx_zyy = 1.445305721320277
SH_C3_xxx_xyy = 0.5900435899266435


def evaluate_sh(f_dc: torch.Tensor, f_rest: torch.Tensor, points: torch.Tensor, c2w: torch.Tensor) -> torch.Tensor:
    """
    Evaluates degree-3 spherical harmonics to derive direction-dependent RGB colors for 3D Gaussians.
    Defensively handles various tensor shapes (e.g. [N, 3], [N, 1, 3], [N, 45], [N, 15, 3]).
    """
    if f_dc.ndim == 3:
        f_dc = f_dc.squeeze(1)

    sh = torch.empty((points.shape[0], 16, 3), device=points.device, dtype=points.dtype)
    sh[:, 0] = f_dc

    if f_rest is not None and f_rest.numel() > 0:
        if f_rest.ndim == 3 and f_rest.shape[1] == 15 and f_rest.shape[2] == 3:
            sh[:, 1:] = f_rest
        elif f_rest.ndim == 2 and f_rest.shape[1] == 45:
            sh[:, 1:, 0] = f_rest[:, :15]   # R
            sh[:, 1:, 1] = f_rest[:, 15:30] # G
            sh[:, 1:, 2] = f_rest[:, 30:45] # B
        else:
            # Fallback for unexpected shapes
            flat_rest = f_rest.reshape(points.shape[0], -1)
            num_coeffs = min(flat_rest.shape[1] // 3, 15)
            sh[:, 1:num_coeffs + 1, 0] = flat_rest[:, :num_coeffs]
            sh[:, 1:num_coeffs + 1, 1] = flat_rest[:, num_coeffs:2 * num_coeffs]
            sh[:, 1:num_coeffs + 1, 2] = flat_rest[:, 2 * num_coeffs:3 * num_coeffs]
            if num_coeffs < 15:
                sh[:, num_coeffs + 1:] = 0.0
    else:
        sh[:, 1:] = 0.0

    c2w = c2w.to(device=points.device, dtype=points.dtype)
    view_dir = points - c2w[:3, 3].unsqueeze(0)  # [N, 3]
    view_dir = view_dir / (view_dir.norm(dim=-1, keepdim=True) + 1e-8)
    x, y, z = view_dir[:, 0], view_dir[:, 1], view_dir[:, 2]

    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z

    Y0 = torch.full_like(x, SH_C0)
    Y1 = - SH_C1_y * y
    Y2 = SH_C1_z * z
    Y3 = - SH_C1_x * x
    Y4 = SH_C2_xy * xy
    Y5 = SH_C2_yz * yz
    Y6 = SH_C2_zz * (3 * zz - 1)
    Y7 = SH_C2_xz * xz
    Y8 = SH_C2_xx_yy * (xx - yy)
    Y9 = SH_C3_yxx_yyy * y * (3 * xx - yy)
    Y10 = SH_C3_xyz * x * y * z
    Y11 = SH_C3_yzz_yxx_yyy * y * (4 * zz - xx - yy)
    Y12 = SH_C3_zzz_zxx_zyy * z * (2 * zz - 3 * xx - 3 * yy)
    Y13 = SH_C3_xzz_xxx_xyy * x * (4 * zz - xx - yy)
    Y14 = SH_C3_zxx_zyy * z * (xx - yy)
    Y15 = SH_C3_xxx_xyy * x * (xx - 3 * yy)
    Y = torch.stack([Y0, Y1, Y2, Y3, Y4, Y5, Y6, Y7, Y8, Y9, Y10, Y11, Y12, Y13, Y14, Y15], dim=1)  # [N, 16]
    return torch.sigmoid((sh * Y.unsqueeze(2)).sum(dim=1))


def project_points(pc: torch.Tensor, c2w: torch.Tensor, fx: float, fy: float, cx: float, cy: float) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """Projects 3D point cloud into 2D camera pixel coordinates using camera parameters."""
    c2w = c2w.to(device=pc.device, dtype=pc.dtype)
    w2c = torch.eye(4, device=pc.device, dtype=pc.dtype)
    R = c2w[:3, :3]
    t = c2w[:3, 3]
    w2c[:3, :3] = R.t()
    w2c[:3, 3] = -R.t() @ t

    ones = torch.ones_like(pc[:, :1])
    pc_hom = torch.cat([pc, ones], dim=1)
    PC = (w2c @ pc_hom.t()).t()[:, :3]
    x, y, z = PC[:, 0], PC[:, 1], PC[:, 2]

    uv = torch.stack([fx * x / z + cx, fy * y / z + cy], dim=-1)
    return uv, x, y, z


def inv2x2(M: torch.Tensor, eps: float = 1e-12) -> torch.Tensor:
    """Inverts batches of 2x2 covariance matrices safely."""
    a, b = M[:, 0, 0], M[:, 0, 1]
    c, d = M[:, 1, 0], M[:, 1, 1]
    det = a * d - b * c
    safe_det = torch.clamp(det, min=eps)
    inv = torch.empty_like(M)
    inv[:, 0, 0] = d / safe_det
    inv[:, 0, 1] = -b / safe_det
    inv[:, 1, 0] = -c / safe_det
    inv[:, 1, 1] = a / safe_det
    return inv


def quat_to_rotmat(quat: torch.Tensor) -> torch.Tensor:
    """Converts raw quaternions [x, y, z, w] into 3x3 rotation matrices."""
    x, y, z, w = quat.unbind(dim=-1)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    xw, yw, zw = x * w, y * w, z * w

    R = torch.stack([
        1 - 2 * (yy + zz), 2 * (xy - zw), 2 * (xz + yw),
        2 * (xy + zw), 1 - 2 * (xx + zz), 2 * (yz - xw),
        2 * (xz - yw), 2 * (yz + xw), 1 - 2 * (xx + yy)
    ], dim=-1).reshape(quat.shape[:-1] + (3, 3))
    return R


def build_sigma_from_params(scale_raw: torch.Tensor, q_raw: torch.Tensor) -> torch.Tensor:
    """Constructs 3D Gaussian spatial covariance matrix Sigma = R S S^T R^T."""
    scale = torch.exp(scale_raw).clamp_min(1e-6)
    if scale.ndim == 1:
        scale = scale.unsqueeze(-1).expand(-1, 3)
    elif scale.ndim == 2 and scale.shape[1] == 1:
        scale = scale.expand(-1, 3)
    q = q_raw / (q_raw.norm(dim=-1, keepdim=True) + 1e-9)
    R = quat_to_rotmat(q)
    S = torch.diag_embed(scale)
    return R @ S @ S @ R.transpose(1, 2)


def scale_intrinsics(H: int, W: int, H_src: int, W_src: int, fx: float, fy: float, cx: float, cy: float) -> Tuple[float, float, float, float]:
    """Scales intrinsic parameters to match output image resolution."""
    scale_x = W / W_src
    scale_y = H / H_src
    return fx * scale_x, fy * scale_y, cx * scale_x, cy * scale_y


@torch.no_grad()
def render_pytorch_3dgs(
    pos: torch.Tensor,
    color: torch.Tensor,
    opacity_raw: torch.Tensor,
    sigma: torch.Tensor,
    c2w: torch.Tensor,
    H: int,
    W: int,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    near: float = 2e-3,
    far: float = 100.0,
    pix_guard: float = 64.0,
    T: int = 16,
    min_conis: float = 1e-6,
    chi_square_clip: float = 9.21,
    alpha_max: float = 0.99,
    alpha_cutoff: float = 1 / 255.0
) -> torch.Tensor:
    """
    Pure PyTorch Tile-based Differentiable 3DGS Rasterizer.
    Returns RGB image tensor of shape (H, W, 3) in float range [0.0, 1.0].
    """
    uv, x, y, z = project_points(pos, c2w, fx, fy, cx, cy)
    in_guard = (uv[:, 0] > -pix_guard) & (uv[:, 0] < W + pix_guard) & (
        uv[:, 1] > -pix_guard) & (uv[:, 1] < H + pix_guard) & (z > near) & (z < far)

    if not in_guard.any():
        return torch.zeros((H, W, 3), device=pos.device, dtype=pos.dtype)

    uv = uv[in_guard]
    pos = pos[in_guard]
    color = color[in_guard]
    opacity = torch.sigmoid(opacity_raw[in_guard]).clamp(0, 0.999)
    z, x, y = z[in_guard], x[in_guard], y[in_guard]
    sigma = sigma[in_guard]
    idx = torch.nonzero(in_guard, as_tuple=False).squeeze(1)

    # Project covariance to 2D image space (Jacobian J)
    Rcw = c2w[:3, :3]
    Rwc = Rcw.t()
    invz = 1 / z.clamp_min(1e-6)
    invz2 = invz * invz
    J = torch.zeros((pos.shape[0], 2, 3), device=pos.device, dtype=pos.dtype)
    J[:, 0, 0] = fx * invz
    J[:, 1, 1] = fy * invz
    J[:, 0, 2] = -fx * x * invz2
    J[:, 1, 2] = -fy * y * invz2
    tmp = Rwc.unsqueeze(0) @ sigma @ Rwc.t().unsqueeze(0)
    sigma_camera = J @ tmp @ J.transpose(1, 2)
    sigma_camera = 0.5 * (sigma_camera + sigma_camera.transpose(1, 2))
    
    # Enforce positive definiteness
    evals, evecs = torch.linalg.eigh(sigma_camera)
    evals = torch.clamp(evals, min=1e-6, max=1e4)
    sigma_camera = evecs @ torch.diag_embed(evals) @ evecs.transpose(1, 2)

    keep = torch.isfinite(sigma_camera.reshape(sigma.shape[0], -1)).all(dim=-1)
    if not keep.any():
        return torch.zeros((H, W, 3), device=pos.device, dtype=pos.dtype)

    uv = uv[keep]
    color = color[keep]
    opacity = opacity[keep]
    z = z[keep]
    sigma_camera = sigma_camera[keep]
    evals = evals[keep]
    idx = idx[keep]

    # Global depth sorting (front to back)
    order = torch.argsort(z, descending=False)
    uv = uv[order]
    u, v = uv[:, 0], uv[:, 1]
    color = color[order]
    opacity = opacity[order]
    sigma_camera = sigma_camera[order]
    evals = evals[order]

    # Tile bounding boxes
    major_variance = evals[:, 1].clamp_min(1e-12).clamp_max(1e4)
    radius = torch.ceil(3.0 * torch.sqrt(major_variance)).to(torch.int64)
    umin = torch.floor(u - radius).to(torch.int64)
    umax = torch.floor(u + radius).to(torch.int64)
    vmin = torch.floor(v - radius).to(torch.int64)
    vmax = torch.floor(v + radius).to(torch.int64)

    on_screen = (umax >= 0) & (umin < W) & (vmax >= 0) & (vmin < H)
    if not on_screen.any():
        return torch.zeros((H, W, 3), device=pos.device, dtype=pos.dtype)

    u, v = u[on_screen], v[on_screen]
    color = color[on_screen]
    opacity = opacity[on_screen]
    sigma_camera = sigma_camera[on_screen]
    umin, umax = umin[on_screen], umax[on_screen]
    vmin, vmax = vmin[on_screen], vmax[on_screen]
    umin = umin.clamp(0, W - 1)
    umax = umax.clamp(0, W - 1)
    vmin = vmin.clamp(0, H - 1)
    vmax = vmax.clamp(0, H - 1)

    umin_tile = (umin // T).to(torch.int64)
    umax_tile = (umax // T).to(torch.int64)
    vmin_tile = (vmin // T).to(torch.int64)
    vmax_tile = (vmax // T).to(torch.int64)

    n_u = umax_tile - umin_tile + 1
    n_v = vmax_tile - vmin_tile + 1
    max_u = int(n_u.max().item())
    max_v = int(n_v.max().item())

    nb_gaussians = umin_tile.shape[0]
    span_u = torch.arange(max_u, device=pos.device, dtype=torch.int64)
    span_v = torch.arange(max_v, device=pos.device, dtype=torch.int64)
    tile_u = (umin_tile[:, None, None] + span_u[None, :, None]).expand(nb_gaussians, max_u, max_v)
    tile_v = (vmin_tile[:, None, None] + span_v[None, None, :]).expand(nb_gaussians, max_u, max_v)
    mask = (span_u[None, :, None] < n_u[:, None, None]) & (span_v[None, None, :] < n_v[:, None, None])

    flat_tile_u = tile_u[mask]
    flat_tile_v = tile_v[mask]

    nb_tiles_per_gaussian = n_u * n_v
    gaussian_ids = torch.repeat_interleave(
        torch.arange(nb_gaussians, device=pos.device, dtype=torch.int64),
        nb_tiles_per_gaussian
    )
    nb_tiles_u = (W + T - 1) // T
    flat_tile_id = flat_tile_v * nb_tiles_u + flat_tile_u

    idx_z_order = torch.arange(nb_gaussians, device=pos.device, dtype=torch.int64)
    M = nb_gaussians + 1
    comp = flat_tile_id * M + idx_z_order[gaussian_ids]
    comp_sorted, perm = torch.sort(comp)
    gaussian_ids = gaussian_ids[perm]
    tile_ids_1d = torch.div(comp_sorted, M, rounding_mode='floor')

    unique_tile_ids, nb_gaussian_per_tile = torch.unique_consecutive(tile_ids_1d, return_counts=True)
    start = torch.zeros_like(unique_tile_ids)
    start[1:] = torch.cumsum(nb_gaussian_per_tile[:-1], dim=0)
    end = start + nb_gaussian_per_tile

    inverse_covariance = inv2x2(sigma_camera)
    inverse_covariance[:, 0, 0] = torch.clamp(inverse_covariance[:, 0, 0], min=min_conis)
    inverse_covariance[:, 1, 1] = torch.clamp(inverse_covariance[:, 1, 1], min=min_conis)

    final_image = torch.zeros((H * W, 3), device=pos.device, dtype=pos.dtype)

    for tile_id, s0, s1 in zip(unique_tile_ids.tolist(), start.tolist(), end.tolist()):
        current_gaussian_ids = gaussian_ids[s0:s1]

        txi = tile_id % nb_tiles_u
        tyi = tile_id // nb_tiles_u
        x0, y0 = txi * T, tyi * T
        x1, y1 = min((txi + 1) * T, W), min((tyi + 1) * T, H)
        if x0 >= x1 or y0 >= y1:
            continue

        xs = torch.arange(x0, x1, device=pos.device, dtype=pos.dtype)
        ys = torch.arange(y0, y1, device=pos.device, dtype=pos.dtype)
        pu, pv = torch.meshgrid(xs, ys, indexing='xy')
        px_u = pu.reshape(-1)
        px_v = pv.reshape(-1)
        pixel_idx_1d = (px_v * W + px_u).to(torch.int64)

        gaussian_i_u = u[current_gaussian_ids]
        gaussian_i_v = v[current_gaussian_ids]
        gaussian_i_color = color[current_gaussian_ids]
        gaussian_i_opacity = opacity[current_gaussian_ids]
        gaussian_i_inv_cov = inverse_covariance[current_gaussian_ids]

        du = px_u.unsqueeze(0) - gaussian_i_u.unsqueeze(-1)
        dv = px_v.unsqueeze(0) - gaussian_i_v.unsqueeze(-1)
        A11 = gaussian_i_inv_cov[:, 0, 0].unsqueeze(-1)
        A12 = gaussian_i_inv_cov[:, 0, 1].unsqueeze(-1)
        A22 = gaussian_i_inv_cov[:, 1, 1].unsqueeze(-1)
        q = A11 * du * du + 2 * A12 * du * dv + A22 * dv * dv

        inside = q <= chi_square_clip
        g = torch.exp(-0.5 * torch.clamp(q, max=chi_square_clip))
        g = torch.where(inside, g, torch.zeros_like(g))
        alpha_i = (gaussian_i_opacity.unsqueeze(-1) * g).clamp_max(alpha_max)
        alpha_i = torch.where(alpha_i >= alpha_cutoff, alpha_i, torch.zeros_like(alpha_i))
        one_minus_alpha = 1 - alpha_i

        T_i = torch.cumprod(one_minus_alpha, dim=0)
        T_i = torch.cat([
            torch.ones((1, alpha_i.shape[-1]), device=pos.device, dtype=pos.dtype),
            T_i[:-1]
        ], dim=0)
        alive = (T_i > 1e-4).float()
        w = alpha_i * T_i * alive

        final_image[pixel_idx_1d] = (w.unsqueeze(-1) * gaussian_i_color.unsqueeze(1)).sum(dim=0)

    return final_image.reshape((H, W, 3)).clamp(0, 1)


# ── OpenCV Utility Helper Functions ──

def save_image_opencv(img_tensor_rgb: torch.Tensor, output_path: str) -> bool:
    """
    Converts PyTorch float RGB tensor [H, W, 3] in [0, 1] to BGR numpy array and saves to disk using OpenCV.
    """
    try:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        img_np = img_tensor_rgb.cpu().detach().numpy()
        img_bgr = cv2.cvtColor((img_np * 255.0).astype(np.uint8), cv2.COLOR_RGB2BGR)
        success = cv2.imwrite(output_path, img_bgr)
        return success
    except Exception as e:
        logger.error(f"OpenCV image save failed for {output_path}: {e}")
        return False


def encode_image_opencv(img_tensor_rgb: torch.Tensor, ext: str = ".jpg", quality: int = 90) -> bytes:
    """
    Encodes PyTorch float RGB tensor directly into in-memory image bytes (e.g. for API response) using OpenCV.
    """
    img_np = img_tensor_rgb.cpu().detach().numpy()
    img_bgr = cv2.cvtColor((img_np * 255.0).astype(np.uint8), cv2.COLOR_RGB2BGR)
    params = []
    if ext.lower() in ('.jpg', '.jpeg'):
        params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    elif ext.lower() == '.png':
        params = [int(cv2.IMWRITE_PNG_COMPRESSION), 4]
    
    _, buf = cv2.imencode(ext, img_bgr, params)
    return buf.tobytes()


def render_orbit_frames_opencv(
    pos: torch.Tensor,
    opacity_raw: torch.Tensor,
    f_dc: torch.Tensor,
    f_rest: torch.Tensor,
    scale_raw: torch.Tensor,
    q_raw: torch.Tensor,
    c2w_matrices: List[torch.Tensor],
    H: int,
    W: int,
    fx: float,
    fy: float,
    output_dir: str,
    prefix: str = "frame"
) -> List[str]:
    """
    Renders a sequence of novel views using the PyTorch renderer and saves them via OpenCV.
    Returns list of saved file paths.
    """
    os.makedirs(output_dir, exist_ok=True)
    sigma = build_sigma_from_params(scale_raw, q_raw)
    cx, cy = W / 2.0, H / 2.0
    saved_paths = []

    for i, c2w in enumerate(c2w_matrices):
        color = evaluate_sh(f_dc, f_rest, pos, c2w)
        img_rgb = render_pytorch_3dgs(pos, color, opacity_raw, sigma, c2w, H, W, fx, fy, cx, cy)
        out_path = os.path.join(output_dir, f"{prefix}_{i:04d}.png")
        if save_image_opencv(img_rgb, out_path):
            saved_paths.append(out_path)

    logger.info(f"OpenCV rendered {len(saved_paths)} frames to {output_dir}")
    return saved_paths
