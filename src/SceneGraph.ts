/**
 * SceneGraph.ts - Manages tour nodes, edges, and hotspots structure.
 */

export interface HotspotPosition {
  yaw: number;   // In degrees (-180 to 180)
  pitch: number; // In degrees (-90 to 90)
}

export type HotspotType = 'navigation' | 'info' | 'media';

export interface Hotspot {
  id: string;
  type: HotspotType;
  position: HotspotPosition;
  targetNodeId?: string;
  entryYaw?: number; // Target orientation after entering node
  label: string;
  badge?: string;
  description?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  icon?: string;
}

export interface MapPosition {
  x: number;
  y: number;
}

export interface PanoramaNode {
  id: string;
  title: string;
  panorama: string;
  initialYaw: number;
  initialPitch: number;
  mapPos?: MapPosition;
  hotspots: Hotspot[];
}

export interface TourData {
  tourTitle: string;
  startNodeId: string;
  nodes: PanoramaNode[];
}

export class SceneGraph {
  private nodesMap: Map<string, PanoramaNode> = new Map();
  private currentNodeId: string = '';
  private tourTitle: string = 'Virtual Panorama Tour';

  constructor(tourData?: TourData) {
    if (tourData) {
      this.loadTourData(tourData);
    }
  }

  public loadTourData(tourData: TourData): void {
    this.nodesMap.clear();
    this.tourTitle = tourData.tourTitle || 'Virtual Panorama Tour';
    
    tourData.nodes.forEach((node) => {
      this.nodesMap.set(node.id, node);
    });

    if (tourData.startNodeId && this.nodesMap.has(tourData.startNodeId)) {
      this.currentNodeId = tourData.startNodeId;
    } else if (tourData.nodes.length > 0) {
      this.currentNodeId = tourData.nodes[0].id;
    }
  }

  public async fetchTourJson(jsonPath: string): Promise<TourData> {
    const response = await fetch(jsonPath);
    if (!response.ok) {
      throw new Error(`Failed to load tour JSON from ${jsonPath}`);
    }
    const tourData: TourData = await response.json();
    this.loadTourData(tourData);
    return tourData;
  }

  public getCurrentNode(): PanoramaNode | null {
    return this.nodesMap.get(this.currentNodeId) || null;
  }

  public getNode(nodeId: string): PanoramaNode | null {
    return this.nodesMap.get(nodeId) || null;
  }

  public setCurrentNodeId(nodeId: string): boolean {
    if (this.nodesMap.has(nodeId)) {
      this.currentNodeId = nodeId;
      return true;
    }
    return false;
  }

  public getAllNodes(): PanoramaNode[] {
    return Array.from(this.nodesMap.values());
  }

  public getTourTitle(): string {
    return this.tourTitle;
  }

  public getHotspot(hotspotId: string): Hotspot | null {
    const currentNode = this.getCurrentNode();
    if (!currentNode) return null;
    return currentNode.hotspots.find((h) => h.id === hotspotId) || null;
  }
}
