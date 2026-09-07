import struct

import numpy as np

def inspect_splat(file_path):
    print(f"=== Inspecting {file_path} ===")
    with open(file_path, "rb") as f:
        data = f.read()

    num_splats = len(data) // 32
    print(f"Total bytes: {len(data)}, Num splats: {num_splats}")

    # Read first 10 splats
    for i in range(min(10, num_splats)):
        chunk = data[i*32:(i+1)*32]
        x, y, z, s0, s1, s2 = struct.unpack("<ffffff", chunk[:24])
        r, g, b, a, q0, q1, q2, q3 = struct.unpack("BBBBBBBB", chunk[24:])
        print(f"Splat #{i}:")
        print(f"  Pos: ({x:.3f}, {y:.3f}, {z:.3f})")
        print(f"  Scale: ({s0:.5f}, {s1:.5f}, {s2:.5f})")
        print(f"  RGBA: ({r}, {g}, {b}, {a})")
        print(f"  Rot uint8: ({q0}, {q1}, {q2}, {q3})")
        # convert rot uint8 to float [-1, 1]
        qw = (q0 - 128) / 128.0
        qx = (q1 - 128) / 128.0
        qy = (q2 - 128) / 128.0
        qz = (q3 - 128) / 128.0
        print(f"  Rot float: qw={qw:.3f}, qx={qx:.3f}, qy={qy:.3f}, qz={qz:.3f}")

if __name__ == "__main__":
    inspect_splat(r"C:\Users\ADMIN\Downloads\scene (6).splat")
