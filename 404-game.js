// 404 ページそのものを壊すブロック崩し。404.html の「404」を押したときだけ読み込まれる（window.ST404Game.start）。
// ブロックは本物の要素で、ボールとバーだけを重ねたキャンバスに描く。「404」から4つのボールが飛び出し、
// 4つとも落とすと残りが崩れ落ちて積み重なる。最後に、動かした要素と分けた文字をすべて元に戻す。外部の素材も通信も使わない
(() => {
  'use strict';
  const doc = document.documentElement;
  const JA = doc.lang !== 'en';
  const TOUCH = matchMedia('(pointer: coarse)').matches;
  const PRESS = JA ? (TOUCH ? 'タップ' : 'Space・クリック') : (TOUCH ? 'Tap' : 'Space or click');
  const T = JA ? {
    about: 'ページを壊すブロック崩し。「404」から4つのボールが飛び出します。矢印キー・マウス・ドラッグでバーを動かし、全部落とすとゲームオーバーです。Esc か戻る操作で終わり、M で消音します。',
    hint: TOUCH ? 'ドラッグでバーを動かす・戻るで終わる' : '← → / マウスでバーを動かす・M 消音・Esc で終わる',
    clear: 'ページを全部壊しました。',
    over: 'ゲームオーバー。ページが崩れ落ちました。',
    restore: `${PRESS}で元に戻す`,
    restored: 'ページを元に戻しました。',
  } : {
    about: 'A breakout game that breaks this page. Four balls burst out of the 404. Move the paddle with the arrow keys, the mouse, or by dragging; lose all the balls and the game is over. Press Esc or go back to stop, and M to mute.',
    hint: TOUCH ? 'Drag to move · go back to stop' : '← → / mouse to move · M mute · Esc to stop',
    clear: 'You broke the whole page.',
    over: 'Game over. The page collapsed.',
    restore: `${PRESS} to restore`,
    restored: 'The page has been restored.',
  };
  // 文字をまとまりに分ける要素（URL は「/」ごと）と、要素ごとにブロックにする範囲
  const WORDS = ['.error-code > span[aria-hidden]', 'header h1', 'header .intro', '#explore-heading', 'main > a.home'];
  const PATHS = ['header .requested-url'];
  const BLOCKS = ['#search', '#sitemap', '.sitemap-extra'];
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- 音（波形をその場で鳴らす） ----
  let muted = false, lastThud = 0, master = null;
  try { muted = localStorage.getItem('st-404-mute') === '1'; } catch (e) {}
  // 入口のクリックの中で作った AudioContext を使う（作れなかった環境では鳴らさない）
  function audio() {
    const ac = window.ST404Audio;
    if (!ac) return null;
    if (!master) {
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    }
    if (ac.state !== 'running') ac.resume().catch(() => {});
    return ac;
  }
  // 立ち上げて少し保ってから消す。すぐ減衰させると、小さなスピーカーでは聞こえない
  function tone(freq, dur, { type = 'square', to = 0, vol = 0.3, at = 0 } = {}) {
    const ac = !muted && audio();
    if (!ac) return;
    const t = ac.currentTime + 0.01 + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.setValueAtTime(vol, t + dur * 0.6);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  const notes = (freqs, dur, gap, opts) => freqs.forEach((f, i) => tone(f, dur, { ...opts, at: (opts.at || 0) + i * gap }));
  const sfx = {
    paddle: () => tone(440, 0.09),
    wall: () => tone(660, 0.05, { type: 'triangle', vol: 0.25 }),
    // 打ち返すまでに続けて壊すほど半音ずつ上がる（1オクターブで頭打ち）
    brick: n => tone(880 * 2 ** (Math.min(n, 12) / 12), 0.08, { vol: 0.2 }),
    drop: () => tone(440, 0.5, { type: 'sawtooth', to: 80, vol: 0.25 }),
    rumble: () => tone(110, 0.6, { type: 'sawtooth', to: 45 }),
    collapse: () => tone(220, 1.2, { type: 'sawtooth', to: 40 }),
    burst: () => notes([660, 880, 1100, 1320], 0.07, 0.04, { at: 0.1, vol: 0.2 }),
    clear: () => notes([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.18, 0.09, { vol: 0.25 }),
    restore: () => notes([392, 523.25, 659.25], 0.12, 0.07, { type: 'triangle' }),
    // 崩れた要素の着地。重なって割れないよう間を空ける
    thud: () => {
      const now = performance.now();
      if (now - lastThud < 70) return;
      lastThud = now;
      tone(90 + Math.random() * 60, 0.12, { type: 'triangle', to: 50, vol: 0.4 });
    },
  };

  // ---- 文字をまとまりに分ける ----
  // 文字の種類: h ひらがな / k カタカナ / c 漢字 / a 英数字 / p 記号
  function kind(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x3041 && c <= 0x309f) return 'h';
    if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) return 'k';
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || c === 0x3005) return 'c';
    if (/[0-9A-Za-z]/.test(ch) || (c >= 0xff10 && c <= 0xff5a)) return 'a';
    return 'p';
  }
  // ブラウザの単語分割（「見／つ／か／り」）をつなぎ直す。ひらがなだけの語と記号は前に、カタカナどうし・漢字どうしもつなぐ。
  // 名詞の直後の助詞は小さなブロックとして切り離し、その後ろのひらがなは助詞につながない。
  // 例: 「ページ」「が」「見つかりませんでした」、「誤り」「が」「あるかもしれません。」
  const PARTICLES = new Set(['が', 'の', 'を', 'に', 'へ', 'と', 'で', 'や', 'は', 'も', 'から', 'まで', 'より']);
  function chunks(str) {
    const seg = window.Intl && Intl.Segmenter ? new Intl.Segmenter(JA ? 'ja' : 'en', { granularity: 'word' }) : null;
    const parts = seg ? Array.from(seg.segment(str), s => s.segment) : str.split(/(\s+)/);
    const out = [];
    let open = false, noun = false, afterParticle = false;
    for (const p of parts) {
      if (!p) continue;
      if (!p.trim()) { out.push(p); open = noun = afterParticle = false; continue; }
      const kinds = [...p].map(kind);
      const hira = kinds.every(k => k === 'h');
      const particle = hira && noun && PARTICLES.has(p);
      const join = open && !particle && (kinds[0] === 'p' || (hira && !afterParticle) || ((kinds[0] === 'k' || kinds[0] === 'c') && kinds[0] === kind(out[out.length - 1].slice(-1))));
      if (join) out[out.length - 1] += p;
      else { out.push(p); open = true; }
      if (kinds[0] !== 'p') afterParticle = particle;
      noun = kinds.some(k => k === 'c' || k === 'k' || k === 'a');
    }
    return out;
  }
  let wrapped = []; // 分けた文字: { text: 元のテキストノード, nodes: 置き換えたノード }
  function splitWords(el, out, byPath) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) texts.push(walker.currentNode);
    for (const text of texts) {
      const parts = byPath ? text.nodeValue.match(/[^/]*\/|[^/]+$/g) : chunks(text.nodeValue);
      const nodes = parts.map(p => {
        if (!p.trim()) return document.createTextNode(p);
        const span = document.createElement('span');
        span.className = 'g404-w';
        span.textContent = p;
        out.push(span);
        return span;
      });
      text.replaceWith(...nodes);
      wrapped.push({ text, nodes });
    }
  }
  // タイルは中の行（アイコン・名前・説明・パス）をブロックにし、行が全部壊れたら枠も落とす。
  // ほかは高さ160pxを超える要素とタイルを含む要素を子に分け、それ以外を1つのブロックにする
  const FRAMES = '.tile';
  let frameOf = new Map(); // 行 → 枠
  let inlined = []; // インライン要素は transform が効かないので inline-block にした: { el, cls: 元の class 属性 }
  function block(el, out) {
    if (el instanceof HTMLElement && getComputedStyle(el).display === 'inline') {
      inlined.push({ el, cls: el.getAttribute('class') });
      el.classList.add('g404-w');
    }
    out.push(el);
  }
  function splitBlocks(el, out) {
    if (el.hidden || getComputedStyle(el).visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    if (el.matches(FRAMES)) { for (const c of el.children) { block(c, out); frameOf.set(c, el); } return; }
    if ((r.height > 160 || el.querySelector(FRAMES)) && el.children.length) { for (const c of el.children) splitBlocks(c, out); return; }
    block(el, out);
  }

  // ---- 壊す・崩す ----
  const anims = new Map(); // 動かした要素 → アニメーション（元に戻すときに逆再生する）
  // 打たれた要素は、位置を空けたまま画面の外まで落ちて消える（回転しても角が残らないよう、対角線の半分だけ余分に落とす）
  function fall(el, delay = 0) {
    const r = el.getBoundingClientRect();
    const dy = H - r.top - r.height / 2 + Math.hypot(r.width, r.height) / 2 + 20;
    const frames = reduce
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ transform: 'none', opacity: 1 }, { transform: `translate(${(Math.random() - 0.5) * 120}px, ${dy}px) rotate(${(Math.random() - 0.5) * 120}deg)`, opacity: 0 }];
    anims.set(el, el.animate(frames, { duration: reduce ? 200 : 800, delay, easing: 'cubic-bezier(.55, 0, 1, .45)', fill: 'both' }));
  }
  // 崩壊: 残った要素を箱として落とし、床・壁・ほかの箱にぶつけて積み上げる（回転はせず、見た目に少し傾けるだけ）。
  // 行が残っているタイルは枠ごと1つの箱にする
  let bodies = [];
  function collapse() {
    const now = performance.now();
    const items = new Set();
    for (const k of bricks) if (k.alive) items.add(k.group ? k.group.el : k.el);
    bodies = [];
    for (const el of items) {
      if (reduce) { anims.set(el, el.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 200, fill: 'both' })); continue; }
      const r = el.getBoundingClientRect();
      bodies.push({
        el, x: r.left, y: r.top, w: r.width, h: r.height, ox: r.left, oy: r.top,
        vx: (Math.random() - 0.5) * 120, vy: 0, tilt: (Math.random() - 0.5) * 5,
        at: now + Math.random() * 700, style: el.getAttribute('style'),
      });
    }
  }
  // 重ならないことを先に守る: 横は動かして重なったら戻し、縦は真下（真上）の最も近い面で止める（速くてもすり抜けない）
  const across = (b, o) => Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x) > 0.5;
  const overlaps = b => bodies.some(o => o !== b && across(b, o) && Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y) > 0.5);
  let idle = 0; // 箱がすべて止まっているフレームの数（続いたら更新を止める）
  function physics(dt, now) {
    const G = 2600, STEPS = 3;
    const h = dt / STEPS;
    for (let s = 0; s < STEPS; s++) {
      bodies.sort((a, b) => (b.y + b.h) - (a.y + a.h)); // 下から動かすと積み上がりが落ち着く
      for (const b of bodies) {
        if (now < b.at) continue; // 崩れ始めるまでは足場になる
        if (b.vx) {
          const x0 = b.x;
          const nx = b.x + b.vx * h;
          b.x = clamp(nx, 0, Math.max(0, W - b.w));
          if (overlaps(b)) b.x = x0;
          if (b.x !== nx) b.vx = -b.vx * 0.3;
        }
        b.vy = Math.min(b.vy + G * h, 1500);
        const y0 = b.y;
        let y = y0 + b.vy * h, landed = false;
        if (b.vy >= 0) {
          let floor = H;
          for (const o of bodies) if (o !== b && across(b, o) && o.y >= y0 + b.h - 1) floor = Math.min(floor, o.y);
          if (y + b.h >= floor) { y = floor - b.h; landed = true; }
        } else {
          let ceil = -Infinity;
          for (const o of bodies) if (o !== b && across(b, o) && o.y + o.h <= y0 + 1) ceil = Math.max(ceil, o.y + o.h);
          if (y < ceil) { y = ceil; b.vy = 0; }
        }
        b.y = y;
        if (landed) {
          if (b.vy > 500) sfx.thud();
          b.vy = b.vy > 300 ? -b.vy * 0.2 : 0; // 少しだけ跳ねる
          b.vx *= 0.8;
        }
      }
    }
    for (const b of bodies) {
      if (now >= b.at) b.el.style.transform = `translate(${b.x - b.ox}px, ${b.y - b.oy}px) rotate(${b.tilt}deg)`;
    }
    idle = bodies.every(b => now >= b.at && !b.vy && Math.abs(b.vx) < 1) ? idle + 1 : 0;
  }

  // ---- 盤面と進行 ----
  let state = 'closed'; // play / over / clear / restoring / closed
  let W, H, py, pw, zoneTop, px, balls, base, bricks, alive, combo, hint, reduce;
  let wrap, canvas, ctx, live, saved, events, pushed = false, backPending = false, gen = 0, raf = 0, last = 0, colors = {};
  // 検索欄へ自動でフォーカスするのは、404.html 本体と同じくマウスのある環境だけ（タッチ端末でキーボードを開かない）
  const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const keys = { ArrowLeft: 0, ArrowRight: 0 };
  const PH = 10, R = 6;

  function readColors() {
    const s = getComputedStyle(doc);
    const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    const bg = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).join(',');
    colors = { accent: v('--accent', '#15803d'), text: v('--text', '#1f2937'), bg: `rgba(${bg},0.92)` };
  }
  function size() {
    W = doc.clientWidth;
    H = doc.clientHeight;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * d);
    canvas.height = Math.round(H * d);
    wrap.style.width = canvas.style.width = W + 'px';
    wrap.style.height = canvas.style.height = H + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    py = H - 40;
    pw = clamp(W * 0.18, 90, 170);
    zoneTop = H - clamp(H * 0.125, 70, 120); // バーの周りの範囲。ここにかかる要素は開始時に自動で崩す
  }
  function announce(msg) {
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = msg; }, 50);
  }
  function build() {
    if (!live) {
      const style = document.createElement('style');
      style.textContent =
        '.g404{position:fixed;left:0;top:0;z-index:2147483000}' +
        '.g404 canvas{display:block;touch-action:none;outline:none}' +
        '.g404 canvas.is-playing{cursor:none}' +
        '.g404-w{display:inline-block}' +
        '.g404-live{position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}';
      document.head.append(style);
      live = document.createElement('p');
      live.className = 'g404-live';
      live.setAttribute('aria-live', 'polite');
      document.body.append(live);
    }
    // ボタンは置かない（全部壊すのが目的なので、画面に残り続ける部品を作らない）。終わるのは Esc・戻る操作・ゲームの終わり
    wrap = document.createElement('div');
    wrap.className = 'g404';
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', T.about);
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d is unavailable');
    canvas.addEventListener('pointermove', e => { px = e.clientX; });
    canvas.addEventListener('pointerdown', e => { px = e.clientX; audio(); });
    // 元に戻す操作は click で受ける。pointerdown で戻すと、同じタップの続き（pointerup・click）が下にあったリンクに届く
    canvas.addEventListener('click', action);
    canvas.addEventListener('blur', () => { keys.ArrowLeft = keys.ArrowRight = 0; });
    wrap.append(canvas);
    document.body.append(wrap);
  }

  function start() {
    if (state !== 'closed') return;
    // 前回の終わりに外した履歴の popstate がまだ届いていなければ、届いてから始める（届いた popstate で新しいゲームが終わらないように）
    if (backPending) { window.addEventListener('popstate', start, { once: true }); return; }
    state = 'starting';
    saved = { overflow: doc.style.overflow, gutter: doc.style.scrollbarGutter };
    try {
      begin();
    } catch (e) {
      // 途中で失敗したら、ページを操作できない状態で残さないよう、すぐ元に戻す
      state = 'restoring';
      finish(false);
      console.error(e);
    }
  }
  function begin() {
    audio();
    reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    readColors();
    // スクロールを止めてから測る。スクロールバーがあったときは、その幅を残して横にずれないようにする
    if (doc.scrollHeight > doc.clientHeight) doc.style.scrollbarGutter = 'stable';
    doc.style.overflow = 'hidden';
    const els = [];
    frameOf = new Map();
    idle = 0;
    for (const sel of WORDS) document.querySelectorAll(sel).forEach(el => { if (!el.hidden) splitWords(el, els, false); });
    for (const sel of PATHS) document.querySelectorAll(sel).forEach(el => { if (!el.hidden) splitWords(el, els, true); });
    for (const sel of BLOCKS) document.querySelectorAll(sel).forEach(el => splitBlocks(el, els));
    build();
    size();
    // バーの周りにかかるものは開始時に落とす。タイルは枠で判定し、かかれば枠ごと落とす
    bricks = [];
    const floor = new Set(), groups = new Map();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 4 || r.top > H || r.right < 0 || r.left > W) continue;
      const frame = frameOf.get(el);
      if ((frame ? frame.getBoundingClientRect() : r).bottom > zoneTop) { floor.add(frame || el); continue; }
      let group = null;
      if (frame) {
        group = groups.get(frame);
        if (!group) groups.set(frame, group = { el: frame, left: 0 });
        group.left++;
      }
      bricks.push({ el, x: r.left, y: r.top, w: r.width, h: r.height, alive: true, group });
    }
    alive = bricks.length;
    const main = document.querySelector('main');
    if (main) main.inert = true; // 遊んでいるあいだ、ページのリンクや検索欄に触れないようにする
    canvas.focus({ preventScroll: true });
    // スマホには Esc が無いので、戻る操作（Android の戻る・iPhone の端からのスワイプ）で終われるよう履歴を1つ積む
    try { history.pushState({ g404: true }, ''); pushed = true; } catch (e) { pushed = false; }
    // 足場が抜け落ち、「404」が落ち、そこから4つのボールが4方向（右下・左下・左上・右上）に1つずつ飛び出す。
    // 各方向の中の向きはランダムで、真横・真上下に近い向きは避ける
    for (const el of floor) fall(el, Math.random() * 250);
    if (floor.size) sfx.rumble();
    const trigger = document.getElementById('game-trigger');
    const tr = trigger ? trigger.getBoundingClientRect() : { left: W / 2, top: 0, width: 0, height: 0 };
    if (trigger) fall(trigger);
    combo = 0; hint = true;
    base = clamp(H * 0.85, 380, 620);
    px = W / 2;
    const cx = tr.left + tr.width / 2, cy = clamp(tr.top + tr.height / 2, R, py - R - 1);
    balls = [];
    for (let i = 0; i < 4; i++) {
      const a = (i + 1 / 6 + Math.random() * 2 / 3) * Math.PI / 2;
      balls.push({ x: cx, y: cy, vx: base * Math.cos(a), vy: base * Math.sin(a), s: base });
    }
    sfx.burst();
    setState('play');
    announce(T.about);
    events = new AbortController();
    const on = (target, type, fn) => target.addEventListener(type, fn, { signal: events.signal });
    on(document, 'keydown', onKey);
    on(document, 'keyup', e => { if (e.key in keys) keys[e.key] = 0; });
    on(window, 'resize', onResize);
    on(window, 'popstate', () => { pushed = false; restore(false); }); // 戻る操作で、積んだ履歴が外れた
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function setState(s) {
    state = s;
    canvas.classList.toggle('is-playing', s === 'play');
  }
  function hitBrick(ball) {
    for (const k of bricks) {
      if (k.alive && ball.x + R > k.x && ball.x - R < k.x + k.w && ball.y + R > k.y && ball.y - R < k.y + k.h) {
        k.alive = false;
        alive--;
        combo++;
        sfx.brick(combo);
        fall(k.el);
        if (k.group && --k.group.left === 0) fall(k.group.el);
        return true;
      }
    }
    return false;
  }
  function sub(b, dt) {
    b.x += b.vx * dt;
    if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx); sfx.wall(); }
    else if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx); sfx.wall(); }
    else if (hitBrick(b)) { b.x -= b.vx * dt; b.vx = -b.vx; }
    b.y += b.vy * dt;
    if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy); sfx.wall(); }
    else if (hitBrick(b)) { b.y -= b.vy * dt; b.vy = -b.vy; }
    // バーの当たった位置で角度を変える（端ほど斜め、最大60度）。打ち返すたびに少しずつ速く
    if (b.vy > 0 && b.y + R >= py && b.y - R <= py + PH && b.x >= px - pw / 2 - R && b.x <= px + pw / 2 + R) {
      const ang = clamp((b.x - px) / (pw / 2), -1, 1) * Math.PI / 3;
      b.s = Math.min(b.s * 1.02, base * 1.6);
      b.vx = b.s * Math.sin(ang);
      b.vy = -b.s * Math.cos(ang);
      b.y = py - R;
      combo = 0;
      hint = false;
      sfx.paddle();
    }
  }
  function step(dt, now) {
    px = clamp(px + (keys.ArrowRight - keys.ArrowLeft) * W * 1.1 * dt, pw / 2, W - pw / 2);
    if (state === 'play') {
      // すり抜けないよう、いちばん速いボールの半径の半分ずつ進める
      const n = Math.max(1, Math.ceil(Math.max(...balls.map(b => b.s)) * dt / (R * 0.5)));
      for (let i = 0; i < n; i++) {
        for (const b of balls) sub(b, dt / n);
        const count = balls.length;
        balls = balls.filter(b => b.y - R <= H);
        if (balls.length < count) sfx.drop();
        if (!alive) { setState('clear'); sfx.clear(); announce(T.clear); break; }
        if (!balls.length) { setState('over'); collapse(); sfx.collapse(); announce(T.over); break; }
      }
    }
    if (bodies.length) physics(dt, now);
  }
  // 「GAME OVER」「CLEAR」と、元に戻す操作の案内を枠の中に描く
  function message(title) {
    const big = clamp(Math.round(W / 16), 28, 56);
    ctx.font = `700 ${big}px ${MONO}`;
    const bw = ctx.measureText(title).width;
    ctx.font = `600 14px ${MONO}`;
    const w = Math.max(bw, ctx.measureText(T.restore).width) + 48;
    const h = big + 66;
    const x = (W - w) / 2, y = H * 0.42 - h / 2;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = colors.accent;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.text;
    ctx.fillText(T.restore, W / 2, y + big + 32);
    ctx.fillStyle = colors.accent;
    ctx.font = `700 ${big}px ${MONO}`;
    ctx.fillText(title, W / 2, y + 20);
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (state === 'restoring') return;
    ctx.fillStyle = colors.text;
    ctx.fillRect(px - pw / 2, py, pw, PH);
    if (state === 'play') {
      ctx.fillStyle = colors.accent;
      for (const b of balls) ctx.fillRect(b.x - R, b.y - R, R * 2, R * 2);
      if (hint) {
        ctx.textBaseline = 'alphabetic';
        ctx.font = `600 14px ${MONO}`;
        ctx.fillStyle = colors.text;
        ctx.textAlign = 'center';
        ctx.fillText(T.hint, W / 2, H - 12);
      }
    }
    else if (state === 'over') message('GAME OVER');
    else if (state === 'clear') message('CLEAR');
  }
  // タブを離れるとブラウザが更新を止める。戻ったときに一気に進まないよう、1回に進める時間には上限を設ける。
  // ゲームが終わり、崩れた要素も落ち着いたら更新を止める（電池を使い続けない）
  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 0;
    last = now;
    step(dt, now);
    draw();
    raf = state === 'play' || (bodies.length && idle < 30) ? requestAnimationFrame(frame) : 0;
  }

  // ---- 操作 ----
  function action() {
    audio();
    if (state === 'over' || state === 'clear') restore(true);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); restore(false); return; }
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) { // Cmd+M（最小化）などは除く
      muted = !muted;
      try { localStorage.setItem('st-404-mute', muted ? '1' : '0'); } catch (err) {}
      return;
    }
    if (e.target !== canvas) return;
    if (e.key in keys) { keys[e.key] = 1; e.preventDefault(); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) action(); }
  }
  // 画面の大きさが変わったら（スマホを横にした、ウィンドウを広げたなど）ブロックの位置や見える範囲が変わるので、すぐ元に戻して終える
  function onResize() {
    if (doc.clientWidth !== W || doc.clientHeight !== H) restore(false, true);
  }

  // ---- 元に戻す ----
  // 書き換えた属性を元の値に戻す（無かったものは消す）
  function resetAttr(el, name, value) {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
  const unstyle = b => resetAttr(b.el, 'style', b.style);
  function restore(toSearch, instant) {
    if (state !== 'play' && state !== 'over' && state !== 'clear') return;
    setState('restoring');
    draw(); // 更新を止めていても、メッセージを消しておく
    // 後始末は今回の分だけ。前回の保険のタイマーが、次のゲームの戻しを打ち切らないようにする
    const id = ++gen;
    const done = () => { if (id === gen) finish(toSearch); };
    if (instant || reduce || (!anims.size && !bodies.length)) { done(); return; }
    sfx.restore();
    const list = [...anims.values()];
    list.forEach(a => { a.playbackRate = 2; a.reverse(); });
    for (const b of bodies) {
      const from = b.el.style.transform;
      unstyle(b);
      if (!from) continue;
      const a = b.el.animate([{ transform: from }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      anims.set(b.el, a);
      list.push(a);
    }
    bodies = [];
    Promise.all(list.map(a => a.finished)).then(done, done);
    setTimeout(done, 2500); // 戻りの完了が届かない場合の保険
  }
  // 開始の途中で失敗したときにも呼ぶので、まだ作っていないものは飛ばす
  function finish(toSearch) {
    if (state !== 'restoring') return;
    state = 'closed';
    cancelAnimationFrame(raf);
    if (events) events.abort();
    anims.forEach(a => a.cancel());
    anims.clear();
    bodies.forEach(unstyle);
    bodies = [];
    for (const { text, nodes } of wrapped) {
      nodes[0].before(text);
      nodes.forEach(n => n.remove());
    }
    wrapped = [];
    for (const { el, cls } of inlined) resetAttr(el, 'class', cls);
    inlined = [];
    doc.style.overflow = saved.overflow;
    doc.style.scrollbarGutter = saved.gutter;
    const main = document.querySelector('main');
    if (main) main.inert = false;
    if (wrap) wrap.remove();
    events = wrap = null;
    // 戻る操作以外で終えたときは、積んだ履歴を外す（戻るボタンを押しても同じページに留まらないように）。
    // 外した popstate は後から届くので、届くまでは次のゲームを始めない（start）
    if (pushed) {
      pushed = false;
      backPending = true;
      window.addEventListener('popstate', () => { backPending = false; }, { once: true });
      history.back();
    }
    keys.ArrowLeft = keys.ArrowRight = 0;
    announce(T.restored);
    // 遊び終えたら検索欄へ（このページの本来の役目に戻す）。途中でやめたときや、タッチ端末では「404」へ
    const target = (toSearch && FINE && document.querySelector('#common-search input')) || document.getElementById('game-trigger');
    if (target) target.focus();
  }

  window.ST404Game = { start };
})();
