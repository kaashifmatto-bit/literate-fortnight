import * as THREE from 'three';

export interface TransitionOptions {
  durationOrient?: number;  // ms
  durationDollyIn?: number; // ms
  durationDollyOut?: number;// ms
  targetFovIn?: number;     // peak zoom FOV
  restingFov?: number;      // resting FOV
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInQuad(t: number): number {
  return t * t;
}

export class WalkTransitionController {
  private isTransitioning: boolean = false;

  public isRunning(): boolean {
    return this.isTransitioning;
  }

  public animateValue(durationMs: number, onUpdate: (progress: number) => void): Promise<void> {
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
