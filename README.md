# ArticulAIT: Photorealistic 3D Walkthrough & Reconstruction Engine

Welcome to **ArticulAIT**, an end-to-end, high-performance 3D Spatial Reconstruction & Interactive Walkthrough Engine. ArticulAIT transforms standard 2D photos or video captures of physical real-world spaces (apartments, offices, residential homes, construction sites) into authentic, 60 FPS interactive 3D digital twins and continuous walkthrough experiences.

---

## 🚀 Core Philosophy: Zero AI Hallucinations

A foundational requirement of ArticulAIT is **100% deterministic physical accuracy**:
- **Purely Grounded Reconstructions:** Unlike generative AI image/video models that generate hallucinated structures, missing furniture, or fake textures, ArticulAIT operates exclusively on the exact physical measurements and pixel data captured in uploaded photos/videos.
- **True Digital Twins:** If a corner or room section is unphotographed, it is never falsely invented. This guarantees physical fidelity essential for real estate verification, architectural reviews, virtual tours, and construction inspections.

---

## 🏗️ End-to-End Technical Workflow & Architecture

ArticulAIT features a modern microservices architecture with a **FastAPI** Python backend engine and a **Next.js 15 (React 19)** frontend client.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      ArticulAIT Pipeline Architecture                   │
└─────────────────────────────────────────────────────────────────────────┘
  [ 2D Photo / Video Upload ]
              │
              ▼
  ┌──────────────────────────────────────────────────┐
  │  Stage 1: Pose Estimation (VGGT-1B + COLMAP)     │
  │  - VGGT-1B Commercial Pose Estimator             │
  │  - Confidence Gating Threshold Check             │
  │  - Fallback to Classical PyCOLMAP SfM            │
  └──────────────────────────┬───────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────┐
  │  Stage 2: Dense Geometry & Depth Estimation      │
  │  - Depth Anything V2 Monocular Depth             │
  │  - Point Cloud Fusing & Backprojection          │
  └──────────────────────────┬───────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────┐
  │  Stage 3: 3D Gaussian Splatting & Optimization   │
  │  - Local CUDA 3DGS Engine (gsplat)               │
  │  - Statistical Outlier Pruning & Mip-Anti-Alias  │
  └──────────────────────────┬───────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────┐
  │  Stage 4: Dual 60FPS Interactive Web Clients     │
  │  - Continuous 60FPS Spatial Photo Walkthrough    │
  │  - Interactive 3D Gaussian Splatting WebGL View  │
  └──────────────────────────────────────────────────┘
```

---

### 📍 Stage 1: AI Pose Estimation & Confidence-Gated Router (`VGGT-1B` + `COLMAP`)
ArticulAIT utilizes a hybrid, confidence-gated pose router (`backend/reconstruction/pose_router.py`) with an explicit **0.60 Confidence Score Threshold** (`POSE_ESTIMATOR_CONFIDENCE_THRESHOLD = 0.60`):

1. **VGGT-1B Deep Pose Estimation:** Initial camera extrinsics & intrinsics prediction is evaluated using **VGGT-1B-Commercial** (`facebook/VGGT-1B-Commercial`).
2. **Confidence-Gated Decision Gate (`Threshold = 0.60`):**
   - 🟢 **Confidence Score $\ge$ 0.60:** High-confidence AI pose estimation. System selects **VGGT-1B** and bypasses COLMAP for maximum pipeline speed.
   - 🟡 **Confidence Score < 0.60 (or model unavailable/unauthenticated):** Triggers an automatic fallback to **PyCOLMAP** (classical Structure-from-Motion photogrammetry feature matching and bundle adjustment).
   - 🔴 **Insufficient Overlap (< 70%):** If COLMAP SfM fails due to wide baselines or low frame overlap, the pipeline automatically generates a **Fallback Dolly Trajectory** (forward-moving synthetic path) to guarantee zero pose failure and ensure the walkthrough always generates successfully.

---

### 📐 Stage 2: Monocular Depth & Point Cloud Backprojection
1. **Monocular Depth Estimation:** Each frame is processed through **Depth Anything V2** (`depth-anything/Depth-Anything-V2-Small-hf`) to generate high-density relative metric depth maps.
2. **Fused Point Cloud Fusing:** Depth maps are backprojected using predicted intrinsics and fused into a dense 3D point cloud, providing a structural spatial foundation for Gaussian scene initialization.

---

### 🎨 Stage 3: 3D Gaussian Splatting (`gsplat` Engine)
1. **CUDA Gaussian Optimization:** The initial dense point cloud is optimized using our localized `gsplat` (v1.4) Gaussian Splatting pipeline over multi-stage iterations (7,000 steps).
2. **Mip-Anti-Aliasing:** Integrates anti-aliased Gaussian splat kernels (`antialiased: True`) to eliminate Moire patterns and jagged artifacts during close-up camera navigation.
3. **Statistical Artifact Pruning:** Pre-renders and PLY assets undergo statistical scale and opacity filtering (`convert_ply_to_splat.py`), removing unwanted floaters ("spider webs" and "needles") to produce clean point clouds.

---

### 🚀 Stage 4: Smart Data Processing & Downsampling
To guarantee rapid processing times and prevent memory exhaustion, ArticulAIT implements an automatic **Smart Downsampling Cap (`max_frames = 50`)**. Uploads exceeding this cap (e.g., a 240-image sequence) are uniformly sampled (selecting every Nth frame) to extract a representative 50-frame sequence spanning the entire property.

---

### 🕹️ Stage 5: Triple Interactive Web Clients

#### 1. Ultra HD 360° Panorama Tour (`PanoWalkthrough.tsx`) - *Default*
- **Matterport-Style Navigation:** Utilizes `@photo-sphere-viewer/virtual-tour-plugin` mapped to the underlying AI waypoint graph.
- **Continuous Gaze Preservation:** Seamlessly transitions between 3D nodes while strictly preserving user camera yaw and pitch.
- **Custom Spatially-Projected UI:** Features interactive, 3D-transformed DOM floor rings (utilizing CSS `rotateX`) projected directly onto the environment to emulate premium real-estate platforms.

#### 2. Continuous 2.5D Photo Walkthrough (`PhotoWalkthrough.tsx`) - *Fallback*
- **Direct DOM-Ref Physics Loop:** Bypasses standard React state re-rendering latencies by executing transform mutations directly on `imgRef.current` inside a 60 FPS `requestAnimationFrame` loop.
- **Sub-frame Spatial Interpolation:** Implements fractional continuous scale interpolation (`currentScale = SCALE * (1 + frac * 0.06)`), producing continuous 3D forward "dolly zoom" motion across keyframes without stutter or visual jumps.
- **Dynamic Boundary Management:** Dynamic container-relative coordinate clamping prevents empty background space exposure regardless of user screen aspect ratio.
- **Snappy WASD & Pan Controls:** Fine-tuned velocity, acceleration, and dampening physics for snappy WASD movement and 360° mouse-drag camera look.

#### 3. WebGL 3D Splat Viewer (`SplatViewer.tsx`)
- Native WebGL 3D Gaussian Splatting renderer with multi-view modes:
  - 👁️ **Walkthrough:** Eye-level first-person exploration.
  - 🏠 **Dollhouse:** Isometric 3D spatial overview.
  - 🗺️ **Floorplan:** Top-down orthographic architectural view.

---

## 🛠️ Tech Stack & Dependencies

### Frontend (`frontend-next`)
- **Framework:** Next.js 15 (App Router), React 19, TypeScript
- **Styling:** Custom Vanilla CSS & Modern Dark-Mode Design System
- **Rendering:** Three.js, WebGL 3D Gaussian Splatting Engine

### Backend (`backend`)
- **Framework:** FastAPI, Uvicorn, SQLAlchemy
- **AI Models & Libraries:**
  - `facebook/VGGT-1B-Commercial` (Deep Camera Pose Estimation)
  - `depth-anything/Depth-Anything-V2-Small-hf` (Monocular Depth)
  - `gsplat==1.4.0` (3D Gaussian Splatting CUDA Backend)
  - `pycolmap==4.0.4` (Structure-from-Motion Photogrammetry)
  - `@photo-sphere-viewer/core` (Frontend 360° Equirectangular Renderer)
  - `torch==2.4.1+cu118`, `torchvision`, `transformers`

---

## ⚙️ Quickstart & Local Setup

### 1. Backend Setup
```bash
# Activate virtual environment
.venv\Scripts\activate

# Launch FastAPI development server
uvicorn backend.app:app --host 0.0.0.0 --reload
```

### 2. Frontend Setup
```bash
# Navigate to frontend application directory
cd frontend-next

# Install dependencies and start development server
npm install
npm run dev
```

### 3. Usage
1. Open `http://localhost:3000` in your web browser.
2. Upload your space photos or video walkthrough.
3. ArticulAIT will automatically estimate camera poses, backproject depth maps, optimize 3D Gaussians, and present the interactive 60 FPS 3D walkthrough engine!
