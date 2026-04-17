class BuyMeACoffee extends HTMLElement {
  static get observedAttributes() {
    return ['github-url', 'kofi-url', 'lightning-url'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._abortController = null;
  }

  connectedCallback() {
    this.render();
    this.addEventListeners();
  }

  disconnectedCallback() {
    this._abortController?.abort();
  }

  attributeChangedCallback() {
    if (this.shadowRoot.innerHTML) this.render();
  }

  get _urls() {
    return {
      github: this.getAttribute('github-url') || 'https://github.com/sponsors',
      kofi: this.getAttribute('kofi-url') || 'https://ko-fi.com',
      lightning: this.getAttribute('lightning-url') || 'https://lightning.network',
    };
  }

  render() {
    const { github, kofi, lightning } = this._urls;
    this.shadowRoot.innerHTML = `
      <style>
        @keyframes steam {
          0%, 100% { transform: translateY(0) rotate(-3deg); }
          25%  { transform: translateY(-4px) rotate(3deg); }
          50%  { transform: translateY(-2px) rotate(-2deg); }
          75%  { transform: translateY(-5px) rotate(2deg); }
        }
        @keyframes gentleBob {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-3px); }
        }
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.92) translateY(20px); }
          to   { opacity: 1; transform: scale(1)    translateY(0); }
        }
        @keyframes backdropIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

        :host { display: inline-block; }

        .coffee-btn {
          animation: gentleBob 2.5s ease-in-out infinite;
          cursor: pointer;
          background: none;
          border: none;
          font-size: 2rem;
          padding: 4px;
        }
        .coffee-btn:hover { animation: steam 0.8s ease-in-out infinite; }
        .coffee-btn:focus-visible {
          outline: 2px solid #6b4226;
          outline-offset: 4px;
          border-radius: 4px;
        }

        .modal-container {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 50;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        .modal-container.is-open { display: flex; }

        .modal-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(30, 18, 8, 0.6);
          animation: backdropIn 0.25s ease forwards;
        }
        .modal-content {
          position: relative;
          width: 100%;
          max-width: 28rem;
          background: linear-gradient(170deg, #fdf8f3 0%, #f0e0cc 100%);
          border-radius: 1rem;
          padding: 2rem;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
          animation: modalIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          z-index: 51;
        }

        .close-btn {
          position: absolute;
          top: 1rem;
          right: 1rem;
          background: rgba(107, 66, 38, 0.08);
          border: none;
          border-radius: 50%;
          width: 2.25rem;
          height: 2.25rem;
          font-size: 1.25rem;
          font-weight: bold;
          color: #6b4226;
          cursor: pointer;
          line-height: 1;
        }
        .close-btn:hover { background: rgba(107, 66, 38, 0.16); }
        .close-btn:focus-visible {
          outline: 2px solid #6b4226;
          outline-offset: 2px;
        }

        .modal-title {
          text-align: center;
          color: #3c2415;
          margin: 0 0 0.5rem;
          font-size: 1.375rem;
        }
        .modal-subtitle {
          text-align: center;
          color: #8b6a50;
          margin: 0 0 2rem;
          font-size: 0.9rem;
        }

        .card-link {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 1.25rem;
          margin-bottom: 1rem;
          background: #fff;
          border: 1px solid rgba(107, 66, 38, 0.1);
          border-radius: 0.75rem;
          text-decoration: none;
          color: #3c2415;
          transition: transform 0.25s ease, box-shadow 0.25s ease, background-color 0.25s ease;
        }
        .card-link:last-child { margin-bottom: 0; }
        .card-link:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 28px rgba(80, 50, 20, 0.18);
          background-color: #f7efe5;
        }
        .card-link:focus-visible {
          outline: 2px solid #6b4226;
          outline-offset: 2px;
        }
        .card-icon  { font-size: 1.875rem; flex-shrink: 0; }
        .card-title { font-weight: 600; font-size: 1.125rem; }
        .card-sub   { font-size: 0.75rem; color: #8b6a50; }
        .card-arrow { margin-left: auto; color: #a8845e; flex-shrink: 0; }
      </style>

      <button id="coffeeBtn" class="coffee-btn" aria-label="Open donation modal">☕</button>

      <div id="modal" class="modal-container" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div id="backdrop" class="modal-backdrop"></div>
        <div class="modal-content">
          <button id="closeBtn" class="close-btn" aria-label="Close modal">×</button>
          <h2 id="modalTitle" class="modal-title">Buy Me a Coffee ☕</h2>
          <p class="modal-subtitle">Choose your preferred way to support</p>

          <a href="${github}" target="_blank" rel="noopener noreferrer" class="card-link">
            <span class="card-icon">💳</span>
            <div>
              <div class="card-title">Credit Card</div>
              <div class="card-sub">via GitHub Sponsors</div>
            </div>
            <span class="card-arrow" aria-hidden="true">→</span>
          </a>

          <a href="${kofi}" target="_blank" rel="noopener noreferrer" class="card-link">
            <span class="card-icon">🅿️</span>
            <div>
              <div class="card-title">PayPal</div>
              <div class="card-sub">via Ko-fi</div>
            </div>
            <span class="card-arrow" aria-hidden="true">→</span>
          </a>

          <a href="${lightning}" target="_blank" rel="noopener noreferrer" class="card-link">
            <span class="card-icon">🪙</span>
            <div>
              <div class="card-title">Cryptocurrency</div>
              <div class="card-sub">via Bitcoin Lightning Network</div>
            </div>
            <span class="card-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    `;
  }

  addEventListeners() {
    this._abortController?.abort();
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    const modal     = this.shadowRoot.getElementById('modal');
    const coffeeBtn = this.shadowRoot.getElementById('coffeeBtn');
    const closeBtn  = this.shadowRoot.getElementById('closeBtn');
    const backdrop  = this.shadowRoot.getElementById('backdrop');

    const openModal  = () => {
      modal.classList.add('is-open');
      closeBtn.focus();
    };
    const closeModal = () => modal.classList.remove('is-open');

    coffeeBtn.addEventListener('click', openModal, { signal });
    closeBtn.addEventListener('click', closeModal, { signal });
    backdrop.addEventListener('click', closeModal, { signal });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
    }, { signal });
  }
}

customElements.define('buy-me-a-coffee', BuyMeACoffee);
