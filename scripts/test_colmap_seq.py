import os
import subprocess
import pycolmap
from backend.core import settings

colmap_cmd = settings.COLMAP_PATH
test_dir = "data/test_seq_recon"
os.makedirs(test_dir + "/sparse", exist_ok=True)

db_path = os.path.join(test_dir, "colmap.db")
img_dir = "data/project_18/images"

if os.path.exists(db_path):
    os.remove(db_path)

cmd1 = f'call "{colmap_cmd}" feature_extractor --database_path "{db_path}" --image_path "{img_dir}" --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV'
cmd2 = f'call "{colmap_cmd}" sequential_matcher --database_path "{db_path}" --SequentialMatching.overlap 10'
cmd3 = f'call "{colmap_cmd}" mapper --database_path "{db_path}" --image_path "{img_dir}" --output_path "{test_dir}/sparse" --Mapper.init_min_tri_angle 1.5 --Mapper.init_min_num_inliers 15 --Mapper.min_model_size 3'

print("Running feature_extractor...")
subprocess.run(cmd1, shell=True)
print("Running sequential_matcher...")
subprocess.run(cmd2, shell=True)
print("Running mapper...")
subprocess.run(cmd3, shell=True)

sparse_0 = os.path.join(test_dir, "sparse", "0")
if os.path.exists(sparse_0):
    recon = pycolmap.Reconstruction(sparse_0)
    print(f"\n[OK] ENHANCED REGISTRATION COUNT: {len(recon.images)} out of 50 images registered!")
else:
    print("\nReconstruction failed.")
