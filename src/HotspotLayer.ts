import * as THREE from 'three';
import { PanoramaViewer } from './PanoramaViewer';
import { Hotspot, HotspotType } from './SceneGraph';

export class HotspotLayer {
  private container: HTMLElement;
  private viewer: PanoramaViewer;
  private hotspots: Hotspot[] = [];
  private pinElements: Map<string, HTMLElement> = new Map();
  private isVisible: boolean = true;

  private onNavigationClick: (hotspot: Hotspot) => void;
  private onInfoClick: (hotspot: Hotspot) => void;
  private onMediaClick: (hotspot: Hotspot) => void;

  constructor(
    container: HTMLElement,
    viewer: PanoramaViewer,
    callbacks: {
      onNavigationClick: (hotspot: Hotspot) => void;
      onInfoClick: (hotspot: Hotspot) => void;
      onMediaClick: (hotspot: Hotspot) => void;
    }
  ) {
    this.container = container;
    this.viewer = viewer;
    this.onNavigationClick = callbacks.onNavigationClick;
    this.onInfoClick = callbacks.onInfoClick;
    this.onMediaClick = callbacks.onMediaClick;

    // Start render update loop for 3D projection
    this.update = this.update.bind(this);
    requestAnimationFrame(this.update);
  }

  public setHotspots(hotspots: Hotspot[]): void {
    this.hotspots = hotspots;
    this.renderDOMPins();
  }

  public setVisibility(visible: boolean): void {
    this.isVisible = visible;
    this.pinElements.forEach((el) => {
      el.style.opacity = visible ? '1' : '0';
      el.style.pointerEvents = visible ? 'auto' : 'none';
    });
  }

  private renderDOMPins(): void {
    // Clear old elements
    this.pinElements.forEach((el) => el.remove());
    this.pinElements.clear();

    this.hotspots.forEach((hotspot) => {
      const pinEl = document.createElement('div');
      pinEl.className = `hotspot-pin hotspot-type-${hotspot.type}`;
      pinEl.dataset.id = hotspot.id;

      // Construct Inner Pin HTML based on Hotspot Type
      if (hotspot.type === 'navigation') {
        pinEl.innerHTML = `
          <div class="pin-ring pin-ring-nav">
            <div class="pin-pulse"></div>
            <div class="pin-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </div>
          <div class="pin-tooltip">${this.escapeHtml(hotspot.label)}</div>
        `;
      } else if (hotspot.type === 'info') {
        const badgeHtml = hotspot.badge ? `<span class="pin-badge">${hotspot.badge}</span>` : '';
        pinEl.innerHTML = `
          <div class="pin-ring pin-ring-info">
            <div class="pin-pulse"></div>
            ${badgeHtml}
            <div class="pin-icon">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </div>
          </div>
          <div class="pin-tooltip">${this.escapeHtml(hotspot.label)}</div>
        `;
      } else if (hotspot.type === 'media') {
        pinEl.innerHTML = `
          <div class="pin-ring pin-ring-media">
            <div class="pin-pulse"></div>
            <div class="pin-icon">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="4" width="20" height="16" rx="3"></rect>
                <polygon points="10 8 16 12 10 16 10 8" fill="currentColor"></polygon>
              </svg>
            </div>
          </div>
          <div class="pin-tooltip">${this.escapeHtml(hotspot.label)}</div>
        `;
      }

      // Attach Click Event Listener
      pinEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.isVisible) return;

        if (hotspot.type === 'navigation') {
          this.onNavigationClick(hotspot);
        } else if (hotspot.type === 'info') {
          this.onInfoClick(hotspot);
        } else if (hotspot.type === 'media') {
          this.onMediaClick(hotspot);
        }
      });

      this.container.appendChild(pinEl);
      this.pinElements.set(hotspot.id, pinEl);
    });
  }

  // Convert Spherical (Yaw, Pitch) -> 3D World Vector
  private getHotspot3DPosition(position: { yaw: number; pitch: number }, radius: number = 400): THREE.Vector3 {
    const yawRad = THREE.MathUtils.degToRad(position.yaw);
    const pitchRad = THREE.MathUtils.degToRad(position.pitch);

    const x = radius * Math.sin(yawRad) * Math.cos(pitchRad);
    const y = radius * Math.sin(pitchRad);
    const z = -radius * Math.cos(yawRad) * Math.cos(pitchRad);

    return new THREE.Vector3(x, y, z);
  }

  /**
   * Updates screen position, scale, and visibility for each hotspot pin
   * projected from 3D camera frustum.
   */
  private update(): void {
    requestAnimationFrame(this.update);

    if (!this.isVisible || this.hotspots.length === 0) return;

    const camera = this.viewer.getCamera();
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    // Camera forward vector for angle test
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);

    this.hotspots.forEach((hotspot) => {
      const pinEl = this.pinElements.get(hotspot.id);
      if (!pinEl) return;

      const worldPos = this.getHotspot3DPosition(hotspot.position);
      const hotspotDir = worldPos.clone().normalize();

      // Check dot product to verify if pin is in front of camera
      const dot = cameraDir.dot(hotspotDir);

      if (dot <= 0.15) {
        // Behind or at extreme camera edge -> hide pin
        pinEl.style.display = 'none';
        return;
      }

      // Project 3D coordinate to Screen Normalized Device Coordinates (NDC)
      const projected = worldPos.clone().project(camera);

      const screenX = (projected.x + 1) * width / 2;
      const screenY = (-projected.y + 1) * height / 2;

      // Check screen bounds
      if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) {
        pinEl.style.display = 'none';
        return;
      }

      pinEl.style.display = 'flex';
      pinEl.style.transform = `translate3d(${screenX}px, ${screenY}px, 0px) translate(-50%, -50%)`;

      // Scale slightly based on camera FOV & angle from view center
      const currentFov = camera.fov;
      const scale = Math.max(0.65, Math.min(1.25, (75 / currentFov) * (dot * 0.9 + 0.1)));
      pinEl.style.scale = scale.toFixed(3);

      // Fade out at extreme screen edges
      const fadeAlpha = Math.min(1.0, (dot - 0.15) / 0.35);
      pinEl.style.opacity = (this.isVisible ? fadeAlpha : 0).toFixed(2);
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
