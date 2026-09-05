/* The OGP cards, as data.
 *
 * Every card is the same shell — brand rail, headline block, illustration,
 * footer rail — and differs only in its illustration and its category accent.
 * Adding a tool means adding one entry here.
 *
 * `cat` must match the tool's `category` in data/tools.json, so a card can
 * never drift from the colour its page and its index card already use.
 */
'use strict';

/* Category accents, dark-theme values from data/tools-ui.css. The card is dark,
 * so the light values (#0F766E etc.) would sink into it. */
const CATEGORIES = {
  converter: { accent: '#2DD4BF', ink: '#052E2B', label: 'CONVERTER' },
  optimizer: { accent: '#38BDF8', ink: '#06283A', label: 'OPTIMIZER' },
  editor:    { accent: '#818CF8', ink: '#14153A', label: 'EDITOR' },
  generator: { accent: '#E879F9', ink: '#2A0D31', label: 'GENERATOR' },
};

const SHELL_CSS = `
  :root {
    --canvas: #0E1113;
    --canvas-2: #14181B;
    --canvas-3: #101416;
    --canvas-rule: #242A2E;
    --canvas-rule-2: #333C43;
    --ink: #F2F5F6;
    --ink-2: #99A3AA;
    --ink-3: #6B757C;
    --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
    --jp: "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", system-ui, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: var(--canvas); color: var(--ink); font-family: var(--jp);
    display: flex; flex-direction: column; padding: 46px 48px 40px;
  }
  .rule { flex: 1; height: 1px; background: var(--canvas-rule); }

  .top { display: flex; align-items: center; gap: 22px; }
  .brand { display: flex; align-items: center; gap: 11px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .brand span, .kind { font-family: var(--mono); font-weight: 700; font-size: 13px; letter-spacing: .22em; }
  .kind { color: var(--accent); }

  .main { flex: 1; display: flex; align-items: center; gap: 44px; padding-top: 6px; }
  .left { width: 470px; flex: none; }
  h1 { font-weight: 900; font-size: 60px; line-height: 1.16; letter-spacing: .01em; color: #FFFFFF; }
  .sub { margin-top: 24px; font-size: 20px; line-height: 1.8; font-weight: 500; color: var(--ink-2); }
  .chips { margin-top: 30px; display: flex; gap: 11px; }
  .chip {
    border: 1px solid var(--canvas-rule-2); border-radius: 5px; padding: 9px 15px;
    font-size: 14.5px; font-weight: 500; color: var(--ink-2); white-space: nowrap;
  }
  .chips.mono .chip { font-family: var(--mono); font-size: 13.5px; letter-spacing: .04em; }

  .right { flex: 1; display: flex; align-items: center; gap: 18px; min-width: 0; }
  .panel {
    flex: 1; background: var(--canvas-2); border: 1px solid var(--canvas-rule);
    border-radius: 9px; overflow: hidden;
  }
  .panel-h {
    font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .2em;
    color: var(--ink-3); padding: 15px 19px; border-bottom: 1px solid var(--canvas-rule);
  }

  .foot { display: flex; align-items: center; gap: 22px; }
  .url { font-family: var(--mono); font-size: 15px; font-weight: 700; letter-spacing: .04em; color: var(--ink); }
  .noup { font-family: var(--mono); font-size: 15px; font-weight: 700; letter-spacing: .2em; color: var(--accent); }
`;

const CARDS = [
  {
    slug: 'csv-charset-converter', out: 'images/ogp/csv-charset-converter-ogp.png', cat: 'converter',
    h1: 'CSV Charset<br>Converter',
    sub: 'CSVが今なにで保存されているか、<br>ひと目で。まとめて直せる。',
    chips: ['自動判別', 'BOM 付け外し', '変換不可文字を検出'],
    css: `
      .row { display: flex; align-items: center; justify-content: space-between; gap: 14px;
             padding: 14px 19px; border-bottom: 1px solid var(--canvas-rule); }
      .row:last-child { border-bottom: 0; }
      .fname { font-family: var(--mono); font-size: 15.5px; color: #D7DCDF; }
      .enc { font-family: var(--mono); font-size: 12.5px; border: 1px solid var(--canvas-rule-2);
             border-radius: 5px; padding: 3px 9px; color: #C3CACF; white-space: nowrap; }
      .row.flag .enc { border-color: var(--accent); color: var(--accent); }
      .arrow { font-size: 20px; color: #556067; }
      .pill { font-family: var(--mono); font-size: 14px; font-weight: 700; letter-spacing: .04em;
              background: var(--accent); color: var(--accent-ink); padding: 12px 16px;
              border-radius: 8px; white-space: nowrap; }`,
    panel: `
      <div class="panel">
        <div class="panel-h">DETECTED</div>
        <div class="row"><span class="fname">売上_2026.csv</span><span class="enc">Shift_JIS</span></div>
        <div class="row"><span class="fname">顧客名簿.csv</span><span class="enc">EUC-JP</span></div>
        <div class="row"><span class="fname">export.csv</span><span class="enc">UTF-8</span></div>
        <div class="row flag"><span class="fname">old_log.csv</span><span class="enc">ISO-2022-JP</span></div>
      </div>
      <div class="arrow">&#8594;</div>
      <div class="pill">UTF-8（BOM）</div>`,
  },

  {
    slug: 'csv-json-bridge', out: 'images/ogp/csv-json-bridge-ogp.png', cat: 'converter', chipMono: true,
    h1: 'CSV JSON<br>Bridge',
    sub: 'Excel からの貼り付けにも対応。<br>エラーは行番号で教えます。',
    chips: ['UTF-8 / BOM', 'Shift-JIS', 'ヘッダー指定'],
    css: `
      .right { gap: 14px; }
      .code { flex: 1; background: var(--canvas-2); border: 1px solid var(--canvas-rule);
              border-radius: 8px; overflow: hidden; height: 300px; }
      .code-h { font-family: var(--mono); font-size: 11.5px; letter-spacing: .2em; color: var(--ink-3);
                padding: 10px 14px; border-bottom: 1px solid var(--canvas-rule); background: var(--canvas-2); }
      .code-b { font-family: var(--mono); font-size: 12.5px; line-height: 1.95; color: #C3CACF;
                padding: 12px 14px; background: var(--canvas-3); height: 100%; white-space: pre; }
      .swap { display: flex; flex-direction: column; gap: 9px; flex: none; }
      .btn { font-family: var(--mono); font-size: 12.5px; font-weight: 700; letter-spacing: .06em;
             padding: 10px 13px; border-radius: 7px; white-space: nowrap; }
      .btn.on { background: var(--accent); color: var(--accent-ink); }
      .btn.off { border: 1px solid var(--canvas-rule-2); color: var(--ink-2); }`,
    panel: `
      <div class="code"><div class="code-h">CSV</div><div class="code-b">id,sku,name
1,1234567,商品A
2,9876543,商品B
3,1111111,商品C</div></div>
      <div class="swap">
        <div class="btn on">CSV &#8594; JSON</div>
        <div class="btn off">JSON &#8594; CSV</div>
      </div>
      <div class="code"><div class="code-h">JSON</div><div class="code-b">[
  {
    "id": "1",
    "sku": "1234567",
    "name": "商品A"
  },</div></div>`,
  },

  {
    slug: 'nextgen-image', out: 'images/ogp/nextgen-image-ogp.png', cat: 'converter', chipMono: true,
    h1: 'NextGen<br>Image',
    sub: '画像を WEBP / AVIF に一発変換。<br>次世代フォーマットで、美しいまま軽く。',
    chips: ['WEBP', '可逆 WEBP', 'AVIF', 'HEIC 対応'],
    css: `
      .body { padding: 22px 24px 26px; }
      .big { display: flex; align-items: flex-start; justify-content: space-between; }
      .pct { font-family: var(--jp); font-weight: 900; font-size: 76px; line-height: .95;
             color: var(--accent); letter-spacing: -.02em; }
      .pct i { font-style: normal; font-size: 30px; font-weight: 700; }
      .meta { font-family: var(--mono); font-size: 13px; line-height: 1.7; color: var(--ink-3);
              text-align: right; padding-top: 10px; letter-spacing: .1em; }
      .bar { display: flex; align-items: center; gap: 16px; margin-top: 16px; }
      .bar-l { font-family: var(--mono); font-size: 12.5px; letter-spacing: .16em; color: var(--ink-3); width: 66px; }
      .track { flex: 1; height: 11px; border-radius: 6px; background: #1B2126; }
      .track i { display: block; height: 100%; border-radius: 6px; }
      .bar-v { font-family: var(--mono); font-size: 14px; font-weight: 700; color: var(--ink); width: 74px; text-align: right; }`,
    panel: `
      <div class="panel">
        <div class="panel-h">SAVED</div>
        <div class="body">
          <div class="big">
            <div class="pct">-73<i>%</i></div>
            <div class="meta">3 FILES<br>204 MS</div>
          </div>
          <div class="bar"><span class="bar-l">BEFORE</span>
            <span class="track"><i style="width:100%;background:#3B454D"></i></span>
            <span class="bar-v">2.41 MB</span></div>
          <div class="bar"><span class="bar-l">AFTER</span>
            <span class="track"><i style="width:27%;background:var(--accent)"></i></span>
            <span class="bar-v">638 KB</span></div>
        </div>
      </div>`,
  },

  {
    slug: 'image-to-animation', out: 'images/ogp/image-to-animation-ogp.webp', cat: 'converter', chipMono: true,
    h1: 'Image to<br>Animation',
    sub: '複数の画像から1本のアニメーションを。<br>順番はドラッグで並べ替えられます。',
    chips: ['WEBP', 'APNG', 'GIF', '往復再生'],
    css: `
      .body { padding: 18px 20px 22px; }
      .frames { display: flex; gap: 12px; }
      .frame { flex: 1; aspect-ratio: 1/1; border-radius: 5px; }
      .bar { display: flex; align-items: center; gap: 16px; margin-top: 18px; }
      .bar-l { font-family: var(--mono); font-size: 12.5px; letter-spacing: .16em; color: var(--ink-3); width: 66px; }
      .track { flex: 1; height: 11px; border-radius: 6px; background: #1B2126; }
      .track i { display: block; height: 100%; border-radius: 6px; }
      .bar-v { font-family: var(--mono); font-size: 14px; font-weight: 700; color: var(--ink); width: 66px; text-align: right; }`,
    panel: `
      <div class="panel">
        <div class="panel-h">FRAMES</div>
        <div class="body">
          <div class="frames">
            <div class="frame" style="background:linear-gradient(150deg,#154740,#34A293)"></div>
            <div class="frame" style="background:linear-gradient(150deg,#288A7D,#77DFD1)"></div>
            <div class="frame" style="background:linear-gradient(150deg,#2DD4BF,#CCF5EF)"></div>
          </div>
          <div class="bar"><span class="bar-l">SOURCE</span>
            <span class="track"><i style="width:100%;background:#3B454D"></i></span>
            <span class="bar-v">123 KB</span></div>
          <div class="bar"><span class="bar-l">OUTPUT</span>
            <span class="track"><i style="width:14%;background:var(--accent)"></i></span>
            <span class="bar-v">17 KB</span></div>
        </div>
      </div>`,
  },

  {
    slug: 'video-to-animation', out: 'images/ogp/video-to-animation-ogp.webp', cat: 'converter', chipMono: true,
    h1: 'Video to<br>Animation',
    sub: '動画を、貼って共有できる<br>アニメーション画像に変換します。',
    chips: ['MP4 / WEBM', 'WEBP', 'APNG', 'GIF'],
    css: `
      .body { padding: 18px 20px 22px; }
      .term { background: #080A0C; border: 1px solid var(--canvas-rule); border-radius: 7px;
              padding: 18px 20px; font-family: var(--mono); font-size: 14.5px; line-height: 2.05; }
      .term .c { color: #E6E9EB; }
      .term .d { color: var(--ink-3); }
      .term .a { color: var(--accent); }
      .cur { display: inline-block; width: 9px; height: 17px; background: var(--accent); vertical-align: -3px; }`,
    panel: `
      <div class="panel">
        <div class="panel-h">ENCODING</div>
        <div class="body">
          <div class="term">
            <div><span class="d">$</span> <span class="c">encode clip.mp4 --to webp --fps 15</span></div>
            <div class="d">&gt; ffmpeg ready</div>
            <div class="d">&gt; input loaded&nbsp; 4.2 MB</div>
            <div class="a">&#10003; clip.webp&nbsp; 4.2 MB &#8594; 512 KB</div>
            <div><span class="d">$</span> <span class="cur"></span></div>
          </div>
        </div>
      </div>`,
  },

  {
    slug: 'light-svg', out: 'images/ogp/light-svg-ogp.webp', cat: 'optimizer', chipMono: true,
    h1: 'Light<br>SVG',
    sub: 'SVG を設定なしで軽量化。<br>スライダーを動かすと結果がその場で変わります。',
    chips: ['SVGO', 'PNG &#8594; SVG', 'Data URI'],
    css: `
      .right { flex-direction: column; align-items: stretch; gap: 14px; }
      .sheet {
        position: relative; height: 340px; border-radius: 4px; background: #FBFBFC;
        background-image: linear-gradient(#E4E8EC 1px, transparent 1px),
                          linear-gradient(90deg, #E4E8EC 1px, transparent 1px);
        background-size: 19px 19px;
      }
      .brk { position: absolute; width: 26px; height: 26px; border: 2px solid var(--accent); }
      .brk.tl { top: 12px; left: 12px; border-right: 0; border-bottom: 0; }
      .brk.br { right: 12px; bottom: 12px; border-left: 0; border-top: 0; }
      .art { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 300px; }
      .head { width: 74px; height: 74px; border-radius: 50%; background: #26303C; margin: 0 auto 4px; }
      .dome { height: 96px; border-radius: 150px 150px 0 0; background: var(--accent); }
      .base { height: 11px; background: #94A3B0; margin-top: 5px; }
      .scale { display: flex; align-items: center; gap: 14px; font-family: var(--mono);
               font-size: 13px; letter-spacing: .12em; }
      .scale .from { color: var(--ink-3); }
      .scale .to { color: var(--accent); }
      .scale .line { flex: 1; height: 1px; background: var(--canvas-rule-2); position: relative; }
      .scale .line::before, .scale .line::after { content: ""; position: absolute; top: -4px;
        width: 1px; height: 9px; background: var(--canvas-rule-2); }
      .scale .line::before { left: 0; } .scale .line::after { right: 0; }`,
    panel: `
      <div class="sheet">
        <i class="brk tl"></i><i class="brk br"></i>
        <div class="art"><div class="head"></div><div class="dome"></div><div class="base"></div></div>
      </div>
      <div class="scale"><span class="from">12.4 KB</span><i class="line"></i><span class="to">3.4 KB</span></div>`,
  },

  {
    slug: 'pdf-studio', out: 'images/ogp/pdf-studio-ogp.png', cat: 'editor',
    h1: 'PDF<br>Studio',
    sub: '回転・結合・分割・面付け・墨消しを<br>1画面で。アップロード不要。',
    chips: ['交互結合', '中綴じ面付け', '墨消し', '圧縮'],
    css: `
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 11px; padding: 16px 18px 18px; }
      .pg { aspect-ratio: 1/1.36; background: #F4F6F8; border-radius: 3px; padding: 9px 8px;
            border: 2px solid transparent; }
      .pg.sel { border-color: var(--accent); }
      .pg i { display: block; height: 2px; background: #C3CBD3; border-radius: 1px; margin-bottom: 4px; }
      .pg i.t { height: 4px; width: 62%; background: #97A3AE; margin-bottom: 7px; }`,
    panel: `
      <div class="panel">
        <div class="panel-h">18 PAGES &middot; 4 SELECTED</div>
        <div class="grid">
          <div class="pg sel"></div><div class="pg sel"></div><div class="pg"></div><div class="pg"></div>
          <div class="pg"></div><div class="pg sel"></div><div class="pg sel"></div><div class="pg"></div>
        </div>
      </div>`,
    // Ruled lines are filler, not content: generating them beats 96 hand-written tags.
    post: `document.querySelectorAll('.pg').forEach(p => {
      p.innerHTML = '<i class="t"></i>' + '<i></i>'.repeat(11);
    });`,
  },

  {
    slug: 'text-diff', out: 'images/ogp/text-diff-ogp.png', cat: 'editor',
    h1: 'Diff<br>Studio',
    sub: '2つの文章の違いを<br>1文字単位で色分け。',
    chips: ['表記ゆれを無視', '採用／却下', '文字数カウント'],
    css: `
      .right { flex-direction: column; align-items: stretch; gap: 14px; }
      .pair { display: flex; gap: 14px; }
      .side { flex: 1; background: var(--canvas-2); border: 1px solid var(--canvas-rule);
              border-radius: 8px; overflow: hidden; }
      .side-h { font-size: 13px; color: var(--ink-3); padding: 11px 15px;
                border-bottom: 1px solid var(--canvas-rule); }
      .side-h b { font-family: var(--mono); font-weight: 500; margin-left: 8px; }
      .side-b { padding: 14px 15px 16px; font-size: 15px; line-height: 2.1; color: #DDE2E5; }
      /* Diff colours are semantic, never the accent — same rule as the tool page. */
      .del { background: rgb(220 38 38 / .30); border-radius: 2px; }
      .ins { background: rgb(14 159 110 / .32); border-radius: 2px; }
      .tally { display: flex; align-items: center; gap: 18px; font-family: var(--mono);
               font-size: 15px; font-weight: 700; }
      .tally .p { color: #34D399; } .tally .m { color: #F87171; }
      .tally .n { color: var(--ink-3); font-weight: 500; }`,
    panel: `
      <div class="pair">
        <div class="side">
          <div class="side-h">変更前<b>/ A</b></div>
          <div class="side-b">新しい<span class="del">問合せ</span>窓口を<br>
            <span class="del">開設致します</span>。<br>
            平日<span class="del">9</span>時から<span class="del">１８</span>時<br>
            までに<span class="del">行なって下さい</span>。</div>
        </div>
        <div class="side">
          <div class="side-h">変更後<b>/ B</b></div>
          <div class="side-b">新しい<span class="ins">お問い合わせ</span>窓口を<br>
            <span class="ins">開設します</span>。<br>
            平日<span class="ins">9</span>時から<span class="ins">18</span>時<br>
            までに<span class="ins">行ってください</span>。</div>
        </div>
      </div>
      <div class="tally"><span class="p">+28</span><span class="m">-31</span><span class="n">90&nbsp;&nbsp;一致</span></div>`,
  },

  {
    slug: 'qr-atelier', out: 'images/ogp/qr-atelier-ogp.png', cat: 'generator',
    h1: 'QR<br>Atelier',
    sub: 'セル・マーカー・色・ロゴまで。<br>おしゃれなQRコードを、無料で。',
    chips: ['デザイン28種', 'セル16種', 'グラデーション', 'SVG書き出し'],
    css: `
      .right { justify-content: flex-end; }
      .art { width: 483px; height: auto; display: block; }`,
    // Real, decodable QR codes exported from the tool itself. Drawing imitation
    // codes here would put an unscannable picture on every share of this page.
    // Verified with jsQR after every regeneration — see README.
    asset: 'qr-artwork.png',
    panel: '<img class="art" src="ASSET" alt="">',
  },
];

module.exports = { CATEGORIES, SHELL_CSS, CARDS };
