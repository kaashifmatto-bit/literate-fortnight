import sqlite3
db_path = 'd:/articulait/data/articulait.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

for pid in [11, 12]:
    print(f"\n--- Project ID {pid} ---")
    imgs = cursor.execute("SELECT * FROM project_images WHERE project_id=? LIMIT 5", (pid,)).fetchall()
    for row in imgs:
        print(row)

conn.close()
