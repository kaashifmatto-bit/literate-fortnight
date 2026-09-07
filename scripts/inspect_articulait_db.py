import sqlite3
db_path = 'd:/articulait/data/articulait.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get all tables
tables = cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print("Tables in database:", [t[0] for t in tables])

for table in tables:
    name = table[0]
    count = cursor.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
    print(f"Table '{name}' has {count} rows")
    if count > 0:
        rows = cursor.execute(f"SELECT * FROM {name} LIMIT 3").fetchall()
        print(f"Sample rows from '{name}':", rows)

conn.close()
