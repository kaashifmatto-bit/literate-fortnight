/**
 * ArticulAIT — Client-Side Guided Bézier Camera Path Generator & Evaluator (§9.1)
 * Computes 3D Cubic Bézier positions and look-at targets across canonical scene space.
 * Matches backend camera_path_service logic for unified shared source of truth.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CameraPathWaypoint {
  frame: number;
  timeSec: number;
  t: number;
  position: Vec3;
  target: Vec3;
  quaternion: Quat;
  segmentDistance: number;
  cumulativeDistance: number;
  densityScore?: number;
  isSparseRegion?: boolean;
}

export interface CameraPathData {
  durationSeconds: number;
  totalDistance: number;
  waypoints: CameraPathWaypoint[];
  controlPoints: {
    p0: [number, number, number];
    p1: [number, number, number];
    p2: [number, number, number];
    p3: [number, number, number];
  };
}

/**
 * 1. Catmull-Rom Spline Evaluator for 3D Positions
 * Interpolates smoothly across 4 control points [P0, P1, P2, P3] at parameter u in [0, 1].
 */
export function evaluateCatmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const t = Math.max(0, Math.min(1, u));
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

/**
 * 2. Pre-computes orientation Quaternion facing from position to target
 */
export function lookAtToQuat(pos: Vec3, target: Vec3): Quat {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dz = target.z - pos.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1.0;

  const fx = dx / len, fy = dy / len, fz = dz / len;

  let ux = 0, uy = 1, uz = 0;
  let rx = uy * fz - uz * fy;
  let ry = uz * fx - ux * fz;
  let rz = ux * fy - uy * fx;
  let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);

  if (rLen < 0.0001) {
    ux = 0; uy = 0; uz = 1;
    rx = uy * fz - uz * fy;
    ry = uz * fx - ux * fz;
    rz = ux * fy - uy * fx;
    rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
  }

  rx /= rLen; ry /= rLen; rz /= rLen;
  const ux2 = fy * rz - fz * ry;
  const uy2 = fz * rx - fx * rz;
  const uz2 = fx * ry - fy * rx;

  const m00 = rx,  m01 = ux2, m02 = -fx;
  const m10 = ry,  m11 = uy2, m12 = -fy;
  const m20 = rz,  m21 = uz2, m22 = -fz;

  const tr = m00 + m11 + m22;
  let qw = 0, qx = 0, qy = 0, qz = 0;

  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1.0;
  return { x: qx / qLen, y: qy / qLen, z: qz / qLen, w: qw / qLen };
}

function evaluateCubicBezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const clampedT = Math.max(0, Math.min(1, t));
  const u = 1 - clampedT;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = clampedT * clampedT;
  const t3 = t2 * clampedT;

  return {
    x: u3 * p0.x + 3 * u2 * clampedT * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
    y: u3 * p0.y + 3 * u2 * clampedT * p1.y + 3 * u * t2 * p2.y + t3 * p3.y,
    z: u3 * p0.z + 3 * u2 * clampedT * p1.z + 3 * u * t2 * p2.z + t3 * p3.z,
  };
}

export function generateClientBezierPath(
  sceneBounds?: { center: Vec3; half_extents: Vec3; max_extent: number } | null
): CameraPathData {
  const center = sceneBounds?.center || { x: 0, y: 0, z: 0 };
  const maxExtent = Math.max(1.5, sceneBounds?.max_extent || 3.5);

  const durationSeconds = Math.round(Math.max(12, Math.min(30, 10 + maxExtent * 1.4)) * 10) / 10;
  const totalFrames = Math.round(durationSeconds * 30);

  const camDist = Math.max(6.0, Math.min(14.0, maxExtent * 3.5));
  const eyeHeight = 0.5;

  const cp0_pos: Vec3 = { x: 0, y: eyeHeight, z: camDist };
  const cp1_pos: Vec3 = { x: camDist * 0.65, y: eyeHeight + 0.3, z: camDist * 0.75 };
  const cp2_pos: Vec3 = { x: -camDist * 0.65, y: eyeHeight + 0.2, z: camDist * 0.75 };
  const cp3_pos: Vec3 = { x: -camDist * 0.35, y: eyeHeight + 0.1, z: camDist * 0.9 };

  const cp_target: Vec3 = { x: 0, y: 0, z: 0 };

  const rawWaypoints: Array<{ frame: number; timeSec: number; t: number; position: Vec3; target: Vec3 }> = [];

  for (let i = 0; i < totalFrames; i++) {
    const t = i / (totalFrames - 1);
    const pos = evaluateCubicBezier(cp0_pos, cp1_pos, cp2_pos, cp3_pos, t);

    rawWaypoints.push({
      frame: i,
      timeSec: Math.round(t * durationSeconds * 1000) / 1000,
      t: Math.round(t * 10000) / 10000,
      position: { x: Math.round(pos.x * 10000) / 10000, y: Math.round(pos.y * 10000) / 10000, z: Math.round(pos.z * 10000) / 10000 },
      target: { x: Math.round(cp_target.x * 10000) / 10000, y: Math.round(cp_target.y * 10000) / 10000, z: Math.round(cp_target.z * 10000) / 10000 },
    });
  }

  // Calculate segment distances d_i, cumulative distances, and pre-computed Quaternions
  let cumulativeDistance = 0;
  const waypoints: CameraPathWaypoint[] = [];

  for (let i = 0; i < rawWaypoints.length; i++) {
    const cur = rawWaypoints[i];
    let segDist = 0;
    if (i < rawWaypoints.length - 1) {
      const nxt = rawWaypoints[i + 1];
      const dx = nxt.position.x - cur.position.x;
      const dy = nxt.position.y - cur.position.y;
      const dz = nxt.position.z - cur.position.z;
      segDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const quat = lookAtToQuat(cur.position, cur.target);

    // Safety metric: check distance from center to flag potential sparse/void regions
    const distFromCenter = Math.sqrt(
      (cur.position.x - center.x) ** 2 +
      (cur.position.y - center.y) ** 2 +
      (cur.position.z - center.z) ** 2
    );
    const isSparseRegion = distFromCenter > maxExtent * 2.8;

    waypoints.push({
      ...cur,
      quaternion: quat,
      segmentDistance: segDist,
      cumulativeDistance,
      densityScore: isSparseRegion ? 15 : 100,
      isSparseRegion,
    });

    cumulativeDistance += segDist;
  }

  return {
    durationSeconds,
    totalDistance: cumulativeDistance,
    waypoints,
    controlPoints: {
      p0: [cp0_pos.x, cp0_pos.y, cp0_pos.z],
      p1: [cp1_pos.x, cp1_pos.y, cp1_pos.z],
      p2: [cp2_pos.x, cp2_pos.y, cp2_pos.z],
      p3: [cp3_pos.x, cp3_pos.y, cp3_pos.z],
    },
  };
}

