"""
ArticulAIT — Logging Module
Provides API logging with daily midnight rotation, zip compression, and 30-day retention cleanup.
"""
import os
import zipfile
import logging
from logging.handlers import TimedRotatingFileHandler
from datetime import datetime, timedelta
from typing import Optional

from backend.core import settings


def purge_old_logs(log_dir: Optional[str] = None, max_days: Optional[int] = None) -> int:
    """
    Scans the log directory and removes any log or zip archive older than max_days.
    Returns the count of deleted files.
    """
    if log_dir is None:
        log_dir = settings.LOG_DIR
    if max_days is None:
        max_days = settings.LOG_RETENTION_DAYS

    if not os.path.exists(log_dir):
        return 0

    cutoff = datetime.now() - timedelta(days=max_days)
    deleted_count = 0

    try:
        for fname in os.listdir(log_dir):
            fpath = os.path.join(log_dir, fname)
            if not os.path.isfile(fpath):
                continue

            # Target .log, .zip, or rotated log files
            if fname.endswith(".log") or fname.endswith(".zip") or ".log." in fname:
                mtime = datetime.fromtimestamp(os.path.getmtime(fpath))
                if mtime < cutoff:
                    try:
                        os.remove(fpath)
                        deleted_count += 1
                        print(f"[Logger] Deleted old log archive (> {max_days} days): {fname}")
                    except Exception as err:
                        print(f"[Logger] Failed to delete old log file {fname}: {err}")
    except Exception as e:
        print(f"[Logger] Exception during log cleanup: {e}")

    return deleted_count


class ZipTimedRotatingFileHandler(TimedRotatingFileHandler):
    """
    TimedRotatingFileHandler that automatically:
    1. Rotates daily at midnight.
    2. Compresses rotated log file into a .zip archive (api_YYYY-MM-DD.zip).
    3. Removes raw uncompressed rotated file.
    4. Purges archives older than max_days (default 30 days).
    """

    def __init__(
        self,
        filename: str,
        when: str = "midnight",
        interval: int = 1,
        backupCount: int = 30,
        encoding: str = "utf-8",
        delay: bool = True,
        max_days: int = 30,
    ):
        super().__init__(
            filename=filename,
            when=when,
            interval=interval,
            backupCount=backupCount,
            encoding=encoding,
            delay=delay,
        )
        self.max_days = max_days
        self.rotator = self._zip_and_remove

    def emit(self, record):
        super().emit(record)
        self.flush()

    def _zip_and_remove(self, source: str, dest: str):
        """Callback executed on file rotation to compress rotated log into .zip."""
        if not os.path.exists(source):
            return

        dirname, base = os.path.split(source)
        
        # Extract date from rotated filename (e.g. api.log.2026-08-04)
        parts = base.split(".")
        date_suffix = ""
        for part in reversed(parts):
            if len(part) == 10 and part.count("-") == 2:
                date_suffix = part
                break

        if date_suffix:
            zip_name = f"api_{date_suffix}.zip"
        else:
            zip_name = f"{base}.zip"

        zip_path = os.path.join(dirname, zip_name)

        try:
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(source, arcname=base)

            if os.path.exists(source):
                os.remove(source)
                
            print(f"[Logger] Midnight log rotation: compressed {base} -> {zip_name}")
        except Exception as e:
            print(f"[Logger] Error compressing rotated log file {source}: {e}")

        # Run 30-day retention cleanup
        purge_old_logs(dirname, self.max_days)


def setup_logger(name: str = "articulait") -> logging.Logger:
    """Configures and returns logger with console output and ZipTimedRotatingFileHandler."""
    os.makedirs(settings.LOG_DIR, exist_ok=True)
    log_file = os.path.join(settings.LOG_DIR, "api.log")

    app_logger = logging.getLogger(name)
    app_logger.setLevel(logging.INFO)

    # Avoid adding duplicate handlers if setup_logger is called multiple times
    if not app_logger.handlers:
        formatter = logging.Formatter(
            "%(asctime)s | %(levelname)-5s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )

        # 1. Midnight rotating file handler with zip & 30-day cleanup (delay=True ensures on-demand log file creation)
        file_handler = ZipTimedRotatingFileHandler(
            filename=log_file,
            when="midnight",
            interval=1,
            backupCount=settings.LOG_RETENTION_DAYS,
            max_days=settings.LOG_RETENTION_DAYS,
            encoding="utf-8",
            delay=True,
        )
        file_handler.setFormatter(formatter)
        file_handler.setLevel(logging.INFO)
        app_logger.addHandler(file_handler)

        # 2. Console stream handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        console_handler.setLevel(logging.INFO)
        app_logger.addHandler(console_handler)

    # Execute initial startup retention purge
    purge_old_logs(settings.LOG_DIR, settings.LOG_RETENTION_DAYS)

    return app_logger


# Global logger instance auto-initialized on import
logger = setup_logger("articulait")
