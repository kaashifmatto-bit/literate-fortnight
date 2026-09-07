import { Hotspot } from './SceneGraph';

export class ModalManager {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public showInfoModal(hotspot: Hotspot): void {
    this.container.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-card modal-info-card">
          <button class="modal-close-btn" title="Close">&times;</button>
          
          <div class="modal-badge-tag">${hotspot.badge ? `POINT #${hotspot.badge}` : 'INFORMATION'}</div>
          <h2 class="modal-title">${this.escapeHtml(hotspot.label)}</h2>
          
          <div class="modal-divider"></div>
          
          <p class="modal-description">${this.escapeHtml(hotspot.description || 'No additional details provided.')}</p>

          <div class="modal-footer">
            <button class="modal-primary-btn modal-close-action">Got It</button>
          </div>
        </div>
      </div>
    `;

    this.attachCloseHandlers();
  }

  public showMediaModal(hotspot: Hotspot): void {
    const isVideo = hotspot.mediaType === 'video' || (hotspot.mediaUrl && hotspot.mediaUrl.endsWith('.mp4'));

    this.container.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-card modal-media-card">
          <button class="modal-close-btn" title="Close">&times;</button>
          
          <div class="modal-badge-tag">${isVideo ? 'VIDEO OVERLAY' : 'PHOTO LIGHTBOX'}</div>
          <h3 class="modal-title">${this.escapeHtml(hotspot.label)}</h3>

          <div class="modal-media-content">
            ${isVideo ? `
              <video src="${hotspot.mediaUrl}" controls autoplay class="modal-video-player"></video>
            ` : `
              <img src="${hotspot.mediaUrl}" alt="${this.escapeHtml(hotspot.label)}" class="modal-image-preview" />
            `}
          </div>

          ${hotspot.description ? `<p class="modal-description">${this.escapeHtml(hotspot.description)}</p>` : ''}
        </div>
      </div>
    `;

    this.attachCloseHandlers();
  }

  public showHelpModal(): void {
    this.container.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-card modal-help-card">
          <button class="modal-close-btn" title="Close">&times;</button>
          
          <div class="modal-badge-tag">WALKTHROUGH CONTROLS & HELP</div>
          <h2 class="modal-title">Navigating the 360° Tour</h2>
          
          <div class="modal-divider"></div>

          <div class="help-grid">
            <div class="help-item">
              <div class="help-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#06b6d4" stroke-width="2">
                  <path d="M15 18l-6-6 6-6"></path>
                </svg>
              </div>
              <div class="help-text">
                <strong>Drag to Free-Look</strong>
                <span>Click & drag (mouse) or swipe (touch) to rotate camera smoothly with Street View momentum.</span>
              </div>
            </div>

            <div class="help-item">
              <div class="help-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#06b6d4" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M8 12h8"></path>
                </svg>
              </div>
              <div class="help-text">
                <strong>Scroll / Pinch to Zoom</strong>
                <span>Use mouse wheel or pinch gesture to adjust field of view (FOV).</span>
              </div>
            </div>

            <div class="help-item">
              <div class="help-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#06b6d4" stroke-width="2">
                  <circle cx="12" cy="12" r="9"></circle>
                  <polygon points="10 8 16 12 10 16 10 8" fill="#06b6d4"></polygon>
                </svg>
              </div>
              <div class="help-text">
                <strong>Hotspot Walk Transition</strong>
                <span>Click blue/red navigation pins to play Matterport zoom-in, cross-fade, and dolly-out sequence.</span>
              </div>
            </div>

            <div class="help-item">
              <div class="help-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#06b6d4" stroke-width="2">
                  <path d="M12 2v20M2 12h20"></path>
                </svg>
              </div>
              <div class="help-text">
                <strong>Authoring / Admin Mode</strong>
                <span>Toggle Admin Mode in bottom bar to click anywhere and extract spherical coordinates.</span>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="modal-primary-btn modal-close-action">Start Exploring</button>
          </div>
        </div>
      </div>
    `;

    this.attachCloseHandlers();
  }

  private attachCloseHandlers(): void {
    const backdrop = this.container.querySelector('.modal-backdrop');
    const closeBtns = this.container.querySelectorAll('.modal-close-btn, .modal-close-action');

    const closeModal = () => {
      this.container.innerHTML = '';
    };

    closeBtns.forEach((btn) => btn.addEventListener('click', closeModal));
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeModal();
      }
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
