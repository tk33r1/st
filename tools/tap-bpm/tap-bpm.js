/* Tap BPM — tempo estimator and readout.
 *
 * The estimator is the point of this tool. Everything else on the page is a
 * pure function of one number.
 *
 * Why least squares rather than an average of intervals:
 *   The usual tap-tempo implementation averages the last N gaps. That throws
 *   away the fact that the taps are samples of a *line* — beat k should land
 *   at P*k + phase — and it lets a single mistimed hit move the answer by
 *   several BPM. Fitting the line instead means each extra tap tightens the
 *   estimate rather than merely re-weighting it, and it gives us a residual,
 *   which is what lets the page show an honest ± error.
 *
 * Beat indices, not consecutive gaps:
 *   Every tap gets an absolute beat number. A gap of roughly 2P is recorded
 *   as "two beats passed", so a skipped tap costs nothing instead of halving
 *   the reported tempo. Indices are stepped per-gap rather than derived from
 *   (t - t0)/P, because per-gap rounding cannot accumulate the drift that
 *   would misnumber the later beats of a long run.
 */
(function () {
  'use strict';

  /* ==================================================================
     estimator
     ================================================================== */

  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Least-squares fit of t = period * index + phase. Returns the slope, the
     residual spread (sigma) and the standard error of the slope, which is
     what the ± on screen is built from. */
  function fit(times, idx) {
    var n = times.length;
    if (n < 2) return null;
    var si = 0, st = 0, k;
    for (k = 0; k < n; k++) { si += idx[k]; st += times[k]; }
    var mi = si / n, mt = st / n;
    var num = 0, den = 0, d;
    for (k = 0; k < n; k++) {
      d = idx[k] - mi;
      num += d * (times[k] - mt);
      den += d * d;
    }
    if (!(den > 0)) return null;
    var period = num / den;
    if (!(period > 0)) return null;
    var phase = mt - period * mi;
    var ss = 0, r;
    for (k = 0; k < n; k++) {
      r = times[k] - (period * idx[k] + phase);
      ss += r * r;
    }
    var sigma = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
    return {
      period: period,
      phase: phase,
      sigma: sigma,
      sePeriod: n > 2 ? sigma / Math.sqrt(den) : 0
    };
  }

  /* Absolute beat number per tap, stepping one gap at a time. */
  function assignIndices(times, base) {
    var idx = [0];
    for (var k = 1; k < times.length; k++) {
      var step = Math.round((times[k] - times[k - 1]) / base);
      if (!(step >= 1)) step = 1;
      if (step > 8) step = 8;   /* longer than that and the run is over */
      idx.push(idx[k - 1] + step);
    }
    return idx;
  }

  function sameIndices(a, b) {
    for (var k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  }

  function analyze(times) {
    var n = times.length;
    if (n < 2) return null;

    var gaps = [], k;
    for (k = 1; k < n; k++) gaps.push(times[k] - times[k - 1]);

    /* Seed from the median gap: robust to one bad tap, good enough to
       number the beats before the fit refines it. */
    var base = median(gaps);
    if (!(base > 0)) return null;

    var idx = assignIndices(times, base);
    var f = fit(times, idx);
    if (!f) return null;
    for (var pass = 0; pass < 4; pass++) {
      var next = assignIndices(times, f.period);
      if (sameIndices(next, idx)) break;
      var f2 = fit(times, next);
      if (!f2) break;
      idx = next;
      f = f2;
    }

    /* Outlier rejection. A tap that misses its own beat badly is a mistake,
       not a tempo — but never discard so many that the "outliers" are
       actually the beat.

       The threshold is scaled by the MAD of the residuals rather than their
       standard deviation: two bad taps inflate a standard deviation enough
       to hide themselves behind it, which is exactly the case this is here
       to catch. The floor keeps a metronome-tight run from rejecting taps
       that are merely human. */
    var keep = [];
    for (k = 0; k < n; k++) keep.push(k);
    var dropped = 0;
    for (var round = 0; round < 2; round++) {
      if (keep.length < 5) break;
      var resid = keep.map(function (x) {
        return Math.abs(times[x] - (f.period * idx[x] + f.phase));
      });
      var robust = 1.4826 * median(resid);
      var limit = Math.max(3.5 * robust, f.period * 0.18);
      var kept = [], out = 0;
      for (var i = 0; i < keep.length; i++) {
        var j = keep[i];
        if (resid[i] > limit) { out++; } else { kept.push(j); }
      }
      if (!out) break;
      if (dropped + out > n * 0.25) break;
      var f3 = fit(
        kept.map(function (x) { return times[x]; }),
        kept.map(function (x) { return idx[x]; })
      );
      if (!f3) break;
      keep = kept;
      dropped += out;
      f = f3;
    }

    var beats = idx[n - 1];
    return {
      bpm: 60000 / f.period,
      period: f.period,
      sigma: f.sigma,
      seBpm: (60000 / (f.period * f.period)) * f.sePeriod,
      taps: n,
      used: keep.length,
      dropped: dropped,
      skipped: Math.max(0, beats - (n - 1))
    };
  }

  /* ==================================================================
     state
     ================================================================== */

  var taps = [];          /* tap times of the current run, in ms */
  var est = null;         /* analysis of the current run */
  var displayBpm = null;  /* the one number the rest of the page reads */
  var source = 'tap';     /* 'tap' | 'manual' */
  var mult = 1;           /* the x2 / /2 correction, applied to the estimate */
  var expired = false;
  var rafId = 0;
  var liveTimer = 0;

  var MULT_MIN = 0.125, MULT_MAX = 8;

  /* ==================================================================
     dom
     ================================================================== */

  var $ = function (id) { return document.getElementById(id); };

  var pad = $('pad');
  var bpmMain = $('bpm-main');
  var tapCount = $('tap-count');
  var chipErr = $('chip-err');
  var chipQuality = $('chip-quality');
  var chipFix = $('chip-fix');
  var timerFill = $('timer-fill');
  var liveRegion = $('live-region');
  var bpmInput = $('bpm-input');
  var meterSel = $('meter');
  var btnUndo = $('btn-undo');
  var statusLed = $('status-led');
  var statusText = $('status-text');

  var fBeat = $('f-beat'), fBar = $('f-bar'), fHz = $('f-hz'), fRecent = $('f-recent');
  var dTaps = $('d-taps'), dUsed = $('d-used'), dDropped = $('d-dropped');
  var dSkipped = $('d-skipped'), dSigma = $('d-sigma'), dSe = $('d-se');

  var NOTES = [
    ['1/1', '全音符', 4],
    ['1/2', '2分音符', 2],
    ['1/4', '4分音符', 1],
    ['1/8', '8分音符', 0.5],
    ['1/16', '16分音符', 0.25],
    ['1/32', '32分音符', 0.125]
  ];
  var VARIANTS = [
    { factor: 1, label: '' },
    { factor: 1.5, label: 'の付点' },
    { factor: 2 / 3, label: 'の3連符' }
  ];
  var FPS = [24, 25, 29.97, 30, 50, 60];
  var PITCH = [4, 6, 8, 16];

  var noteCells = [];   /* { el, mult } */
  var fpsCells = [];    /* { el, fps } */
  var pitchCells = [];  /* { el, kind, pct } */

  /* ==================================================================
     formatting
     ================================================================== */

  /* Two decimals up to a second: delay plug-ins take that resolution, and
     468.75 is the number a musician expects to see for a quarter at 128. */
  function fmtMs(ms) {
    return ms >= 1000 ? ms.toFixed(1) : ms.toFixed(2);
  }
  function fmtBpm(v) {
    return v.toFixed(1);
  }

  /* Quarter-note beats per bar. 6/8 and 7/8 are counted in eighths, so they
     carry an explicit value alongside their display name. */
  function barBeats() {
    var raw = meterSel.value.split('|')[0];
    var v = parseFloat(raw);
    return isFinite(v) && v > 0 ? v : 4;
  }

  /* ==================================================================
     build the static tables
     ================================================================== */

  (function buildNoteTable() {
    var tbody = $('tbody-note');
    NOTES.forEach(function (note) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      th.appendChild(document.createTextNode(note[0]));
      var span = document.createElement('span');
      span.textContent = note[1];
      th.appendChild(span);
      tr.appendChild(th);

      VARIANTS.forEach(function (v) {
        var td = document.createElement('td');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cellbtn';
        btn.disabled = true;
        btn.textContent = '--';
        btn.setAttribute('aria-label', note[1] + v.label + 'の長さをコピー');
        td.appendChild(btn);
        tr.appendChild(td);
        noteCells.push({ el: btn, mult: note[2] * v.factor });
      });
      tbody.appendChild(tr);
    });
  })();

  function kvItem(container, label) {
    var wrap = document.createElement('div');
    var lbl = document.createElement('span');
    lbl.className = 'st-lbl';
    lbl.textContent = label;
    var val = document.createElement('b');
    val.textContent = '--';
    wrap.appendChild(lbl);
    wrap.appendChild(val);
    container.appendChild(wrap);
    return val;
  }

  (function buildFps() {
    var box = $('kv-fps');
    FPS.forEach(function (f) {
      fpsCells.push({ el: kvItem(box, f + ' fps'), fps: f });
    });
  })();

  (function buildPitch() {
    var box = $('kv-pitch');
    pitchCells.push({ el: kvItem(box, 'ハーフタイム'), kind: 'half' });
    pitchCells.push({ el: kvItem(box, 'ダブルタイム'), kind: 'double' });
    PITCH.forEach(function (p) {
      pitchCells.push({ el: kvItem(box, '±' + p + '%'), kind: 'range', pct: p });
    });
  })();

  /* ==================================================================
     render
     ================================================================== */

  function renderDerived() {
    var bpm = displayBpm;
    var ok = bpm !== null && isFinite(bpm) && bpm > 0;
    var period = ok ? 60000 / bpm : 0;

    fBeat.textContent = ok ? fmtMs(period) : '--';
    fBar.textContent = ok ? fmtMs(period * barBeats()) : '--';
    fHz.textContent = ok ? (1000 / period).toFixed(3) : '--';

    noteCells.forEach(function (c) {
      if (!ok) {
        c.el.textContent = '--';
        c.el.disabled = true;
        c.el.dataset.value = '';
        return;
      }
      var ms = period * c.mult;
      c.el.textContent = fmtMs(ms);
      c.el.dataset.value = fmtMs(ms);
      c.el.disabled = false;
    });

    fpsCells.forEach(function (c) {
      c.el.textContent = ok ? (c.fps * period / 1000).toFixed(2) + ' f' : '--';
    });

    pitchCells.forEach(function (c) {
      if (!ok) { c.el.textContent = '--'; return; }
      if (c.kind === 'half') c.el.textContent = fmtBpm(bpm / 2);
      else if (c.kind === 'double') c.el.textContent = fmtBpm(bpm * 2);
      else c.el.textContent = fmtBpm(bpm * (1 - c.pct / 100)) + ' – ' + fmtBpm(bpm * (1 + c.pct / 100));
    });

    /* The whole site drives its animations off --bpm, so the page breathes
       at whatever tempo is on screen. */
    if (ok) {
      document.documentElement.style.setProperty('--bpm', String(Math.min(300, Math.max(30, bpm))));
    }
  }

  function qualityOf(sigma) {
    if (sigma <= 10) return { text: '安定', cls: 'good' };
    if (sigma <= 25) return { text: '良好', cls: '' };
    if (sigma <= 45) return { text: 'ばらつきあり', cls: '' };
    return { text: 'ばらつき大', cls: 'warn' };
  }

  function setChip(el, text, cls) {
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
  }

  function render() {
    tapCount.textContent = String(taps.length);
    btnUndo.disabled = taps.length === 0;

    bpmMain.textContent = displayBpm === null ? '--' : fmtBpm(displayBpm);
    /* Do not fight the user for the caret while they are typing a tempo. */
    if (document.activeElement !== bpmInput) {
      bpmInput.value = displayBpm === null ? '' : fmtBpm(displayBpm);
    }
    pad.classList.toggle('stale', displayBpm !== null && taps.length < 2);

    if (est && source === 'tap') {
      var se = est.seBpm * mult;
      setChip(chipErr, se > 0 ? '±' + se.toFixed(2) + ' BPM' : '概算', '');
      var q = qualityOf(est.sigma);
      setChip(chipQuality, 'ブレ ' + est.sigma.toFixed(0) + 'ms · ' + q.text, q.cls);
      chipQuality.classList.remove('hidden');
      var fixes = [];
      if (est.skipped) fixes.push('拍抜け ' + est.skipped);
      if (est.dropped) fixes.push('除外 ' + est.dropped);
      if (mult !== 1) fixes.push(mult > 1 ? '×' + mult : '÷' + (1 / mult));
      if (fixes.length) {
        setChip(chipFix, fixes.join(' · '), '');
        chipFix.classList.remove('hidden');
      } else {
        chipFix.classList.add('hidden');
      }
    } else if (taps.length === 1) {
      setChip(chipErr, '計測中 … あと3回', '');
      chipQuality.classList.add('hidden');
      chipFix.classList.add('hidden');
    } else if (source === 'manual') {
      setChip(chipErr, '手入力', '');
      chipQuality.classList.add('hidden');
      chipFix.classList.add('hidden');
    } else if (source === 'held') {
      setChip(chipErr, '保持中 · 次のタップで新規計測', '');
      chipQuality.classList.add('hidden');
      chipFix.classList.add('hidden');
    } else {
      setChip(chipErr, 'まだ計測していません', '');
      chipQuality.classList.add('hidden');
      chipFix.classList.add('hidden');
    }

    dTaps.textContent = est ? String(est.taps) : String(taps.length);
    dUsed.textContent = est ? String(est.used) : '0';
    dDropped.textContent = est ? String(est.dropped) : '0';
    dSkipped.textContent = est ? String(est.skipped) : '0';
    dSigma.textContent = est ? est.sigma.toFixed(1) + ' ms' : '--';
    dSe.textContent = est ? '±' + (est.seBpm * mult).toFixed(2) + ' BPM' : '--';

    /* The trailing window says whether the player is drifting; the headline
       number is the whole run and stays calm while they do. */
    if (taps.length >= 5) {
      var recent = analyze(taps.slice(-8));
      fRecent.textContent = recent ? fmtBpm(recent.bpm * mult) : '--';
    } else {
      fRecent.textContent = '--';
    }

    renderDerived();
  }

  function announce() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(function () {
      if (displayBpm === null) return;
      liveRegion.textContent = fmtBpm(displayBpm) + ' BPM、'
        + (est && source === 'tap' ? '誤差 ' + (est.seBpm * mult).toFixed(2) + '、' : '')
        + '1拍 ' + fmtMs(60000 / displayBpm) + 'ミリ秒';
    }, 700);
  }

  /* ==================================================================
     the run
     ================================================================== */

  /* How long a silence ends the run. Scaled to the tempo being played, so a
     slow ballad is not cut off between beats, and clamped so a stray tap
     cannot leave the run open forever. */
  function idleLimit() {
    if (!est) return 3000;
    return Math.min(6000, Math.max(2000, est.period * 4));
  }

  function loop() {
    rafId = 0;
    if (!taps.length) return;
    var since = performance.now() - taps[taps.length - 1];
    var p = Math.min(1, since / idleLimit());
    timerFill.style.width = (p * 100).toFixed(1) + '%';
    if (p >= 1) {
      if (!expired) endRun();
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    expired = false;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  /* Ending a run deliberately keeps the number on screen. Wiping the result
     the moment the player stops tapping is the single most annoying habit of
     every other tap-tempo tool. */
  function endRun() {
    expired = true;
    pad.classList.remove('live');
    timerFill.style.width = '100%';
    statusLed.classList.add('idle');
    statusText.textContent = 'ready';
    if (displayBpm !== null) {
      setChip(chipErr, est && source === 'tap'
        ? '±' + (est.seBpm * mult).toFixed(2) + ' BPM · 計測終了'
        : '計測終了', '');
    }
  }

  /* Use the time the event actually happened rather than the time this
     handler got to run — that difference is exactly the jitter we are
     trying to keep out of the estimate. */
  function eventTime(e) {
    var t = e.timeStamp;
    var now = performance.now();
    return (typeof t === 'number' && t > 0 && Math.abs(t - now) < 5000) ? t : now;
  }

  function tap(t) {
    if (taps.length && t - taps[taps.length - 1] > idleLimit()) {
      taps = [];
      est = null;
    }
    taps.push(t);
    var next = analyze(taps);
    if (next) {
      est = next;
      source = 'tap';
      displayBpm = next.bpm * mult;
    }

    /* Restart the pulse on the beat that was just played, so the ring is in
       phase with the player instead of free-running. */
    pad.classList.remove('live');
    void pad.offsetWidth;
    if (taps.length >= 2) pad.classList.add('live');

    pad.classList.add('hit');
    setTimeout(function () { pad.classList.remove('hit'); }, 90);

    statusLed.classList.remove('idle');
    statusText.textContent = 'tap';

    startLoop();
    render();
    announce();
  }

  function undo() {
    if (!taps.length) return;
    taps.pop();
    est = analyze(taps);
    if (est) displayBpm = est.bpm * mult;
    if (!taps.length) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      timerFill.style.width = '0%';
      pad.classList.remove('live');
      statusLed.classList.add('idle');
      statusText.textContent = 'ready';
    }
    render();
  }

  function resetRun() {
    taps = [];
    est = null;
    mult = 1;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    expired = false;
    timerFill.style.width = '0%';
    pad.classList.remove('live');
    statusLed.classList.add('idle');
    statusText.textContent = 'ready';
    /* displayBpm survives on purpose: the conversion tables below are the
       reason most people opened the page, and clearing them is a loss. */
    if (displayBpm !== null) source = 'held';
    render();
  }

  function applyMult(factor) {
    var next = mult * factor;
    if (next < MULT_MIN || next > MULT_MAX) return;
    if (source === 'tap' && est) {
      mult = next;
      displayBpm = est.bpm * mult;
    } else if (displayBpm !== null) {
      displayBpm = displayBpm * factor;
    } else {
      return;
    }
    render();
    announce();
  }

  /* ==================================================================
     clipboard
     ================================================================== */

  function toast(msg, type) {
    if (window.STCommon && window.STCommon.showToast) window.STCommon.showToast(msg, type);
  }

  function copy(text, label) {
    var done = function () { toast(label + ' をコピーしました'); };
    var fail = function () { toast('コピーできませんでした', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { fail(); }
  }

  /* ==================================================================
     wiring
     ================================================================== */

  pad.addEventListener('pointerdown', function (e) {
    e.preventDefault();     /* no text selection, no synthetic click delay */
    pad.focus();
    tap(eventTime(e));
  });

  window.addEventListener('keydown', function (e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    var tag = t && t.tagName;
    if (t && (t.isContentEditable || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    /* Space on a focused button belongs to that button. */
    if (t && t.closest && t.closest('button, a')) {
      if (e.key !== 'Escape') return;
    }

    if (e.code === 'Space' || e.key === ' ' || (e.key === 'Enter' && t === pad)) {
      e.preventDefault();
      tap(eventTime(e));
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      resetRun();
      toast('計測をリセットしました');
    }
  });

  $('btn-reset').addEventListener('click', function () {
    resetRun();
    toast('計測をリセットしました');
  });
  btnUndo.addEventListener('click', undo);
  $('btn-half').addEventListener('click', function () { applyMult(0.5); });
  $('btn-double').addEventListener('click', function () { applyMult(2); });

  $('btn-copy-bpm').addEventListener('click', function () {
    if (displayBpm === null) { toast('先にBPMを計測してください', 'error'); return; }
    copy(fmtBpm(displayBpm), fmtBpm(displayBpm) + ' BPM');
  });

  $('tbody-note').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.cellbtn') : null;
    if (!btn || btn.disabled) return;
    var v = btn.dataset.value;
    if (v) copy(v, v + ' ms');
  });

  bpmInput.addEventListener('input', function () {
    var v = parseFloat(bpmInput.value);
    if (!isFinite(v) || v <= 0) return;
    displayBpm = v;
    source = 'manual';
    est = null;
    render();
    announce();
  });

  meterSel.addEventListener('change', renderDerived);

  /* A shared tempo should survive being pasted into a chat window. */
  (function fromUrl() {
    try {
      var v = parseFloat(new URLSearchParams(location.search).get('bpm'));
      if (isFinite(v) && v >= 20 && v <= 400) {
        displayBpm = v;
        source = 'manual';
      }
    } catch (e) { /* no URLSearchParams, no shared tempo — not fatal */ }
  })();

  render();
})();
