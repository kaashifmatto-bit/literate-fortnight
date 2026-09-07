import os
import torch
import numpy as np
from gsplat.exporter import export_splats

def export_ckpt(ckpt_path, ply_out, splat_out):
    print(f"Loading checkpoint {ckpt_path}...")
    ckpt = torch.load(ckpt_path, map_location="cpu")
    splats = ckpt["splats"]
    
    means = splats["means"]
    scales = splats["scales"]
    quats = torch.nn.functional.normalize(splats["quats"], dim=-1)
    opacities = splats["opacities"]
    sh0 = splats["sh0"]
    shN = splats["shN"] if "shN" in splats else torch.empty([sh0.shape[0], 0, 3])
    
    print(f"Exporting {len(means)} Gaussians to {ply_out}...")
    export_splats(
        means=means,
        scales=scales,
        quats=quats,
        opacities=opacities,
        sh0=sh0,
        shN=shN,
        format="ply",
        save_to=ply_out
    )
    print(f"[OK] Saved {ply_out}")
    
    from scripts.convert_ply_to_splat import convert_ply_to_splat
    convert_ply_to_splat(ply_out, splat_out)
    print(f"[OK] Saved {splat_out}")

if __name__ == "__main__":
    ckpt_18 = "data/project_18/ckpts/ckpt_6999_rank0.pt"
    if os.path.exists(ckpt_18):
        export_ckpt(ckpt_18, "data/project_18/scene.ply", "data/project_18/scene.splat")
        
        # Also copy to Project 14
        import shutil
        os.makedirs("data/project_14", exist_ok=True)
        shutil.copy2("data/project_18/scene.ply", "data/project_14/scene.ply")
        shutil.copy2("data/project_18/scene.splat", "data/project_14/scene.splat")
        print("[OK] Synced high-res 7000-step 3D twin to Project 14 & 18!")
