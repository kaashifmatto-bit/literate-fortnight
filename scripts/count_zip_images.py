import zipfile
zip_path = 'd:/articulait/data/nerf_llff_data.zip'
with zipfile.ZipFile(zip_path, 'r') as zip_ref:
    counts = {}
    for name in zip_ref.namelist():
        if '/images/' in name and not name.endswith('/'):
            parts = name.split('/')
            scene = parts[1]
            counts[scene] = counts.get(scene, 0) + 1
    for scene, count in sorted(counts.items()):
        print(f"Scene: {scene}, Image Count: {count}")
