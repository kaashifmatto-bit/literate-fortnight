"use client";

import React, { useEffect, useRef, useState, useCallback, memo } from "react";
import * as pc from "playcanvas";
import type { SceneBounds } from "@/lib/types";
import { generateClientBezierPath, evaluateCatmullRom, lookAtToQuat, CameraPathData } from "@/lib/bezierPath";
import { saveRenderedFrame, prepareFrameCapture } from "@/lib/api";
import JSZip from "jszip";

export interface SplatCullingConfig {
  enableFrustumCulling: boolean;
  enableDistanceCulling: boolean;
  enableScaleCulling: boolean;
  minPixelSize: number;       // Default: 1.0 px
  maxRenderDistance: number;  // Default: 45.0 meters
  frustumMargin: number;      // Default: 0.15 (15% margin to prevent edge pop-in)
  debugInstrumentation: boolean; // Default: false
}

interface SplatViewerProps {
  splatUrl?: string;
  file?: File | null;
  viewMode: "walkthrough" | "dollhouse" | "floorplan";
  sceneBounds?: SceneBounds | null;
  projectId?: number;
  onOpenFile?: () => void;
  onFallback?: () => void;
  cullingConfig?: Partial<SplatCullingConfig>;
  // ── Photo Tour frame capture ──────────────────────────────
  // Bump captureTrigger (any changing number, e.g. Date.now() at click time)
  // to run one capture pass: fetch camerasUrl (defaults to
  // /data/project_{projectId}/cameras.json), fly the camera to each pose in
  // turn, and POST a rendered still back for each - fills in the images/
  // folder for a reality_capture_bypass project (a directly-imported 3D
  // model) so the existing Photo Tour / PanoWalkthrough experience, which
  // already reads poses.json + images/*.jpg, has real frames to show.
  captureTrigger?: number;
  camerasUrl?: string;
  onCaptureProgress?: (done: number, total: number) => void;
  onCaptureComplete?: (result: { saved: number; failed: number; error?: string }) => void;
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isEditableTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

// Exported (not just used internally below) so the multi-room listing splat
// compositor (ListingSplatViewer.tsx, W1-48's real 3DGS composite work) can
// reuse the exact same PLY/splat binary handling instead of a second,
// divergent copy of ~200 lines of binary parsing logic - see that file's
// header comment for why this one-directional dependency is deliberate.
export function isPlyBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const u8 = new Uint8Array(buffer, 0, 4);
  return u8[0] === 112 && u8[1] === 108 && u8[2] === 121;
}

export function splatToPly(buffer: ArrayBuffer): ArrayBuffer {
  const numVertices = Math.floor(buffer.byteLength / 32);
  const headerStr = `ply\nformat binary_little_endian 1.0\ncomment align\nelement vertex ${numVertices}\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n`;
  const encoder = new TextEncoder();
  let headerBytes = encoder.encode(headerStr);
  const padRemainder = headerBytes.length % 4;
  if (padRemainder !== 0) {
    const padCount = 4 - padRemainder;
    headerBytes = encoder.encode(headerStr.replace("comment align", "comment align" + " ".repeat(padCount)));
  }
  const outBuffer = new ArrayBuffer(headerBytes.length + numVertices * 56);
  const outView = new DataView(outBuffer);
  new Uint8Array(outBuffer).set(headerBytes, 0);

  const inView = new DataView(buffer);
  let outOffset = headerBytes.length;
  const SH_C0 = 0.28209479177387814;
  for (let i = 0; i < numVertices; i++) {
    const inOff = i * 32;
    outView.setFloat32(outOffset + 0, inView.getFloat32(inOff, true), true);
    outView.setFloat32(outOffset + 4, inView.getFloat32(inOff + 4, true), true);
    outView.setFloat32(outOffset + 8, inView.getFloat32(inOff + 8, true), true);

    const r = inView.getUint8(inOff + 24);
    const g = inView.getUint8(inOff + 25);
    const b = inView.getUint8(inOff + 26);
    const a = inView.getUint8(inOff + 27);
    outView.setFloat32(outOffset + 12, (r / 255.0 - 0.5) / SH_C0, true);
    outView.setFloat32(outOffset + 16, (g / 255.0 - 0.5) / SH_C0, true);
    outView.setFloat32(outOffset + 20, (b / 255.0 - 0.5) / SH_C0, true);

    let alpha = a / 255.0;
    if (alpha < 0.001) alpha = 0.001;
    if (alpha > 0.999) alpha = 0.999;
    outView.setFloat32(outOffset + 24, Math.log(alpha / (1.0 - alpha)), true);

    const s0 = inView.getFloat32(inOff + 12, true);
    const s1 = inView.getFloat32(inOff + 16, true);
    const s2 = inView.getFloat32(inOff + 20, true);
    const logS0 = (isFinite(s0) && s0 > 0) ? Math.log(s0) : -4.5;
    const logS1 = (isFinite(s1) && s1 > 0) ? Math.log(s1) : -4.5;
    const logS2 = (isFinite(s2) && s2 > 0) ? Math.log(s2) : -4.5;
    outView.setFloat32(outOffset + 28, logS0, true);
    outView.setFloat32(outOffset + 32, logS1, true);
    outView.setFloat32(outOffset + 36, logS2, true);

    const r0 = (inView.getUint8(inOff + 28) - 128) / 128.0;
    const r1 = (inView.getUint8(inOff + 29) - 128) / 128.0;
    const r2 = (inView.getUint8(inOff + 30) - 128) / 128.0;
    const r3 = (inView.getUint8(inOff + 31) - 128) / 128.0;
    let qLen = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
    if (qLen === 0) qLen = 1;
    outView.setFloat32(outOffset + 40, r0 / qLen, true);
    outView.setFloat32(outOffset + 44, r1 / qLen, true);
    outView.setFloat32(outOffset + 48, r2 / qLen, true);
    outView.setFloat32(outOffset + 52, r3 / qLen, true);
    outOffset += 56;
  }
  return outBuffer;
}

interface PlyHeader {
  numVertices: number;
  vertexStride: number;
  headerByteLength: number;
  isBinaryLittleEndian: boolean;
  isAscii: boolean;
  properties: Record<string, { offset: number; type: string; size: number }>;
}

function parsePlyHeader(buffer: ArrayBuffer): PlyHeader | null {
  try {
    const maxHeaderCheck = Math.min(buffer.byteLength, 16000);
    const textDecoder = new TextDecoder("ascii");
    const headerBytes = new Uint8Array(buffer, 0, maxHeaderCheck);
    const headerStr = textDecoder.decode(headerBytes);

    const endHeaderStr = "end_header";
    const endHeaderIndex = headerStr.indexOf(endHeaderStr);
    if (endHeaderIndex === -1) return null;

    let headerEndByte = endHeaderIndex + endHeaderStr.length;
    while (headerEndByte < maxHeaderCheck && (headerBytes[headerEndByte] === 13 || headerBytes[headerEndByte] === 10 || headerBytes[headerEndByte] === 32)) {
      headerEndByte++;
    }

    const headerText = headerStr.substring(0, endHeaderIndex);
    const lines = headerText.split(/\r?\n/);

    let numVertices = 0;
    let isBinaryLittleEndian = false;
    let isAscii = false;

    let inVertexElement = false;
    let currentVertexOffset = 0;
    const properties: Record<string, { offset: number; type: string; size: number }> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("comment")) continue;

      if (trimmed.startsWith("format ")) {
        if (trimmed.includes("binary_little_endian")) isBinaryLittleEndian = true;
        else if (trimmed.includes("ascii")) isAscii = true;
      } else if (trimmed.startsWith("element ")) {
        const parts = trimmed.split(/\s+/);
        if (parts[1] === "vertex") {
          inVertexElement = true;
          numVertices = parseInt(parts[2], 10) || 0;
        } else {
          inVertexElement = false;
        }
      } else if (inVertexElement && trimmed.startsWith("property ")) {
        const parts = trimmed.split(/\s+/);
        const propType = parts[1];
        const propName = parts[parts.length - 1];

        let propSize = 4;
        if (propType === "uchar" || propType === "uint8" || propType === "char" || propType === "int8") {
          propSize = 1;
        } else if (propType === "short" || propType === "ushort" || propType === "int16" || propType === "uint16") {
          propSize = 2;
        } else if (propType === "float" || propType === "float32" || propType === "int" || propType === "int32" || propType === "uint" || propType === "uint32") {
          propSize = 4;
        } else if (propType === "double" || propType === "float64" || propType === "int64") {
          propSize = 8;
        }

        properties[propName] = {
          offset: currentVertexOffset,
          type: propType,
          size: propSize,
        };
        currentVertexOffset += propSize;
      }
    }

    if (numVertices === 0 || currentVertexOffset === 0) return null;

    return {
      numVertices,
      vertexStride: currentVertexOffset,
      headerByteLength: headerEndByte,
      isBinaryLittleEndian,
      isAscii,
      properties,
    };
  } catch (err) {
    console.warn("[SplatViewer] PLY header parse error:", err);
    return null;
  }
}

// A directly-opened local file (via "Open 3D File") or an unusually large
// scene never passes through the backend's LOD tiers at all - this viewer
// was handed the raw buffer and asked to render every single splat in it.
// For an ordinary reconstructed room that's a few hundred thousand points
// and is fine, but an AI-generated "world" export can be several million,
// which is enough to make the browser hang or the tab appear to render
// nothing at all while it struggles. This caps what actually reaches the
// GPU, independent of whether the source was a backend URL or a local file.
//
// NOTE: this previously sat at 900k, which was well below a typical
// World Labs Marble "2M splat" export (~2.4M points once loaded as PLY).
// That meant every Marble import was silently losing ~63% of its detail
// on every load, regardless of which LOD tier was selected upstream -
// the exact cause of a "quality looks soft/lacking" report even though
// the source file itself was fine. Raised to comfortably cover a full
// 2M-class export while still guarding against genuinely pathological
// files (5M+ splats) that can hang the tab.
export const MAX_CLIENT_SPLATS = 2_500_000;

export function downsamplePlyBinary(buffer: ArrayBuffer, maxVertices: number): ArrayBuffer {
  const header = parsePlyHeader(buffer);
  if (!header || !header.isBinaryLittleEndian || header.numVertices <= maxVertices) {
    return buffer;
  }

  const { numVertices, vertexStride, headerByteLength } = header;
  const keepCount = Math.max(1, maxVertices);
  const step = numVertices / keepCount;

  const headerBytes = new Uint8Array(buffer, 0, headerByteLength);
  const headerStr = new TextDecoder("ascii").decode(headerBytes);
  const newHeaderStr = headerStr.replace(/element vertex \d+/, `element vertex ${keepCount}`);
  const newHeaderBytes = new TextEncoder().encode(newHeaderStr);

  const bodyView = new Uint8Array(buffer, headerByteLength);
  const outBuffer = new ArrayBuffer(newHeaderBytes.length + keepCount * vertexStride);
  const outBytes = new Uint8Array(outBuffer);
  outBytes.set(newHeaderBytes, 0);

  for (let i = 0; i < keepCount; i++) {
    const srcIndex = Math.min(numVertices - 1, Math.floor(i * step));
    const srcOffset = srcIndex * vertexStride;
    outBytes.set(
      bodyView.subarray(srcOffset, srcOffset + vertexStride),
      newHeaderBytes.length + i * vertexStride
    );
  }

  console.log(`[SplatViewer] Downsampled ${numVertices.toLocaleString()} -> ${keepCount.toLocaleString()} splats for browser performance.`);
  return outBuffer;
}

export function sanitizePlyBuffer(plyBuffer: ArrayBuffer): {
  buffer: ArrayBuffer;
  numVertices: number;
  center: pc.Vec3;
  halfExtents: pc.Vec3;
  maxExtent: number;
  avgScale: number;
  minScale: number;
  maxScale: number;
  avgOpacity: number;
  bboxMin: pc.Vec3;
  bboxMax: pc.Vec3;
} {
  const header = parsePlyHeader(plyBuffer);
  let center = new pc.Vec3(0, 0, 0);
  let halfExtents = new pc.Vec3(2.5, 2.5, 2.5);
  let maxExtent = 2.5;
  let avgScale = 0, minScale = Infinity, maxScale = 0, avgOpacity = 0;
  let bboxMin = new pc.Vec3(-2.5, -2.5, -2.5);
  let bboxMax = new pc.Vec3(2.5, 2.5, 2.5);

  if (!header || !header.isBinaryLittleEndian || header.numVertices === 0) {
    return {
      buffer: plyBuffer,
      numVertices: header?.numVertices || 0,
      center,
      halfExtents,
      maxExtent,
      avgScale,
      minScale: 0,
      maxScale: 0,
      avgOpacity: 0,
      bboxMin,
      bboxMax,
    };
  }

  const { numVertices, vertexStride, headerByteLength, properties } = header;
  const outBuffer = plyBuffer.slice(0);
  const view = new DataView(outBuffer, headerByteLength);

  const xProp = properties["x"], yProp = properties["y"], zProp = properties["z"];
  const s0Prop = properties["scale_0"], s1Prop = properties["scale_1"], s2Prop = properties["scale_2"];
  const opProp = properties["opacity"];
  const r0Prop = properties["rot_0"] || properties["q0"] || properties["qw"];
  const r1Prop = properties["rot_1"] || properties["q1"] || properties["qx"];
  const r2Prop = properties["rot_2"] || properties["q2"] || properties["qy"];
  const r3Prop = properties["rot_3"] || properties["q3"] || properties["qz"];

  if (!s0Prop || !s1Prop || !s2Prop || !r0Prop || !r1Prop || !r2Prop || !r3Prop) {
    const origView = new DataView(plyBuffer, headerByteLength);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (let i = 0; i < numVertices; i += Math.max(1, Math.floor(numVertices / 2000))) {
      const vOff = i * vertexStride;
      const px = xProp ? origView.getFloat32(vOff + xProp.offset, true) : 0;
      const py = yProp ? origView.getFloat32(vOff + yProp.offset, true) : 0;
      const pz = zProp ? origView.getFloat32(vOff + zProp.offset, true) : 0;
      if (isFinite(px) && isFinite(py) && isFinite(pz) && Math.abs(px) < 200 && Math.abs(py) < 200 && Math.abs(pz) < 200) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      }
    }

    const spanX = isFinite(minX) ? (maxX - minX) / 2 : 2.5;
    const spanY = isFinite(minY) ? (maxY - minY) / 2 : 2.5;
    const spanZ = isFinite(minZ) ? (maxZ - minZ) / 2 : 2.5;
    const autoExtent = Math.max(0.5, Math.min(30, Math.max(spanX, spanY, spanZ)));
    const autoTargetScale = Math.max(0.04, Math.min(0.18, autoExtent / 35.0));
    const defaultLogScale = Math.log(autoTargetScale);

    let headerStr = `ply
format binary_little_endian 1.0
comment align
element vertex ${numVertices}
property float x
property float y
property float z
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
`;
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(headerStr);
    const alignedHeaderLength = Math.ceil(headerBytes.length / 4) * 4;

    const convertedBuffer = new ArrayBuffer(alignedHeaderLength + numVertices * 56);
    new Uint8Array(convertedBuffer).set(headerBytes);
    const outFloat = new Float32Array(convertedBuffer, alignedHeaderLength, numVertices * 14);

    const rProp = properties["red"] || properties["diffuse_red"] || properties["r"];
    const gProp = properties["green"] || properties["diffuse_green"] || properties["g"];
    const bProp = properties["blue"] || properties["diffuse_blue"] || properties["b"];
    const f0Prop = properties["f_dc_0"], f1Prop = properties["f_dc_1"], f2Prop = properties["f_dc_2"];
    const SH_C0 = 0.28209479177387814;

    for (let i = 0; i < numVertices; i++) {
      const vOff = i * vertexStride;
      const outOff = i * 14;

      const px = xProp ? origView.getFloat32(vOff + xProp.offset, true) : 0;
      const py = yProp ? origView.getFloat32(vOff + yProp.offset, true) : 0;
      const pz = zProp ? origView.getFloat32(vOff + zProp.offset, true) : 0;

      outFloat[outOff + 0] = isFinite(px) ? px : 0;
      outFloat[outOff + 1] = isFinite(py) ? py : 0;
      outFloat[outOff + 2] = isFinite(pz) ? pz : 0;

      if (f0Prop && f1Prop && f2Prop) {
        outFloat[outOff + 3] = origView.getFloat32(vOff + f0Prop.offset, true);
        outFloat[outOff + 4] = origView.getFloat32(vOff + f1Prop.offset, true);
        outFloat[outOff + 5] = origView.getFloat32(vOff + f2Prop.offset, true);
      } else if (rProp && gProp && bProp) {
        const cr = rProp.size === 1 ? origView.getUint8(vOff + rProp.offset) : origView.getFloat32(vOff + rProp.offset, true) * 255;
        const cg = gProp.size === 1 ? origView.getUint8(vOff + gProp.offset) : origView.getFloat32(vOff + gProp.offset, true) * 255;
        const cb = bProp.size === 1 ? origView.getUint8(vOff + bProp.offset) : origView.getFloat32(vOff + bProp.offset, true) * 255;
        outFloat[outOff + 3] = (cr / 255.0 - 0.5) / SH_C0;
        outFloat[outOff + 4] = (cg / 255.0 - 0.5) / SH_C0;
        outFloat[outOff + 5] = (cb / 255.0 - 0.5) / SH_C0;
      } else {
        outFloat[outOff + 3] = (0.7 - 0.5) / SH_C0;
        outFloat[outOff + 4] = (0.7 - 0.5) / SH_C0;
        outFloat[outOff + 5] = (0.7 - 0.5) / SH_C0;
      }

      outFloat[outOff + 6] = 4.0;
      outFloat[outOff + 7] = defaultLogScale;
      outFloat[outOff + 8] = defaultLogScale;
      outFloat[outOff + 9] = defaultLogScale;
      outFloat[outOff + 10] = 1.0;
      outFloat[outOff + 11] = 0.0;
      outFloat[outOff + 12] = 0.0;
      outFloat[outOff + 13] = 0.0;
    }

    return sanitizePlyBuffer(convertedBuffer);
  }

  const maxLogScale = 1.609;
  const prePassStep = Math.max(1, Math.floor(numVertices / 1000));
  let prePassSum = 0, prePassCount = 0;
  if (s0Prop && s1Prop && s2Prop) {
    for (let i = 0; i < numVertices; i += prePassStep) {
      const vOff = i * vertexStride;
      const s0 = view.getFloat32(vOff + s0Prop.offset, true);
      const s1 = view.getFloat32(vOff + s1Prop.offset, true);
      const s2 = view.getFloat32(vOff + s2Prop.offset, true);
      const lin0 = isFinite(s0) ? (s0 < 0 ? Math.exp(s0) : s0) : 0.015;
      const lin1 = isFinite(s1) ? (s1 < 0 ? Math.exp(s1) : s1) : 0.015;
      const lin2 = isFinite(s2) ? (s2 < 0 ? Math.exp(s2) : s2) : 0.015;
      prePassSum += Math.max(lin0, lin1, lin2);
      prePassCount++;
    }
  }
  const avgNativeScale = prePassCount > 0 ? prePassSum / prePassCount : 0.035;

  let adaptiveCap: number;
  if (numVertices < 1500000) {
    adaptiveCap = Math.min(avgNativeScale, Math.max(0.035, avgNativeScale * 0.72));
  } else if (numVertices <= 3000000) {
    adaptiveCap = Math.min(avgNativeScale, Math.max(0.025, avgNativeScale * 0.80));
  } else {
    if (avgNativeScale <= 0.035) {
      adaptiveCap = Math.max(0.025, avgNativeScale * 1.10);
    } else {
      adaptiveCap = Math.max(0.038, avgNativeScale * 1.15);
    }
  }

  const validXs: number[] = [], validYs: number[] = [], validZs: number[] = [];
  const sampleStep = Math.max(1, Math.floor(numVertices / 5000));

  let totalScaleSum = 0;
  let totalOpacitySum = 0;

  for (let i = 0; i < numVertices; i++) {
    const vOff = i * vertexStride;
    if (vOff + vertexStride > view.byteLength) break;

    if (s0Prop && s1Prop && s2Prop) {
      let s0 = view.getFloat32(vOff + s0Prop.offset, true);
      let s1 = view.getFloat32(vOff + s1Prop.offset, true);
      let s2 = view.getFloat32(vOff + s2Prop.offset, true);

      // Convert linear scales (> 0) to log scales; preserve negative log scales intact
      let logS0 = isFinite(s0) ? (s0 > 0 ? Math.log(s0) : s0) : -4.5;
      let logS1 = isFinite(s1) ? (s1 > 0 ? Math.log(s1) : s1) : -4.5;
      let logS2 = isFinite(s2) ? (s2 > 0 ? Math.log(s2) : s2) : -4.5;

      // Cap extreme runaway scales (> 1.5 in log-space corresponds to > 4.5m Gaussians)
      logS0 = Math.min(1.5, logS0);
      logS1 = Math.min(1.5, logS1);
      logS2 = Math.min(1.5, logS2);

      const linMax = Math.max(Math.exp(logS0), Math.exp(logS1), Math.exp(logS2));
      totalScaleSum += linMax;
      if (linMax < minScale) minScale = linMax;
      if (linMax > maxScale) maxScale = linMax;

      view.setFloat32(vOff + s0Prop.offset, logS0, true);
      view.setFloat32(vOff + s1Prop.offset, logS1, true);
      view.setFloat32(vOff + s2Prop.offset, logS2, true);
    }

    if (opProp) {
      const rawOp = view.getFloat32(vOff + opProp.offset, true);
      let linOp = isFinite(rawOp) ? 1.0 / (1.0 + Math.exp(-rawOp)) : 0.8;
      totalOpacitySum += linOp;
    } else {
      totalOpacitySum += 0.9;
    }

    if (r0Prop && r1Prop && r2Prop && r3Prop) {
      let r0 = view.getFloat32(vOff + r0Prop.offset, true);
      let r1 = view.getFloat32(vOff + r1Prop.offset, true);
      let r2 = view.getFloat32(vOff + r2Prop.offset, true);
      let r3 = view.getFloat32(vOff + r3Prop.offset, true);
      if (!isFinite(r0) || !isFinite(r1) || !isFinite(r2) || !isFinite(r3)) { r0 = 1; r1 = 0; r2 = 0; r3 = 0; }
      let qLen = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3) || 1.0;
      view.setFloat32(vOff + r0Prop.offset, r0 / qLen, true);
      view.setFloat32(vOff + r1Prop.offset, r1 / qLen, true);
      view.setFloat32(vOff + r2Prop.offset, r2 / qLen, true);
      view.setFloat32(vOff + r3Prop.offset, r3 / qLen, true);
    }

    if (xProp && yProp && zProp) {
      const x = view.getFloat32(vOff + xProp.offset, true);
      const y = view.getFloat32(vOff + yProp.offset, true);
      const z = view.getFloat32(vOff + zProp.offset, true);
      if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 200 && Math.abs(y) < 200 && Math.abs(z) < 200) {
        if (i % sampleStep === 0) { validXs.push(x); validYs.push(y); validZs.push(z); }
      }
    }
  }

  avgScale = numVertices > 0 ? totalScaleSum / numVertices : 0.05;
  avgOpacity = numVertices > 0 ? totalOpacitySum / numVertices : 0.8;
  if (!isFinite(minScale)) minScale = 0.001;

  if (validXs.length > 0) {
    validXs.sort((a, b) => a - b); validYs.sort((a, b) => a - b); validZs.sort((a, b) => a - b);
    const p01 = Math.floor(validXs.length * 0.01);
    const p99 = Math.floor(validXs.length * 0.99);
    const minX = validXs[p01]; const maxX = validXs[p99];
    const minY = validYs[p01]; const maxY = validYs[p99];
    const minZ = validZs[p01]; const maxZ = validZs[p99];
    bboxMin = new pc.Vec3(minX, minY, minZ);
    bboxMax = new pc.Vec3(maxX, maxY, maxZ);
    center = bboxMin.clone().add(bboxMax).mulScalar(0.5);
    halfExtents = bboxMax.clone().sub(bboxMin).mulScalar(0.5);
    maxExtent = Math.max(halfExtents.x, halfExtents.y, halfExtents.z);
  }

  return {
    buffer: outBuffer,
    numVertices,
    center,
    halfExtents,
    maxExtent,
    avgScale,
    minScale,
    maxScale,
    avgOpacity,
    bboxMin,
    bboxMax,
  };
}

const SplatViewer: React.FC<SplatViewerProps> = memo(({
  splatUrl,
  file,
  viewMode,
  sceneBounds,
  projectId,
  onOpenFile,
  onFallback,
  cullingConfig,
  captureTrigger,
  camerasUrl,
  onCaptureProgress,
  onCaptureComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<pc.Application | null>(null);
  const cameraRef = useRef<pc.Entity | null>(null);
  const pcBoundsRef = useRef<any>(null);
  const capturingRef = useRef(false);
  const sceneFitRef = useRef<{ center: pc.Vec3; orbitDistance: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPointerLockChange = useCallback(() => {
    if (document.pointerLockElement !== canvasRef.current) {
      // Pointer was unlocked, potentially show cursor or UI elements
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const probeCanvas = document.createElement("canvas");
    const gl = probeCanvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
               probeCanvas.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ||
               probeCanvas.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: false });
    if (!gl) {
      setIsLoading(false);
      setError(null);
      if (onFallback) onFallback();
      return;
    }

    let app: pc.Application;
    try {
      app = new pc.Application(canvas, {
        mouse: new pc.Mouse(document.body),
        keyboard: new pc.Keyboard(window),
        touch: "ontouchstart" in window ? new pc.TouchDevice(canvas) : undefined,
        graphicsDeviceOptions: {
          preserveDrawingBuffer: false,
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
          use3d11: true,
        },
      });
      appRef.current = app;
    } catch (err: unknown) {
      console.warn("[SplatViewer] Hardware WebGL unavailable. Engaging fallback photo/tour mode.", err);
      setIsLoading(false);
      setError("WebGL is not supported in this environment.");
      if (onFallback) {
        onFallback();
      }
      return;
    }

    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.ambientLight = new pc.Color(0.2, 0.2, 0.2);

    const camera = new pc.Entity("camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(0.1, 0.1, 0.1, 0.0),
      nearClip: 0.05,
      farClip: 200,
      fov: 55,
    });
    app.root.addChild(camera);
    cameraRef.current = camera;

    const light = new pc.Entity("light");
    light.addComponent("light", {
      type: "directional",
      color: pc.Color.WHITE,
      intensity: 0.8,
      castShadows: false,
    });
    app.root.addChild(light);
    light.setLocalEulerAngles(45, 30, 0);

    // --- Orbit Controls (dollhouse / floorplan) & First-Person Walkthrough ---
    let orbitAzimuth = 45;
    let orbitElevation = 20;
    let orbitDistance = 5;
    const target = new pc.Vec3(0, 0, 0);

    // "walkthrough" mode previously only orbited around a fixed point from
    // outside the scene - there was no way to actually move through it.
    // This adds real first-person movement, using the same drag-to-look /
    // WASD-to-move scheme the panorama walkthrough elsewhere in the app
    // already uses, instead of introducing pointer-lock (a different
    // interaction model) just for this viewer.
    const isFirstPerson = viewMode === "walkthrough";
    let fpYaw = 180;
    let fpPitch = 0;
    const fpPosition = new pc.Vec3(0, 1.6, 5);
    let fpMoveSpeed = 2.0;

    if (viewMode === "dollhouse") {
      orbitElevation = 45;
      orbitAzimuth = 45;
    } else if (viewMode === "floorplan") {
      orbitElevation = 89.0;
      orbitAzimuth = 0;
    } else {
      orbitElevation = 10;
      orbitAzimuth = 0;
    }

    if (app.mouse) {
      app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
        if (e.buttons[pc.MOUSEBUTTON_LEFT]) {
          if (isFirstPerson) {
            fpYaw -= e.dx * 0.25;
            fpPitch -= e.dy * 0.25;
            fpPitch = Math.max(-85, Math.min(85, fpPitch));
          } else {
            orbitAzimuth -= e.dx * 0.5;
            orbitElevation -= e.dy * 0.5;
            orbitElevation = Math.max(-89.9, Math.min(89.9, orbitElevation));
          }
        } else if (e.buttons[pc.MOUSEBUTTON_RIGHT] || e.buttons[pc.MOUSEBUTTON_MIDDLE]) {
          const panSpeed = orbitDistance * 0.002;
          target.add(camera.right.clone().mulScalar(-e.dx * panSpeed));
          target.add(camera.up.clone().mulScalar(e.dy * panSpeed));
        }
      });
      app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: pc.MouseEvent) => {
        if (isFirstPerson) {
          fpMoveSpeed *= (1 + e.wheelDelta * 0.1);
          fpMoveSpeed = Math.max(0.2, Math.min(20, fpMoveSpeed));
        } else {
          orbitDistance *= (1 + e.wheelDelta * 0.1);
          orbitDistance = Math.max(0.1, Math.min(200, orbitDistance));
        }
      });
      app.mouse.disableContextMenu();
    }

    app.on('update', (dt: number) => {
      // While a frame-capture pass (see captureTrigger effect below) is
      // driving the camera to explicit poses.json positions, don't let the
      // normal orbit/first-person controls fight it and snap the camera
      // back every tick.
      if (capturingRef.current) return;
      if (isFirstPerson) {
        // Apply the orientation FIRST, then read the engine's own
        // camera.forward/camera.right off of it - rather than deriving
        // forward/right from fpYaw by hand, which risks not matching
        // whatever axis convention setEulerAngles actually uses and
        // pointing the camera away from the scene entirely (the earlier
        // black-screen bug: everything loaded fine, the camera just wasn't
        // facing it). camera.right is already used this same way for the
        // orbit pan controls above, so this convention is known-correct.
        camera.setEulerAngles(fpPitch, fpYaw, 0);
        const forward = camera.forward.clone();
        forward.y = 0;
        if (forward.length() > 0.0001) forward.normalize();
        const right = camera.right.clone();
        right.y = 0;
        if (right.length() > 0.0001) right.normalize();

        if (app.keyboard) {
          const step = fpMoveSpeed * dt;
          if (app.keyboard.isPressed(pc.KEY_W) || app.keyboard.isPressed(pc.KEY_UP)) {
            fpPosition.add(forward.clone().mulScalar(step));
          }
          if (app.keyboard.isPressed(pc.KEY_S) || app.keyboard.isPressed(pc.KEY_DOWN)) {
            fpPosition.add(forward.clone().mulScalar(-step));
          }
          if (app.keyboard.isPressed(pc.KEY_A)) {
            fpYaw += 60 * dt;
          }
          if (app.keyboard.isPressed(pc.KEY_D)) {
            fpYaw -= 60 * dt;
          }
          if (app.keyboard.isPressed(pc.KEY_Q)) {
            fpPosition.add(right.clone().mulScalar(-step));
          }
          if (app.keyboard.isPressed(pc.KEY_E)) {
            fpPosition.add(right.clone().mulScalar(step));
          }
        }

        camera.setPosition(fpPosition.x, fpPosition.y, fpPosition.z);
        return;
      }

      const elevationRad = orbitElevation * pc.math.DEG_TO_RAD;
      const azimuthRad = orbitAzimuth * pc.math.DEG_TO_RAD;

      const y = target.y + orbitDistance * Math.sin(elevationRad);
      const x = target.x + orbitDistance * Math.cos(elevationRad) * Math.sin(azimuthRad);
      const z = target.z + orbitDistance * Math.cos(elevationRad) * Math.cos(azimuthRad);

      camera.setPosition(x, y, z);
      camera.lookAt(target);
    });
    // ----------------------

    let active = true;

    async function loadSplat() {
      if (!splatUrl || splatUrl.includes("undefined")) return;
      try {
        setIsLoading(true);
        let splatBuffer: ArrayBuffer | null = null;
        let splatExt = splatUrl.split('.').pop()?.toLowerCase();

        const res = await fetch(splatUrl);
        if (!res.ok) throw new Error("Failed to fetch splat");
        const buffer = await res.arrayBuffer();

        if (splatExt === "lcc") {
          try {
            const zip = await JSZip.loadAsync(buffer);
            const splatFile = zip.file("scene.splat") || zip.file("scene.ply") || zip.file("scene_clean.ply");
            if (!splatFile) throw new Error("Invalid .lcc archive (missing splat/ply data)");
            splatBuffer = await splatFile.async("arraybuffer");
            splatExt = splatFile.name.split('.').pop()?.toLowerCase();
          } catch (zipErr) {
            console.log("LCC fallback triggered: File is not a valid zip archive, treating as raw buffer.");
            if (isPlyBuffer(buffer)) {
              splatBuffer = buffer;
              splatExt = "ply";
            } else {
              splatBuffer = buffer;
              splatExt = "splat";
            }
          }
        } else {
          splatBuffer = buffer;
        }

        if (!active) return;

        let finalBuffer = splatBuffer;
        let sanitizedInfo: ReturnType<typeof sanitizePlyBuffer> | null = null;
        if (finalBuffer) {
          if (splatExt === "splat" || !isPlyBuffer(finalBuffer)) {
            try {
              finalBuffer = splatToPly(finalBuffer);
            } catch (convErr) {
              console.warn("[SplatViewer] splatToPly conversion warning:", convErr);
            }
          }
          finalBuffer = downsamplePlyBinary(finalBuffer, MAX_CLIENT_SPLATS);
          sanitizedInfo = sanitizePlyBuffer(finalBuffer);
          finalBuffer = sanitizedInfo.buffer;
        }

        if (sanitizedInfo && sanitizedInfo.center) {
          // Account for splatEntity 180° X-axis rotation: (x, y, z) -> (x, -y, -z)
          target.set(
            sanitizedInfo.center.x,
            -sanitizedInfo.center.y,
            -sanitizedInfo.center.z
          );
          orbitDistance = Math.max(1.2, Math.min(20.0, sanitizedInfo.maxExtent * 1.3));
          if (viewMode === "dollhouse") orbitDistance *= 1.2;
          if (viewMode === "floorplan") orbitDistance *= 1.4;

          // Remember the ACTUAL fitted center/distance for this scene so a
          // later frame-capture pass (captureTrigger effect below) can
          // rescale the synthetic poses.json orbit (which is generated
          // server-side as a fixed radius=2.5 circle around world origin,
          // independent of this scene's real bounds - see
          // pipeline_orchestrator._estimate_reality_poses_lightweight) onto
          // this scene's real geometry instead of an arbitrary fixed
          // radius, which for most real scenes would otherwise capture
          // frames pointed at empty space or clipped inside the geometry.
          sceneFitRef.current = { center: target.clone(), orbitDistance };

          if (isFirstPerson) {
            // Start just outside the scene looking toward its center, and
            // scale move speed to the scene's actual size so "walking" feels
            // roughly human-paced whether the scene is a small room or a
            // large multi-room space.
            fpPosition.set(target.x, target.y, target.z + orbitDistance);
            // Use lookAt to derive the correct initial yaw/pitch instead of
            // assuming a fixed angle - guarantees the camera actually faces
            // the scene regardless of axis convention.
            camera.setPosition(fpPosition.x, fpPosition.y, fpPosition.z);
            camera.lookAt(target);
            const initialAngles = camera.getEulerAngles();
            fpPitch = initialAngles.x;
            fpYaw = initialAngles.y;
            fpMoveSpeed = Math.max(0.4, Math.min(8.0, sanitizedInfo.maxExtent * 0.35));
          }
        }

        const blob = new Blob([finalBuffer as ArrayBuffer], { type: "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob) + "#scene.ply";

        const asset = new pc.Asset("splat_asset", "gsplat", {
          url: blobUrl,
          filename: "scene.ply"
        });
        app.assets.add(asset);

        asset.ready(() => {
          if (!active) return;
          const splatEntity = new pc.Entity("Splat");
          splatEntity.addComponent("gsplat", {
            asset: asset,
          });
          // Rotate 180° on X to align COLMAP/gsplat Y-down coordinates to PlayCanvas Y-up
          splatEntity.setLocalEulerAngles(180, 0, 0);
          app.root.addChild(splatEntity);
          setIsLoading(false);
          setIsLoaded(true);
        });

        asset.on("error", (err: Error) => {
          if (active) {
            setError("Failed to load splat asset: " + String(err));
            setIsLoading(false);
          }
        });

        app.assets.load(asset);
      } catch (err: unknown) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        }
      }
    }

    loadSplat();

    app.start();

    const handleResize = () => app.resizeCanvas();
    window.addEventListener("resize", handleResize);
    document.addEventListener('pointerlockchange', onPointerLockChange, false);


    return () => {
      active = false;
      window.removeEventListener("resize", handleResize);
      document.removeEventListener('pointerlockchange', onPointerLockChange, false);
      if (appRef.current) {
        try {
          appRef.current.destroy();
        } catch (_) {}
        appRef.current = null;
      }
    };
  }, [onPointerLockChange, splatUrl, viewMode]);

  // ── Frame capture pass (Photo Tour generation from a 3D model) ──────
  // Bumping captureTrigger runs one full pass: fetch the project's
  // cameras.json, fly to each pose in turn (rescaled onto this scene's
  // real fitted bounds via sceneFitRef - see comment above), capture the
  // rendered canvas, and upload each still. Guarded on capturingRef so the
  // normal orbit/first-person update loop doesn't fight the scripted moves.
  useEffect(() => {
    if (!captureTrigger) return;
    const app = appRef.current;
    const camera = cameraRef.current;
    const canvas = canvasRef.current;
    if (!app || !camera || !canvas || !projectId) {
      onCaptureComplete?.({ saved: 0, failed: 0, error: "Scene isn't loaded yet - wait for the model to finish loading, then try again." });
      return;
    }

    let cancelled = false;

    // The capture pass spans several `await`s (network round-trips to
    // /frames/prepare, cameras.json, and per-slice postrender waits), and
    // during that window React/Next can legitimately tear the PlayCanvas
    // app down and rebuild a new one (dev-mode Fast Refresh picking up a
    // file save, React StrictMode's mount/cleanup/remount pass, or the
    // user navigating away and back). When that happens, `app`/`camera`
    // here are still the OLD, now-destroyed instances - PlayCanvas sets
    // `app.graphicsDevice = null` on destroy(), so any further call on
    // them throws "Cannot read properties of null (reading 'canvas')".
    // Before this guard, that either hard-crashed on the very next
    // PlayCanvas call, or (if the destroy landed between capture calls)
    // silently rendered black frames while the loop kept blasting through
    // the remaining waypoints in a tight, near-instant failure loop - the
    // "solid black" and "it ran very fast" reports were almost certainly
    // both this same underlying issue.
    const sceneAlive = () => !!app.graphicsDevice && appRef.current === app;

    const captureOneFrame = () => new Promise<string>((resolve, reject) => {
      if (!sceneAlive()) {
        reject(new Error("__SCENE_RESET__"));
        return;
      }
      app.once("postrender", () => {
        if (!sceneAlive()) {
          reject(new Error("__SCENE_RESET__"));
          return;
        }
        resolve(canvas.toDataURL("image/jpeg", 0.92));
      });
    });

    async function runCapture() {
      // A project can end up with an empty poses.json/cameras.json even
      // after going through reality_capture_bypass (see prepareFrameCapture's
      // docstring on the backend for why) - always check and self-heal
      // before trusting whatever's currently on disk.
      try {
        await prepareFrameCapture(projectId!);
      } catch (err) {
        console.warn("[SplatViewer] prepareFrameCapture failed, proceeding with existing poses.json anyway:", err);
      }

      const posesUrl = camerasUrl || `http://${window.location.hostname}:8000/data/project_${projectId}/cameras.json?_t=${Date.now()}`;
      let cameras: Array<{
        filename: string;
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }> = [];
      try {
        const res = await fetch(posesUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch camera poses (HTTP ${res.status})`);
        const data = await res.json();
        cameras = Array.isArray(data.cameras) ? data.cameras : [];
      } catch (err) {
        if (!cancelled) {
          onCaptureComplete?.({ saved: 0, failed: 0, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (!cameras.length) {
        onCaptureComplete?.({ saved: 0, failed: 0, error: "No camera poses found for this project's cameras.json." });
        return;
      }

      const fit = sceneFitRef.current;
      capturingRef.current = true;
      let saved = 0;
      let failed = 0;

      // PanoWalkthrough decides how to render each waypoint purely from the
      // saved image's pixel aspect ratio: aspect between 1.85 and 2.15 is
      // treated as a REAL equirectangular panorama and mapped directly onto
      // a full 360x180 sphere; anything else goes through its "ordinary
      // photo" path, which synthesizes a seamless pseudo-equirect instead -
      // filling in whatever the single photo didn't cover. A single shot,
      // even a wide-FOV one, still only covers a fraction of the sphere, so
      // rotating past that wedge showed the synthetic fill giving out as
      // empty/black rather than real content. The actual fix is to not rely
      // on synthetic fill at all: build a REAL, complete equirectangular
      // panorama by sweeping a narrow-FOV camera through a full 360deg yaw
      // rotation at each waypoint and tiling the captured strips side by
      // side - real content in every direction, no synthesis needed.
      const origFov = camera.camera?.fov ?? 55;
      const origHorizontalFov = camera.camera?.horizontalFov ?? false;

      const loadImage = (dataUrl: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to decode captured slice"));
        img.src = dataUrl;
      });

      // Slice count trades seam visibility against total render time (each
      // slice is a full postrender-settle + capture round trip). 16 slices
      // = 22.5deg each, narrow enough that perspective-vs-equirectangular
      // warping per slice is minor, without ballooning capture time.
      const SLICES = 16;
      const SLICE_FOV = 360 / SLICES;
      const SLICE_W = 160;
      const SLICE_H = 520;
      const EQUIRECT_W = SLICES * SLICE_W;   // 2560 - aspect 2:1, real panorama
      const EQUIRECT_H = EQUIRECT_W / 2;     // 1280

      // app was set up with FILLMODE_FILL_WINDOW (see scene-init effect
      // above), which keeps auto-resizing the canvas back to the browser
      // window on its own - fighting a plain resizeCanvas(w,h) call here.
      // Without disabling that first, each "slice" capture below actually
      // grabs the full window-sized render and gets squished into a tiny
      // SLICE_W x SLICE_H rectangle by drawImage, which is exactly what
      // produces a smeared/stretched result instead of a clean narrow
      // slice. FILLMODE_NONE turns off that auto-refit for the duration of
      // the capture pass; restored (with the matching resizeCanvas() call)
      // once every waypoint is done.
      if (!sceneAlive()) {
        capturingRef.current = false;
        if (!cancelled) {
          onCaptureComplete?.({ saved: 0, failed: 0, error: "The 3D scene reloaded before capture could start. Wait for the model to finish loading, then try again." });
        }
        return;
      }
      app.setCanvasFillMode(pc.FILLMODE_NONE);

      async function buildEquirectPanorama(pos: { x: number; y: number; z: number }): Promise<string> {
        const out = document.createElement("canvas");
        out.width = EQUIRECT_W;
        out.height = EQUIRECT_H;
        const ctx = out.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, EQUIRECT_W, EQUIRECT_H);

        camera!.setPosition(pos.x, pos.y, pos.z);
        if (camera!.camera) {
          camera!.camera.horizontalFov = true;
          camera!.camera.fov = SLICE_FOV;
        }
        app!.resizeCanvas(SLICE_W, SLICE_H);

        const destY = Math.round((EQUIRECT_H - SLICE_H) / 2);
        for (let s = 0; s < SLICES; s++) {
          camera!.setEulerAngles(0, s * SLICE_FOV, 0);
          // Let one frame settle at the new yaw, then capture the next.
          await captureOneFrame();
          const dataUrl = await captureOneFrame();
          const img = await loadImage(dataUrl);
          ctx.drawImage(img, s * SLICE_W, destY, SLICE_W, SLICE_H);
        }

        return out.toDataURL("image/jpeg", 0.9);
      }

      let sceneWasReset = false;
      // Every prior failure mode we'd diagnosed (app torn down mid-capture,
      // culling, fillmode/resize fighting) got fixed blind, from screenshots
      // alone, because nothing surfaced the ACTUAL thrown error - console.warn
      // only goes to devtools, and the UI just showed a bare "N failed"
      // count. Capturing the first real error message here and putting it in
      // the completion banner (below) means the next failure is diagnosable
      // from the screenshot instead of guessed at again.
      let firstErrorMessage: string | null = null;
      for (let i = 0; i < cameras.length && !cancelled; i++) {
        if (!sceneAlive()) { sceneWasReset = true; break; }
        const camPose = cameras[i];
        try {
          let posX = camPose.position.x, posY = camPose.position.y, posZ = camPose.position.z;

          if (fit) {
            // These synthetic poses are a fixed radius=2.5 circle around
            // world origin, generated generically without knowing whether
            // the asset is a small standalone object (fine to orbit from
            // outside) or an enclosed interior room (a Marble "world" import
            // almost always is).
            //
            // History: originally placed the camera at center + direction *
            // orbitDistance (the scene's own OUTSIDE-viewing distance) -
            // that pushed it straight through the walls for a room, showing
            // the exterior instead of the interior. Collapsing every
            // waypoint to the exact center fixed that, but then every
            // "waypoint" was the same physical spot - just spinning in
            // place - which isn't a walkthrough at all. This keeps each
            // pose's original angle as a real STANDING POSITION on a small
            // circle safely INSIDE the room (not the outside-viewing
            // radius), so each waypoint is a distinct spot to walk to.
            const dir = new pc.Vec3(posX, posY, posZ);
            if (dir.length() > 0.0001) dir.normalize(); else dir.set(0, 0, 1);
            const innerRadius = fit.orbitDistance * 0.35;
            const realPos = fit.center.clone().add(dir.clone().mulScalar(innerRadius));
            posX = realPos.x; posY = realPos.y; posZ = realPos.z;
          }

          const dataUrl = await buildEquirectPanorama({ x: posX, y: posY, z: posZ });
          await saveRenderedFrame(projectId, camPose.filename, dataUrl);
          saved++;
        } catch (err) {
          if (err instanceof Error && err.message === "__SCENE_RESET__") {
            sceneWasReset = true;
            break;
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[SplatViewer] Frame capture failed for ${camPose.filename}:`, err);
          if (!firstErrorMessage) firstErrorMessage = msg;
          failed++;
        }
        onCaptureProgress?.(i + 1, cameras.length);
      }

      // Restore the live view's normal viewport/FOV - the capture
      // resolution/FOV above was only meant for the saved stills. Only if
      // the app we captured with is still the live one; if it's gone,
      // there's nothing to restore and touching it again would just throw.
      if (sceneAlive()) {
        try {
          if (camera.camera) {
            camera.camera.fov = origFov;
            camera.camera.horizontalFov = origHorizontalFov;
          }
          app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
          app.resizeCanvas();
        } catch (err) {
          console.warn("[SplatViewer] Failed to restore viewport after capture:", err);
        }
      }

      capturingRef.current = false;
      if (!cancelled) {
        if (sceneWasReset) {
          onCaptureComplete?.({
            saved,
            failed,
            error: saved > 0
              ? `The 3D scene reloaded partway through (${saved} of ${cameras.length} frames saved before that happened). This usually means the page hot-reloaded mid-capture - try again without editing/saving files while it runs.`
              : "The 3D scene reloaded right as capture started, before any frames were saved. Wait for the model to finish loading, then try again.",
          });
        } else if (failed > 0) {
          onCaptureComplete?.({
            saved,
            failed,
            error: saved > 0
              ? `Captured ${saved} of ${cameras.length} frames - ${failed} failed. First failure: ${firstErrorMessage || "unknown error"}`
              : `All ${failed} frame(s) failed to capture. Error: ${firstErrorMessage || "unknown error"}`,
          });
        } else {
          onCaptureComplete?.({ saved, failed });
        }
      }
    }

    runCapture();

    return () => {
      cancelled = true;
      capturingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureTrigger]);

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {isLoading && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", color: "white" }}>
          Loading...
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", color: "red" }}>
          Error: {error}
        </div>
      )}
      {!isLoading && !error && viewMode === "walkthrough" && (
        <div style={{
          position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
          color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
          background: "rgba(0,0,0,0.55)", padding: "6px 12px", borderRadius: 8, pointerEvents: "none",
          whiteSpace: "nowrap",
        }}>
          W/S Glide Walk &nbsp;|&nbsp; A/D Rotate &nbsp;|&nbsp; Drag Free Look &nbsp;|&nbsp; Q/E Strafe &nbsp;|&nbsp; Scroll Speed
        </div>
      )}
    </div>
  );
});

SplatViewer.displayName = "SplatViewer";

export default SplatViewer;