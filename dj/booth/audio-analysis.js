/* 30秒プレビューから BPM とキーを推定する。ブースコンソール（dj/booth/）専用。
   外部のライブラリは使わず、ブラウザの中だけで完結させる（音声はどこにも送らない）。

   BPM: スペクトルの立ち上がり（spectral flux）を拍の手掛かりにし、その自己相関で
        周期を探す。拍の周期 L の曲は L, 2L, 3L… にも山が立つので、倍数の山を足し合わせて
        細かい BPM を決める。倍・半分の取り違えはこの方法では区別できないので、
        120 付近を好む弱い事前分布で選び、最後に DJ ソフトと同じ範囲（78〜180）へ折り返す。
   キー: スペクトルのピークを12音（クロマ）に集め、長調・短調の型（Temperley）と相関を取る。
        古い録音は A=440 からずれていることがあるので、ピークの半音からのずれで調律を補正する。
        平行調（Am と C）の取り違えが一番多い。Camelot では同じ番号なので、ミックスの上では
        致命傷になりにくい。

   プレビューは曲の一部（多くはサビ付近）なので、イントロだけテンポが違う曲や
   転調する曲は拾えない。 */
(function (global) {
  'use strict';

  const SR = 22050;              // 解析のサンプルレート。decodeAudioData がここへ変換する
  const BPM_MIN = 78, BPM_MAX = 180;
  const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

  /* Temperley (Kostka-Payne) の調性プロファイル。C を起点に12音の出やすさ。
     Krumhansl-Kessler・低音の強調・倍音の畳み込みも試したが、相対調より遠い外れ
     （ミックスで実害が出る外れ）が一番少なかったのがこの素の組み合わせだった。 */
  const PROFILE = {
    major: [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
    minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330],
  };

  /* ── FFT（基数2、その場で書き換える） ── */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  }

  const hann = (n) => {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  };

  /** 窓をずらしながら振幅スペクトルを返す。each(frameIndex, mag) を呼ぶ。 */
  function stft(x, size, hop, each) {
    const win = hann(size);
    const re = new Float32Array(size), im = new Float32Array(size);
    const mag = new Float32Array(size / 2);
    let f = 0;
    for (let start = 0; start + size <= x.length; start += hop, f++) {
      for (let i = 0; i < size; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      each(f, mag);
    }
    return f;
  }

  /* ── BPM ── */
  const TEMPO_FRAME = 1024, TEMPO_HOP = 128;
  const FPS = SR / TEMPO_HOP;

  function onsetEnvelope(x) {
    const bins = TEMPO_FRAME / 2;
    const frames = Math.max(0, Math.floor((x.length - TEMPO_FRAME) / TEMPO_HOP) + 1);
    const env = new Float32Array(frames);
    let prev = new Float32Array(bins), cur = new Float32Array(bins);
    stft(x, TEMPO_FRAME, TEMPO_HOP, (f, mag) => {
      let flux = 0;
      for (let k = 1; k < bins; k++) {
        cur[k] = Math.log1p(1000 * mag[k]);
        const d = cur[k] - prev[k];
        if (d > 0 && f > 0) flux += d;
      }
      env[f] = flux;
      const t = prev; prev = cur; cur = t;
    });
    // 局所平均を引いて立ち上がりだけを残す（音量の大きな区間に引っ張られないように）
    const w = Math.round(FPS * 0.4);
    const out = new Float32Array(frames);
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      sum += env[i];
      if (i - 2 * w - 1 >= 0) sum -= env[i - 2 * w - 1];
      const c = i - w;
      if (c >= 0) {
        const n = Math.min(i, frames - 1) - Math.max(0, c - w) + 1;
        out[c] = Math.max(0, env[c] - sum / n);
      }
    }
    return out;
  }

  function autocorr(env, maxLag) {
    const n = env.length;
    const ac = new Float32Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (n - lag);
    }
    return ac;
  }

  const lerp = (a, t) => {
    const i = Math.floor(t), f = t - i;
    return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : 0;
  };

  function estimateBpm(x) {
    const env = onsetEnvelope(x);
    if (env.length < FPS * 8) return null;          // 8秒未満は測らない
    const HARM = 4;
    const maxLag = Math.ceil(60 * FPS / 60 * HARM);  // 60 BPM の4拍分まで
    const ac = autocorr(env, maxLag);
    if (!(ac[0] > 0)) return null;

    // 0.05 BPM 刻みで「拍の周期の倍数に立つ山」の合計を採る
    const grid = [];
    for (let bpm = 60; bpm <= 200; bpm += 0.05) {
      const L = 60 * FPS / bpm;
      let s = 0;
      for (let m = 1; m <= HARM; m++) s += lerp(ac, m * L);
      // 120 BPM 付近を好む弱い事前分布（対数で1オクターブ幅）
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
      grid.push({ bpm, raw: s, score: s * prior });
    }
    let best = grid[0];
    for (const g of grid) if (g.score > best.score) best = g;

    // 確信度: 最高点が全体の中央値からどれだけ抜けているか
    const sorted = grid.map((g) => g.raw).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const confidence = median > 0 ? best.raw / median : 0;

    let bpm = best.bpm;
    while (bpm < BPM_MIN) bpm *= 2;
    while (bpm >= BPM_MAX) bpm /= 2;
    return { bpm: Math.round(bpm * 10) / 10, confidence };
  }

  /* ── キー ── */
  const KEY_FRAME = 8192, KEY_HOP = 4096;
  const F_LO = 55, F_HI = 2000;

  function chroma(x) {
    const binHz = SR / KEY_FRAME;
    const kLo = Math.ceil(F_LO / binHz), kHi = Math.floor(F_HI / binHz);
    const peaks = [];   // [pitch(連続値), 重み]
    const frames = [];
    stft(x, KEY_FRAME, KEY_HOP, (f, mag) => {
      const list = [];
      let max = 0;
      for (let k = kLo; k <= kHi; k++) if (mag[k] > max) max = mag[k];
      if (max <= 0) return;
      for (let k = kLo; k <= kHi; k++) {
        const m = mag[k];
        if (m < max * 0.02 || m <= mag[k - 1] || m < mag[k + 1]) continue;
        // 放物線補間でピークの本当の周波数を詰める
        const a = mag[k - 1], c = mag[k + 1];
        const d = (a - 2 * m + c) ? 0.5 * (a - c) / (a - 2 * m + c) : 0;
        const hz = (k + d) * binHz;
        const pitch = 12 * Math.log2(hz / 440) + 69;
        list.push([pitch, m / max]);
      }
      frames.push(list);
      for (const p of list) peaks.push(p);
    });
    if (!peaks.length) return null;

    // 調律のずれ（半音の何分の一か）を、ピークのずれの円周平均で求める
    let sx = 0, sy = 0;
    for (const [p, w] of peaks) {
      const ang = 2 * Math.PI * (p - Math.round(p));
      sx += w * Math.cos(ang); sy += w * Math.sin(ang);
    }
    const tuning = Math.atan2(sy, sx) / (2 * Math.PI);

    const c = new Float64Array(12);
    for (const list of frames) {
      const fc = new Float64Array(12);
      for (const [p, w] of list) {
        const pc = ((Math.round(p - tuning) % 12) + 12) % 12;
        fc[pc] += w;
      }
      let norm = 0;
      for (let i = 0; i < 12; i++) norm += fc[i] * fc[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 12; i++) c[i] += fc[i] / norm;
    }
    return { chroma: c, tuning };
  }

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  /** 長調の主音（0=C）から Camelot 番号。C=8B から完全五度ごとに +1 */
  const camelotNo = (majorPc) => ((majorPc * 7 + 7) % 12 + 12) % 12 + 1;

  function estimateKey(x) {
    const got = chroma(x);
    if (!got) return null;
    const scores = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ['major', 'minor']) {
        const rotated = new Array(12);
        for (let i = 0; i < 12; i++) rotated[i] = got.chroma[(i + tonic) % 12];
        scores.push({ tonic, mode, r: pearson(rotated, PROFILE[mode]) });
      }
    }
    let best = scores[0];
    for (const s of scores) if (s.r > best.r) best = s;
    const minor = best.mode === 'minor';
    return {
      songKey: minor ? MINOR_NAMES[best.tonic] : PITCH_NAMES[best.tonic],
      camelot: camelotNo(minor ? (best.tonic + 3) % 12 : best.tonic) + (minor ? 'A' : 'B'),
      tuning: got.tuning,
    };
  }

  /* ── 入口 ── */
  async function decode(url, signal) {
    const res = await fetch(url, { signal, credentials: 'omit' });
    if (!res.ok) throw new Error('preview ' + res.status);
    const buf = await res.arrayBuffer();
    const Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('no audio');
    const audio = await new Ctx(1, 1, SR).decodeAudioData(buf);
    const n = audio.length, ch = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
    }
    return mono;
  }

  /* これを下回る BPM は返さない。正解の分かっている27曲で、外れた曲は 3.2 以下、
     当たった曲は 3.5 以上だった。キーは確信度で当たり外れを分けられなかったので
     返すだけ返し、画面では「推定」と明示する。 */
  const MIN_BPM_CONF = 3.3;

  function analyzeSamples(x) {
    const bpm = estimateBpm(x);
    const key = estimateKey(x);
    return {
      bpm: bpm && bpm.confidence >= MIN_BPM_CONF ? bpm.bpm : null,
      songKey: key ? key.songKey : '',
      camelot: key ? key.camelot : '',
      detail: { bpm, key },
    };
  }

  async function analyzeUrl(url, { signal } = {}) {
    return analyzeSamples(await decode(url, signal));
  }

  global.DJAudioAnalysis = { analyzeUrl, analyzeSamples, decode, camelotNo };
})(window);
