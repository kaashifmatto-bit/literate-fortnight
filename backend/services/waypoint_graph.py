import numpy as np
import math
from typing import List, Dict, Optional

def build_waypoint_graph(
    waypoints: List[Dict],
    point_cloud: Optional[np.ndarray] = None,
    k_neighbors: int = 4,
    max_dist: float = 4.0,
    min_dist: float = 0.01,
    voxel_size: float = 0.1,
    wall_thickness_tolerance: int = 3
) -> List[Dict]:
    """
    Builds a spatial graph of waypoints.
    1. For each waypoint, finds K=4 nearest neighbors by 3D distance.
    2. Filters connections to min_dist < dist < max_dist.
    3. If point_cloud is provided, voxelizes it and performs a line-of-sight check
       to prevent connections passing through walls.
    """
    if not waypoints:
        return waypoints

    # 1. Build occupancy grid if point_cloud is provided
    occupancy_grid = set()
    if point_cloud is not None and len(point_cloud) > 0:
        try:
            # Convert to lower-precision float to reduce peak memory usage.
            point_cloud_arr = np.asarray(point_cloud, dtype=np.float32)
            voxels = np.floor(point_cloud_arr / voxel_size).astype(np.int32)
            occupancy_grid = set(map(tuple, voxels))
        except MemoryError as err:
            print(f"[waypoint_graph] Point cloud voxelization failed, falling back to free-space graph: {err}")
            occupancy_grid = set()
        except Exception as err:
            print(f"[waypoint_graph] Point cloud voxelization failed, falling back to free-space graph: {err}")
            occupancy_grid = set()

    # Helper function to check line of sight
    def has_line_of_sight(p1: dict, p2: dict) -> bool:
        if not occupancy_grid:
            return True
        
        start = np.array([p1.get("x", 0), p1.get("y", 0), p1.get("z", 0)])
        end = np.array([p2.get("x", 0), p2.get("y", 0), p2.get("z", 0)])
        
        dist = np.linalg.norm(end - start)
        if dist < 1e-4:
            return True
            
        direction = (end - start) / dist
        step_size = voxel_size / 2.0
        steps = int(dist / step_size)
        
        hit_count = 0
        for i in range(1, steps):
            sample_pt = start + direction * (i * step_size)
            voxel = tuple(np.floor(sample_pt / voxel_size).astype(np.int32))
            if voxel in occupancy_grid:
                hit_count += 1
                if hit_count > wall_thickness_tolerance:
                    return False
        return True

    # 2. Compute distances and build graph
    for i, wp_i in enumerate(waypoints):
        pos_i = wp_i.get("position", {})
        candidates = []
        
        for j, wp_j in enumerate(waypoints):
            if i == j:
                continue
            pos_j = wp_j.get("position", {})
            
            dx = pos_i.get("x", 0) - pos_j.get("x", 0)
            dy = pos_i.get("y", 0) - pos_j.get("y", 0)
            dz = pos_i.get("z", 0) - pos_j.get("z", 0)
            dist = math.sqrt(dx*dx + dy*dy + dz*dz)
            
            if min_dist <= dist <= max_dist:
                candidates.append((dist, wp_j.get("index"), pos_j))
                
        # Sort by distance
        candidates.sort(key=lambda x: x[0])
        
        # Take K nearest and check line of sight
        connections = []
        for dist, j_index, pos_j in candidates:
            if has_line_of_sight(pos_i, pos_j):
                connections.append(j_index)
                if len(connections) >= k_neighbors:
                    break
                    
        wp_i["connections"] = connections
        
    return waypoints
