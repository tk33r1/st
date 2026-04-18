/**
 * Donation Widget Component
 *
 * 使い方:
 * 1. このスクリプトを読み込む ( <script src="buy-me-a-coffee.js"></script> )
 * 2. Tailwind CSS が読み込まれていることを確認する
 * 3. 以下のコードで初期化する
 *
 * // 最小構成（画面右下に固定表示）
 * new DonationWidget().init();
 *
 * // オプション指定
 * new DonationWidget({
 *   containerId: 'donation-button-container', // 省略すると画面右下に固定表示されます
 *   lightningUrl: 'lightning:your_address'    // 省略すると Lightning ボタンは非表示になります
 * }).init();
 */

class DonationWidget {
    constructor(config = {}) {
        this.kofiId       = config.kofiId       || 'shinyatakeda';
        this.githubUrl    = config.githubUrl    || 'https://github.com/sponsors/tk33r1';
        this.lightningUrl = config.lightningUrl || null;
        this.containerId  = config.containerId  || null;

        this.modal          = null;
        this.openBtnWrapper = null;
        this.closeBtn       = null;
        this._abortController = null;
        this._prevOverflow    = '';
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
        this._abortController?.abort();
        this.modal?.remove();
        this.openBtnWrapper?.remove();
        const style = document.getElementById('donation-widget-styles');
        if (style) style.remove();
        this.modal = null;
        this.openBtnWrapper = null;
    }

    injectStyles() {
        if (document.getElementById('donation-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'donation-widget-styles';
        style.textContent = `
            @keyframes donationPopAndShake {
                0%,   66.6% { transform: scale(1)    rotate(0deg);  }
                73.3%        { transform: scale(1.15) rotate(0deg);  }
                80%          { transform: scale(1.15) rotate(-8deg); }
                86.6%        { transform: scale(1.15) rotate(8deg);  }
                93.3%        { transform: scale(1.15) rotate(-8deg); }
                100%         { transform: scale(1)    rotate(0deg);  }
            }
            .donation-animate-pop-shake {
                animation: donationPopAndShake 3s ease-in-out infinite;
                transform-origin: center center;
            }
        `;
        document.head.appendChild(style);
    }

    renderModal() {
        const lightningBtn = this.lightningUrl ? `
            <a href="${this.lightningUrl}" target="_blank" rel="noopener noreferrer"
               class="flex items-center justify-center gap-2 bg-[#F7931A] hover:bg-[#e08516] text-white text-sm font-medium py-2 px-4 rounded-lg w-full sm:w-auto transition-colors shadow-sm">
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M14.24 10.56C13.93 11.8 12 11.17 11.4 11L11.95 8.82C12.57 8.99 14.56 9.26 14.24 10.56M11.13 12.12L10.53 14.53C11.29 14.73 13.53 15.43 13.87 14.09C14.21 12.7 11.9 12.32 11.13 12.12M21.7 14.42C20.36 19.78 14.94 23.04 9.58 21.7C4.22 20.36.963 14.94 2.3 9.58C3.64 4.22 9.06.964 14.42 2.3C19.77 3.64 23.03 9.06 21.7 14.42M13.61 8.25L14.05 6.25L12.89 6L12.46 7.97C12.15 7.9 11.83 7.82 11.5 7.75L11.94 5.76L10.78 5.5L10.34 7.5C10.08 7.44 9.83 7.38 9.59 7.31L8 6.92L7.72 8.15C7.72 8.15 8.58 8.35 8.56 8.36C9 8.46 9.07 8.75 9.06 9L8.56 11.1C8.58 11.11 8.62 11.11 8.66 11.13L8.55 11.1L7.85 13.97C7.8 14.12 7.64 14.35 7.3 14.27C7.31 14.28 6.46 14.06 6.46 14.06L5.91 15.37L7.41 15.74C7.7 15.82 7.98 15.9 8.26 15.97L7.82 17.97L8.97 18.24L9.41 16.23C9.73 16.32 10.04 16.4 10.35 16.47L9.91 18.47L11.07 18.74L11.5 16.75C13.6 17.17 15.17 17 15.87 15.08C16.44 13.53 15.82 12.62 14.71 12.04C15.53 11.84 16.15 11.3 16.32 10.27C16.56 8.84 15.46 8.1 13.94 7.68Z"/>
                </svg>
                Lightning Network
            </a>` : '';

        this.modal = document.createElement('div');
        this.modal.setAttribute('role', 'dialog');
        this.modal.setAttribute('aria-modal', 'true');
        this.modal.setAttribute('aria-labelledby', 'donation-modal-title');
        this.modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:none;align-items:center;justify-content:center;padding:1rem;box-sizing:border-box;';
        this.modal.innerHTML = `
            <div class="bg-white rounded-2xl w-full max-w-2xl relative flex flex-col shadow-2xl overflow-hidden" style="max-height: 90vh;">
                <button id="donation-close-btn"
                        aria-label="閉じる"
                        class="absolute top-4 right-4 bg-white text-gray-600 hover:text-gray-900 rounded-full p-2 shadow-lg border border-gray-200 z-20 transition-transform hover:scale-110">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </button>
                <div class="overflow-y-auto w-full flex-grow bg-[#f9f9f9] relative z-0">
                    <h2 id="donation-modal-title" class="sr-only">Buy Me a Coffee</h2>
                    <iframe src="https://ko-fi.com/${this.kofiId}/?hidefeed=true&widget=true&embed=true&preview=true"
                            style="border:none;width:100%;padding:4px;background:#f9f9f9;"
                            height="712"
                            title="Ko-fi donation widget for ${this.kofiId}">
                    </iframe>
                </div>
                <div class="bg-white border-t border-gray-200 p-4 sm:p-5 flex flex-col sm:flex-row gap-3 justify-center items-center relative z-10 shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)]">
                    <span class="text-sm font-bold text-gray-600 w-full sm:w-auto text-center sm:text-left mb-1 sm:mb-0">Other options:</span>
                    <a href="${this.githubUrl}" target="_blank" rel="noopener noreferrer"
                       class="flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium py-2 px-4 rounded-lg w-full sm:w-auto transition-colors shadow-sm">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd"/>
                        </svg>
                        GitHub Sponsors
                    </a>
                    ${lightningBtn}
                </div>
            </div>
        `;
        document.body.appendChild(this.modal);
        this.closeBtn = this.modal.querySelector('#donation-close-btn');
    }

    renderButton() {
        const container = this.containerId
            ? (document.getElementById(this.containerId) ?? document.body)
            : document.body;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="relative group flex justify-center items-center">
                <div class="absolute bottom-full mb-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gray-800 text-white text-xs font-bold px-3 py-1.5 rounded-lg whitespace-nowrap pointer-events-none shadow-lg z-10" aria-hidden="true">
                    Buy Me a Coffee
                    <div class="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                </div>
                <button aria-label="Buy Me a Coffee - 寄付モーダルを開く"
                        class="transition-transform duration-300 group-hover:-translate-y-2 bg-transparent border-none p-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-800 rounded-full drop-shadow-md flex items-center justify-center w-8 h-8">
                    <div class="donation-animate-pop-shake w-full h-full flex items-center justify-center">
                        <img src="https://storage.ko-fi.com/cdn/logomarkLogo.png" alt="" class="max-w-full max-h-full object-contain">
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

    bindEvents() {
        this._abortController = new AbortController();
        const { signal } = this._abortController;

        const triggerBtn = this.openBtnWrapper.querySelector('button');

        const openModal = () => {
            this._prevOverflow = document.body.style.overflow;
            this.modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            this.closeBtn.focus();
        };

        const closeModal = () => {
            this.modal.style.display = 'none';
            document.body.style.overflow = this._prevOverflow;
        };

        triggerBtn.addEventListener('click', openModal, { signal });
        this.closeBtn.addEventListener('click', closeModal, { signal });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) closeModal();
        }, { signal });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) closeModal();
        }, { signal });
    }
}
