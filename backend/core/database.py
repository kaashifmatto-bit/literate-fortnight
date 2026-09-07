"""
ArticulAIT — Database Engine & Session Management
Uses SQLAlchemy with SQLite (zero-install, WAL mode for concurrency).
"""
# pyrefly: ignore [missing-import]
from sqlalchemy import create_engine, event
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from backend.core import settings
import os


# Ensure data directory exists
os.makedirs(os.path.dirname(settings.DATABASE_URL.replace("sqlite:///", "")), exist_ok=True)

# Create engine with SQLite-specific optimizations
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False},  # Allow multi-thread access
    echo=False,
)


# Enable WAL mode for better concurrent read/write performance
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Base class for all ORM models
class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: yields a database session, auto-closes after use."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables defined by ORM models and migrate missing columns."""
    from backend.models import schema  # noqa: F401 — registers models with Base
    Base.metadata.create_all(bind=engine)

    # Perform lightweight automatic migrations for SQLite
    with engine.connect() as conn:
        # Migrate projects table
        res_proj = conn.exec_driver_sql("PRAGMA table_info(projects)").fetchall()
        existing_proj_cols = [row[1] for row in res_proj]
        proj_migrations = [
            ("failure_reason", "VARCHAR(255)"),
            ("quality_flag", "VARCHAR(50) DEFAULT 'pending_review'"),
            ("needs_privacy_review", "BOOLEAN DEFAULT 1"),
            ("updated_at", "DATETIME"),
            ("pose_source", "VARCHAR(50) DEFAULT 'colmap'"),
            ("pose_confidence", "FLOAT DEFAULT 1.0"),
            ("output_status", "VARCHAR(50) DEFAULT 'completed'"),
            ("reason_code", "VARCHAR(100) DEFAULT 'NONE'"),
            ("panorama_type", "VARCHAR(50) DEFAULT 'flat'"),
        ]

        for col_name, col_type in proj_migrations:
            if col_name not in existing_proj_cols:
                conn.exec_driver_sql(f"ALTER TABLE projects ADD COLUMN {col_name} {col_type}")


        # Migrate scenes table
        res_scene = conn.exec_driver_sql("PRAGMA table_info(scenes)").fetchall()
        existing_scene_cols = [row[1] for row in res_scene]
        scene_migrations = [
            ("psnr", "FLOAT"),
            ("ssim", "FLOAT"),
            ("lpips", "FLOAT"),
        ]
        for col_name, col_type in scene_migrations:
            if col_name not in existing_scene_cols:
                conn.exec_driver_sql(f"ALTER TABLE scenes ADD COLUMN {col_name} {col_type}")

        # Migrate pipeline_steps table
        res_steps = conn.exec_driver_sql("PRAGMA table_info(pipeline_steps)").fetchall()
        existing_step_cols = [row[1] for row in res_steps]
        step_migrations = [
            ("duration_ms", "INTEGER"),
        ]
        for col_name, col_type in step_migrations:
            if col_name not in existing_step_cols:
                conn.exec_driver_sql(f"ALTER TABLE pipeline_steps ADD COLUMN {col_name} {col_type}")

        # Migrate hotspots table
        # SQLite does not support ALTER COLUMN, so we must recreate the table if
        # waypoint_id still carries a NOT NULL constraint from the original schema.
        res_hotspots = conn.exec_driver_sql("PRAGMA table_info(hotspots)").fetchall()
        existing_hotspot_cols = {row[1]: row for row in res_hotspots}

        waypoint_id_col = existing_hotspot_cols.get("waypoint_id")
        waypoint_id_notnull = waypoint_id_col[3] if waypoint_id_col else 0  # row[3] = notnull flag
        has_waypoint_index = "waypoint_index" in existing_hotspot_cols

        if waypoint_id_notnull or not has_waypoint_index:
            # Recreate table with the corrected schema (nullable waypoint_id + waypoint_index column)
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            conn.exec_driver_sql("""
                CREATE TABLE IF NOT EXISTS hotspots_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE,
                    waypoint_index INTEGER,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    yaw FLOAT,
                    pitch FLOAT,
                    title VARCHAR(255),
                    description TEXT,
                    icon_type VARCHAR(50) DEFAULT 'info'
                )
            """)
            # Copy existing rows (waypoint_index defaults to NULL for old rows)
            conn.exec_driver_sql("""
                INSERT OR IGNORE INTO hotspots_new
                    (id, waypoint_id, waypoint_index, project_id, yaw, pitch, title, description, icon_type)
                SELECT id, waypoint_id, NULL, project_id, yaw, pitch, title, description, icon_type
                FROM hotspots
            """)
            conn.exec_driver_sql("DROP TABLE hotspots")
            conn.exec_driver_sql("ALTER TABLE hotspots_new RENAME TO hotspots")
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            print("[DB] hotspots table recreated: waypoint_id is now nullable, waypoint_index added.")

        # Migrate listing_rooms table (W1-48 real 3DGS composite: per-room
        # manual scale, added after the table itself already existed on disk
        # for earlier W1-48 work, so a plain create_all() won't add it).
        res_lroom = conn.exec_driver_sql("PRAGMA table_info(listing_rooms)").fetchall()
        existing_lroom_cols = [row[1] for row in res_lroom]
        lroom_migrations = [
            ("scale", "FLOAT DEFAULT 1.0"),
        ]
        for col_name, col_type in lroom_migrations:
            if col_name not in existing_lroom_cols:
                conn.exec_driver_sql(f"ALTER TABLE listing_rooms ADD COLUMN {col_name} {col_type}")

        conn.commit()

    print("[OK] Database initialized and schema auto-migrated (SQLite WAL mode)")
