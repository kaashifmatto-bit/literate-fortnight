# ArticulAIT — Model Download & Installation Guide

This directory (`d:\articulait\models\`) contains instructions, direct download links, and copy-paste CLI commands to download or update all 3D reconstruction and AI model dependencies.

---

## 1. 📷 COLMAP 3.9.1 CUDA (Structure-from-Motion Engine)
* **Official Download URL**:  
  [https://github.com/colmap/colmap/releases/download/3.9.1/COLMAP-3.9.1-windows-cuda.zip](https://github.com/colmap/colmap/releases/download/3.9.1/COLMAP-3.9.1-windows-cuda.zip)
* **Installation Path**:  
  Extract the ZIP archive into `d:\articulait\colmap_bin\COLMAP-3.9.1-windows-cuda\`
* **PowerShell Download Command**:
  ```powershell
  Invoke-WebRequest -Uri "https://github.com/colmap/colmap/releases/download/3.9.1/COLMAP-3.9.1-windows-cuda.zip" -OutFile "d:\articulait\colmap.zip"
  Expand-Archive -Path "d:\articulait\colmap.zip" -DestinationPath "d:\articulait\colmap_bin"
  Remove-Item "d:\articulait\colmap.zip"
  ```

---

## 2. 🎯 YOLOv8 Object Detection Weights (`yolov8n.pt`)
* **Official Direct Download URL**:  
  [https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.pt](https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.pt)
* **Target Path**: `d:\articulait\yolov8n.pt`
* **Python Automatic Download Command**:
  ```powershell
  python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
  ```

---

## 3. 🌊 Depth Anything V2 (Dense Depth Map Generator)
* **Hugging Face Model Page**:  
  [https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
* **HuggingFace CLI Download Command**:
  ```powershell
  huggingface-cli download depth-anything/Depth-Anything-V2-Small-hf
  ```
* **Python Auto-Preload Command**:
  ```powershell
  python -c "from transformers import pipeline; pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Small-hf')"
  ```
* **Default System Cache Path**:  
  `C:\Users\ADMIN\.cache\huggingface\hub\models--depth-anything--Depth-Anything-V2-Small-hf\`

---

## 4. 🧠 VGGT-1B Model Weights (Visual Geometry Transformer)
* **Hugging Face Model Page**:  
  [https://huggingface.co/facebook/vggt-1B](https://huggingface.co/facebook/vggt-1B)
* **Download directly to local `models/vggt1b` folder**:
  ```powershell
  huggingface-cli download facebook/vggt-1B --local-dir d:\articulait\models\vggt1b
  ```
* **Local Offline Directory**:  
  `d:\articulait\models\vggt1b\`

---

## 5. 📦 Generated Project Scene Outputs & Checkpoints
* **Path**: `d:\articulait\data\project_<ID>\`
  - `.splat` — Gaussian Splatting binary model
  - `.ply` — Cleaned Point Cloud / Mesh asset
  - `.lcc` — ArticulAIT LCC1 compressed container
  - `checkpoints/` — PyTorch training checkpoint state (`pos.pt`, `opacity_raw.pt`, `scale_raw.pt`, `q_rot.pt`)
