import { HotspotType } from './SceneGraph';

export class AdminModePanel {
  private container: HTMLElement;
  private isActive: boolean = false;
  private currentYaw: number = 0;
  private currentPitch: number = 0;
  private selectedType: HotspotType = 'navigation';

  private onAddHotspotCallback: ((hotspotData: any) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public setActive(active: boolean): void {
    this.isActive = active;
    if (active) {
      this.render();
    } else {
      this.container.innerHTML = '';
    }
  }

  public setClickedCoordinates(yaw: number, pitch: number): void {
    this.currentYaw = yaw;
    this.currentPitch = pitch;
    if (this.isActive) {
      this.render();
    }
  }

  public onAddHotspot(cb: (data: any) => void): void {
    this.onAddHotspotCallback = cb;
  }

  private render(): void {
    const jsonSnippet = JSON.stringify({
      id: `hotspot-${Date.now().toString().slice(-4)}`,
      type: this.selectedType,
      position: { yaw: this.currentYaw, pitch: this.currentPitch },
      label: this.selectedType === 'navigation' ? 'Go to Room' : 'New Feature Point',
      ...(this.selectedType === 'navigation' ? { targetNodeId: 'lobby', entryYaw: 0 } : {}),
      ...(this.selectedType === 'info' ? { badge: '01', description: 'Enter description...' } : {})
    }, null, 2);

    this.container.innerHTML = `
      <div class="admin-panel-card">
        <div class="admin-panel-header">
          <div class="admin-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#06b6d4" stroke-width="2.5">
              <path d="M12 2v20M2 12h20"></path>
              <circle cx="12" cy="12" r="7"></circle>
            </svg>
            <span>AUTHORING / ADMIN MODE</span>
          </div>
          <span class="admin-badge">ACTIVE</span>
        </div>

        <div class="admin-instructions">
          Click anywhere in 360° panorama to capture spatial coordinates.
        </div>

        <div class="admin-coords-grid">
          <div class="coord-box">
            <span class="coord-label">YAW (HORIZONTAL)</span>
            <span class="coord-value">${this.currentYaw}°</span>
          </div>
          <div class="coord-box">
            <span class="coord-label">PITCH (VERTICAL)</span>
            <span class="coord-value">${this.currentPitch}°</span>
          </div>
        </div>

        <div class="admin-type-selector">
          <label>Hotspot Type:</label>
          <div class="type-btns">
            <button class="type-btn ${this.selectedType === 'navigation' ? 'active' : ''}" data-type="navigation">Navigation</button>
            <button class="type-btn ${this.selectedType === 'info' ? 'active' : ''}" data-type="info">Info Point</button>
            <button class="type-btn ${this.selectedType === 'media' ? 'active' : ''}" data-type="media">Media</button>
          </div>
        </div>

        <div class="admin-json-box">
          <pre><code>${this.escapeHtml(jsonSnippet)}</code></pre>
        </div>

        <div class="admin-actions">
          <button class="admin-btn copy-btn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy JSON</span>
          </button>
          <button class="admin-btn add-btn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>Test Add Pin</span>
          </button>
        </div>
      </div>
    `;

    // Type Selector listeners
    const typeBtns = this.container.querySelectorAll('.type-btn');
    typeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedType = (btn as HTMLElement).dataset.type as HotspotType;
        this.render();
      });
    });

    // Copy JSON listener
    const copyBtn = this.container.querySelector('.copy-btn');
    copyBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(jsonSnippet);
      const span = copyBtn.querySelector('span');
      if (span) {
        span.textContent = 'Copied!';
        setTimeout(() => { span.textContent = 'Copy JSON'; }, 1500);
      }
    });

    // Test Add Pin listener
    const addBtn = this.container.querySelector('.add-btn');
    addBtn?.addEventListener('click', () => {
      if (this.onAddHotspotCallback) {
        this.onAddHotspotCallback(JSON.parse(jsonSnippet));
      }
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
