import cv2
import os

img_paths = [
    'd:/articulait/Office_360_Test_Photos/frame_0000.jpg',
    'd:/articulait/test_dataset_photos/DJI_20200226_143850_006.JPG'
]

for path in img_paths:
    if os.path.exists(path):
        img = cv2.imread(path)
        if img is not None:
            h, w, c = img.shape
            print(f"{os.path.basename(path)}: {w}x{h} ({c} channels)")
        else:
            print(f"Could not read {path}")
    else:
        print(f"{path} does not exist")
