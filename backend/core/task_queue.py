"""
ArticulAIT — Lightweight SQLite-Backed Task Queue
No Redis/Celery required. Uses a background thread to process tasks.
"""
import threading
import traceback
import time
from datetime import datetime, timezone
from typing import Callable, Dict, Any
from backend.core.database import SessionLocal
from backend.models.schema import PipelineStep


# Registry of task functions
_task_registry: Dict[str, Callable] = {}


def register_task(name: str):
    """Decorator to register a function as a background task."""
    def decorator(func: Callable):
        _task_registry[name] = func
        return func
    return decorator


def enqueue_pipeline(project_id: int, steps: list[dict]):
    """
    Initialize pipeline steps in the database for a project.
    Each step dict: {"step_number": 1, "step_name": "Feature Extraction"}
    """
    db = SessionLocal()
    try:
        # Clear existing steps for project to prevent duplicate key entries
        db.query(PipelineStep).filter(PipelineStep.project_id == project_id).delete()
        db.commit()
        for step_def in steps:
            step = PipelineStep(
                project_id=project_id,
                step_number=step_def["step_number"],
                step_name=step_def["step_name"],
                status="pending",
                progress=0.0,
            )
            db.add(step)
        db.commit()
    finally:
        db.close()


def update_step(project_id: int, step_number: int, status: str,
                progress: float = 0.0, message: str = None):
    """Update the status/progress of a specific pipeline step."""
    db = SessionLocal()
    try:
        step = db.query(PipelineStep).filter(
            PipelineStep.project_id == project_id,
            PipelineStep.step_number == step_number
        ).first()
        if step:
            step.status = status
            step.progress = progress
            if message:
                step.message = message
            if status == "running" and not step.started_at:
                step.started_at = datetime.now(timezone.utc)
            if status in ("completed", "failed"):
                step.completed_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def run_pipeline_async(project_id: int, task_name: str, **kwargs):
    """
    Launch a registered task in a background thread.
    The task function receives (project_id, **kwargs).
    """
    task_func = _task_registry.get(task_name)
    if not task_func:
        raise ValueError(f"Unknown task: {task_name}. Registered: {list(_task_registry.keys())}")

    def _worker():
        try:
            task_func(project_id, **kwargs)
        except Exception as e:
            print(f"[ERROR] Pipeline task '{task_name}' failed for project {project_id}: {e}")
            traceback.print_exc()
            # Mark project as failed
            from backend.models.schema import Project
            db = SessionLocal()
            try:
                project = db.query(Project).get(project_id)
                if project:
                    project.status = "failed"
                    db.commit()
            finally:
                db.close()

    thread = threading.Thread(target=_worker, daemon=True, name=f"pipeline-{project_id}")
    thread.start()
    print(f"[START] Pipeline task '{task_name}' started for project {project_id} (thread: {thread.name})")
    return thread
