import os
from backend.core.database import SessionLocal
from backend.models.schema import Project

db = SessionLocal()
projects = db.query(Project).order_by(Project.id.desc()).all()

print("=" * 60)
print("PROJECTS LIST IN DATABASE:")
print("=" * 60)
for p in projects:
    img_dir = os.path.join("data", f"project_{p.id}", "processed_images")
    count = len(os.listdir(img_dir)) if os.path.exists(img_dir) else 0
    print(f"Project ID: {p.id:<4} | Name: {p.name:<25} | Status: {p.status:<12} | Photos: {count}")
print("=" * 60)
