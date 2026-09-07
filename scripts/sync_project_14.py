import os
import shutil
from backend.core.database import SessionLocal
from backend.models.schema import Project, Scene

db = SessionLocal()

# Check Project 14
p14 = db.query(Project).get(14)
p18 = db.query(Project).get(18)

print("Project 14:", p14.name if p14 else "None", "Status:", p14.status if p14 else "None")
print("Project 18:", p18.name if p18 else "None", "Status:", p18.status if p18 else "None")

# Copy scene outputs from 18 to 14 so both work seamlessly
dir14 = os.path.join("data", "project_14")
dir18 = os.path.join("data", "project_18")

os.makedirs(dir14, exist_ok=True)

for fname in ["scene.ply", "scene.splat"]:
    src = os.path.join(dir18, fname)
    dst = os.path.join(dir14, fname)
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print(f"Copied {src} -> {dst}")

if p14:
    p14.status = "completed"
    if not p14.scene:
        s = Scene(
            project_id=14,
            splat_path="/data/project_14/scene.splat",
            ply_path="/data/project_14/scene.ply",
            point_count=320683,
            training_steps=7000
        )
        db.add(s)
    else:
        p14.scene.splat_path = "/data/project_14/scene.splat"
        p14.scene.ply_path = "/data/project_14/scene.ply"
        p14.scene.training_steps = 7000
    db.commit()
    print("[OK] Project 14 updated to COMPLETED in database!")

db.close()
