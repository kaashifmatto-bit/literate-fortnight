import os
import sys
import glob
import math
import numpy as np

def main():
    print("================================================================================")
    print("                  ARTICULAIT POSE ESTIMATION INSPECTOR                          ")
    print("================================================================================\n")
    
    data_dir = r"d:\articulait\data"
    proj_dirs = sorted(glob.glob(os.path.join(data_dir, "project_*")))
    
    if not proj_dirs:
        print("No project directories found in d:\\articulait\\data")
        return

    for proj_dir in proj_dirs:
        proj_name = os.path.basename(proj_dir)
        sparse_images = os.path.join(proj_dir, "sparse", "0", "images.txt")
        
        print(f"--------------------------------------------------------------------------------")
        print(f"Project Directory: {proj_name}")
        
        if os.path.exists(sparse_images):
            print(f"Sparse File      : {sparse_images}\n")
            print(f"{'Camera Name':<20} | {'Translation (tx, ty, tz)':<26} | {'World Center C(x,y,z)':<26} | {'Quat (qw,qx,qy,qz)':<25}")
            print("-" * 105)
            
            with open(sparse_images, "r") as f:
                lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
                
            i = 0
            while i < len(lines):
                parts = lines[i].split()
                if len(parts) >= 10:
                    qw, qx, qy, qz = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
                    tx, ty, tz = float(parts[5]), float(parts[6]), float(parts[7])
                    name = parts[9]
                    
                    # Compute world camera center C = -R^T * t
                    R = np.array([
                        [1-2*(qy**2+qz**2), 2*(qx*qy-qw*qz),   2*(qx*qz+qw*qy)],
                        [2*(qx*qy+qw*qz),   1-2*(qx**2+qz**2), 2*(qy*qz-qw*qx)],
                        [2*(qx*qz-qw*qy),   2*(qy*qz+qw*qx),   1-2*(qx**2+qy**2)],
                    ])
                    t = np.array([tx, ty, tz])
                    C = -R.T @ t
                    
                    print(f"{name:<20} | ({tx:6.3f}, {ty:6.3f}, {tz:6.3f}) | ({C[0]:6.3f}, {C[1]:6.3f}, {C[2]:6.3f}) | ({qw:.3f},{qx:.3f},{qy:.3f},{qz:.3f})")
                    i += 2
                else:
                    i += 1
        else:
            print(f"Sparse images.txt NOT found at {sparse_images}")
        print("\n")

if __name__ == "__main__":
    main()
