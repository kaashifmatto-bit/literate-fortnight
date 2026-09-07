#!/usr/bin/env python3
"""
ArticulAIT R&D — SPZ -> PLY converter (Marble evaluation only)

Converts a World Labs Marble ".spz" gaussian-splat export into the exact
binary PLY layout ArticulAIT's own frontend viewer already knows how to load
(see frontend-next/src/components/SplatViewer.tsx: splatToPly() /
sanitizePlyBuffer(), which both write this same 56-bytes-per-vertex layout:
x,y,z,f_dc_0,f_dc_1,f_dc_2,opacity,scale_0,scale_1,scale_2,rot_0,rot_1,rot_2,rot_3
— all float32, binary_little_endian).

This is a one-off inspection tool, deliberately kept in backend/rd/ next to
marble_test.py — NOT wired into the real pipeline. It exists to answer one
question: does the Marble output actually look right when loaded in our own
viewer, via the app's existing "Open 3D File (.ply)" picker on
/viewer/local (SplatViewer's `file` prop creates a blob URL immediately —
no backend upload/route change needed to preview it).

Known, deliberately-unresolved issues (see the R&D conversation this came
from) — this script does not attempt to fix either of these:
  1. Marble has been observed inventing room content (e.g. a second seating
     area) that was not present in the source photos. This conversion does
     not detect or filter that — it faithfully reproduces whatever Marble
     returned.
  2. Marble's free-tier output is restricted to non-commercial use per
     World Labs' general ToS (unconfirmed whether this differs for Atlas).
     This script does not check your account tier.

── Why the values pass through almost unchanged ───────────────────────────
The `spz` PyPI package (v0.0.1) decodes a .spz file into numpy arrays that
turn out to already be numerically in the same encoding our own PLY format
uses, confirmed by inspecting real output from this project's own
scene.spz (1.92M points, 2026-09-07):
  - scales:   already log-space (matches PLY `scale_0..2`)
  - alphas:   already logit-space, i.e. log(a/(1-a)) (matches PLY `opacity`)
  - colors:   already the SH0 DC coefficient, i.e. (rgb/255 - 0.5)/0.28209..
              (matches PLY `f_dc_0..2`) — NOT raw 0..1 RGB
  - rotations: already a unit quaternion as (w, x, y, z) float32, matching
              the identity-rotation example in the package's own docstring
              ([1, 0, 0, 0]) and the order our PLY's rot_0..3 already uses.
So this script just loads, optionally downsamples, and writes — no color-
space or scale-space math needed, unlike converting from a *raw* RGB source.

── The `spz` package's own import bug (v0.0.1) ─────────────────────────────
`import spz` fails out of the box on this version with:
  ImportError: cannot import name 'BoundingBox' from partially initialized
  module 'spz' (most likely due to a circular import)
Root cause: spz/__init__.py does `from spz import (...)` (an absolute,
self-referential import) instead of `from .spz import (...)` (the compiled
extension submodule) — a packaging bug, not anything wrong with the .spz
file or your environment. Worked around below by loading the compiled
extension directly by file path under the module name it expects
(PyInit_spz fixes the name to "spz"), bypassing the broken __init__.py
entirely. If a later `spz` release fixes this, the workaround becomes
unnecessary but harmless (it only triggers if `import spz` fails first).

Usage:
    pip install spz   # needs network access; not required if only reading
                       # an already-converted .ply this script produced
    python spz_to_ply.py --input scene.spz --output scene_marble.ply
    python spz_to_ply.py --input scene.spz --output scene_marble_preview.ply --max-points 350000
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np


def _load_spz_module():
    """Import the `spz` package, working around its v0.0.1 circular-import
    bug (see module docstring) if the normal import fails."""
    try:
        import spz  # type: ignore
        return spz
    except ImportError as first_err:
        try:
            import importlib.util
            import sys as _sys

            spec = importlib.util.find_spec("spz")
            if spec is None or spec.submodule_search_locations is None:
                raise first_err
            pkg_dir = Path(list(spec.submodule_search_locations)[0])
            candidates = list(pkg_dir.glob("spz.*.so")) + list(pkg_dir.glob("spz*.pyd"))
            if not candidates:
                raise first_err
            ext_path = candidates[0]

            mod_spec = importlib.util.spec_from_file_location("spz", ext_path)
            mod = importlib.util.module_from_spec(mod_spec)
            _sys.modules["spz"] = mod
            mod_spec.loader.exec_module(mod)  # type: ignore[union-attr]
            print(
                f"[spz_to_ply] Worked around the spz==0.0.1 __init__.py circular-"
                f"import bug by loading {ext_path.name} directly.",
                file=sys.stderr,
            )
            return mod
        except Exception:
            raise first_err


PLY_HEADER_TEMPLATE = (
    "ply\n"
    "format binary_little_endian 1.0\n"
    "comment ArticulAIT R&D: converted from World Labs Marble .spz\n"
    "element vertex {num_vertices}\n"
    "property float x\n"
    "property float y\n"
    "property float z\n"
    "property float f_dc_0\n"
    "property float f_dc_1\n"
    "property float f_dc_2\n"
    "property float opacity\n"
    "property float scale_0\n"
    "property float scale_1\n"
    "property float scale_2\n"
    "property float rot_0\n"
    "property float rot_1\n"
    "property float rot_2\n"
    "property float rot_3\n"
    "end_header\n"
)


def convert(
    input_path: Path,
    output_path: Path,
    max_points: int | None,
    coordinate_system: str,
) -> dict:
    spz = _load_spz_module()

    coord_enum = getattr(spz.CoordinateSystem, coordinate_system, None)
    if coord_enum is None:
        valid = [n for n in dir(spz.CoordinateSystem) if not n.startswith("_")]
        raise SystemExit(f"Unknown --coordinate-system {coordinate_system!r}. Valid: {valid}")

    print(f"[spz_to_ply] Loading {input_path} (coordinate_system={coordinate_system})...")
    splat = spz.GaussianSplat.load(str(input_path), coordinate_system=coord_enum)

    n = splat.num_points
    print(f"[spz_to_ply] Loaded {n:,} points (sh_degree={splat.sh_degree}, bbox={splat.bbox})")

    positions = np.asarray(splat.positions, dtype=np.float32)
    scales = np.asarray(splat.scales, dtype=np.float32)
    rotations = np.asarray(splat.rotations, dtype=np.float32)
    alphas = np.asarray(splat.alphas, dtype=np.float32)
    colors = np.asarray(splat.colors, dtype=np.float32)

    if max_points is not None and n > max_points:
        # Uniform random subsample (not spatial LOD) — fine for a one-off
        # visual sanity check, not for a real delivered asset.
        rng = np.random.default_rng(seed=0)
        keep = np.sort(rng.choice(n, size=max_points, replace=False))
        positions, scales, rotations, alphas, colors = (
            positions[keep], scales[keep], rotations[keep], alphas[keep], colors[keep],
        )
        n = max_points
        print(f"[spz_to_ply] Downsampled to {n:,} points for a smaller preview file.")

    # Interleave into the exact 56-byte-per-vertex layout the frontend expects:
    # x,y,z, f_dc_0,f_dc_1,f_dc_2, opacity, scale_0,scale_1,scale_2, rot_0..3
    out = np.empty((n, 14), dtype="<f4")
    out[:, 0:3] = positions
    out[:, 3:6] = colors
    out[:, 6] = alphas
    out[:, 7:10] = scales
    out[:, 10:14] = rotations

    if not np.all(np.isfinite(out)):
        bad = int((~np.isfinite(out)).any(axis=1).sum())
        print(f"[spz_to_ply] WARNING: {bad:,} point(s) contain NaN/Inf values; zeroing them out "
              f"rather than producing a corrupt file.", file=sys.stderr)
        bad_mask = ~np.isfinite(out).all(axis=1)
        out[bad_mask] = 0.0

    header = PLY_HEADER_TEMPLATE.format(num_vertices=n).encode("ascii")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(header)
        f.write(out.tobytes())

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"[spz_to_ply] Wrote {output_path} ({size_mb:.1f} MB, {n:,} points)")
    return {"num_points": n, "size_bytes": output_path.stat().st_size, "bbox": splat.bbox}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, required=True, help="Path to the source .spz file")
    parser.add_argument("--output", type=Path, required=True, help="Path to write the .ply file to")
    parser.add_argument("--max-points", type=int, default=None,
                         help="Randomly downsample to at most this many points (default: no downsampling)")
    parser.add_argument("--coordinate-system", type=str, default="RDF",
                         help="Target coordinate system (default RDF, to match this project's COLMAP/gsplat-style "
                              "Y-down convention that SplatViewer.tsx already compensates for). "
                              "Options: LDB, LDF, LUB, LUF, RDB, RDF, RUB, RUF, UNSPECIFIED.")
    args = parser.parse_args()

    if not args.input.is_file():
        print(f"✘ --input does not exist: {args.input}", file=sys.stderr)
        return 1

    convert(args.input, args.output, args.max_points, args.coordinate_system)
    return 0


if __name__ == "__main__":
    sys.exit(main())
