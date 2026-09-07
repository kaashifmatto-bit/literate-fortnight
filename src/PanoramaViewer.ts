import * as THREE from 'three';
import { generateEquirectangularDataUrl } from './PanoramaGenerator';

export interface ViewState {
  yaw: number;   // In degrees (-180 to 180)
  pitch: number; // In degrees (-85 to 85)
  fov: number;   // In degrees (30 to 100)
}

export class PanoramaViewer {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private textureLoader: THREE.TextureLoader;

  // Dual Spheres for smooth Matterport cross-fading transitions
  private sphereCurrent: THREE.Mesh;
  private sphereNext: THREE.Mesh;
  private materialCurrent: THREE.MeshBasicMaterial;
  private materialNext: THREE.MeshBasicMaterial;

  // Camera orientation & free-look state
  private yaw: number = 0;       // Current yaw (degrees)
  private pitch: number = 0;     // Current pitch (degrees)
  private targetYaw: number = 0;
  private targetPitch: number = 0;

  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;
  private friction: number = 0.91; // Street View momentum friction

  // FOV Zoom state
  private currentFov: number = 75;
  private targetFov: number = 75;
  private minFov: number = 30;
  private maxFov: number = 100;

  // Interaction tracking
  private isPointerDown: boolean = false;
  private pointerStartX: number = 0;
  private pointerStartY: number = 0;
  private lastPointerX: number = 0;
  private lastPointerY: number = 0;
  private isInteracting: boolean = false;
  private isControlsEnabled: boolean = true;

  // Touch pinch zoom state
  private pinchStartDist: number = 0;

  // Gyroscope tracking
  private isGyroEnabled: boolean = false;
  private gyroAlpha: number = 0;
  private gyroBeta: number = 0;
  private gyroGamma: number = 0;

  // Admin / Authoring mode click listener
  private onSphereClickCallback: ((yaw: number, pitch: number) => void) | null = null;
  private isAdminMode: boolean = false;

  // Transition blur / opacity overlay state
  private transitionBlurAmount: number = 0;
  private overlayElement: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    // 1. Initialize Scene & Camera
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.currentFov,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 0, 0);

    // 2. Initialize WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.textureLoader = new THREE.TextureLoader();

    // 3. Create Dual Spheres for Seamless Texture Cross-fading
    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1); // Invert sphere to view from inside

    this.materialCurrent = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      transparent: true,
      opacity: 1.0,
    });

    this.materialNext = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      transparent: true,
      opacity: 0.0,
    });

    this.sphereCurrent = new THREE.Mesh(geometry, this.materialCurrent);
    this.sphereNext = new THREE.Mesh(geometry.clone(), this.materialNext);

    this.scene.add(this.sphereCurrent);
    this.scene.add(this.sphereNext);

    // Create Blur Overlay DOM Element
    this.createBlurOverlay();

    // 4. Setup Event Listeners
    this.setupEventListeners();

    // 5. Start Animation Render Loop
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  private createBlurOverlay(): void {
    const overlay = document.createElement('div');
    overlay.className = 'pano-blur-overlay';
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.pointerEvents = 'none';
    overlay.style.backdropFilter = 'blur(0px)';
    overlay.style.webkitBackdropFilter = 'blur(0px)';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    overlay.style.transition = 'backdrop-filter 0.1s ease, background-color 0.1s ease';
    overlay.style.zIndex = '5';
    this.container.appendChild(overlay);
    this.overlayElement = overlay;
  }

  // --- EQUIRECTANGULAR TEXTURE LOADING ---

  public async loadPanoramaTexture(url: string, nodeId?: string): Promise<void> {
    return new Promise((resolve) => {
      this.textureLoader.load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          if (this.renderer) {
            texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          }
          this.materialCurrent.map = texture;
          this.materialCurrent.needsUpdate = true;
          resolve();
        },
        undefined,
        () => {
          // Fallback: Generate equirectangular texture procedurally if network load fails
          const fallbackUrl = generateEquirectangularDataUrl(nodeId || 'default');
          this.textureLoader.load(fallbackUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            this.materialCurrent.map = tex;
            this.materialCurrent.needsUpdate = true;
            resolve();
          });
        }
      );
    });
  }

  public async loadNextPanoramaTexture(url: string, nodeId?: string): Promise<void> {
    return new Promise((resolve) => {
      this.textureLoader.load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          if (this.renderer) {
            texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          }
          this.materialNext.map = texture;
          this.materialNext.needsUpdate = true;
          resolve();
        },
        undefined,
        () => {
          const fallbackUrl = generateEquirectangularDataUrl(nodeId || 'default');
          this.textureLoader.load(fallbackUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            this.materialNext.map = tex;
            this.materialNext.needsUpdate = true;
            resolve();
          });
        }
      );
    });
  }

  public swapNextToCurrent(): void {
    if (this.materialNext.map) {
      this.materialCurrent.map = this.materialNext.map;
      this.materialCurrent.needsUpdate = true;
      this.materialCurrent.opacity = 1.0;
      this.materialNext.opacity = 0.0;
    }
  }

  public setCrossFadeOpacity(progress: number): void {
    // progress: 0 (all current) -> 1 (all next)
    this.materialCurrent.opacity = Math.max(0, Math.min(1, 1 - progress));
    this.materialNext.opacity = Math.max(0, Math.min(1, progress));
  }

  public setBlurAmount(blurPx: number, darkOpacity: number = 0): void {
    this.transitionBlurAmount = blurPx;
    if (this.overlayElement) {
      this.overlayElement.style.backdropFilter = blurPx > 0 ? `blur(${blurPx}px)` : 'blur(0px)';
      this.overlayElement.style.webkitBackdropFilter = blurPx > 0 ? `blur(${blurPx}px)` : 'blur(0px)';
      this.overlayElement.style.backgroundColor = `rgba(0, 0, 0, ${darkOpacity})`;
    }
  }

  // --- FREE-LOOK CONTROLS (Street View Inertia & Momentum) ---

  private setupEventListeners(): void {
    const dom = this.renderer.domElement;

    // Pointer Down (Mouse / Touch)
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!this.isControlsEnabled) return;

      this.isPointerDown = true;
      this.isInteracting = true;

      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      this.pointerStartX = clientX;
      this.pointerStartY = clientY;
      this.lastPointerX = clientX;
      this.lastPointerY = clientY;

      // Handle multi-touch pinch start
      if ('touches' in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this.pinchStartDist = Math.hypot(dx, dy);
      }
    };

    // Pointer Move
    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!this.isPointerDown || !this.isControlsEnabled) return;

      // Handle multi-touch pinch zoom
      if ('touches' in e && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (this.pinchStartDist > 0) {
          const delta = (this.pinchStartDist - dist) * 0.15;
          this.setTargetFov(this.targetFov + delta);
          this.pinchStartDist = dist;
        }
        return;
      }

      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const deltaX = clientX - this.lastPointerX;
      const deltaY = clientY - this.lastPointerY;

      this.lastPointerX = clientX;
      this.lastPointerY = clientY;

      // Sensitivity scaled by FOV ratio (zoomed in = finer control)
      const sensitivity = 0.18 * (this.currentFov / 75);

      this.yawVelocity = -deltaX * sensitivity;
      this.pitchVelocity = deltaY * sensitivity;

      this.targetYaw += this.yawVelocity;
      this.targetPitch += this.pitchVelocity;

      // Clamp pitch to avoid poles flip
      this.targetPitch = Math.max(-85, Math.min(85, this.targetPitch));
    };

    // Pointer Up
    const onPointerUp = (e: MouseEvent | TouchEvent) => {
      if (!this.isPointerDown) return;

      const clientX = 'changedTouches' in e ? e.changedTouches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'changedTouches' in e ? e.changedTouches[0].clientY : (e as MouseEvent).clientY;

      const totalDist = Math.hypot(clientX - this.pointerStartX, clientY - this.pointerStartY);

      this.isPointerDown = false;
      this.pinchStartDist = 0;

      // Admin mode click detection (if short click without dragging)
      if (this.isAdminMode && totalDist < 5 && this.onSphereClickCallback) {
        const rect = dom.getBoundingClientRect();
        const screenX = clientX - rect.left;
        const screenY = clientY - rect.top;
        const coords = this.screenToYawPitch(screenX, screenY);
        if (coords) {
          this.onSphereClickCallback(coords.yaw, coords.pitch);
        }
      }
    };

    // Mouse Wheel FOV Zooming
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!this.isControlsEnabled) return;
      const zoomSpeed = 0.05 * (this.targetFov / 75);
      const deltaFov = e.deltaY * zoomSpeed;
      this.setTargetFov(this.targetFov + deltaFov);
    };

    // Attach listener events
    dom.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    dom.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp);

    dom.addEventListener('wheel', onWheel, { passive: false });

    // Handle Window Resize
    window.addEventListener('resize', () => {
      if (!this.container) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
  }

  // --- GYROSCOPE ORIENTATION CONTROLS ---

  public toggleGyroscope(enable?: boolean): boolean {
    this.isGyroEnabled = enable !== undefined ? enable : !this.isGyroEnabled;
    if (this.isGyroEnabled && typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
      const handler = (e: DeviceOrientationEvent) => {
        if (!this.isGyroEnabled) return;
        this.gyroAlpha = e.alpha || 0;
        this.gyroBeta = e.beta || 0;
        this.gyroGamma = e.gamma || 0;
      };
      window.addEventListener('deviceorientation', handler, true);
    }
    return this.isGyroEnabled;
  }

  // --- RENDER & ANIMATION LOOP ---

  private animate(): void {
    requestAnimationFrame(this.animate);

    // 1. Inertia Momentum Decay (Street View feel)
    if (!this.isPointerDown) {
      if (Math.abs(this.yawVelocity) > 0.001 || Math.abs(this.pitchVelocity) > 0.001) {
        this.targetYaw += this.yawVelocity;
        this.targetPitch += this.pitchVelocity;
        this.targetPitch = Math.max(-85, Math.min(85, this.targetPitch));

        this.yawVelocity *= this.friction;
        this.pitchVelocity *= this.friction;
      } else {
        this.yawVelocity = 0;
        this.pitchVelocity = 0;
        this.isInteracting = false;
      }
    }

    // 2. Smooth Interpolation for Yaw & Pitch
    this.yaw += (this.targetYaw - this.yaw) * 0.2;
    this.pitch += (this.targetPitch - this.pitch) * 0.2;

    // Normalize Yaw to (-180 to 180)
    while (this.yaw > 180) { this.yaw -= 360; this.targetYaw -= 360; }
    while (this.yaw < -180) { this.yaw += 360; this.targetYaw += 360; }

    // 3. Smooth FOV Interpolation
    if (Math.abs(this.currentFov - this.targetFov) > 0.01) {
      this.currentFov += (this.targetFov - this.currentFov) * 0.18;
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // 4. Update Camera Rotation Matrix
    this.updateCameraRotation();

    // 5. Render Three.js Scene
    this.renderer.render(this.scene, this.camera);
  }

  private updateCameraRotation(): void {
    let finalYaw = this.yaw;
    let finalPitch = this.pitch;

    if (this.isGyroEnabled) {
      finalYaw += (this.gyroAlpha * 0.5);
      finalPitch += ((this.gyroBeta - 45) * 0.5);
      finalPitch = Math.max(-85, Math.min(85, finalPitch));
    }

    const yawRad = THREE.MathUtils.degToRad(finalYaw);
    const pitchRad = THREE.MathUtils.degToRad(finalPitch);

    // Calculate spherical direction look-at vector
    const x = Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);

    this.camera.lookAt(x, y, z);
  }

  // --- SCREEN TO YAW/PITCH RAYCASTING (AUTHORING / ADMIN MODE) ---

  public screenToYawPitch(screenX: number, screenY: number): { yaw: number; pitch: number } | null {
    const rect = this.container.getBoundingClientRect();
    const ndcX = (screenX / rect.width) * 2 - 1;
    const ndcY = -(screenY / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const intersects = raycaster.intersectObject(this.sphereCurrent);
    if (intersects.length > 0) {
      const point = intersects[0].point.clone().normalize();

      // Convert point (x, y, z) back to spherical yaw and pitch
      const pitchRad = Math.asin(point.y);
      const yawRad = Math.atan2(point.x, -point.z);

      const yawDeg = THREE.MathUtils.radToDeg(yawRad);
      const pitchDeg = THREE.MathUtils.radToDeg(pitchRad);

      return {
        yaw: Math.round(yawDeg * 10) / 10,
        pitch: Math.round(pitchDeg * 10) / 10
      };
    }
    return null;
  }

  // --- GETTERS & SETTERS ---

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public getViewState(): ViewState {
    return {
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.currentFov
    };
  }

  public setOrientation(yaw: number, pitch: number, immediate: boolean = false): void {
    this.targetYaw = yaw;
    this.targetPitch = Math.max(-85, Math.min(85, pitch));
    if (immediate) {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
      this.yawVelocity = 0;
      this.pitchVelocity = 0;
    }
  }

  public setTargetFov(fov: number): void {
    this.targetFov = Math.max(this.minFov, Math.min(this.maxFov, fov));
  }

  public setControlsEnabled(enabled: boolean): void {
    this.isControlsEnabled = enabled;
    if (!enabled) {
      this.isPointerDown = false;
      this.yawVelocity = 0;
      this.pitchVelocity = 0;
    }
  }

  public setAdminMode(enabled: boolean, callback?: (yaw: number, pitch: number) => void): void {
    this.isAdminMode = enabled;
    this.onSphereClickCallback = callback || null;
  }
}
