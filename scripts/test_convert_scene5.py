import struct
import numpy as np

def test_convert_scene5():
    file_path = r'C:\Users\ADMIN\Downloads\scene (5).splat'
    with open(file_path, "rb") as f:
        data = f.read()

    num_splats = len(data) // 32
    xs, ys, zs = [], [], []
    scales0, scales1, scales2 = [], [], []
    rot_w, rot_x, rot_y, rot_z = [], [], [], []

    for i in range(num_splats):
        chunk = data[i*32:(i+1)*32]
        x, y, z, s0, s1, s2 = struct.unpack("<ffffff", chunk[:24])
        r, g, b, a, q0, q1, q2, q3 = struct.unpack("BBBBBBBB", chunk[24:])

        qw = (q0 - 128) / 128.0
        qx = (q1 - 128) / 128.0
        qy = (q2 - 128) / 128.0
        qz = (q3 - 128) / 128.0

        if abs(x) < 100 and abs(y) < 100 and abs(z) < 100:
            xs.append(x)
            ys.append(y)
            zs.append(z)
            scales0.append(s0)
            scales1.append(s1)
            scales2.append(s2)
            rot_w.append(qw)
            rot_x.append(qx)
            rot_y.append(qy)
            rot_z.append(qz)

    xs.sort()
    ys.sort()
    zs.sort()

    mid = len(xs) // 2
    med_x, med_y, med_z = xs[mid], ys[mid], zs[mid]

    p15 = int(len(xs) * 0.15)
    p85 = int(len(xs) * 0.85)

    span_x = xs[p85] - xs[p15]
    span_y = ys[p85] - ys[p15]
    span_z = zs[p85] - zs[p15]

    max_extent = max(0.5, min(10, max(span_x, span_y, span_z) / 2))

    print(f"Median center: ({med_x:.3f}, {med_y:.3f}, {med_z:.3f})")
    print(f"World center (rotated 180 deg X): ({med_x:.3f}, {-med_y:.3f}, {-med_z:.3f})")
    print(f"15th-85th Percentile Spans: X={span_x:.3f}, Y={span_y:.3f}, Z={span_z:.3f}")
    print(f"Max Extent: {max_extent:.3f}")
    print(f"Min/Max X: {min(xs):.3f} to {max(xs):.3f}")
    print(f"Min/Max Y: {min(ys):.3f} to {max(ys):.3f}")
    print(f"Min/Max Z: {min(zs):.3f} to {max(zs):.3f}")

if __name__ == "__main__":
    test_convert_scene5()
