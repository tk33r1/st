/* ===========================================================================
   bijutsu-shisui.js — 美術紫水（bijutsushisui.com）由来の「白昼夢」演出

   /dj/schedule/（日程調整）・/dj/request/（曲リクエスト）・/dj/booth/（ブース
   コンソール）の3ページが共有する背景演出。3ページに同じものが写経されていた
   ので、ここへ一本化した。対になる見た目は data/bijutsu-shisui.css。

   中身は3つ:
     1. window.DJ_ART … ドット絵のハートと配色、canvas を DPR 込みで張る道具
     2. テイクオーバー背景 … #bs-takeover-canvas があれば勝手に回りはじめる
     3. window.djCelebrate() … #celebrate-canvas があれば使えるクラッカー

   どれも「対象の canvas が無ければ何もしない」ので、クラッカーを置いていない
   ページ（booth）がこのファイルを読んでも副作用はない。
   prefers-reduced-motion が効いている環境では 2 と 3 は起動しない。

   使い方（body の末尾、canvas より後ろで）:
     <script src="/data/bijutsu-shisui.js?v=YYYYMMDD"></script>
   defer / async は付けないこと。djCelebrate() を呼ぶページ側スクリプトより
   先に評価される必要がある。
   =========================================================================== */

/* ===== 1. 共有物 =====
   背景もクラッカーも prefers-reduced-motion で即 return するので、
   共有物はその手前のこの一枚に置く */
(function () {
  'use strict';
  var rootStyle = getComputedStyle(document.documentElement);
  window.DJ_ART = {
    // ドット絵のハート。'1' の升目だけ塗る
    HEART: ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'],
    // ドットの隙間。これがないと升目が繋がってドット絵に見えない
    DOT: 0.92,
    bg: rootStyle.getPropertyValue('--bg').trim() || '#0a0a0c',
    pink: rootStyle.getPropertyValue('--heart-primary').trim() || '#ff2f6e',
    cyan: rootStyle.getPropertyValue('--heart-secondary').trim() || '#37f2e6',
    // 画面いっぱいのキャンバスを DPR ぶん解像度を上げて張る
    fitCanvas: function (canvas, ctx) {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = window.innerWidth, h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { W: w, H: h, DPR: dpr };
    }
  };
})();

/* ===== 2. テイクオーバー背景 =====
   本家（bijutsushisui.com）のものをそのまま移植。ドットのハートが漂い、
   たまに走査帯ズレ・RGB色収差でグリッチする */
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var canvas = document.getElementById('bs-takeover-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var art = window.DJ_ART;
  var settings = {
    bgColor: art.bg,
    heartPrimary: art.pink,
    heartSecondary: art.cyan,
    heartCount: 42,
    glitchFrequency: 0.02,
    motionStyle: 'breath'
  };

  // オフスクリーン: シーン本体 / R・G・B分離用 / 焼き付き用
  var scene = document.createElement('canvas');
  var sceneCtx = scene.getContext('2d');
  var rC = document.createElement('canvas'), rCtx = rC.getContext('2d');
  var gC = document.createElement('canvas'), gCtx = gC.getContext('2d');
  var bC = document.createElement('canvas'), bCtx = bC.getContext('2d');
  var burn = document.createElement('canvas'); // 残像焼き付きレイヤー
  var burnCtx = burn.getContext('2d');

  var W, H, DPR;
  function resize() {
    var fit = art.fitCanvas(canvas, ctx);
    W = fit.W; H = fit.H; DPR = fit.DPR;

    [scene, rC, gC, bC, burn].forEach(function (cv) {
      cv.width = W; cv.height = H;
    });
    burnCtx.fillStyle = settings.bgColor;
    burnCtx.fillRect(0, 0, W, H);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- ハートのドット絵形状 ----
  var HEART_GRID = art.HEART;

  function drawHeartTile(g, cx, cy, size, angleRad, color, alpha) {
    var rows = HEART_GRID.length, cols = HEART_GRID[0].length;
    var cell = size / cols;
    g.save();
    g.translate(cx, cy);
    g.rotate(angleRad);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (HEART_GRID[r][c] === '1') {
          g.fillRect((c - cols / 2) * cell, (r - rows / 2) * cell, cell * art.DOT, cell * art.DOT);
        }
      }
    }
    g.restore();
  }

  function makeHearts(count) {
    var hearts = [];
    for (var i = 0; i < count; i++) {
      hearts.push({
        x: Math.random(), y: Math.random(),
        size: 14 + Math.random() * 22,
        color: Math.random() > 0.5 ? settings.heartPrimary : settings.heartSecondary,
        phase: Math.random() * Math.PI * 2,
        period: 3 + Math.random() * 5,
        angularVelocity: (Math.random() - 0.5) * 1.2,
        baseAlpha: 0.35 + Math.random() * 0.35
      });
    }
    return hearts;
  }
  var hearts = makeHearts(settings.heartCount);

  // ---- グリッチ状態 ----
  var glitchUntil = 0;
  var BANDS = 32;
  var bandShift = [];
  var charFlashUntil = 0;
  var CORRUPT_CHARS = ['0', '1', 'ｱ', 'ｶ', 'ﾀ', 'ﾅ', '■', 'ﾊ', 'ﾏ', 'ﾔ', 'ﾝ'];

  function triggerGlitch(now) {
    glitchUntil = now + 140 + Math.random() * 180;
    bandShift = [];
    for (var b = 0; b < BANDS; b++) {
      var big = Math.random() < 0.06;
      bandShift.push((Math.random() - 0.5) * (big ? 36 : 5));
    }
    if (Math.random() < 0.6) {
      charFlashUntil = now + 300 + Math.random() * 200;
    }
  }

  function maybeTriggerGlitch(now) {
    if (now > glitchUntil && Math.random() < settings.glitchFrequency * 0.5) {
      triggerGlitch(now);
    }
  }

  function makeChannel(canvasEl, ctxEl, source, color) {
    ctxEl.clearRect(0, 0, W, H);
    ctxEl.drawImage(source, 0, 0);
    ctxEl.globalCompositeOperation = 'multiply';
    ctxEl.fillStyle = color;
    ctxEl.fillRect(0, 0, W, H);
    ctxEl.globalCompositeOperation = 'source-over';
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    var r = parseInt(hex.substring(0, 2), 16);
    var g = parseInt(hex.substring(2, 4), 16);
    var b = parseInt(hex.substring(4, 6), 16);
    return r + ',' + g + ',' + b;
  }

  var start = performance.now();

  function frame(now) {
    var t = now - start;
    maybeTriggerGlitch(now);
    var glitching = now < glitchUntil;

    // --- シーン本体を描画（背景は塗らず、ハートのみ透明背景に描く） ---
    sceneCtx.clearRect(0, 0, W, H);
    for (var i = 0; i < hearts.length; i++) {
      var h = hearts[i];
      var angle;
      if (settings.motionStyle === 'flutter') {
        angle = (t / 1000) * h.angularVelocity;
      } else {
        var speed = Math.sin((t / 1000 / h.period) * Math.PI * 2 + h.phase);
        angle = speed * Math.PI * 0.9;
      }
      drawHeartTile(sceneCtx, h.x * W, h.y * H, h.size, angle, h.color, h.baseAlpha);
    }

    // --- 残像焼き付き ---
    burnCtx.fillStyle = 'rgba(' + hexToRgb(settings.bgColor) + ',0.14)';
    burnCtx.fillRect(0, 0, W, H);
    burnCtx.drawImage(scene, 0, 0);

    // --- RGB色収差（常時わずか、グリッチ中は強める） ---
    makeChannel(rC, rCtx, burn, '#ff0000');
    makeChannel(gC, gCtx, burn, '#00ff00');
    makeChannel(bC, bCtx, burn, '#0000ff');
    var ab = glitching ? 6 : 1.2;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = settings.bgColor;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(rC, -ab, 0);
    ctx.drawImage(gC, 0, 0);
    ctx.drawImage(bC, ab, 0);
    ctx.globalCompositeOperation = 'source-over';

    // --- 走査帯ズレ（グリッチ中のみ） ---
    if (glitching) {
      var snap = document.createElement('canvas');
      snap.width = W; snap.height = H;
      snap.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, W, H);
      var bh = H / BANDS;
      for (var b = 0; b < BANDS; b++) {
        var sx = bandShift[b] || 0;
        ctx.drawImage(snap, 0, b * bh, W, bh + 1, sx, b * bh, W, bh + 1);
      }
    }

    // --- 文字化けフラッシュ（グリッチ中のみ） ---
    if (now < charFlashUntil && Math.random() < 0.6) {
      ctx.font = '11px monospace';
      ctx.fillStyle = '#ffe14d';
      for (var c2 = 0; c2 < 6; c2++) {
        ctx.globalAlpha = 0.6 + Math.random() * 0.4;
        ctx.fillText(
          CORRUPT_CHARS[Math.floor(Math.random() * CORRUPT_CHARS.length)],
          Math.random() * W, Math.random() * H
        );
      }
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();

/* ===== 3. クラッカー =====
   決まったとき / 通ったときに、背景と同じドット絵のハートを左右から弾けさせる。
   ページ側から window.djCelebrate() で呼ぶ */
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var canvas = document.getElementById('celebrate-canvas');
  if (!canvas) return;

  var art = window.DJ_ART;
  var ctx = canvas.getContext('2d');
  var TILE = 64;
  var FADE = 0.28;   // 寿命の最後のこの割合をかけて消える

  var W = 0, H = 0;
  var pieces = [];
  var tiles = null;
  var running = false;
  var last = 0;

  // ハートは 1 色 1 枚だけ焼いて使い回す。
  // 1粒ごとに 42 個の矩形を塗るより軽いうえ、薄いグローも一緒に焼き込める
  function makeTile(color) {
    var c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    var g = c.getContext('2d');
    var rows = art.HEART.length, cols = art.HEART[0].length;
    var cell = (TILE * 0.72) / cols;
    var ox = (TILE - cell * cols) / 2;
    var oy = (TILE - cell * rows) / 2;
    g.shadowColor = color;
    g.shadowBlur = TILE * 0.16;
    g.fillStyle = color;
    for (var r = 0; r < rows; r++) {
      for (var i = 0; i < cols; i++) {
        if (art.HEART[r][i] === '1') {
          g.fillRect(ox + i * cell, oy + r * cell, cell * art.DOT, cell * art.DOT);
        }
      }
    }
    return c;
  }

  function resize() {
    var fit = art.fitCanvas(canvas, ctx);
    W = fit.W;
    H = fit.H;
  }

  // クラッカー1発ぶん。aim の向きへ扇状に飛ばす
  function popper(x, y, aim, count, power) {
    for (var i = 0; i < count; i++) {
      var spread = (Math.random() - 0.5) * 1.15;
      var speed = power * (0.45 + Math.random() * 0.75);
      pieces.push({
        x: x, y: y,
        vx: Math.cos(aim + spread) * speed,
        vy: Math.sin(aim + spread) * speed,
        size: (12 + Math.random() * 18) * 1.4,   // タイルの余白ぶん大きめに描く
        tile: Math.random() > 0.5 ? tiles.pink : tiles.cyan,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 9,
        // 落下速度の頭打ち。紙吹雪のようにゆっくり降らせる
        fall: 95 + Math.random() * 140,
        sway: 20 + Math.random() * 30,
        phase: Math.random() * Math.PI * 2,
        life: 0,
        span: 2.8 + Math.random() * 1.8
      });
    }
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    var damp = Math.pow(0.28, dt);
    last = now;
    ctx.clearRect(0, 0, W, H);

    var alive = 0;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      p.life += dt;
      if (p.life >= p.span) continue;
      alive++;
      // 飛び出しの勢いを一気に殺してから落とすと、クラッカーらしい弧になる
      p.vx *= damp;
      p.vy *= damp;
      p.vy += 900 * dt;
      if (p.vy > p.fall) p.vy = p.fall;
      p.x += (p.vx + Math.sin(p.life * 5 + p.phase) * p.sway) * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.globalAlpha = Math.min(1, (1 - p.life / p.span) / FADE);
      ctx.drawImage(p.tile, -p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }

    if (alive) {
      requestAnimationFrame(frame);
    } else {
      running = false;
      pieces = [];
      canvas.hidden = true;
      canvas.width = canvas.height = 0;
    }
  }

  window.djCelebrate = function () {
    if (!tiles) tiles = { pink: makeTile(art.pink), cyan: makeTile(art.cyan) };
    canvas.hidden = false;
    resize();
    pieces = [];
    // 左下・右下から内向きに2発、真ん中から真上に1発
    popper(-14, H * 0.84, -Math.PI / 3.6, 84, 1400);
    popper(W + 14, H * 0.84, -Math.PI + Math.PI / 3.6, 84, 1400);
    popper(W / 2, H * 1.04, -Math.PI / 2, 64, 1650);
    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  };

  window.addEventListener('resize', function () { if (running) resize(); });
})();
