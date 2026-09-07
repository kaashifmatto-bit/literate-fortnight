"""
ArticulAIT — Centralized Configuration
Loads settings from .env file using Pydantic Settings.
"""
# pyrefly: ignore [missing-import]
from pydantic_settings import BaseSettings
from pathlib import Path
import os


# Derive the project root (3 levels up from this file: core/__init__.py → core → backend → project root)
_BASE_DIR = str(Path(__file__).resolve().parent.parent.parent)

# ── HuggingFace cache location ──────────────────────────────────
# By default huggingface_hub downloads model weights (e.g. VGGT-1B, ~1-2GB)
# to C:\Users\<user>\.cache\huggingface. Redirect that into the D: drive
# project folder instead. This MUST be set before any package that imports
# huggingface_hub (transformers, ultralytics, vggt) gets imported anywhere
# in the app - this module (backend/core) is the first backend import in
# app.py, so setting it here, before anything else runs, is early enough.
os.environ.setdefault("HF_HOME", os.path.join(_BASE_DIR, "hf_cache"))


class Settings(BaseSettings):
    # ── Paths ──────────────────────────────────────────────────
    BASE_DIR: str = _BASE_DIR
    # Default to project-relative paths — override via .env if needed
    DATA_DIR: str = os.path.join(_BASE_DIR, "data")
    SAVED_3D_WALKTHROUGH: str = os.path.join(_BASE_DIR, "data")
    MSDIR: str = os.path.join(_BASE_DIR, "data")
    MODELS_DIR: str = os.path.join(_BASE_DIR, "models")
    LOG_DIR: str = os.path.join(_BASE_DIR, "data", "logs")
    LOG_RETENTION_DAYS: int = 30
    
    # ── Database ───────────────────────────────────────────────
    DATABASE_URL: str = f"sqlite:///{os.path.join(_BASE_DIR, 'data', 'articulait.db')}"
    
    # ── COLMAP ─────────────────────────────────────────────────
    COLMAP_PATH: str = os.path.join(
        _BASE_DIR, "colmap_bin", "COLMAP-3.9.1-windows-cuda", "COLMAP.bat"
    )
    
    # ── AI Models & Pose Estimation ────────────────────────────
    VGGT_MODEL: str = "facebook/VGGT-1B-Commercial"
    HF_TOKEN: str = ""
    POSE_ESTIMATOR_CONFIDENCE_THRESHOLD: float = 0.6
    VGGT_MOCK_ROTATION_ERROR: float = 1.2
    VGGT_MOCK_TRANSLATION_ERROR: float = 3.5
    COLMAP_MOCK_ROTATION_ERROR: float = 1.0
    COLMAP_MOCK_TRANSLATION_ERROR: float = 3.0
    COLMAP_UNREGISTERED_ROTATION_ERROR: float = 6.0
    COLMAP_UNREGISTERED_TRANSLATION_ERROR: float = 18.0

    
    # ── 3DGS Training ─────────────────────────────────────────
    GSPLAT_MAX_STEPS: int = 7000
    GSPLAT_SH_DEGREE: int = 3
    
    # ── Pipeline Mode ──────────────────────────────────────────
    # 'local' or 'luma_mock'
    RECONSTRUCTION_MODE: str = "luma_mock"
    GENERATE_SCENE_MESH: bool = False
    
    # ── Upload Limits ─────────────────────────────────────────
    MAX_UPLOAD_IMAGES: int = 5000
    
    # ── Server ────────────────────────────────────────────────
    CORS_ORIGINS: str = "*"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


# Singleton instance
settings = Settings()

