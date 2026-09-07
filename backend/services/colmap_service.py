import subprocess 
import os
import shutil

def run_colmap():
    # Setup absolute paths
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data"))
    raw_images = os.path.join(base_dir, "raw_images")
    colmap_out = os.path.join(base_dir, "colmap_output")
    db_path = os.path.join(colmap_out, "database.db")
    sparse_out = os.path.join(colmap_out, "sparse", "0")

    os.makedirs(colmap_out, exist_ok=True)
    os.makedirs(sparse_out, exist_ok=True)

    # Windows specific fix: check if colmap is available as a bat file
    # base_dir is d:\articulait\data, so we need to go one level up to articulait root
    project_root = os.path.abspath(os.path.join(base_dir, ".."))
    local_colmap = os.path.join(project_root, "colmap_bin", "COLMAP-3.9.1-windows-cuda", "COLMAP.bat")
    
    if os.path.exists(local_colmap):
        colmap_cmd = local_colmap
    elif shutil.which("COLMAP.bat"):
        colmap_cmd = "COLMAP.bat"
    elif shutil.which("colmap.bat"):
        colmap_cmd = "colmap.bat"
    else:
        colmap_cmd = "colmap"

    try:
        print("1. Extracting Features...")
        subprocess.run([
            colmap_cmd, "feature_extractor",
            "--database_path", db_path,
            "--image_path", raw_images,
            "--ImageReader.single_camera", "1"
        ], check=True, shell=True)

        print("2. Exhaustive Matcher...")
        subprocess.run([
            colmap_cmd, "exhaustive_matcher",
            "--database_path", db_path
        ], check=True, shell=True)

        print("3. Point Mapper...")
        subprocess.run([
            colmap_cmd, "mapper",
            "--database_path", db_path,
            "--image_path", raw_images,
            "--output_path", colmap_out,
            "--Mapper.init_min_tri_angle", "4.0",
            "--Mapper.init_min_num_inliers", "30",
            "--Mapper.min_model_size", "5"
        ], check=True, shell=True)

        print("Structuring COLMAP output for gsplat...")
        images_dest = os.path.join(colmap_out, "images")
        if not os.path.exists(images_dest):
            import shutil
            shutil.copytree(raw_images, images_dest)

        print("COLMAP processing complete. Starting 3D Gaussian Splatting Training...")
        from backend.routes.walkthrough import pipeline_status
        pipeline_status["step"] = 3
        pipeline_status["message"] = "Training neural radiance fields natively..."
        
        from backend.services.gaussian_service import train_gaussians
        if train_gaussians():
            print("3D Walkthrough Generation Complete!")
            return True
        else:
            print("3D Gaussian Splatting Training Failed.")
            return False

    except FileNotFoundError:
        print("CRITICAL ERROR: COLMAP is not installed or not in your PATH.")
        print("Please download COLMAP for Windows and add the folder to your System PATH variables.")
        return False
    except subprocess.CalledProcessError as e:
        print(f"COLMAP Error: {e}")
        return False