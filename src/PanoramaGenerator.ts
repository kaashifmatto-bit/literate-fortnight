/**
 * PanoramaGenerator - Generates high-definition equirectangular 360° textures
 * for tour nodes when external images are loaded or generated procedurally.
 */

export interface RoomTheme {
  name: string;
  skyColor: string;
  wallColor: string;
  floorColor: string;
  accentColor: string;
  details: string[];
}

export const ROOM_THEMES: Record<string, RoomTheme> = {
  reception: {
    name: "Main Reception & Welcome Desk",
    skyColor: "#1e293b",
    wallColor: "#334155",
    floorColor: "#0f172a",
    accentColor: "#06b6d4",
    details: ["RECEPTION DESK", "WELCOME", "ENTRANCE", "SECURITY"]
  },
  lobby: {
    name: "Grand Atrium Lobby",
    skyColor: "#18181b",
    wallColor: "#27272a",
    floorColor: "#09090b",
    accentColor: "#3b82f6",
    details: ["GRAND ATRIUM", "ART SCULPTURE", "ELEVATORS", "COLLABORATION ZONE"]
  },
  office: {
    name: "Executive Suite",
    skyColor: "#1c1917",
    wallColor: "#292524",
    floorColor: "#0c0a09",
    accentColor: "#f59e0b",
    details: ["EXECUTIVE DESK", "WORKSTATION", "ANALYTICS DISPLAY", "MEETING SPACE"]
  },
  conference: {
    name: "Boardroom & Conference Center",
    skyColor: "#0f172a",
    wallColor: "#1e293b",
    floorColor: "#020617",
    accentColor: "#10b981",
    details: ["4K VIDEO WALL", "BOARDROOM TABLE", "PRESENTATION SCREEN", "AV CONSOLE"]
  },
  lounge: {
    name: "Skyline Terrace Lounge",
    skyColor: "#2e1065",
    wallColor: "#3b0764",
    floorColor: "#1e1b4b",
    accentColor: "#a855f7",
    details: ["ESPRESSO BAR", "SKYLINE VIEW", "LOUNGE CHAIRS", "OUTDOOR BALCONY"]
  }
};

export function generateEquirectangularDataUrl(nodeId: string, width = 2048, height = 1024): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const theme = ROOM_THEMES[nodeId] || {
    name: nodeId.toUpperCase(),
    skyColor: '#1e293b',
    wallColor: '#334155',
    floorColor: '#0f172a',
    accentColor: '#06b6d4',
    details: ['ROOM ZONE', 'VIEWPOINT']
  };

  // Ceiling/Sky gradient (Top 35%)
  const skyGradient = ctx.createLinearGradient(0, 0, 0, height * 0.35);
  skyGradient.addColorStop(0, '#090d16');
  skyGradient.addColorStop(1, theme.skyColor);
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, width, height * 0.35);

  // Ceiling lights grid
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  for (let x = 100; x < width; x += 250) {
    ctx.beginPath();
    ctx.ellipse(x, height * 0.15, 40, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    // Light glow
    const lightGlow = ctx.createRadialGradient(x, height * 0.15, 5, x, height * 0.15, 80);
    lightGlow.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
    lightGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = lightGlow;
    ctx.beginPath();
    ctx.ellipse(x, height * 0.15, 80, 20, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Walls (Middle 40%)
  const wallGradient = ctx.createLinearGradient(0, height * 0.35, 0, height * 0.75);
  wallGradient.addColorStop(0, theme.wallColor);
  wallGradient.addColorStop(0.5, theme.skyColor);
  wallGradient.addColorStop(1, '#111827');
  ctx.fillStyle = wallGradient;
  ctx.fillRect(0, height * 0.35, width, height * 0.4);

  // Wall Architectural Pillars & Panels
  const panelWidth = width / 8;
  for (let i = 0; i < 8; i++) {
    const x = i * panelWidth;

    // Vertical pillar shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(x, height * 0.35, 12, height * 0.4);

    // Wall Art / Displays / Windows
    if (i % 2 === 0) {
      // Modern Glass Window / Illuminated Panel
      const winGrad = ctx.createLinearGradient(x + 30, height * 0.4, x + panelWidth - 30, height * 0.7);
      winGrad.addColorStop(0, theme.accentColor + '44');
      winGrad.addColorStop(1, 'rgba(255, 255, 255, 0.15)');
      ctx.fillStyle = winGrad;
      ctx.fillRect(x + 30, height * 0.4, panelWidth - 60, height * 0.28);
      ctx.strokeStyle = theme.accentColor;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 30, height * 0.4, panelWidth - 60, height * 0.28);

      // Window Frame Lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 30, height * 0.54);
      ctx.lineTo(x + panelWidth - 30, height * 0.54);
      ctx.stroke();
    } else {
      // Wall Signage / Artwork
      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.fillRect(x + 40, height * 0.42, panelWidth - 80, height * 0.24);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.strokeRect(x + 40, height * 0.42, panelWidth - 80, height * 0.24);

      // Room Title Text on wall
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px Inter, sans-serif';
      ctx.textAlign = 'center';
      const detailText = theme.details[Math.floor(i / 2) % theme.details.length] || theme.name;
      ctx.fillText(detailText, x + panelWidth / 2, height * 0.52);

      ctx.fillStyle = theme.accentColor;
      ctx.font = '14px Inter, monospace';
      ctx.fillText(`ZONE 0${i + 1} • 360° EQUIRECTANGULAR`, x + panelWidth / 2, height * 0.58);
    }
  }

  // Floor (Bottom 25%)
  const floorGradient = ctx.createLinearGradient(0, height * 0.75, 0, height);
  floorGradient.addColorStop(0, '#1f2937');
  floorGradient.addColorStop(1, theme.floorColor);
  ctx.fillStyle = floorGradient;
  ctx.fillRect(0, height * 0.75, width, height * 0.25);

  // Perspective floor grid & reflection lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  const numGridLines = 24;
  for (let i = 0; i <= numGridLines; i++) {
    const x = (i / numGridLines) * width;
    ctx.beginPath();
    ctx.moveTo(x, height * 0.75);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  // Horizontal floor lines
  for (let y = height * 0.75; y <= height; y += 35) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Center Floor Compass / Waypoint Ring Glow
  ctx.save();
  ctx.translate(width / 2, height * 0.88);
  const ringGlow = ctx.createRadialGradient(0, 0, 10, 0, 0, 120);
  ringGlow.addColorStop(0, theme.accentColor + 'aa');
  ringGlow.addColorStop(0.6, theme.accentColor + '22');
  ringGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ringGlow;
  ctx.beginPath();
  ctx.ellipse(0, 0, 180, 45, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = theme.accentColor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 140, 35, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(theme.name.toUpperCase(), 0, 5);
  ctx.restore();

  // 360 Degree Marks along horizon (height * 0.73)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  for (let deg = 0; deg < 360; deg += 45) {
    const x = (deg / 360) * width;
    ctx.fillText(`${deg}°`, x, height * 0.74);
    ctx.fillRect(x - 1, height * 0.745, 2, 8);
  }

  return canvas.toDataURL('image/jpeg', 0.92);
}
