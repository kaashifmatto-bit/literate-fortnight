import { PanoramaViewer } from './PanoramaViewer';
import { SceneGraph, Hotspot } from './SceneGraph';

export interface TransitionOptions {
  durationOrient?: number;  // ms (default ~300)
  durationDollyIn?: number; // ms (default ~450)
  durationDollyOut?: number;// ms (default ~450)
  targetFovIn?: number;     // peak zoom FOV (default ~20)
  restingFov?: number;      // normal resting FOV (default ~75)
}

// Cubic Easing helper functions
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInQuad(t: number): number {
  return t * t;
}

export class WalkTransitionManager {
  private viewer: PanoramaViewer;
  private sceneGraph: SceneGraph;
  private isTransitioning: boolean = false;

  private onTransitionStartCallbacks: Array<() => void> = [];
  private onTransitionEndCallbacks: Array<(newNodeId: string) => void> = [];

  constructor(viewer: PanoramaViewer, sceneGraph: SceneGraph) {
    this.viewer = viewer;
    this.sceneGraph = sceneGraph;
  }

  public isRunning(): boolean {
    return this.isTransitioning;
  }

  public onTransitionStart(fn: () => void): void {
    this.onTransitionStartCallbacks.push(fn);
  }

  public onTransitionEnd(fn: (newNodeId: string) => void): void {
    this.onTransitionEndCallbacks.push(fn);
  }

  /**
   * Triggers the full 6-step Matterport "walk" transition to a target node
   * when a navigation hotspot is clicked.
   */
  public async executeWalkTransition(
    hotspot: Hotspot,
    options: TransitionOptions = {}
  ): Promise<void> {
    if (this.isTransitioning) return;
    if (!hotspot.targetNodeId) return;

    const targetNode = this.sceneGraph.getNode(hotspot.targetNodeId);
    if (!targetNode) return;

    this.isTransitioning = true;
    this.viewer.setControlsEnabled(false);

    // Notify listeners transition is starting (hides hotspots)
    this.onTransitionStartCallbacks.forEach((fn) => fn());

    const opts: Required<TransitionOptions> = {
      durationOrient: options.durationOrient || 300,
      durationDollyIn: options.durationDollyIn || 450,
      durationDollyOut: options.durationDollyOut || 450,
      targetFovIn: options.targetFovIn || 20,
      restingFov: options.restingFov || 75
    };

    const initialViewState = this.viewer.getViewState();

    // -------------------------------------------------------------
    // STEP 1: ORIENT - Animate camera yaw & pitch toward hotspot position
    // -------------------------------------------------------------
    const startYaw = initialViewState.yaw;
    const startPitch = initialViewState.pitch;
    const targetHotspotYaw = hotspot.position.yaw;
    const targetHotspotPitch = hotspot.position.pitch;

    // Calculate shortest yaw difference angle
    let deltaYaw = targetHotspotYaw - startYaw;
    while (deltaYaw > 180) deltaYaw -= 360;
    while (deltaYaw < -180) deltaYaw += 360;

    await this.animateValue(opts.durationOrient, (progress) => {
      const eased = easeInOutCubic(progress);
      const currentYaw = startYaw + deltaYaw * eased;
      const currentPitch = startPitch + (targetHotspotPitch - startPitch) * eased;
      this.viewer.setOrientation(currentYaw, currentPitch, true);
    });

    // Start pre-loading destination panorama texture into secondary sphere
    const textureLoadPromise = this.viewer.loadNextPanoramaTexture(targetNode.panorama, targetNode.id);

    // -------------------------------------------------------------
    // STEP 2: DOLLY IN - Zoom FOV down to peak zoom & blur panorama
    // -------------------------------------------------------------
    const startFov = this.viewer.getViewState().fov;
    await this.animateValue(opts.durationDollyIn, (progress) => {
      const eased = easeInQuad(progress);
      // Zoom FOV down from current to ~20deg
      const currentFov = startFov + (opts.targetFovIn - startFov) * eased;
      this.viewer.setTargetFov(currentFov);

      // Increase background blur overlay & dark vignette
      const blurPx = eased * 12;
      const darkOpacity = eased * 0.45;
      this.viewer.setBlurAmount(blurPx, darkOpacity);

      // Cross-fade sphere textures halfway through dolly-in
      if (progress > 0.6) {
        const fadeProgress = (progress - 0.6) / 0.4;
        this.viewer.setCrossFadeOpacity(fadeProgress);
      }
    });

    // Ensure texture load completes
    await textureLoadPromise;

    // -------------------------------------------------------------
    // STEP 3: CROSS-FADE & NODE SWAP at peak zoom-in
    // -------------------------------------------------------------
    this.viewer.swapNextToCurrent();
    this.sceneGraph.setCurrentNodeId(targetNode.id);

    // -------------------------------------------------------------
    // STEP 4: SET ENTRY ORIENTATION
    // Apply continuous direction of travel (entryYaw) or continuation yaw
    // -------------------------------------------------------------
    const entryYaw = hotspot.entryYaw !== undefined ? hotspot.entryYaw : targetNode.initialYaw;
    const entryPitch = targetNode.initialPitch || 0;
    this.viewer.setOrientation(entryYaw, entryPitch, true);

    // -------------------------------------------------------------
    // STEP 5: DOLLY OUT - Zoom FOV back out to normal resting FOV
    // -------------------------------------------------------------
    await this.animateValue(opts.durationDollyOut, (progress) => {
      const eased = easeOutCubic(progress);
      // Zoom FOV back out from peak zoom (~20deg) to resting FOV (~75deg)
      const currentFov = opts.targetFovIn + (opts.restingFov - opts.targetFovIn) * eased;
      this.viewer.setTargetFov(currentFov);

      // Fade out blur overlay
      const blurPx = (1 - eased) * 12;
      const darkOpacity = (1 - eased) * 0.45;
      this.viewer.setBlurAmount(blurPx, darkOpacity);
    });

    // -------------------------------------------------------------
    // STEP 6: CLEANUP & REVEAL HOTSPOTS
    // -------------------------------------------------------------
    this.viewer.setBlurAmount(0, 0);
    this.viewer.setControlsEnabled(true);
    this.isTransitioning = false;

    // Notify listeners transition completed (reveals new node's hotspots)
    this.onTransitionEndCallbacks.forEach((fn) => fn(targetNode.id));
  }

  private animateValue(durationMs: number, onUpdate: (progress: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const startTime = performance.now();

      const step = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1.0, elapsed / durationMs);

        onUpdate(progress);

        if (progress < 1.0) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(step);
    });
  }
}
