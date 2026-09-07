import zipfile
zip_path = 'd:/articulait/data/nerf_llff_data.zip'
with zipfile.ZipFile(zip_path, 'r') as zip_ref:
    paths = set()
    for name in zip_ref.namelist():
        parts = name.split('/')
        if len(parts) > 1:
            paths.add(parts[1])
    print("Found subdirectories in nerf_llff_data:", sorted(list(paths)))
