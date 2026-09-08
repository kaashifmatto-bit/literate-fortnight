"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";


const PARALLAX_AMOUNT = 0.4;
const CAMERA_RIG_STRENGTH = 0.3;

const vertexShader = `
uniform sampler2D uDepthMap;
uniform float uDepthScale;
varying vec2 vUv;

void main() {
    vUv = uv;
    // Depth Anything V2 outputs closer objects as brighter (closer to 1.0)
    // We want closer objects to be pushed forward (+z)
    float depth = texture2D(uDepthMap, uv).r;
    
    vec3 pos = position;
    // Center the depth around 0.5 so the plane rotates around its center of mass
    pos.z += (depth - 0.5) * uDepthScale;
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const fragmentShader = `
uniform sampler2D uImage;
varying vec2 vUv;

void main() {
    gl_FragColor = texture2D(uImage, vUv);
}
`;

function ParallaxScene({ imageUrl, depthUrl }: { imageUrl: string; depthUrl: string }) {
  const { size, camera } = useThree();
  const [textures, setTextures] = useState<{ img: THREE.Texture; depth: THREE.Texture } | null>(null);

  // Load textures
  useEffect(() => {
    let active = true;
    const loader = new THREE.TextureLoader();
    Promise.all([
      loader.loadAsync(imageUrl),
      loader.loadAsync(depthUrl)
    ]).then(([imgTex, depthTex]) => {
      if (active) {
        // Essential to avoid color washing out in modern Three.js
        imgTex.colorSpace = THREE.SRGBColorSpace;
        
        // Prevent texture wrapping artifacts
        imgTex.wrapS = imgTex.wrapT = THREE.ClampToEdgeWrapping;
        depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
        
        setTextures({ img: imgTex, depth: depthTex });
      }
    }).catch(err => {
      console.error("Failed to load textures for 2.5D", err);
    });
    return () => { active = false; };
  }, [imageUrl, depthUrl]);

  // Handle plane scaling to fit screen while maintaining aspect ratio
  const planeArgs = useMemo(() => {
    if (!textures) return [1, 1, 128, 128] as [number, number, number, number];
    const img = textures.img.image as { width: number; height: number };
    const imageAspect = img.width / img.height;
    const screenAspect = size.width / size.height;
    
    let w, h;
    if (imageAspect > screenAspect) {
      // Image is wider than screen
      h = 10;
      w = h * imageAspect;
    } else {
      // Screen is wider than image
      w = 10 * screenAspect;
      h = w / imageAspect;
    }
    
    // Slightly scale up to hide edges during parallax movement
    const scaleUp = 1.15; 
    return [w * scaleUp, h * scaleUp, 128, 128] as [number, number, number, number];
  }, [textures, size]);

  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Mouse & Auto-drift Tracking
  const mouse = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  useFrame((state, delta) => {
    // Auto-drift if no mouse movement (simulate Facebook 3D photo drift)
    const time = state.clock.getElapsedTime();
    const driftX = Math.sin(time * 0.5) * 0.2;
    const driftY = Math.cos(time * 0.3) * 0.1;

    // Blend user input with auto-drift
    target.current.x = mouse.current.x * 0.8 + driftX;
    target.current.y = mouse.current.y * 0.8 + driftY;

    // Clamp targets to avoid excessive edge stretching
    target.current.x = Math.max(-0.5, Math.min(0.5, target.current.x));
    target.current.y = Math.max(-0.5, Math.min(0.5, target.current.y));

    // Smooth easing
    camera.position.x += (target.current.x * CAMERA_RIG_STRENGTH - camera.position.x) * 5 * delta;
    camera.position.y += (target.current.y * CAMERA_RIG_STRENGTH - camera.position.y) * 5 * delta;
    camera.lookAt(0, 0, 0);
  });

  if (!textures) return null;

  return (
    <mesh>
      <planeGeometry args={planeArgs} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={{
          uImage: { value: textures.img },
          uDepthMap: { value: textures.depth },
          uDepthScale: { value: PARALLAX_AMOUNT }
        }}
      />
    </mesh>
  );
}


interface Waypoint {
  index: number;
  image_url: string;
  depth_map_url?: string;
}

import { getApiBase } from "@/lib/api";

export default function DepthParallaxViewer({ projectId, reasonCode }: { projectId: number; reasonCode?: string }) {
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const fetchWaypoints = async () => {
      try {
        const apiBase = getApiBase();
        const res = await fetch(`${apiBase}/api/projects/${projectId}/waypoints`);
        const data = await res.json();
        if (active) {
          setWaypoints(data.waypoints || []);
          setIsLoading(false);
        }
      } catch (err) {
        console.error(err);
        if (active) setIsLoading(false);
      }
    };
    
    fetchWaypoints();
    return () => { active = false; };
  }, [projectId]);

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-black">
        <span className="animate-spin inline-block w-8 h-8 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full" />
        <p className="mt-4 text-xs text-white/50 font-bold uppercase tracking-widest">Loading 2.5D Fallback</p>
      </div>
    );
  }

  if (waypoints.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-black text-white text-sm">
        No waypoints found for 2.5D view.
      </div>
    );
  }

  const currentWaypoint = waypoints[currentIndex];
  const apiBase = getApiBase();
  // Reconstruct full URLs assuming apiBase if they are relative
  const imageUrl = currentWaypoint.image_url.startsWith('http') ? currentWaypoint.image_url : `${apiBase}${currentWaypoint.image_url}`;
  const depthUrl = currentWaypoint.depth_map_url ? (currentWaypoint.depth_map_url.startsWith('http') ? currentWaypoint.depth_map_url : `${apiBase}${currentWaypoint.depth_map_url}`) : "";

  return (
    <div className="absolute inset-0 w-full h-full bg-black overflow-hidden select-none">
      
      {/* 2.5D Parallax Canvas */}
      {depthUrl ? (
        <Canvas camera={{ position: [0, 0, 7.5], fov: 75 }} gl={{ antialias: true }}>
          <ParallaxScene key={currentWaypoint.index} imageUrl={imageUrl} depthUrl={depthUrl} />
        </Canvas>
      ) : (
        // Ken Burns Fallback if depth map is missing
        <div 
          className="w-full h-full bg-center bg-cover animate-[kenburns_20s_ease-in-out_infinite_alternate]"
          style={{ backgroundImage: `url(${imageUrl})` }}
        />
      )}

      {/* Crossfade overlay transition could be added here, but Canvas key change is sufficient for rapid swapping */}

      {/* Nav Controls */}
      <div className="absolute bottom-10 inset-x-0 flex justify-center items-center gap-6 z-50 pointer-events-none">
        <button
          onClick={() => setCurrentIndex(c => Math.max(0, c - 1))}
          disabled={currentIndex === 0}
          className="pointer-events-auto w-12 h-12 rounded-full bg-black/50 backdrop-blur-md border border-white/20 text-white flex items-center justify-center disabled:opacity-30 hover:bg-white/10 hover:scale-105 transition-all shadow-xl"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" /></svg>
        </button>

        <div className="bg-black/60 backdrop-blur-lg border border-white/10 px-5 py-2.5 rounded-2xl flex flex-col items-center shadow-2xl">
          <span className="text-white font-bold text-sm tracking-widest">{currentIndex + 1} / {waypoints.length}</span>
          <span className="text-indigo-400 text-[10px] font-black uppercase tracking-widest mt-0.5 opacity-80">2.5D PARALLAX MODE</span>
        </div>

        <button
          onClick={() => setCurrentIndex(c => Math.min(waypoints.length - 1, c + 1))}
          disabled={currentIndex === waypoints.length - 1}
          className="pointer-events-auto w-12 h-12 rounded-full bg-black/50 backdrop-blur-md border border-white/20 text-white flex items-center justify-center disabled:opacity-30 hover:bg-white/10 hover:scale-105 transition-all shadow-xl"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>

      {/* Top Warning Badge */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <div className="bg-amber-950/80 backdrop-blur-md border border-amber-500/30 px-4 py-2 rounded-xl text-center shadow-2xl">
          <p className="text-amber-400 text-xs font-black tracking-widest uppercase">3D Fallback Active</p>
          <p className="text-amber-200/60 text-[10px] mt-0.5 max-w-[250px] leading-tight">
            Insufficient capture overlap ({reasonCode}). Displaying AI Depth Parallax.
          </p>
        </div>
      </div>
      
    </div>
  );
}
