"use client";

import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import HotspotLayer, { HotspotItem } from "./HotspotLayer";
import { easeInOutCubic, easeInQuad, easeOutCubic } from "./transitions";

export interface PanoramaViewerRef {
  executeWalkTransition: (targetNodeId: string | number, targetEntryYaw?: number) => Promise<void>;
  snapNorth: () => void;
  getYaw: () => number;
}

export interface PanoramaViewerProps {
  currentPanoramaUrl: string;
  hotspots: HotspotItem[];
  initialYaw?: number;
  initialPitch?: number;
  onHotspotClick: (hotspot: HotspotItem) => void;
  onYawChange?: (yawDeg: number) => void;
  onTransitionStart?: () => void;
  onTransitionEnd?: (newNodeId: string | number) => void;
  onGetTextureForNode?: (nodeId: string | number) => Promise<string>;
}

const PanoramaViewer = forwardRef<PanoramaViewerRef, PanoramaViewerProps>(({
  currentPanoramaUrl,
  hotspots,
  initialYaw = 0,
  initialPitch = 0,
  onHotspotClick,
  onYawChange,
  onTransitionStart,
  onTransitionEnd,
  onGetTextureForNode,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Three.js State
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const sphereCurrentRef = useRef<THREE.Mesh | null>(null);
  const sphereNextRef = useRef<THREE.Mesh | null>(null);
  const planeCurrentRef = useRef<THREE.Mesh | null>(null);
  const planeNextRef = useRef<THREE.Mesh | null>(null);

  const materialCurrentRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const materialNextRef = useRef<THREE.MeshBasicMaterial | null>(null);

  // Rotation State
  const yawRef = useRef<number>(initialYaw);
  const pitchRef = useRef<number>(initialPitch);
  const targetYawRef = useRef<number>(initialYaw);
  const targetPitchRef = useRef<number>(initialPitch);
  const yawVelocityRef = useRef<number>(0);
  const pitchVelocityRef = useRef<number>(0);
  const friction = 0.88;

  // FOV Zoom State
  const currentFovRef = useRef<number>(75);
  const targetFovRef = useRef<number>(75);

  // Pointer / Touch State
  const isPointerDownRef = useRef<boolean>(false);
  const lastPointerXRef = useRef<number>(0);
  const lastPointerYRef = useRef<number>(0);
  const pinchStartDistRef = useRef<number>(0);
  const isTransitioningRef = useRef<boolean>(false);

  const [is360, setIs360] = useState<boolean>(true);
  const [containerDimensions, setContainerDimensions] = useState({ width: 0, height: 0 });

  // Texture loader helper supporting 360° Equirectangular Sphere AND Flat HD Photo Viewport
  const loadTextureIntoMaterial = useCallback((url: string, material: THREE.MeshBasicMaterial): Promise<void> => {
    return new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;

          if (rendererRef.current) {
            tex.anisotropy = rendererRef.current.capabilities.getMaxAnisotropy();
          }

          const img = tex.image;
          let isPano = true;

          if (img && img.width && img.height) {
            const aspect = img.width / img.height;
            isPano = aspect >= 1.85 && aspect <= 2.15;
            setIs360(isPano);

            if (isPano) {
              tex.wrapS = THREE.RepeatWrapping;
              tex.wrapT = THREE.ClampToEdgeWrapping;
              tex.repeat.set(1, 1);
              tex.offset.set(0, 0);
            } else {
              const planeW = 1200 * aspect;
              const planeH = 1200;

              if (planeCurrentRef.current) planeCurrentRef.current.scale.set(planeW, planeH, 1);
              if (planeNextRef.current) planeNextRef.current.scale.set(planeW, planeH, 1);
            }
          }

          if (sphereCurrentRef.current) sphereCurrentRef.current.visible = isPano;
          if (sphereNextRef.current) sphereNextRef.current.visible = isPano;
          if (planeCurrentRef.current) planeCurrentRef.current.visible = !isPano;
          if (planeNextRef.current) planeNextRef.current.visible = !isPano;

          material.map = tex;
          material.needsUpdate = true;
          resolve();
        },
        undefined,
        () => {
          const canvas = document.createElement("canvas");
          canvas.width = 2048;
          canvas.height = 1024;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, 2048, 1024);
          ctx.fillStyle = "#38bdf8";
          ctx.font = "bold 44px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("360° VIRTUAL PANORAMA", 1024, 512);

          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          material.map = tex;
          material.needsUpdate = true;
          resolve();
        }
      );
    });
  }, []);

  // Execute Matterport 6-step Walk Transition
  const executeWalkTransition = useCallback(async (targetNodeId: string | number, targetEntryYaw?: number) => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    onTransitionStart?.();

    targetPitchRef.current = 0;

    // STEP 1: ORIENT
    const startYaw = yawRef.current;
    const targetHeading = targetEntryYaw !== undefined ? targetEntryYaw : startYaw;
    let delta = targetHeading - startYaw;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;

    const durationOrient = 250;
    const startTimeOrient = performance.now();
    await new Promise<void>((res) => {
      const step = (now: number) => {
        const progress = Math.min(1.0, (now - startTimeOrient) / durationOrient);
        targetYawRef.current = startYaw + delta * easeInOutCubic(progress);
        yawRef.current = targetYawRef.current;
        if (progress < 1.0) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });

    let nextUrl = currentPanoramaUrl;
    if (onGetTextureForNode) {
      try {
        nextUrl = await onGetTextureForNode(targetNodeId);
      } catch {}
    }
    const texturePromise = loadTextureIntoMaterial(nextUrl, materialNextRef.current!);

    // STEP 2: DOLLY IN
    const startFov = currentFovRef.current;
    const targetFovIn = 20;
    const durationDollyIn = 400;
    const startTimeDollyIn = performance.now();

    await new Promise<void>((res) => {
      const step = (now: number) => {
        const progress = Math.min(1.0, (now - startTimeDollyIn) / durationDollyIn);
        const eased = easeInQuad(progress);
        targetFovRef.current = startFov + (targetFovIn - startFov) * eased;

        if (overlayRef.current) {
          overlayRef.current.style.backdropFilter = `blur(${eased * 14}px)`;
          overlayRef.current.style.backgroundColor = `rgba(0,0,0,${eased * 0.4})`;
        }

        if (progress > 0.6 && materialCurrentRef.current && materialNextRef.current) {
          const fade = (progress - 0.6) / 0.4;
          materialCurrentRef.current.opacity = 1 - fade;
          materialNextRef.current.opacity = fade;
        }

        if (progress < 1.0) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });

    await texturePromise;

    // STEP 3: CROSS-FADE TEXTURE SWAP
    if (materialNextRef.current?.map && materialCurrentRef.current) {
      materialCurrentRef.current.map = materialNextRef.current.map;
      materialCurrentRef.current.needsUpdate = true;
      materialCurrentRef.current.opacity = 1.0;
      materialNextRef.current.opacity = 0.0;
    }

    // STEP 4: SET ENTRY ORIENTATION
    if (targetEntryYaw !== undefined) {
      targetYawRef.current = targetEntryYaw;
      yawRef.current = targetEntryYaw;
    }

    // STEP 5: DOLLY OUT
    const durationDollyOut = 400;
    const startTimeDollyOut = performance.now();
    await new Promise<void>((res) => {
      const step = (now: number) => {
        const progress = Math.min(1.0, (now - startTimeDollyOut) / durationDollyOut);
        const eased = easeOutCubic(progress);
        targetFovRef.current = targetFovIn + (75 - targetFovIn) * eased;

        if (overlayRef.current) {
          overlayRef.current.style.backdropFilter = `blur(${(1 - eased) * 14}px)`;
          overlayRef.current.style.backgroundColor = `rgba(0,0,0,${(1 - eased) * 0.4})`;
        }

        if (progress < 1.0) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });

    if (overlayRef.current) {
      overlayRef.current.style.backdropFilter = "blur(0px)";
      overlayRef.current.style.backgroundColor = "rgba(0,0,0,0)";
    }

    isTransitioningRef.current = false;
    onTransitionEnd?.(targetNodeId);
  }, [currentPanoramaUrl, loadTextureIntoMaterial, onGetTextureForNode, onTransitionStart, onTransitionEnd]);

  const snapNorth = useCallback(() => {
    targetYawRef.current = 0;
    targetPitchRef.current = 0;
  }, []);

  useImperativeHandle(ref, () => ({
    executeWalkTransition,
    snapNorth,
    getYaw: () => yawRef.current,
  }));

  // Three.js Scene Setup & Loop
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    setContainerDimensions({ width, height });

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#030305");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(currentFovRef.current, width / height, 0.1, 2000);
    const probeCanvas = document.createElement("canvas");
    const gl = probeCanvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
               probeCanvas.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ||
               probeCanvas.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: false });
    if (!gl) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch (err) {
      console.warn("[PanoramaViewer] Hardware WebGL unavailable.", err);
      return;
    }

    const materialCurrent = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 1.0 });
    const materialNext = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.0 });
    materialCurrentRef.current = materialCurrent;
    materialNextRef.current = materialNext;

    // 1. 360 Spheres
    const sphereGeometry = new THREE.SphereGeometry(500, 60, 40);
    const sphereCurrent = new THREE.Mesh(sphereGeometry, materialCurrent);
    const sphereNext = new THREE.Mesh(sphereGeometry.clone(), materialNext);
    sphereCurrent.scale.set(-1, 1, 1);
    sphereNext.scale.set(-1, 1, 1);

    sphereCurrentRef.current = sphereCurrent;
    sphereNextRef.current = sphereNext;
    scene.add(sphereCurrent);
    scene.add(sphereNext);

    // 2. Flat Photo Planes
    const planeGeometry = new THREE.PlaneGeometry(1, 1);
    const planeCurrent = new THREE.Mesh(planeGeometry, materialCurrent);
    const planeNext = new THREE.Mesh(planeGeometry, materialNext);
    planeCurrent.position.set(0, 0, -500);
    planeNext.position.set(0, 0, -500);

    planeCurrentRef.current = planeCurrent;
    planeNextRef.current = planeNext;
    scene.add(planeCurrent);
    scene.add(planeNext);

    // Initial texture load
    loadTextureIntoMaterial(currentPanoramaUrl, materialCurrent);

    // Drag & Zoom Listeners
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      isPointerDownRef.current = true;
      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;

      if ("touches" in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDistRef.current = Math.hypot(dx, dy);
      }
    };

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!isPointerDownRef.current) return;

      if ("touches" in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (pinchStartDistRef.current > 0) {
          const delta = (pinchStartDistRef.current - dist) * 0.15;
          targetFovRef.current = Math.max(30, Math.min(100, targetFovRef.current + delta));
          pinchStartDistRef.current = dist;
        }
        return;
      }

      const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const deltaX = clientX - lastPointerXRef.current;
      const deltaY = clientY - lastPointerYRef.current;
      lastPointerXRef.current = clientX;
      lastPointerYRef.current = clientY;

      const sensitivity = 0.15 * (currentFovRef.current / 75);
      yawVelocityRef.current = -deltaX * sensitivity;
      pitchVelocityRef.current = -deltaY * sensitivity;

      targetYawRef.current += yawVelocityRef.current;
      targetPitchRef.current += pitchVelocityRef.current;

      const maxPitch = is360 ? 75 : 35;
      const maxYaw = is360 ? 180 : 45;
      targetPitchRef.current = Math.max(-maxPitch, Math.min(maxPitch, targetPitchRef.current));
      if (!is360) {
        targetYawRef.current = Math.max(-maxYaw, Math.min(maxYaw, targetYawRef.current));
      }
    };

    const onPointerUp = () => {
      isPointerDownRef.current = false;
      pinchStartDistRef.current = 0;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.05 * (targetFovRef.current / 75);
      targetFovRef.current = Math.max(30, Math.min(100, targetFovRef.current + e.deltaY * zoomSpeed));
    };

    const onDoubleClick = () => {
      targetYawRef.current = 0;
      targetPitchRef.current = 0;
      targetFovRef.current = 75;
    };

    const dom = renderer.domElement;
    dom.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    dom.addEventListener("dblclick", onDoubleClick);

    dom.addEventListener("touchstart", onPointerDown, { passive: false });
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("touchend", onPointerUp);

    dom.addEventListener("wheel", onWheel, { passive: false });

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      setContainerDimensions({ width: w, height: h });
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // Animation Render Loop
    let animId: number;
    const loop = () => {
      animId = requestAnimationFrame(loop);

      if (!isPointerDownRef.current) {
        if (Math.abs(yawVelocityRef.current) > 0.001 || Math.abs(pitchVelocityRef.current) > 0.001) {
          targetYawRef.current += yawVelocityRef.current;
          targetPitchRef.current += pitchVelocityRef.current;

          const maxPitch = is360 ? 75 : 35;
          const maxYaw = is360 ? 180 : 45;
          targetPitchRef.current = Math.max(-maxPitch, Math.min(maxPitch, targetPitchRef.current));
          if (!is360) {
            targetYawRef.current = Math.max(-maxYaw, Math.min(maxYaw, targetYawRef.current));
          }

          yawVelocityRef.current *= friction;
          pitchVelocityRef.current *= friction;
        } else {
          yawVelocityRef.current = 0;
          pitchVelocityRef.current = 0;
        }
      }

      yawRef.current += (targetYawRef.current - yawRef.current) * 0.2;
      pitchRef.current += (targetPitchRef.current - pitchRef.current) * 0.2;

      if (is360) {
        while (yawRef.current > 180) { yawRef.current -= 360; targetYawRef.current -= 360; }
        while (yawRef.current < -180) { yawRef.current += 360; targetYawRef.current += 360; }
      }

      if (onYawChange) {
        onYawChange(yawRef.current);
      }

      if (Math.abs(currentFovRef.current - targetFovRef.current) > 0.01) {
        currentFovRef.current += (targetFovRef.current - currentFovRef.current) * 0.18;
        camera.fov = currentFovRef.current;
        camera.updateProjectionMatrix();
      }

      const yawRad = THREE.MathUtils.degToRad(yawRef.current);
      const pitchRad = THREE.MathUtils.degToRad(pitchRef.current);

      const x = Math.sin(yawRad) * Math.cos(pitchRad);
      const y = Math.sin(pitchRad);
      const z = -Math.cos(yawRad) * Math.cos(pitchRad);

      camera.lookAt(x, y, z);
      renderer.render(scene, camera);
    };

    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      dom.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      dom.removeEventListener("dblclick", onDoubleClick);
      dom.removeEventListener("wheel", onWheel);
      if (rendererRef.current?.domElement) {
        rendererRef.current.domElement.remove();
      }
    };
  }, [currentPanoramaUrl, loadTextureIntoMaterial, onYawChange, is360]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-[#0a0a0f] select-none">
      <div ref={containerRef} className="w-full h-full" />
      <div
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none z-10 transition-all duration-100"
        style={{ backdropFilter: "blur(0px)", backgroundColor: "rgba(0,0,0,0)" }}
      />

      {/* Mode Badge Indicator */}
      <div className="absolute top-6 left-6 z-30 flex items-center gap-2">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-black/70 border border-cyan-500/40 text-cyan-300 backdrop-blur-md">
          {is360 ? "🌐 360° Panorama Sphere" : "🖼️ HD Photo Viewport"}
        </span>
      </div>

      <HotspotLayer
        camera={cameraRef.current}
        containerWidth={containerDimensions.width}
        containerHeight={containerDimensions.height}
        hotspots={hotspots}
        onHotspotClick={onHotspotClick}
      />
    </div>
  );
});

PanoramaViewer.displayName = "PanoramaViewer";
export default PanoramaViewer;
