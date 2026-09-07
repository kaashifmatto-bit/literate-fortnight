"""
Render all 120 training views using the trained 3DGS checkpoint.
Outputs clean photorealistic JPEG frames to data/project_19/rendered_frames/
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'gsplat_source', 'examples'))

import torch
import numpy as np
from PIL import Image
import gsplat
from datasets.colmap import Parser

CKPT_PATH = "temp_bedroom_test/result/ckpts/ckpt_6999_rank0.pt"
DATA_DIR = "temp_bedroom_test"
OUT_DIR = "data/project_19/rendered_frames"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

os.makedirs(OUT_DIR, exist_ok=True)

print(f"Using device: {DEVICE}")
print("Loading checkpoint...")
ckpt = torch.load(CKPT_PATH, map_location=DEVICE, weights_only=False)
splats = ckpt['splats']

means    = splats['means'].to(DEVICE)       # [N, 3]
quats    = splats['quats'].to(DEVICE)       # [N, 4]
scales   = splats['scales'].to(DEVICE)      # [N, 3]  (log-space)
opacities = splats['opacities'].to(DEVICE)  # [N]     (pre-sigmoid logits)
sh0      = splats['sh0'].to(DEVICE)         # [N, 1, 3]
shN      = splats['shN'].to(DEVICE)         # [N, 15, 3]

print(f"Loaded {means.shape[0]:,} Gaussians")

print("Loading COLMAP cameras...")
parser = Parser(data_dir=DATA_DIR, factor=1, normalize=True, test_every=99999)

# Build camera-to-world matrices
camtoworlds = torch.from_numpy(parser.camtoworlds).float().to(DEVICE)  # [N, 4, 4]
image_names = parser.image_names

print(f"Rendering {len(image_names)} views...")

# Scene scale (from normalization)
scene_scale = parser.scene_scale

for i, img_name in enumerate(image_names):
    cam_id = parser.camera_ids[i]
    K = parser.Ks_dict[cam_id]           # [3, 3] intrinsics
    H, W = parser.imsize_dict[cam_id]    # (H, W)

    c2w = camtoworlds[i]                 # [4, 4]
    w2c = torch.linalg.inv(c2w)         # [4, 4]

    # Build viewmat (world-to-camera)
    viewmat = w2c.unsqueeze(0)           # [1, 4, 4]

    fx, fy = float(K[0, 0]), float(K[1, 1])
    cx, cy = float(K[0, 2]), float(K[1, 2])

    # Rasterize
    with torch.no_grad():
        renders, alphas, meta = gsplat.rasterization(
            means=means,
            quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
            scales=torch.exp(scales),
            opacities=torch.sigmoid(opacities),
            colors=torch.cat([sh0, shN], dim=1).reshape(means.shape[0], -1, 3),
            viewmats=viewmat,
            Ks=torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
                            dtype=torch.float32, device=DEVICE).unsqueeze(0),
            width=W,
            height=H,
            sh_degree=3,
            near_plane=0.01,
            far_plane=1e6,
            backgrounds=torch.ones(1, 3, device=DEVICE),
        )

    # renders: [1, H, W, 3]
    img = renders[0].clamp(0, 1).cpu().numpy()
    img_uint8 = (img * 255).astype(np.uint8)

    out_path = os.path.join(OUT_DIR, f"{os.path.splitext(img_name)[0]}.jpg")
    Image.fromarray(img_uint8).save(out_path, quality=95)

    if (i + 1) % 10 == 0 or i == 0:
        print(f"  [{i+1}/{len(image_names)}] Rendered {img_name} -> {out_path}")

print(f"\nDone! Rendered {len(image_names)} frames to {OUT_DIR}")
