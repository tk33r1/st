/**
 * Donation Widget Component
 *
 * 使い方:
 * 1. このスクリプトを読み込む ( <script src="buy-me-a-coffee.js"></script> )
 * 2. 以下のコードで初期化する（外部CSSへの依存なし。スタイルはすべてインラインで完結）
 *
 * // 最小構成（画面右下に固定表示）
 * new DonationWidget().init();
 *
 * // オプション指定
 * new DonationWidget({
 *   containerId : 'donation-button-container', // 省略すると画面右下に固定表示されます
 *   lightningUrl: 'lightning:your_address',    // 省略すると Lightning ボタンは非表示になります
 *   onOpen      : () => { ... },               // モーダルが完全に開く直前に呼ばれる
 *   onClose     : () => { ... }                // モーダルが完全に閉じた後に呼ばれる
 * }).init();
 */

let _donationInstanceCounter = 0;

const DONATION_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'summary',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

class DonationWidget {
    constructor(config = {}) {
        this.kofiId = config.kofiId || 'shinyatakeda';
        this.githubUrl = config.githubUrl || 'https://github.com/sponsors/tk33r1';
        this.lightningUrl = config.lightningUrl || 'https://tk.st/ln_100y';
        this.containerId = config.containerId || null;
        this.onOpen = typeof config.onOpen === 'function' ? config.onOpen : null;
        this.onClose = typeof config.onClose === 'function' ? config.onClose : null;

        this._uid = ++_donationInstanceCounter;
        this._titleId = `donation-modal-title-${this._uid}`;
        this._closeBtnId = `donation-close-btn-${this._uid}`;

        this.modal = null;
        this.openBtnWrapper = null;
        this.closeBtn = null;
        this._abortController = null;
        this._prevOverflow = '';
        this._lastFocused = null;
        this._inertedNodes = [];
        this._iframeLoaded = false;
        this._isOpen = false;
        this._closeFinishTimer = null;
        this._mobileMql = null;
    }

    init() {
        if (typeof window === 'undefined') return;
        if (this.modal) return; // 二重初期化防止
        this.injectStyles();
        this.renderModal();
        this.renderButton();
        this.bindEvents();
    }

    destroy() {
        if (this._isOpen) this._restorePageState();
        clearTimeout(this._closeFinishTimer);
        this._abortController?.abort();
        this.modal?.remove();
        this.openBtnWrapper?.remove();
        const style = document.getElementById('donation-widget-styles');
        if (style) style.remove();
        this.modal = null;
        this.openBtnWrapper = null;
        this._inertedNodes = [];
        this._mobileMql = null;
    }

    // ---- Helpers ----

    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _safeUrl(url, allowedProtocols = ['http:', 'https:', 'lightning:', 'mailto:']) {
        try {
            const u = new URL(url, window.location.href);
            if (allowedProtocols.includes(u.protocol)) return u.href;
        } catch { /* fall through */ }
        return '#';
    }

    // ---- Styles ----

    injectStyles() {
        if (document.getElementById('donation-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'donation-widget-styles';
        style.textContent = `
            @keyframes donationPopAndShake {
                0%,   66.6% { transform: scale(1)    rotate(0deg);  }
                73.3%       { transform: scale(1.15) rotate(0deg);  }
                80%         { transform: scale(1.15) rotate(-8deg); }
                86.6%       { transform: scale(1.15) rotate(8deg);  }
                93.3%       { transform: scale(1.15) rotate(-8deg); }
                100%        { transform: scale(1)    rotate(0deg);  }
            }
            .donation-animate-pop-shake {
                animation: donationPopAndShake 3s ease-in-out infinite;
                transform-origin: center center;
            }
            .donation-widget-wrapper {
                position: relative;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            .donation-widget-tooltip {
                position: absolute;
                bottom: 100%;
                margin-bottom: 0.75rem;
                opacity: 0;
                transition: opacity 300ms;
                background-color: #1f2937;
                color: #fff;
                font-size: 0.75rem;
                font-weight: 700;
                padding: 0.375rem 0.75rem;
                border-radius: 0.5rem;
                white-space: nowrap;
                pointer-events: none;
                box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
                z-index: 10;
            }
            .donation-widget-wrapper:hover .donation-widget-tooltip { opacity: 1; }
            .donation-widget-tooltip::after {
                content: '';
                position: absolute;
                top: 100%;
                left: 50%;
                transform: translateX(-50%);
                border-width: 4px;
                border-style: solid;
                border-color: #1f2937 transparent transparent transparent;
            }
            .donation-widget-button {
                transition: transform 300ms;
                background-color: transparent;
                border: none;
                padding: 0;
                cursor: pointer;
                border-radius: 9999px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                outline: none;
                filter: drop-shadow(0 4px 3px rgba(0,0,0,0.07)) drop-shadow(0 2px 2px rgba(0,0,0,0.06));
            }
            .donation-widget-button:focus-visible {
                box-shadow: 0 0 0 3px #fff, 0 0 0 5px #2563eb;
            }
            .donation-widget-wrapper:hover .donation-widget-button {
                transform: translateY(-0.5rem);
            }
            .donation-widget-button img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                display: block;
            }

            /* ---- Modal ---- */
            .donation-modal-backdrop {
                position: fixed;
                inset: 0;
                width: 100vw;
                height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 2147483647;
                display: none;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                overflow: hidden;
                opacity: 0;
                transition: opacity 180ms ease-out;
                -webkit-backdrop-filter: blur(8px);
                backdrop-filter: blur(8px);
            }
            .donation-modal-panel {
                position: relative;
                display: flex;
                flex-direction: column;
                background: #fff;
                border-radius: 1rem;
                width: calc(100vw - 2rem);
                max-width: 42rem;
                max-height: 90vh;
                box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
                overflow: hidden;
                box-sizing: border-box;
                outline: none;
                transform: scale(0.96);
                opacity: 0;
                transition: transform 180ms ease-out, opacity 180ms ease-out;
            }
            .donation-modal-backdrop.donation-modal-visible { opacity: 1; }
            .donation-modal-backdrop.donation-modal-visible .donation-modal-panel {
                transform: scale(1);
                opacity: 1;
            }

            .donation-close-btn {
                position: absolute;
                top: 0.75rem;
                right: 0.75rem;
                z-index: 10;
                background: #fff;
                border: 1px solid #e5e7eb;
                border-radius: 9999px;
                padding: 0.4rem;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 1px 3px rgba(0,0,0,0.12);
                color: #4b5563;
                transition: background-color 150ms ease-out;
            }
            .donation-close-btn:hover { background-color: #f3f4f6; }
            .donation-close-btn:focus-visible {
                outline: 2px solid #2563eb;
                outline-offset: 2px;
            }
            .donation-close-icon { width: 1.5rem; height: 1.5rem; }

            .donation-scroll-container {
                overflow-y: auto;
                overflow-x: hidden;
                width: 100%;
                flex: 1 1 auto;
                background: #f9f9f9;
            }
            .donation-modal-title {
                position: absolute;
                width: 1px;
                height: 1px;
                padding: 0;
                margin: -1px;
                overflow: hidden;
                clip: rect(0,0,0,0);
                white-space: nowrap;
                border-width: 0;
            }
            .donation-modal-intro {
                /* 右パディングは閉じるボタンと重ならないように広めに取る */
                padding: 1.25rem 3.25rem 0 1.25rem;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }
            .donation-modal-intro p {
                margin: 0;
                font-size: 0.8rem;
                line-height: 1.7;
                color: #374151;
            }

            /* Ko-fi 埋め込みウィジェットの余白を切り詰めるためのスケール調整 */
            .donation-kofi-wrap { overflow: hidden; }
            .donation-kofi-iframe {
                border: none;
                width: 105.26%;     /* scale(0.95) の逆比 */
                padding: 4px;
                background: #f9f9f9;
                display: block;
                box-sizing: border-box;
                transform: scale(0.95);
                transform-origin: top left;
            }

            /* ---- Other options ---- */
            .donation-other-options-details {
                background: #fff;
                border-top: 1px solid #e5e7eb;
                padding: 1rem;
                flex-shrink: 0;
            }
            .donation-other-options-summary {
                font-size: 0.875rem;
                font-weight: 700;
                color: #4b5563;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.5rem;
                list-style: none;
                outline: none;
            }
            .donation-other-options-summary::-webkit-details-marker { display: none; }
            .donation-other-options-summary::marker { display: none; }
            .donation-other-options-summary:focus-visible {
                outline: 2px solid #2563eb;
                outline-offset: 2px;
                border-radius: 0.25rem;
            }
            .donation-other-options-chevron {
                width: 1rem;
                height: 1rem;
                transition: transform 200ms;
                flex-shrink: 0;
            }
            .donation-other-options-details[open] .donation-other-options-chevron {
                transform: rotate(180deg);
            }
            .donation-options-btns {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                padding-top: 0.5rem;
            }

            /* ---- Option buttons ---- */
            .donation-option-btn-row {
                display: flex;
                gap: 0.5rem;
            }
            .donation-option-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 0.5rem;
                font-size: 0.8rem;
                font-weight: 500;
                padding: 0.5rem 0.75rem;
                border-radius: 0.5rem;
                flex: 1 1 0;
                min-width: 0;
                box-sizing: border-box;
                text-decoration: none;
                white-space: nowrap;
                border: 1px solid transparent;
                transition: transform 150ms ease-out, box-shadow 150ms ease-out, filter 150ms ease-out;
            }
            .donation-option-btn--dark    { background: #111827; color: #fff; }
            .donation-option-btn--orange  { background: #F7931A; color: #fff; }
            .donation-option-btn--neutral { background: #fff;    color: #111827; border-color: #e5e7eb; }
            .donation-option-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
                filter: brightness(1.05);
            }
            .donation-option-btn:active {
                transform: translateY(0);
                filter: brightness(0.97);
            }
            .donation-option-btn:focus-visible {
                outline: 2px solid #2563eb;
                outline-offset: 2px;
            }
            .donation-option-icon {
                width: 1.125rem;
                height: 1.125rem;
                flex-shrink: 0;
            }

            @media (prefers-reduced-motion: reduce) {
                .donation-modal-backdrop,
                .donation-modal-panel,
                .donation-option-btn,
                .donation-close-btn,
                .donation-other-options-chevron {
                    transition: none !important;
                }
                .donation-animate-pop-shake { animation: none !important; }
            }

            @media (min-width: 481px) {
                .donation-other-options-summary {
                    cursor: default;
                    pointer-events: none;
                }
                .donation-other-options-chevron { display: none; }
            }
            @media (max-width: 480px) {
                .donation-option-btn-row { flex-direction: column; }
                .donation-option-btn { flex: none; width: 100%; }
                .donation-kofi-iframe {
                    transform: scale(0.9);
                    width: 111.11%;     /* scale(0.9) の逆比 */
                    height: 550px;
                }
                .donation-other-options-summary {
                    padding: 0.625rem 0.5rem;
                    margin: -0.625rem -0.5rem;
                    border-radius: 0.5rem;
                    transition: background-color 150ms ease-out;
                    -webkit-tap-highlight-color: transparent;
                }
                .donation-other-options-summary:hover,
                .donation-other-options-summary:active {
                    background-color: rgba(0,0,0,0.04);
                }
            }
        `;
        document.head.appendChild(style);
    }

    // ---- Render ----

    renderModal() {
        const safeKofiId = encodeURIComponent(this.kofiId);
        const kofiUrl = `https://ko-fi.com/${safeKofiId}/?hidefeed=true&widget=true&embed=true&preview=true`;
        const kofiTitle = this._escapeHtml(`Ko-fi donation widget for ${this.kofiId}`);
        const githubHref = this._escapeHtml(this._safeUrl(this.githubUrl));
        const lightningHref = this.lightningUrl ? this._escapeHtml(this._safeUrl(this.lightningUrl)) : null;
        const referralHref = this._escapeHtml(this._safeUrl('https://tk.st/glitch/index.html#referralSection'));
        const affiliateHref = this._escapeHtml(this._safeUrl('https://tk.st/glitch/index.html#affiliateSection'));

        const lightningBtn = lightningHref ? `
            <a class="donation-option-btn donation-option-btn--orange"
               href="${lightningHref}" target="_blank" rel="noopener noreferrer">
                <svg class="donation-option-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M14.24 10.56C13.93 11.8 12 11.17 11.4 11L11.95 8.82C12.57 8.99 14.56 9.26 14.24 10.56M11.13 12.12L10.53 14.53C11.29 14.73 13.53 15.43 13.87 14.09C14.21 12.7 11.9 12.32 11.13 12.12M21.7 14.42C20.36 19.78 14.94 23.04 9.58 21.7C4.22 20.36.963 14.94 2.3 9.58C3.64 4.22 9.06.964 14.42 2.3C19.77 3.64 23.03 9.06 21.7 14.42M13.61 8.25L14.05 6.25L12.89 6L12.46 7.97C12.15 7.9 11.83 7.82 11.5 7.75L11.94 5.76L10.78 5.5L10.34 7.5C10.08 7.44 9.83 7.38 9.59 7.31L8 6.92L7.72 8.15C7.72 8.15 8.58 8.35 8.56 8.36C9 8.46 9.07 8.75 9.06 9L8.56 11.1C8.58 11.11 8.62 11.11 8.66 11.13L8.55 11.1L7.85 13.97C7.8 14.12 7.64 14.35 7.3 14.27C7.31 14.28 6.46 14.06 6.46 14.06L5.91 15.37L7.41 15.74C7.7 15.82 7.98 15.9 8.26 15.97L7.82 17.97L8.97 18.24L9.41 16.23C9.73 16.32 10.04 16.4 10.35 16.47L9.91 18.47L11.07 18.74L11.5 16.75C13.6 17.17 15.17 17 15.87 15.08C16.44 13.53 15.82 12.62 14.71 12.04C15.53 11.84 16.15 11.3 16.32 10.27C16.56 8.84 15.46 8.1 13.94 7.68Z"/>
                </svg>
                Lightning Network
            </a>` : '';

        this.modal = document.createElement('div');
        this.modal.setAttribute('role', 'dialog');
        this.modal.setAttribute('aria-modal', 'true');
        this.modal.setAttribute('aria-labelledby', this._titleId);
        this.modal.className = 'donation-modal-backdrop';
        this.modal.innerHTML = `
            <div class="donation-modal-panel" tabindex="-1">
                <button id="${this._closeBtnId}" class="donation-close-btn" aria-label="閉じる" type="button">
                    <svg class="donation-close-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </button>
                <div class="donation-scroll-container">
                    <h2 id="${this._titleId}" class="donation-modal-title">Buy Me a Coffee</h2>
                    <div class="donation-modal-intro">
                        <p>広告に頼らず、<strong>「誰でも無料で楽しめること」</strong>を大切にしています。</p>
                        <p>お役に立てたなら、コーヒー1杯（☕）のご支援が大きな励みになります。</p>
                    </div>
                    <div class="donation-kofi-wrap">
                        <iframe class="donation-kofi-iframe"
                                data-src="${this._escapeHtml(kofiUrl)}"
                                height="712"
                                title="${kofiTitle}"
                                loading="lazy">
                        </iframe>
                    </div>
                </div>
                <details class="donation-other-options-details">
                    <summary class="donation-other-options-summary">
                        Other options:
                        <svg class="donation-other-options-chevron" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                        </svg>
                    </summary>
                    <div class="donation-options-btns">
                        <div class="donation-option-btn-row">
                            <a class="donation-option-btn donation-option-btn--dark"
                               href="${githubHref}" target="_blank" rel="noopener noreferrer">
                                <svg class="donation-option-icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd"/>
                                </svg>
                                GitHub Sponsors
                            </a>
                            ${lightningBtn}
                        </div>
                        <div class="donation-option-btn-row">
                            <a class="donation-option-btn donation-option-btn--neutral"
                               href="${referralHref}" target="_blank" rel="noopener noreferrer">
                                <svg class="donation-option-icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M22 10V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v4c1.1 0 2 .9 2 2s-.9 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2zm-2-1.46c-1.19.69-2 1.99-2 3.46s.81 2.77 2 3.46V18H4v-2.54c1.19-.69 2-1.99 2-3.46s-.81-2.77-2-3.46V6h16v2.54zM11 15h2v2h-2zm0-4h2v2h-2zm0-4h2v2h-2z"/>
                                </svg>
                                Invitation Code
                            </a>
                            <a class="donation-option-btn donation-option-btn--neutral"
                               href="${affiliateHref}" target="_blank" rel="noopener noreferrer">
                                <svg class="donation-option-icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
                                </svg>
                                Affiliate Links
                            </a>
                        </div>
                    </div>
                </details>
            </div>
        `;
        document.body.appendChild(this.modal);

        // モバイル時は details を初期状態で閉じる。デスクトップへリサイズしたら自動で開く
        const details = this.modal.querySelector('.donation-other-options-details');
        const summary = this.modal.querySelector('.donation-other-options-summary');
        this._mobileMql = window.matchMedia('(max-width: 480px)');
        const applyViewportState = () => {
            const isMobile = this._mobileMql.matches;
            details.open = !isMobile; // デスクトップでは常に開く
            // デスクトップでは summary をフォーカス対象から外す（pointer-events:none と整合）
            if (isMobile) summary.removeAttribute('tabindex');
            else summary.setAttribute('tabindex', '-1');
        };
        applyViewportState();
        this._mqlListener = applyViewportState;
        this._mobileMql.addEventListener('change', this._mqlListener);

        this.closeBtn = this.modal.querySelector(`#${this._closeBtnId}`);
    }

    renderButton() {
        const container = this.containerId
            ? (document.getElementById(this.containerId) ?? document.body)
            : document.body;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="donation-widget-wrapper">
                <div class="donation-widget-tooltip" aria-hidden="true">
                    Buy Me a Coffee
                </div>
                <button aria-label="Buy Me a Coffee - 寄付モーダルを開く"
                        class="donation-widget-button" type="button">
                    <div class="donation-animate-pop-shake" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
                        <img src="https://storage.ko-fi.com/cdn/logomarkLogo.png" alt="">
                    </div>
                </button>
            </div>
        `;
        this.openBtnWrapper = wrapper.firstElementChild;

        if (!this.containerId) {
            this.openBtnWrapper.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:40;';
        }

        container.appendChild(this.openBtnWrapper);
    }

    // ---- Events ----

    bindEvents() {
        this._abortController = new AbortController();
        const { signal } = this._abortController;

        const triggerBtn = this.openBtnWrapper.querySelector('button');

        triggerBtn.addEventListener('click', () => this._open(), { signal });
        this.closeBtn.addEventListener('click', () => this._close(), { signal });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this._close();
        }, { signal });

        document.addEventListener('keydown', (e) => {
            if (!this._isOpen) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this._close();
                return;
            }
            if (e.key === 'Tab') {
                this._trapFocus(e);
            }
        }, { signal });
    }

    _open() {
        if (this._isOpen) return;
        this._isOpen = true;

        // 進行中のクローズ処理を打ち切って状態を上書き
        clearTimeout(this._closeFinishTimer);
        this._closeFinishTimer = null;

        // iframe を初回オープン時にロード（無駄なネットワークリクエストを避ける）
        if (!this._iframeLoaded) {
            const iframe = this.modal.querySelector('.donation-kofi-iframe');
            if (iframe?.dataset.src) {
                iframe.src = iframe.dataset.src;
                delete iframe.dataset.src;
            }
            this._iframeLoaded = true;
        }

        this._lastFocused = document.activeElement;
        this._prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        this._setBackgroundInert(true);

        this.modal.style.display = 'flex';
        // 二段 rAF: display:flex 直後にクラスを付けても初期スタイルが確定しておらず
        // トランジションが発火しない。Chromium のスタイル確定を1フレーム待ってから付与する。
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!this._isOpen) return;
                this.modal.classList.add('donation-modal-visible');
            });
        });

        // 初期フォーカスはパネル本体（スクリーンリーダがタイトルを読む）
        const panel = this.modal.querySelector('.donation-modal-panel');
        panel?.focus({ preventScroll: true });

        this.onOpen?.();
    }

    _close() {
        if (!this._isOpen) return;
        this._isOpen = false;
        this.modal.classList.remove('donation-modal-visible');

        const finish = () => {
            this._closeFinishTimer = null;
            // 閉じる途中で再オープンされたら何もしない
            if (this._isOpen) return;
            this.modal.style.display = 'none';
            this._restorePageState();
            this.onClose?.();
        };

        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) {
            finish();
            return;
        }

        // transitionend を listen するが、タブ非アクティブ時など発火しないケースの保険にタイマーも併用
        const panel = this.modal.querySelector('.donation-modal-panel');
        let done = false;
        const onEnd = (e) => {
            if (e.target !== panel || e.propertyName !== 'opacity') return;
            if (done) return;
            done = true;
            panel.removeEventListener('transitionend', onEnd);
            clearTimeout(this._closeFinishTimer);
            finish();
        };
        if (panel) panel.addEventListener('transitionend', onEnd);
        this._closeFinishTimer = setTimeout(() => {
            if (done) return;
            done = true;
            panel?.removeEventListener('transitionend', onEnd);
            finish();
        }, 250);
    }

    _restorePageState() {
        document.body.style.overflow = this._prevOverflow;
        this._setBackgroundInert(false);
        const target = this._lastFocused;
        this._lastFocused = null;
        if (target && typeof target.focus === 'function' && document.contains(target)) {
            try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
        }
    }

    _setBackgroundInert(active) {
        if (active) {
            this._inertedNodes = [];
            for (const child of document.body.children) {
                if (child === this.modal) continue;
                if (child.hasAttribute('inert')) continue; // 既存の inert は触らない
                child.setAttribute('inert', '');
                child.setAttribute('data-donation-inert', '');
                this._inertedNodes.push(child);
            }
        } else {
            for (const node of this._inertedNodes) {
                if (node.hasAttribute('data-donation-inert')) {
                    node.removeAttribute('inert');
                    node.removeAttribute('data-donation-inert');
                }
            }
            this._inertedNodes = [];
        }
    }

    _trapFocus(e) {
        const nodes = this.modal.querySelectorAll(DONATION_FOCUSABLE_SELECTOR);
        const focusable = Array.from(nodes).filter((el) => {
            if (el.disabled) return false;
            if (el.tabIndex < 0) return false;
            // 不可視要素を除外（getClientRects で fast-path）
            return el.offsetParent !== null || el === document.activeElement;
        });
        if (focusable.length === 0) {
            e.preventDefault();
            this.modal.querySelector('.donation-modal-panel')?.focus({ preventScroll: true });
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || !this.modal.contains(active)) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (active === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }
}
