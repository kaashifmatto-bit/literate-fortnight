import './index.css';
import { SceneGraph } from './SceneGraph';
import { PanoramaViewer } from './PanoramaViewer';
import { WalkTransitionManager } from './transitions';
import { HotspotLayer } from './HotspotLayer';
import { MiniMap } from './MiniMap';
import { AdminModePanel } from './AdminModePanel';
import { ModalManager } from './ModalManager';

document.addEventListener('DOMContentLoaded', async () => {
  const viewerContainer = document.getElementById('pano-viewer-container')!;
  const hotspotContainer = document.getElementById('hotspot-layer-container')!;
  const minimapContainer = document.getElementById('minimap-container')!;
  const adminContainer = document.getElementById('admin-panel-container')!;
  const modalContainer = document.getElementById('modal-container')!;
  const loadingIndicator = document.getElementById('loading-indicator')!;

  // 1. Initialize SceneGraph
  const sceneGraph = new SceneGraph();
  
  try {
    await sceneGraph.fetchTourJson('/data/tour.json');
  } catch (e) {
    // If fetch fails, load default inline dataset fallback
    console.warn("Using inline tour dataset fallback...");
    sceneGraph.loadTourData({
      tourTitle: "Luxury Office & Executive Center Tour",
      startNodeId: "reception",
      nodes: [
        {
          id: "reception",
          title: "Main Reception & Welcome Desk",
          panorama: "/panoramas/reception.jpg",
          initialYaw: 0,
          initialPitch: 0,
          mapPos: { x: 100, y: 280 },
          hotspots: [
            { id: "to-lobby", targetNodeId: "lobby", position: { yaw: 45, pitch: -4 }, type: "navigation", label: "Proceed to Main Lobby", entryYaw: 40 },
            { id: "to-lounge", targetNodeId: "lounge", position: { yaw: -55, pitch: -3 }, type: "navigation", label: "Executive Lounge", entryYaw: -60 },
            { id: "info-desk", type: "info", position: { yaw: 10, pitch: -12 }, label: "Reception Desk", badge: "01", description: "Main check-in desk equipped with touchless visitor registration, high-speed badge printing, and 24/7 concierge assistance." },
            { id: "video-1", type: "media", position: { yaw: -20, pitch: 2 }, label: "Virtual Host Introduction", mediaUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", mediaType: "video", description: "Watch a brief video introduction presenting our facility standards." }
          ]
        },
        {
          id: "lobby",
          title: "Grand Atrium Lobby",
          panorama: "/panoramas/lobby.jpg",
          initialYaw: 30,
          initialPitch: 0,
          mapPos: { x: 220, y: 200 },
          hotspots: [
            { id: "to-reception", targetNodeId: "reception", position: { yaw: -135, pitch: -5 }, type: "navigation", label: "Back to Reception", entryYaw: -135 },
            { id: "to-office", targetNodeId: "office", position: { yaw: 20, pitch: -4 }, type: "navigation", label: "Executive Suite", entryYaw: 15 },
            { id: "info-sculpture", type: "info", position: { yaw: -45, pitch: 8 }, label: "Kinetica Art Installation", badge: "03", description: "Award-winning kinetic glass structure designed by Studio Lumina." }
          ]
        },
        {
          id: "office",
          title: "Executive Suite",
          panorama: "/panoramas/office.jpg",
          initialYaw: 0,
          initialPitch: 0,
          mapPos: { x: 340, y: 140 },
          hotspots: [
            { id: "to-lobby-from-office", targetNodeId: "lobby", position: { yaw: -160, pitch: -5 }, type: "navigation", label: "Return to Atrium Lobby", entryYaw: -160 }
          ]
        },
        {
          id: "lounge",
          title: "Skyline Terrace Lounge",
          panorama: "/panoramas/lounge.jpg",
          initialYaw: -30,
          initialPitch: 0,
          mapPos: { x: 100, y: 120 },
          hotspots: [
            { id: "to-reception-from-lounge", targetNodeId: "reception", position: { yaw: 125, pitch: -4 }, type: "navigation", label: "Return to Reception", entryYaw: 125 }
          ]
        }
      ]
    });
  }

  // 2. Initialize Three.js Panorama Viewer
  const viewer = new PanoramaViewer(viewerContainer);

  // 3. Initialize Walk Transition Manager
  const transitions = new WalkTransitionManager(viewer, sceneGraph);

  // 4. Initialize Modals
  const modals = new ModalManager(modalContainer);

  // 5. Initialize Hotspots Layer
  const hotspotLayer = new HotspotLayer(hotspotContainer, viewer, {
    onNavigationClick: (hotspot) => {
      transitions.executeWalkTransition(hotspot);
    },
    onInfoClick: (hotspot) => {
      modals.showInfoModal(hotspot);
    },
    onMediaClick: (hotspot) => {
      modals.showMediaModal(hotspot);
    }
  });

  // 6. Initialize MiniMap
  const miniMap = new MiniMap(minimapContainer, sceneGraph, viewer, (targetNodeId) => {
    const currentNode = sceneGraph.getCurrentNode();
    if (!currentNode || currentNode.id === targetNodeId) return;

    // Find direct hotspot connection or jump
    const connHotspot = currentNode.hotspots.find(h => h.type === 'navigation' && h.targetNodeId === targetNodeId);
    if (connHotspot) {
      transitions.executeWalkTransition(connHotspot);
    } else {
      // Create synthetic transition hotspot for map jump
      transitions.executeWalkTransition({
        id: `map-jump-${targetNodeId}`,
        type: 'navigation',
        targetNodeId: targetNodeId,
        position: { yaw: 0, pitch: 0 },
        label: `Jump to ${targetNodeId}`
      });
    }
  });

  // 7. Initialize Admin Authoring Panel
  const adminPanel = new AdminModePanel(adminContainer);
  adminPanel.onAddHotspot((newHotspot) => {
    const currentNode = sceneGraph.getCurrentNode();
    if (currentNode) {
      currentNode.hotspots.push(newHotspot);
      hotspotLayer.setHotspots(currentNode.hotspots);
    }
  });

  // Transition Listeners: Hide hotspots & show loading during walk
  transitions.onTransitionStart(() => {
    hotspotLayer.setVisibility(false);
    loadingIndicator.classList.add('active');
  });

  transitions.onTransitionEnd((newNodeId) => {
    const newNode = sceneGraph.getNode(newNodeId);
    if (newNode) {
      updateUIHeader(newNode);
      hotspotLayer.setHotspots(newNode.hotspots);
      miniMap.updateActiveNode();
      updateNodeDropdownSelect(newNode.id);
    }
    hotspotLayer.setVisibility(true);
    loadingIndicator.classList.remove('active');
  });

  // 8. Load Initial Node
  const startNode = sceneGraph.getCurrentNode();
  if (startNode) {
    loadingIndicator.classList.add('active');
    await viewer.loadPanoramaTexture(startNode.panorama, startNode.id);
    viewer.setOrientation(startNode.initialYaw, startNode.initialPitch, true);
    hotspotLayer.setHotspots(startNode.hotspots);
    updateUIHeader(startNode);
    setupNodeDropdownSelect();
    loadingIndicator.classList.remove('active');
  }

  // UI Header & Toolbar Wiring
  function updateUIHeader(node: any) {
    const titleEl = document.getElementById('tour-main-title');
    const nodeEl = document.getElementById('tour-node-title');
    if (titleEl) titleEl.textContent = sceneGraph.getTourTitle();
    if (nodeEl) nodeEl.textContent = `📍 ${node.title}`;
  }

  function setupNodeDropdownSelect() {
    const select = document.getElementById('node-select') as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = '';
    sceneGraph.getAllNodes().forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = n.title;
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      const targetId = (e.target as HTMLSelectElement).value;
      const current = sceneGraph.getCurrentNode();
      if (current && current.id !== targetId) {
        transitions.executeWalkTransition({
          id: `dropdown-jump-${targetId}`,
          type: 'navigation',
          targetNodeId: targetId,
          position: { yaw: 0, pitch: 0 },
          label: `Jump to ${targetId}`
        });
      }
    });
  }

  function updateNodeDropdownSelect(nodeId: string) {
    const select = document.getElementById('node-select') as HTMLSelectElement;
    if (select) select.value = nodeId;
  }

  // Setup Toolbar Button Listeners
  const helpBtn = document.getElementById('btn-help');
  helpBtn?.addEventListener('click', () => modals.showHelpModal());

  const gyroBtn = document.getElementById('btn-gyro');
  gyroBtn?.addEventListener('click', () => {
    const enabled = viewer.toggleGyroscope();
    gyroBtn.classList.toggle('active', enabled);
  });

  const adminBtn = document.getElementById('btn-admin');
  let isAdminModeActive = false;
  adminBtn?.addEventListener('click', () => {
    isAdminModeActive = !isAdminModeActive;
    adminBtn.classList.toggle('active', isAdminModeActive);
    adminPanel.setActive(isAdminModeActive);
    viewer.setAdminMode(isAdminModeActive, (yaw, pitch) => {
      adminPanel.setClickedCoordinates(yaw, pitch);
    });
  });

  const fullscreenBtn = document.getElementById('btn-fullscreen');
  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });
});
