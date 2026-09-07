import os
from backend.services.pipeline_orchestrator import PipelineOrchestrator
from backend.core.database import SessionLocal
from backend.models.schema import Project

print("Starting reprocessing of Project 18 with robust threshold and trajectory...")
db = SessionLocal()
p = db.query(Project).get(18)
if p:
    p.status = "processing"
    db.commit()
db.close()

orchestrator = PipelineOrchestrator(18)
# Full high-resolution training (7000 steps, SH degree 3)
from backend.core import settings
settings.GSPLAT_MAX_STEPS = 7000
success = orchestrator.run()

print(f"\n[OK] Reprocessing result: {success}")
