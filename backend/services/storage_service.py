"""
ArticulAIT — Storage Service Abstraction Layer
Provides a unified interface for storing, retrieving, and deleting project assets.
Supports local filesystem storage with future seams for cloud S3 / R2 backends.
"""

import os
import shutil
from abc import ABC, abstractmethod
from typing import Optional


class StorageProvider(ABC):
    """Abstract Base Class for file storage backends."""

    @abstractmethod
    def save_file(self, file_bytes: bytes, target_rel_path: str) -> str:
        """Saves file bytes to storage and returns the absolute/accessible path or URI."""
        pass

    @abstractmethod
    def get_file_path(self, target_rel_path: str) -> Optional[str]:
        """Returns local path or URL for accessing the saved asset."""
        pass

    @abstractmethod
    def delete_file(self, target_rel_path: str) -> bool:
        """Deletes a file from storage."""
        pass


class LocalStorageProvider(StorageProvider):
    """Local filesystem storage implementation."""

    def __init__(self, base_dir: str = "data"):
        self.base_dir = os.path.abspath(base_dir)
        os.makedirs(self.base_dir, exist_ok=True)

    def save_file(self, file_bytes: bytes, target_rel_path: str) -> str:
        full_path = os.path.join(self.base_dir, target_rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as f:
            f.write(file_bytes)
        return full_path

    def get_file_path(self, target_rel_path: str) -> Optional[str]:
        full_path = os.path.join(self.base_dir, target_rel_path)
        if os.path.exists(full_path):
            return full_path
        return None

    def delete_file(self, target_rel_path: str) -> bool:
        full_path = os.path.join(self.base_dir, target_rel_path)
        if os.path.exists(full_path):
            if os.path.isdir(full_path):
                shutil.rmtree(full_path)
            else:
                os.remove(full_path)
            return True
        return False


# Default storage instance for the application
storage_service = LocalStorageProvider()
