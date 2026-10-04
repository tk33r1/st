// ブースとWorkerで同じBPM・キー・入力・加点を使う。曲名や音源の推測は含めない。
export const effBpm = (raw) => {
  const b = Math.round(raw || 0);
  return b && b < 90 ? b * 2 : b;
};
export const bpmForMix = (s) => (s.bpmTapped ? s.bpm : effBpm(s.bpm)) || null;
export function parseCamelot(c) {
  const t = String(c || '').trim().toUpperCase();
  const n = parseInt(t, 10), ab = t.slice(-1);
  return n >= 1 && n <= 12 && (ab === 'A' || ab === 'B') ? { n, mode: ab } : null;
}
const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function keyCamelot(k) {
  const m = /^([A-Ga-g])([#b♯♭]?)(m|min|minor)?$/.exec(String(k || '').trim());
  if (!m) return null;
  let pc = PITCH[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  else if (m[2]) pc -= 1;
  if (m[3]) pc += 3;
  const n = (((pc * 7 + 7) % 12) + 12) % 12 + 1;
  return { n, mode: m[3] ? 'A' : 'B' };
}
export const songCamelot = (s) => parseCamelot(s.camelot) || keyCamelot(s.songKey);
export function keyFit(a, b) {
  const x = songCamelot(a), y = songCamelot(b);
  if (!x || !y) return { score: 2, label: 'キー不明' };
  const d = (y.n - x.n + 12) % 12;
  if (d === 0) return x.mode === y.mode ? { score: 0, label: '同じキー' } : { score: 1, label: '平行調' };
  if (x.mode === y.mode) {
    if (d === 1) return { score: 1, label: '+1 上げる' };
    if (d === 11) return { score: 1, label: '−1 落ち着かせる' };
    if (d === 2) return { score: 2, label: '+2 ブースト' };
    if (d === 7) return { score: 2, label: '半音上げ' };
  } else if (d === 1 || d === 11) return { score: 2, label: '斜め（少し濁る）' };
  return { score: 4, label: 'キーが合わない' };
}
export function bpmFit(a, b) {
  const x = bpmForMix(a), y = bpmForMix(b);
  if (!x || !y) return null;
  let best = null;
  for (const m of [1, 2, 0.5]) {
    const pct = (y * m - x) / x * 100;
    if (!best || Math.abs(pct) < Math.abs(best.pct)) best = { pct, m, bpm: y };
  }
  return best;
}
export const bpmPenalty = (bf) => {
  if (!bf) return 3;
  const p = Math.abs(bf.pct);
  return (p <= 3 ? 0 : p <= 6 ? 1 : p <= 10 ? 2.5 : 4) + (bf.m !== 1 ? 0.5 : 0);
};
export function likePoints(likes) {
  const n = Number.isInteger(likes) && likes >= 0 ? likes : 0;
  return 30 * (n / (n + 2));
}
export const totalPoints = (score, likes) => 70 * score + likePoints(likes);
export function transitionState(from, to) {
  function shape(song) {
    const version = String(song.variant || '').toLowerCase();
    const originalYear = song.info?.card?.originalYear ?? song.originalYear ?? null;
    return {
      genre: String(song.genre || '').slice(0, 120), originalYear,
      releaseYear: song.releaseYear || null, bpm: song.bpm ?? null,
      camelot: String(song.camelot || '').slice(0, 12), songKey: String(song.songKey || '').slice(0, 12),
      bpmSrc: String(song.bpmSrc || '').slice(0, 16), keySrc: String(song.keySrc || '').slice(0, 16),
      versionKind: ['remix', 'refix', ' mix'].some((word) => version.includes(word)) ? 'remix'
        : version.includes('remaster') ? 'remaster' : version.includes('extended') ? 'extended' : 'unspecified',
    };
  }
  return { from: shape(from), to: shape(to), bpmFit: bpmFit(from, to), keyFit: keyFit(from, to),
    effectiveFromBpm: bpmForMix(from), effectiveToBpm: bpmForMix(to) };
}
export const transitionSignature = (from, to) => JSON.stringify(transitionState(from, to));
