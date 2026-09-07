import { SceneGraph, PanoramaNode } from './SceneGraph';
import { PanoramaViewer } from './PanoramaViewer';

export class MiniMap {
  private container: HTMLElement;
  private sceneGraph: SceneGraph;
  private viewer: PanoramaViewer;
  private onNodeSelect: (nodeId: string) => void;

  private svgElement: SVGSVGElement | null = null;
  private isCollapsed: boolean = false;

  constructor(
    container: HTMLElement,
    sceneGraph: SceneGraph,
    viewer: PanoramaViewer,
    onNodeSelect: (nodeId: string) => void
  ) {
    this.container = container;
    this.sceneGraph = sceneGraph;
    this.viewer = viewer;
    this.onNodeSelect = onNodeSelect;

    this.render();
    this.startUpdateLoop();
  }

  public render(): void {
    this.container.innerHTML = `
      <div class="minimap-card ${this.isCollapsed ? 'collapsed' : ''}">
        <div class="minimap-header">
          <div class="minimap-title">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
              <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
            <span>FLOOR PLAN</span>
          </div>
          <button class="minimap-toggle-btn" title="Toggle Minimap">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="${this.isCollapsed ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}"></polyline>
            </svg>
          </button>
        </div>
        <div class="minimap-body">
          <svg class="minimap-svg" viewBox="0 0 450 380"></svg>
        </div>
      </div>
    `;

    const toggleBtn = this.container.querySelector('.minimap-toggle-btn');
    toggleBtn?.addEventListener('click', () => {
      this.isCollapsed = !this.isCollapsed;
      this.render();
    });

    if (!this.isCollapsed) {
      this.drawMapGraph();
    }
  }

  private drawMapGraph(): void {
    const svg = this.container.querySelector('.minimap-svg') as SVGSVGElement;
    if (!svg) return;
    this.svgElement = svg;

    const nodes = this.sceneGraph.getAllNodes();
    const currentNode = this.sceneGraph.getCurrentNode();

    let svgContent = `
      <!-- Floor Plan Background Grid -->
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255, 255, 255, 0.05)" stroke-width="1"/>
      </pattern>
      <rect width="100%" height="100%" fill="url(#grid)" />

      <!-- Architectural Outer Walls -->
      <path d="M 60 80 L 400 80 L 400 340 L 60 340 Z" fill="rgba(15, 23, 42, 0.6)" stroke="rgba(56, 189, 248, 0.3)" stroke-width="2" stroke-dasharray="4 4"/>
    `;

    // Draw connection lines (edges)
    nodes.forEach((node) => {
      if (!node.mapPos) return;

      node.hotspots.forEach((h) => {
        if (h.type === 'navigation' && h.targetNodeId) {
          const targetNode = this.sceneGraph.getNode(h.targetNodeId);
          if (targetNode && targetNode.mapPos) {
            svgContent += `
              <line 
                x1="${node.mapPos.x}" y1="${node.mapPos.y}" 
                x2="${targetNode.mapPos.x}" y2="${targetNode.mapPos.y}" 
                stroke="rgba(56, 189, 248, 0.4)" stroke-width="2" stroke-dasharray="3 3"
              />
            `;
          }
        }
      });
    });

    // Draw Node Dots
    nodes.forEach((node) => {
      if (!node.mapPos) return;

      const isCurrent = currentNode && currentNode.id === node.id;
      const fillColor = isCurrent ? '#06b6d4' : 'rgba(255, 255, 255, 0.8)';
      const strokeColor = isCurrent ? '#38bdf8' : 'rgba(15, 23, 42, 0.9)';

      svgContent += `
        <g class="minimap-node-group" data-id="${node.id}" style="cursor: pointer;">
          ${isCurrent ? `
            <circle cx="${node.mapPos.x}" cy="${node.mapPos.y}" r="16" fill="rgba(6, 182, 212, 0.25)" class="minimap-active-pulse" />
            <g id="camera-heading-cone" transform="translate(${node.mapPos.x}, ${node.mapPos.y})">
              <path d="M 0 0 L -18 -32 L 18 -32 Z" fill="rgba(56, 189, 248, 0.35)" stroke="#38bdf8" stroke-width="1.5" />
            </g>
          ` : ''}
          <circle cx="${node.mapPos.x}" cy="${node.mapPos.y}" r="7" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2.5" />
          <text x="${node.mapPos.x}" y="${node.mapPos.y + 20}" fill="#94a3b8" font-size="10" font-weight="600" text-anchor="middle" font-family="sans-serif">
            ${node.id.toUpperCase()}
          </text>
        </g>
      `;
    });

    svg.innerHTML = svgContent;

    // Attach click listeners to map dots
    const nodeGroups = svg.querySelectorAll('.minimap-node-group');
    nodeGroups.forEach((g) => {
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = (g as HTMLElement).dataset.id;
        if (nodeId) {
          this.onNodeSelect(nodeId);
        }
      });
    });
  }

  private startUpdateLoop(): void {
    const updateHeading = () => {
      requestAnimationFrame(updateHeading);

      if (this.isCollapsed || !this.svgElement) return;

      const cone = this.svgElement.querySelector('#camera-heading-cone');
      if (cone) {
        const yaw = this.viewer.getViewState().yaw;
        cone.setAttribute('transform', `translate(${this.getActiveNodeX()}, ${this.getActiveNodeY()}) rotate(${yaw})`);
      }
    };
    requestAnimationFrame(updateHeading);
  }

  private getActiveNodeX(): number {
    const currentNode = this.sceneGraph.getCurrentNode();
    return currentNode?.mapPos?.x || 0;
  }

  private getActiveNodeY(): number {
    const currentNode = this.sceneGraph.getCurrentNode();
    return currentNode?.mapPos?.y || 0;
  }

  public updateActiveNode(): void {
    if (!this.isCollapsed) {
      this.drawMapGraph();
    }
  }
}
