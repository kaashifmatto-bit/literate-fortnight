"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export interface MeshStats {
  filename: string;
  fileSizeFormatted: string;
  fileSizeBytes: number;
  vertexCount: number;
  triangleCount: number;
  boundingBox: {
    x: number;
    y: number;
    z: number;
  };
}

interface MeshCheckViewerProps {
  file: File;
  onStatsLoaded?: (stats: MeshStats) => void;
  onError?: (errorMessage: string) => void;
}

export default function MeshCheckViewer({
  file,
  onStatsLoaded,
  onError,
}: MeshCheckViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingText, setLoadingText] = useState("Parsing 3D Mesh...");
  const [webGlError, setWebGlError] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"webgl" | "software" | null>(null);

  const onStatsLoadedRef = useRef(onStatsLoaded);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onStatsLoadedRef.current = onStatsLoaded;
    onErrorRef.current = onError;
  }, [onStatsLoaded, onError]);

  useEffect(() => {
    if (!containerRef.current || !file) return;

    setIsLoading(true);
    setWebGlError(null);
    setRenderMode(null);
    setLoadingText("Initializing 3D WebGL graphics context...");

    const container = containerRef.current;
    container.innerHTML = ""; // Clean DOM node

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    // Silent WebGL probe — check if WebGL context can be created without triggering browser blocked warnings
    const isWebGLSupported = (() => {
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        if (!gl) return false;
        const loseCtx = gl.getExtension("WEBGL_lose_context");
        if (loseCtx) loseCtx.loseContext();
        return true;
      } catch {
        return false;
      }
    })();

    let renderer: THREE.WebGLRenderer | null = null;

    if (isWebGLSupported) {
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "default",
          failIfMajorPerformanceCaveat: false,
        });
        console.info("[MeshCheckViewer] THREE.WebGLRenderer GPU hardware context initialized successfully.");
      } catch (err) {
        console.warn("[MeshCheckViewer] Hardware WebGL graphics context creation unavailable.", err);
      }
    }

    if (!renderer) {
      // ── SOFTWARE 2D CANVAS FALLBACK RENDERER ──
      const canvas = document.createElement("canvas");
      canvas.className = "w-full h-full block";
      container.appendChild(canvas);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) {
        setIsLoading(false);
        setWebGlError("Unable to initialize WebGL or 2D graphics context.");
        if (onErrorRef.current) onErrorRef.current("Graphics context unavailable.");
        return;
      }

      ctx2d.scale(dpr, dpr);
      setRenderMode("software");
      console.warn("[MeshCheckViewer] Falling back to 2D Software Renderer due to WebGL failure.");

      let rotX = 0.4;
      let rotY = 0.6;
      let zoom = 1.0;
      let isDragging = false;
      let prevMousePos = { x: 0, y: 0 };

      interface SoftwareTriangle {
        p1: THREE.Vector3;
        p2: THREE.Vector3;
        p3: THREE.Vector3;
        normal: THREE.Vector3;
        color: THREE.Color;
      }
      let loadedSoftwareTriangles: SoftwareTriangle[] = [];
      let loadedBBox = { x: 1, y: 1, z: 1 };
      let calculatedFloorY = -0.5;
      let animationFrameId2D: number;

      const draw2DPipeline = () => {
        ctx2d.clearRect(0, 0, width, height);

        const bgGradient = ctx2d.createRadialGradient(
          width / 2,
          height / 2,
          30,
          width / 2,
          height / 2,
          Math.max(width, height) * 0.7
        );
        bgGradient.addColorStop(0, "#2d2f45"); // Studio central spotlight
        bgGradient.addColorStop(0.5, "#1c1d2b");
        bgGradient.addColorStop(1, "#0e0f17"); // Dark outer vignette
        ctx2d.fillStyle = bgGradient;
        ctx2d.fillRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;
        const scale = (Math.min(width, height) / 3) * zoom;

        const cosX = Math.cos(rotX);
        const sinX = Math.sin(rotX);
        const cosY = Math.cos(rotY);
        const sinY = Math.sin(rotY);

        // Floor Grid Snapped to Model Base (Crisp See-Through Lines)
        const floorY = calculatedFloorY;

        for (let g = -5; g <= 5; g += 1) {
          const isCenter = g === 0;
          ctx2d.strokeStyle = isCenter ? "rgba(165, 180, 252, 0.7)" : "rgba(129, 140, 248, 0.38)";
          ctx2d.lineWidth = isCenter ? 1.5 : 1;

          const gx1 = g * 0.3;
          const gz1 = -1.5;
          const gx2 = g * 0.3;
          const gz2 = 1.5;

          const x1 = gx1 * cosY - gz1 * sinY;
          const z1 = gx1 * sinY + gz1 * cosY;
          const y1Trans = floorY * cosX - z1 * sinX;

          const x2 = gx2 * cosY - gz2 * sinY;
          const z2 = gx2 * sinY + gz2 * cosY;
          const y2Trans = floorY * cosX - z2 * sinX;

          ctx2d.beginPath();
          ctx2d.moveTo(cx + x1 * scale, cy - y1Trans * scale);
          ctx2d.lineTo(cx + x2 * scale, cy - y2Trans * scale);
          ctx2d.stroke();

          const gx3 = -1.5;
          const gz3 = g * 0.3;
          const gx4 = 1.5;
          const gz4 = g * 0.3;

          const x3 = gx3 * cosY - gz3 * sinY;
          const z3 = gx3 * sinY + gz3 * cosY;
          const y3Trans = floorY * cosX - z3 * sinX;

          const x4 = gx4 * cosY - gz4 * sinY;
          const z4 = gx4 * sinY + gz4 * cosY;
          const y4Trans = floorY * cosX - z4 * sinX;

          ctx2d.beginPath();
          ctx2d.moveTo(cx + x3 * scale, cy - y3Trans * scale);
          ctx2d.lineTo(cx + x4 * scale, cy - y4Trans * scale);
          ctx2d.stroke();
        }

        // Soft See-Through Contact Shadow (Feathered Radial Blur)
        const shadowYTrans = floorY * cosX;
        const shadowX = cx;
        const shadowY = cy - shadowYTrans * scale;
        const shadowRx = scale * 0.7;
        const shadowRy = scale * 0.22;

        ctx2d.save();
        const shadowGrad = ctx2d.createRadialGradient(shadowX, shadowY, 0, shadowX, shadowY, shadowRx);
        shadowGrad.addColorStop(0, "rgba(0, 0, 0, 0.35)");
        shadowGrad.addColorStop(0.6, "rgba(0, 0, 0, 0.15)");
        shadowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx2d.fillStyle = shadowGrad;
        ctx2d.beginPath();
        ctx2d.ellipse(shadowX, shadowY, shadowRx, shadowRy, 0, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.restore();

        // Dynamic 3D Studio Lighting & Specular Gloss
        interface ProjectedTriangle {
          px1: number; py1: number;
          px2: number; py2: number;
          px3: number; py3: number;
          zAvg: number;
          r: number; g: number; b: number;
        }

        const projectedTriangles: ProjectedTriangle[] = [];

        for (let i = 0; i < loadedSoftwareTriangles.length; i++) {
          const t = loadedSoftwareTriangles[i];
          const x1 = t.p1.x * cosY - t.p1.z * sinY;
          const z1 = t.p1.x * sinY + t.p1.z * cosY;
          const y1 = t.p1.y * cosX - z1 * sinX;
          const z1Final = t.p1.y * sinX + z1 * cosX;

          const x2 = t.p2.x * cosY - t.p2.z * sinY;
          const z2 = t.p2.x * sinY + t.p2.z * cosY;
          const y2 = t.p2.y * cosX - z2 * sinX;
          const z2Final = t.p2.y * sinX + z2 * cosX;

          const x3 = t.p3.x * cosY - t.p3.z * sinY;
          const z3 = t.p3.x * sinY + t.p3.z * cosY;
          const y3 = t.p3.y * cosX - z3 * sinX;
          const z3Final = t.p3.y * sinX + z3 * cosX;

          const px1 = cx + x1 * scale;
          const py1 = cy - y1 * scale;
          const px2 = cx + x2 * scale;
          const py2 = cy - y2 * scale;
          const px3 = cx + x3 * scale;
          const py3 = cy - y3 * scale;

          const cross = (px2 - px1) * (py3 - py1) - (py2 - py1) * (px3 - px1);
          if (Math.abs(cross) < 0.001) continue; // Skip zero-area degenerate faces

          // Transform 3D Normal vector by camera view rotation angles
          const nx = t.normal.x * cosY - t.normal.z * sinY;
          const nzTemp = t.normal.x * sinY + t.normal.z * cosY;
          const ny = t.normal.y * cosX - nzTemp * sinX;
          const nzFinal = t.normal.y * sinX + nzTemp * cosX;

          // Camera View-Space Back-Face Culling:
          // Skip faces pointing away from the camera to eliminate interior dark bleed-through & speckles
          if (nzFinal <= -0.05) continue;

          // Studio Key Light + Ambient Fill + Top Rim Specular Gloss
          const dotKey = Math.max(0, nx * 0.45 + ny * 0.75 + nzFinal * 0.48);
          const dotFill = Math.max(0, nx * -0.4 + ny * -0.2 + nzFinal * 0.35);
          const dotRim = Math.max(0, ny * 0.70 + nzFinal * 0.70);
          const spec = Math.pow(Math.max(0, nzFinal), 10) * 0.45;

          const lightFactor = 0.40 + dotKey * 0.82 + dotFill * 0.30 + Math.pow(dotRim, 3) * 0.30;

          // Gamma Correction (0.85 exponent) & Metallic Lacquer Highlights
          const r = Math.min(255, Math.round(Math.pow(t.color.r, 0.85) * 255 * lightFactor + spec * 80));
          const g = Math.min(255, Math.round(Math.pow(t.color.g, 0.85) * 255 * lightFactor + spec * 80));
          const b = Math.min(255, Math.round(Math.pow(t.color.b, 0.85) * 255 * lightFactor + spec * 80));

          const zAvg = (z1Final + z2Final + z3Final) / 3;
          projectedTriangles.push({ px1, py1, px2, py2, px3, py3, zAvg, r, g, b });
        }

        projectedTriangles.sort((a, b) => a.zAvg - b.zAvg);

        ctx2d.lineJoin = "round";
        ctx2d.lineCap = "round";

        // Render contiguous triangles without index skipping
        for (let i = 0; i < projectedTriangles.length; i++) {
          const tri = projectedTriangles[i];
          ctx2d.beginPath();
          ctx2d.moveTo(tri.px1, tri.py1);
          ctx2d.lineTo(tri.px2, tri.py2);
          ctx2d.lineTo(tri.px3, tri.py3);
          ctx2d.closePath();
          const colStr = `rgb(${tri.r}, ${tri.g}, ${tri.b})`;
          ctx2d.fillStyle = colStr;
          ctx2d.strokeStyle = colStr;
          ctx2d.lineWidth = 1.35; // Fine-tuned seam lock
          ctx2d.fill();
          ctx2d.stroke();
        }

        // Top-Left Engine Status Badge
        ctx2d.fillStyle = "rgba(15, 23, 42, 0.88)";
        ctx2d.strokeStyle = "rgba(99, 102, 241, 0.45)";
        ctx2d.beginPath();
        ctx2d.roundRect(16, 16, 275, 28, 6);
        ctx2d.fill();
        ctx2d.stroke();

        ctx2d.fillStyle = "#c7d2fe";
        ctx2d.font = "600 11px sans-serif";
        ctx2d.fillText("⚡ 2D Studio Software Engine • Vivid GLB", 26, 34);

        // Bottom Control Hint HUD Badge
        const hudText = "🖱️ Left-Click + Drag to Rotate  •  🔍 Scroll to Zoom";
        ctx2d.font = "500 11px sans-serif";
        const hudW = ctx2d.measureText(hudText).width + 24;
        const hudX = width / 2 - hudW / 2;
        const hudY = height - 42;

        ctx2d.fillStyle = "rgba(15, 23, 42, 0.85)";
        ctx2d.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx2d.beginPath();
        ctx2d.roundRect(hudX, hudY, hudW, 26, 13);
        ctx2d.fill();
        ctx2d.stroke();

        ctx2d.fillStyle = "#94a3b8";
        ctx2d.fillText(hudText, hudX + 12, hudY + 17);
      };

      let isRenderPending = false;
      const requestRedraw = () => {
        if (!isRenderPending) {
          isRenderPending = true;
          requestAnimationFrame(() => {
            isRenderPending = false;
            draw2DPipeline();
          });
        }
      };

      const handleMouseDown = (e: MouseEvent) => {
        isDragging = true;
        prevMousePos = { x: e.clientX, y: e.clientY };
      };
      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - prevMousePos.x;
        const dy = e.clientY - prevMousePos.y;
        rotY += dx * 0.01;
        rotX += dy * 0.01;
        prevMousePos = { x: e.clientX, y: e.clientY };
        requestRedraw();
      };
      const handleMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          requestRedraw(); // Final high-detail static redraw
        }
      };
      const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
        zoom *= e.deltaY > 0 ? 0.9 : 1.1;
        zoom = Math.max(0.2, Math.min(zoom, 5.0));
        requestRedraw();
      };

      canvas.addEventListener("mousedown", handleMouseDown);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      canvas.addEventListener("wheel", handleWheel, { passive: false });

      const handleLoadedObjectFallback = (object: THREE.Object3D) => {
        let totalVerts = 0;
        let totalTris = 0;
        const tris: SoftwareTriangle[] = [];

        object.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const geom = mesh.geometry;
            if (geom && geom.attributes.position) {
              const pos = geom.attributes.position;
              totalVerts += pos.count;
              const index = geom.index;
              const triCount = index ? index.count / 3 : pos.count / 3;
              totalTris += triCount;

              // Extract material base color & image texture maps
              let defaultMatColor = new THREE.Color(0xd4d8e8);
              let textureData: Uint8ClampedArray | null = null;
              let texW = 0;
              let texH = 0;

              if (mesh.material) {
                const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
                if (mat && "color" in mat && (mat as THREE.MeshStandardMaterial).color) {
                  defaultMatColor = (mat as THREE.MeshStandardMaterial).color.clone();
                }
                const tex = (mat as THREE.MeshStandardMaterial).map;
                if (tex && tex.image) {
                  try {
                    const img = tex.image;
                    if (img.width && img.height) {
                      const offCanvas = document.createElement("canvas");
                      offCanvas.width = img.width;
                      offCanvas.height = img.height;
                      const offCtx = offCanvas.getContext("2d");
                      if (offCtx) {
                        offCtx.drawImage(img, 0, 0);
                        textureData = offCtx.getImageData(0, 0, img.width, img.height).data;
                        texW = img.width;
                        texH = img.height;
                      }
                    }
                  } catch { }
                }
              }

              const colors = geom.attributes.color;
              const uvs = geom.attributes.uv;

              const getTriColor = (i1: number, i2: number, i3: number): THREE.Color => {
                if (uvs && textureData && texW > 0 && texH > 0) {
                  const u = (uvs.getX(i1) + uvs.getX(i2) + uvs.getX(i3)) / 3;
                  const v = (uvs.getY(i1) + uvs.getY(i2) + uvs.getY(i3)) / 3;
                  const uClamped = Math.max(0, Math.min(1, u));
                  const vClamped = Math.max(0, Math.min(1, v));
                  const tx = Math.floor(uClamped * (texW - 1));
                  const ty = Math.floor((1 - vClamped) * (texH - 1));
                  const idx = (ty * texW + tx) * 4;
                  return new THREE.Color(
                    textureData[idx] / 255,
                    textureData[idx + 1] / 255,
                    textureData[idx + 2] / 255
                  );
                }

                if (colors) {
                  const rVal = (colors.getX(i1) + colors.getX(i2) + colors.getX(i3)) / 3;
                  const gVal = (colors.getY(i1) + colors.getY(i2) + colors.getY(i3)) / 3;
                  const bVal = (colors.getZ(i1) + colors.getZ(i2) + colors.getZ(i3)) / 3;
                  return new THREE.Color(rVal, gVal, bVal);
                }

                return defaultMatColor.clone();
              };

              const addTri = (p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, triColor: THREE.Color) => {
                const vA = new THREE.Vector3().subVectors(p2, p1);
                const vB = new THREE.Vector3().subVectors(p3, p1);
                const norm = new THREE.Vector3().crossVectors(vA, vB).normalize();
                if (isNaN(norm.x)) norm.set(0, 1, 0);
                tris.push({ p1, p2, p3, normal: norm, color: triColor });
              };

              const stride = Math.max(1, Math.floor(triCount / 7500));
              if (index) {
                for (let i = 0; i < index.count; i += 3 * stride) {
                  const i1 = index.getX(i);
                  const i2 = index.getX(i + 1);
                  const i3 = index.getX(i + 2);
                  addTri(
                    new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1)),
                    new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2)),
                    new THREE.Vector3(pos.getX(i3), pos.getY(i3), pos.getZ(i3)),
                    getTriColor(i1, i2, i3)
                  );
                }
              } else {
                for (let i = 0; i < pos.count; i += 3 * stride) {
                  const i1 = i;
                  const i2 = i + 1;
                  const i3 = i + 2;
                  addTri(
                    new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1)),
                    new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2)),
                    new THREE.Vector3(pos.getX(i3), pos.getY(i3), pos.getZ(i3)),
                    getTriColor(i1, i2, i3)
                  );
                }
              }
            }
          }
        });

        const bbox = new THREE.Box3().setFromObject(object);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        let minY = 0;
        tris.forEach((t) => {
          t.p1.sub(center).divideScalar(maxDim);
          t.p2.sub(center).divideScalar(maxDim);
          t.p3.sub(center).divideScalar(maxDim);
          minY = Math.min(minY, t.p1.y, t.p2.y, t.p3.y);
        });

        // Calculate exact floor level at bottom of normalized model triangles
        calculatedFloorY = minY - 0.02;

        loadedSoftwareTriangles = tris;
        loadedBBox = { x: Math.round(size.x * 100) / 100, y: Math.round(size.y * 100) / 100, z: Math.round(size.z * 100) / 100 };

        setIsLoading(false);
        draw2DPipeline();

        const sizeMb = file.size / (1024 * 1024);
        const formattedSize = sizeMb >= 1 ? `${sizeMb.toFixed(2)} MB` : `${(file.size / 1024).toFixed(1)} KB`;

        if (onStatsLoadedRef.current) {
          onStatsLoadedRef.current({
            filename: file.name,
            fileSizeFormatted: formattedSize,
            fileSizeBytes: file.size,
            vertexCount: Math.round(totalVerts),
            triangleCount: Math.round(totalTris),
            boundingBox: loadedBBox,
          });
        }
      };

      const ext = file.name.toLowerCase().split(".").pop();
      const manager = new THREE.LoadingManager();
      manager.onError = (url) => {
        console.info(`[MeshCheckViewer] Optional texture resource skipped: ${url}`);
      };

      if (ext === "glb" || ext === "gltf") {
        const reader = new FileReader();
        reader.onload = (e) => {
          const contents = e.target?.result as ArrayBuffer;
          if (!contents) return;
          new GLTFLoader(manager).parse(
            contents,
            "",
            (gltf) => {
              handleLoadedObjectFallback(gltf.scene);
            },
            (err) => {
              console.error("[MeshCheckViewer] 2D Fallback GLTFLoader error:", err);
            }
          );
        };
        reader.readAsArrayBuffer(file);
      } else if (ext === "obj") {
        const reader = new FileReader();
        reader.onload = (e) => {
          const txt = e.target?.result as string;
          handleLoadedObjectFallback(new OBJLoader(manager).parse(txt));
        };
        reader.readAsText(file);
      }

      return () => {
        if (animationFrameId2D) cancelAnimationFrame(animationFrameId2D);
        canvas.removeEventListener("mousedown", handleMouseDown);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        canvas.removeEventListener("wheel", handleWheel);
        canvas.remove();
      };
    } else {
      // ── REAL HARDWARE WEBGL RENDERER PATH ──
      const activeRenderer = renderer;
      activeRenderer.setSize(width, height, false);
      activeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      activeRenderer.shadowMap.enabled = true;

      const canvas = activeRenderer.domElement;
      canvas.className = "w-full h-full block";
      container.appendChild(canvas);
      setRenderMode("webgl");

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0f1015);

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);
      camera.position.set(0, 2, 5);
      camera.rotation.order = "YXZ";

      // ── First-person WASD + drag-look navigation, mirroring SplatViewer.tsx's
      // walkthrough scheme (drag to look, WASD/arrows to move, Q/E to strafe,
      // scroll to adjust speed) so a .glb/.obj upload gets the same in-scene
      // navigation as a .splat/.ply/.lcc one instead of being orbit/zoom-only.
      const DEG2RAD = Math.PI / 180;
      let fpYaw = 0;
      let fpPitch = 0;
      const fpPosition = camera.position.clone();
      let fpMoveSpeed = 2.0;
      const pressedKeys = new Set<string>();
      let isDragging = false;
      let prevMouse = { x: 0, y: 0 };

      const onFpMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        isDragging = true;
        prevMouse = { x: e.clientX, y: e.clientY };
      };
      const onFpMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - prevMouse.x;
        const dy = e.clientY - prevMouse.y;
        prevMouse = { x: e.clientX, y: e.clientY };
        fpYaw -= dx * 0.25;
        fpPitch -= dy * 0.25;
        fpPitch = Math.max(-85, Math.min(85, fpPitch));
      };
      const onFpMouseUp = () => {
        isDragging = false;
      };
      const onFpWheel = (e: WheelEvent) => {
        e.preventDefault();
        fpMoveSpeed *= e.deltaY > 0 ? 0.9 : 1.1;
        fpMoveSpeed = Math.max(0.2, Math.min(20, fpMoveSpeed));
      };
      const onFpKeyDown = (e: KeyboardEvent) => pressedKeys.add(e.code);
      const onFpKeyUp = (e: KeyboardEvent) => pressedKeys.delete(e.code);

      canvas.addEventListener("mousedown", onFpMouseDown);
      window.addEventListener("mousemove", onFpMouseMove);
      window.addEventListener("mouseup", onFpMouseUp);
      canvas.addEventListener("wheel", onFpWheel, { passive: false });
      window.addEventListener("keydown", onFpKeyDown);
      window.addEventListener("keyup", onFpKeyUp);

      const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
      scene.add(ambientLight);

      const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.8);
      dirLight1.position.set(5, 10, 7);
      scene.add(dirLight1);

      const dirLight2 = new THREE.DirectionalLight(0x818cf8, 1.0);
      dirLight2.position.set(-5, -5, -5);
      scene.add(dirLight2);

      const gridHelper = new THREE.GridHelper(10, 20, 0x6366f1, 0x334155);
      gridHelper.position.y = 0;
      scene.add(gridHelper);

      let animationFrameId: number;
      let lastFrameTime = performance.now();

      const animate = () => {
        animationFrameId = requestAnimationFrame(animate);
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
        lastFrameTime = now;

        camera.rotation.set(fpPitch * DEG2RAD, fpYaw * DEG2RAD, 0);

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() > 0.0001) forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, camera.up);
        if (right.lengthSq() > 0.0001) right.normalize();

        const step = fpMoveSpeed * dt;
        if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) fpPosition.addScaledVector(forward, step);
        if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) fpPosition.addScaledVector(forward, -step);
        if (pressedKeys.has("KeyA")) fpYaw += 60 * dt;
        if (pressedKeys.has("KeyD")) fpYaw -= 60 * dt;
        if (pressedKeys.has("KeyQ")) fpPosition.addScaledVector(right, -step);
        if (pressedKeys.has("KeyE")) fpPosition.addScaledVector(right, step);

        camera.position.copy(fpPosition);
        activeRenderer.render(scene, camera);
      };

      animate();

      const handleLoadedObject = (object: THREE.Object3D) => {
        setLoadingText("Calculating 3D mesh geometry statistics...");

        let totalVertices = 0;
        let totalTriangles = 0;

        object.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const geom = mesh.geometry;
            if (geom) {
              if (geom.attributes.position) {
                totalVertices += geom.attributes.position.count;
              }
              if (geom.index) {
                totalTriangles += geom.index.count / 3;
              } else if (geom.attributes.position) {
                totalTriangles += geom.attributes.position.count / 3;
              }

              if (mesh.material) {
                if (Array.isArray(mesh.material)) {
                  mesh.material.forEach((m) => {
                    m.side = THREE.DoubleSide;
                  });
                } else {
                  mesh.material.side = THREE.DoubleSide;
                }
              }
            }
          }
        });

        const bbox = new THREE.Box3().setFromObject(object);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());

        object.position.sub(center);
        gridHelper.position.y = -size.y / 2;

        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = camera.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2))) * 1.6;
        cameraZ = Math.max(cameraZ, 1.5);

        camera.position.set(cameraZ * 0.7, cameraZ * 0.5, cameraZ);
        camera.lookAt(0, 0, 0);
        fpYaw = camera.rotation.y / DEG2RAD;
        fpPitch = camera.rotation.x / DEG2RAD;
        fpPosition.copy(camera.position);
        fpMoveSpeed = Math.max(0.3, Math.min(8.0, maxDim * 0.35));

        scene.add(object);
        setIsLoading(false);

        const sizeMb = file.size / (1024 * 1024);
        const formattedSize =
          sizeMb >= 1
            ? `${sizeMb.toFixed(2)} MB`
            : `${(file.size / 1024).toFixed(1)} KB`;

        const stats: MeshStats = {
          filename: file.name,
          fileSizeFormatted: formattedSize,
          fileSizeBytes: file.size,
          vertexCount: Math.round(totalVertices),
          triangleCount: Math.round(totalTriangles),
          boundingBox: {
            x: Math.round(size.x * 100) / 100,
            y: Math.round(size.y * 100) / 100,
            z: Math.round(size.z * 100) / 100,
          },
        };

        if (onStatsLoadedRef.current) {
          onStatsLoadedRef.current(stats);
        }
      };

      const handleLoadError = (error: unknown) => {
        setIsLoading(false);
        const msg =
          error instanceof Error
            ? error.message
            : "Failed to parse 3D mesh file. The file may be corrupt or invalid.";
        console.error("[MeshCheckViewer] Error loading 3D model in WebGL mode:", error);
        if (onErrorRef.current) {
          onErrorRef.current(msg);
        }
      };

      const loadingManager = new THREE.LoadingManager();
      loadingManager.onError = (url) => {
        console.warn(`[MeshCheckViewer] WebGL mode resource loading warning for: ${url}`);
      };
      const ext = file.name.toLowerCase().split(".").pop();

      if (ext === "glb" || ext === "gltf") {
        setLoadingText("Parsing GLTF/GLB binary container...");
        const reader = new FileReader();
        reader.onload = (e) => {
          const contents = e.target?.result as ArrayBuffer;
          if (!contents) {
            handleLoadError(new Error("Failed to read GLTF/GLB file buffer."));
            return;
          }
          try {
            const gltfLoader = new GLTFLoader(loadingManager);
            gltfLoader.parse(
              contents,
              "",
              (gltf) => {
                handleLoadedObject(gltf.scene);
              },
              (err) => {
                handleLoadError(err);
              }
            );
          } catch (err) {
            handleLoadError(err);
          }
        };
        reader.onerror = (err) => handleLoadError(err);
        reader.readAsArrayBuffer(file);
      } else if (ext === "obj") {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target?.result as string;
          if (!text) {
            handleLoadError(new Error("Failed to read OBJ text content."));
            return;
          }
          try {
            setLoadingText("Parsing OBJ mesh geometry...");
            const objLoader = new OBJLoader(loadingManager);
            const obj = objLoader.parse(text);
            handleLoadedObject(obj);
          } catch (err) {
            handleLoadError(err);
          }
        };
        reader.onerror = (err) => handleLoadError(err);
        reader.readAsText(file);
      } else {
        handleLoadError(
          new Error(`Unsupported file extension '.${ext}'. Please upload a .glb or .obj file.`)
        );
      }

      const handleResize = () => {
        if (!containerRef.current) return;
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        activeRenderer.setSize(w, h, false);
      };

      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        canvas.removeEventListener("mousedown", onFpMouseDown);
        window.removeEventListener("mousemove", onFpMouseMove);
        window.removeEventListener("mouseup", onFpMouseUp);
        canvas.removeEventListener("wheel", onFpWheel);
        window.removeEventListener("keydown", onFpKeyDown);
        window.removeEventListener("keyup", onFpKeyUp);
        if (activeRenderer) {
          activeRenderer.dispose();
          try {
            activeRenderer.forceContextLoss();
          } catch (_) { }
        }
        scene.clear();
        canvas.remove();
      };
    }
  }, [file]);

  return (
    <div className="relative w-full h-full min-h-[500px] rounded-2xl overflow-hidden bg-black/40 border border-white/10 shadow-2xl flex items-center justify-center">
      <div ref={containerRef} className="absolute inset-0 w-full h-full" />

      {isLoading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm p-6 text-center space-y-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium text-indigo-300">{loadingText}</p>
        </div>
      )}

      {!isLoading && !webGlError && renderMode === "webgl" && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/75 text-[11px] font-semibold tracking-wide bg-black/55 px-3 py-1.5 rounded-lg pointer-events-none whitespace-nowrap"
        >
          W/S Glide Walk &nbsp;|&nbsp; A/D Rotate &nbsp;|&nbsp; Drag Free Look &nbsp;|&nbsp; Q/E Strafe &nbsp;|&nbsp; Scroll Speed
        </div>
      )}

      {webGlError && !isLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-zinc-950/90 backdrop-blur-md space-y-4">
          <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-2xl font-bold">
            ⚡
          </div>
          <h3 className="text-lg font-semibold text-white">Browser WebGL Context Reset Required</h3>
          <p className="text-sm text-zinc-400 max-w-md">
            Chrome's GPU WebGL context is currently blocked. Click below to reload the tab and restore 3D rendering.
          </p>
          <div className="pt-2 flex items-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors shadow-lg shadow-indigo-500/20"
            >
              Reload Page & Restore WebGL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
