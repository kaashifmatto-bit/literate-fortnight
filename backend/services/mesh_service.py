"""
ArticulAIT — Scene Mesh Generation Service
Generates 3D surface meshes (.obj, .glb) from point cloud data using Open3D and Trimesh.
Implements Poisson Surface Reconstruction with consistent tangent plane normal estimation,
conservative low-density vertex pruning, and quadric decimation.
"""

import os
import logging
import numpy as np

logger = logging.getLogger(__name__)


def _parse_points3d_txt(points3d_path: str):
    """
    Parses COLMAP sparse/dense points3D.txt text file.
    Format per point line: POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]
    Returns (xyz_array, rgb_array_normalized_0_to_1).
    """
    pts = []
    colors = []
    with open(points3d_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 7:
                try:
                    x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
                    r, g, b = int(parts[4]), int(parts[5]), int(parts[6])
                    pts.append([x, y, z])
                    colors.append([r / 255.0, g / 255.0, b / 255.0])
                except ValueError:
                    continue

    if not pts:
        return np.empty((0, 3), dtype=np.float64), np.empty((0, 3), dtype=np.float64)

    return np.array(pts, dtype=np.float64), np.array(colors, dtype=np.float64)


def generate_scene_mesh(
    points3d_path: str,
    output_dir: str,
    depth: int = 8,
    density_quantile_threshold: float = 0.05,
    max_target_triangles: int = 150000
) -> dict:
    """
    Generates a clean 3D scene mesh (.obj and .glb) from a point cloud file using Open3D & Trimesh.

    Diagnostics-Backed Fixes:
    - Normal Orientation: Uses orient_normals_consistent_tangent_plane(k=15) so normal vectors
      are globally aligned with tangent planes (prevents inward centroid normal collapse).
    - Conservative Trimming: Trims bottom 5% quantile of vertex densities (quantile=0.05) to strip
      sparse noise without carving away valid wall geometry.
    - Quadric Decimation: Optimizes mesh topology for 60FPS WebGL browser rendering.
    """
    if not os.path.exists(points3d_path):
        msg = f"[MeshService] Source point cloud file not found at: {points3d_path}"
        logger.warning(msg)
        print(msg)
        return {"success": False, "reason": "point_cloud_missing"}

    os.makedirs(output_dir, exist_ok=True)
    obj_path = os.path.join(output_dir, "scene_mesh.obj")
    glb_path = os.path.join(output_dir, "scene_mesh.glb")

    try:
        # Step 1: Import Open3D and Trimesh
        # pyrefly: ignore [missing-import]
        import open3d as o3d
        # pyrefly: ignore [missing-import]
        import trimesh

        print(f"[MeshService] Step 1/6: Loading point cloud from {os.path.basename(points3d_path)}...")
        if points3d_path.endswith(".txt"):
            xyz, rgb = _parse_points3d_txt(points3d_path)
        elif points3d_path.endswith(".ply"):
            pcd_in = o3d.io.read_point_cloud(points3d_path)
            xyz = np.asarray(pcd_in.points)
            rgb = np.asarray(pcd_in.colors) if pcd_in.has_colors() else np.empty((0, 3))
        else:
            return {"success": False, "reason": "unsupported_point_cloud_format"}

        if len(xyz) < 50:
            msg = f"[MeshService] Insufficient points for Poisson surface reconstruction ({len(xyz)} < 50 minimum). Skipping."
            logger.warning(msg)
            print(msg)
            return {"success": False, "reason": "too_few_points", "point_count": len(xyz)}

        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(xyz)
        if rgb is not None and len(rgb) == len(xyz):
            pcd.colors = o3d.utility.Vector3dVector(rgb)

        print(f"[MeshService] Step 2/6: Estimating surface normals across {len(xyz)} points...")
        nn_distances = pcd.compute_nearest_neighbor_distance()
        mean_dist = np.mean(nn_distances) if len(nn_distances) > 0 else 0.05
        search_radius = max(0.02, float(mean_dist * 2.5))

        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=search_radius,
                max_nn=30
            )
        )
        
        # Consistent tangent plane orientation (prevents inward normal flips)
        pcd.orient_normals_consistent_tangent_plane(k=15)

        print(f"[MeshService] Step 3/6: Running Poisson Surface Reconstruction (octree depth={depth})...")
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=depth, linear_fit=False
        )

        print(f"[MeshService] Step 4/6: Pruning low-density vertices (bottom {density_quantile_threshold*100:.0f}%)...")
        densities_arr = np.asarray(densities)
        if len(densities_arr) > 0 and density_quantile_threshold > 0:
            cutoff = float(np.quantile(densities_arr, density_quantile_threshold))
            vertices_to_remove = densities_arr < cutoff
            mesh.remove_vertices_by_mask(vertices_to_remove)

        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()

        # Step 5: Optional Quadric Decimation for web performance
        raw_faces = len(mesh.triangles)
        if max_target_triangles > 0 and raw_faces > max_target_triangles:
            print(f"[MeshService] Step 5/6: Decimating mesh from {raw_faces} faces to target {max_target_triangles}...")
            mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=max_target_triangles)
            mesh.remove_degenerate_triangles()
            mesh.remove_duplicated_vertices()
        else:
            print(f"[MeshService] Step 5/6: Retaining clean mesh detail ({raw_faces} faces)...")

        vertex_cnt = len(mesh.vertices)
        face_cnt = len(mesh.triangles)

        if vertex_cnt == 0 or face_cnt == 0:
            msg = "[MeshService] Poisson reconstruction resulted in an empty mesh after pruning."
            logger.warning(msg)
            print(msg)
            return {"success": False, "reason": "empty_mesh_after_pruning"}

        print(f"[MeshService] Step 6/6: Exporting OBJ and GLB ({vertex_cnt} vertices, {face_cnt} faces)...")
        o3d.io.write_triangle_mesh(obj_path, mesh)

        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        vertex_colors = np.asarray(mesh.vertex_colors) if mesh.has_vertex_colors() else None

        t_mesh = trimesh.Trimesh(
            vertices=vertices,
            faces=faces,
            vertex_colors=vertex_colors,
            process=False
        )
        t_mesh.export(glb_path)

        success_msg = f"[MeshService] Successfully generated clean scene mesh -> {obj_path} & {glb_path} ({vertex_cnt} vertices, {face_cnt} faces)"
        logger.info(success_msg)
        print(f"[OK] {success_msg}")

        return {
            "success": True,
            "obj_path": obj_path,
            "glb_path": glb_path,
            "vertex_count": vertex_cnt,
            "face_count": face_cnt
        }

    except Exception as e:
        msg = f"[MeshService] Failed executing Poisson mesh generation: {e}"
        logger.warning(msg)
        print(f"[WARNING] {msg}")
        return {"success": False, "error": str(e)}
