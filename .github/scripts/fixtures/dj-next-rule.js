// 2026-10-04の置換前NEXTを比較するための保存版。正本のHTMLからそのまま抽出。
    const effBpm = (raw) => {
      const b = Math.round(raw || 0);
      return b && b < 90 ? b * 2 : b;
    };

    /* 並べ替えと繋ぎ候補で使う BPM。タップで手入れした値だけは読み替えない（cardHTML の bpmChip と同じ考え）。
       規則を1か所に置き、BPM 順の並びと NEXT の候補が食い違わないようにする */
    const bpmForMix = (s) => (s.bpmTapped ? s.bpm : effBpm(s.bpm)) || null;

    /* キャメロット（"11A"）は文字列のままだと 10A → 11A → 1A と並ぶ。
       数字→文字の順に直すとホイールの並びになり、隣り合うキーが近くに来る。 */
    const parseCamelot = (c) => {
      const t = String(c || '').trim().toUpperCase();
      const n = parseInt(t, 10), ab = t.slice(-1);
      if (!(n >= 1 && n <= 12) || (ab !== 'A' && ab !== 'B')) return null;
      return { n, mode: ab };
    };

    /* camelot が空で songKey（"F#m"）だけ届くことがある。カードはキーを
       出しているのに末尾へ落ちる、という食い違いを避けるため五度圏から
       番号を割り出す。C=8B を起点に完全五度ごとに +1 で回るので
       (pc * 7 + 7) % 12 + 1。短調は平行長調（+3 半音）の番号を借りる。
       式は audio-analysis.js の camelotNo と同じだが、あちらが読めなくても
       一覧が動くよう、ここにも持っておく。 */
    const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const keyCamelot = (k) => {
      const m = /^([A-Ga-g])([#b♯♭]?)(m|min|minor)?$/.exec(String(k || '').trim());
      if (!m) return null;
      const minor = !!m[3];
      let pc = PITCH[m[1].toUpperCase()];
      if (m[2] === '#' || m[2] === '♯') pc += 1;
      else if (m[2]) pc -= 1;
      if (minor) pc += 3;
      const n = (((pc * 7 + 7) % 12) + 12) % 12 + 1;
      return { n, mode: minor ? 'A' : 'B' };
    };

    /* 表示が camelot と songKey の両方を見せている以上、並びも両方見る。 */
    const songCamelot = (s) => parseCamelot(s.camelot) || keyCamelot(s.songKey);
    function keyFit(a, b) {
      const x = songCamelot(a), y = songCamelot(b);
      if (!x || !y) return { score: 2, label: 'キー不明' };
      const d = (y.n - x.n + 12) % 12;
      if (d === 0) return x.mode === y.mode ? { score: 0, label: '同じキー' } : { score: 1, label: '平行調' };
      if (x.mode === y.mode) {
        if (d === 1) return { score: 1, label: '+1 上げる' };
        if (d === 11) return { score: 1, label: '−1 落ち着かせる' };
        if (d === 2) return { score: 2, label: '+2 ブースト' };
        if (d === 7) return { score: 2, label: '半音上げ' };
      } else if (d === 1 || d === 11) {
        return { score: 2, label: '斜め（少し濁る）' };
      }
      return { score: 4, label: 'キーが合わない' };
    }

    /* 次の曲の BPM が今の曲からどれだけ離れているか。倍・半分で数えたほうが近ければそちらで */
    function bpmFit(a, b) {
      const x = bpmForMix(a), y = bpmForMix(b);
      if (!x || !y) return null;
      let best = null;
      for (const m of [1, 2, 0.5]) {
        const pct = (y * m - x) / x * 100;
        if (!best || Math.abs(pct) < Math.abs(best.pct)) best = { pct, m, bpm: y };
      }
      return best;
    }

    const bpmPenalty = (bf) => {
      if (!bf) return 3;
      const p = Math.abs(bf.pct);
      return (p <= 3 ? 0 : p <= 6 ? 1 : p <= 10 ? 2.5 : 4) + (bf.m !== 1 ? 0.5 : 0);
    };


export function legacyFeatures(base, s) {
  const result = (() => { const bf = bpmFit(base, s), kf = keyFit(base, s);
          const fit = bpmPenalty(bf) + kf.score;
          // 人気（いいね・同じ曲のリクエスト）と、採用済かどうかは軽く効かせるだけ
          const pop = Math.min(1.5, 0.3 * (s.likes || 0) + 0.3 * Math.max(0, (s.votes || 0) - 1));
          return { s, bf, kf, fit, score: fit - pop - (s.status === 'queued' ? 0.5 : 0) }; })();
  return { bpmFit: result.bf, keyFit: result.kf, ruleScore: result.score,
    bpmPenalty: bpmPenalty(result.bf), keyPenalty: result.kf.score, fit: result.fit,
    effectiveFromBpm: bpmForMix(base), effectiveToBpm: bpmForMix(s) };
}
