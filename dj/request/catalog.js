/* DJ リクエスト画面の iTunes 検索・候補整理・AI 推薦曲の照合。
   dj/assets/dj-request-core.js（DJRequestCore）の後に読む。 */
(function (global) {
  'use strict';

  const { timeoutSignal } = global.DJRequestCore;

  /* 同じ曲の DJ ミックス収録版が1曲につき10件以上返ってくるので、
     まず落とし、次にバージョン違いを畳んで、原曲を代表に押し上げる。 */
  const MIXED = /[(\[]\s*(mixed|continuous mix)\s*[)\]]/i;
  const DJMIX = /\(dj mix\)|\bdj mix\b/i;
  const SUFFIX = /\s*[(\[]([^)\]]*)[)\]]\s*$/;
  const FEAT = /\s*[(\[]?\bfeat\.?\s[^)\]]*[)\]]?/i;

  const norm = (s) => String(s || '').replace(FEAT, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

  function splitVariant(name) {
    const parts = [];
    let s = name;
    for (;;) {
      const m = SUFFIX.exec(s);
      if (!m) break;
      parts.unshift(m[1].trim());
      s = s.slice(0, m.index);
    }
    return { base: s.trim(), variant: parts.join(' / ') };
  }

  const bigArt = (u) => String(u || '').replace(/\/\d+x\d+bb\.jpg$/, '/240x240bb.webp');

  // DJ ミックス収録版を落とし、画面で使う形に直す（並びは iTunes の関連度順のまま）
  function toTracks(results) {
    const kept = [];
    for (const r of results) {
      if (MIXED.test(r.trackName || '') || DJMIX.test(r.collectionName || '')) continue;
      const { base, variant } = splitVariant(r.trackName || '');
      kept.push({
        trackId: r.trackId, artist: r.artistName || '', title: base, variant,
        album: r.collectionName || '', durationMs: r.trackTimeMillis || 0,
        // 繋ぎの判断材料。iTunes の応答にそのまま入っているので拾うだけ
        genre: r.primaryGenreName || '',
        releaseYear: Number(String(r.releaseDate || '').slice(0, 4)) || 0,
        explicitness: r.trackExplicitness || '',   // explicit | cleaned | notExplicit
        artwork: bigArt(r.artworkUrl100), appleUrl: r.trackViewUrl || '',
        previewUrl: r.previewUrl || '',
        key: norm(r.artistName) + '|' + norm(base),
      });
    }
    return kept;
  }

  function refine(results) {
    const groups = new Map();
    for (const t of toTracks(results)) {
      if (!groups.has(t.key)) groups.set(t.key, []);
      const g = groups.get(t.key);
      // 同じバージョンで尺もほぼ同じなら同一音源とみなして畳む
      const half = Math.round(t.durationMs / 2000);
      if (g.some((x) => x.variant.toLowerCase() === t.variant.toLowerCase()
        && Math.abs(Math.round(x.durationMs / 2000) - half) <= 1)) continue;
      g.push(t);
    }

    const out = [];
    for (const g of groups.values()) {
      // 代表は「バージョン表記なし」→「Single/EP 収録」→「尺が長い」→「trackId が古い」
      g.sort((a, b) =>
        (a.variant ? 1 : 0) - (b.variant ? 1 : 0) ||
        (/-\s*(single|ep)$/i.test(a.album) ? 0 : 1) - (/-\s*(single|ep)$/i.test(b.album) ? 0 : 1) ||
        b.durationMs - a.durationMs ||
        a.trackId - b.trackId);
      // ジャケットの無い別バージョンは、代表のジャケットで埋める
      const alts = g.slice(1, 6).map((t) => (t.artwork ? t : { ...t, artwork: g[0].artwork }));
      out.push({ rep: g[0], alts });
    }
    return out.slice(0, 5);
  }

  /* iTunes Search API の通信口。検索欄は次の入力で中断し、AI 回答の照合は
     指定時間で打ち切る。用途ごとの違いは options に残し、URL と JSON 読み込みは共通にする。 */
  const BASE = 'https://itunes.apple.com';

  async function read(path, { signal, timeout = 0 } = {}) {
    const res = await fetch(BASE + path, { signal: timeout ? timeoutSignal(timeout) : signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function search(term, { country = 'JP', limit = 50, ...options } = {}) {
    return read('/search?term=' + encodeURIComponent(term) + '&entity=song&limit=' + limit +
      '&country=' + encodeURIComponent(country), options);
  }

  function lookup(ids, { country = 'US', ...options } = {}) {
    const value = Array.isArray(ids) ? ids.join(',') : String(ids || '');
    return read('/lookup?id=' + value + '&country=' + encodeURIComponent(country), options);
  }

  /* rekordbox の検索で当たりやすいラテン表記を US ストアフロントから取る。
     trackId はストアフロント共通なので同じ曲を引ける。失敗したら空文字（送信は続ける） */
  async function latinArtist(trackId) {
    if (!trackId) return '';
    try {
      const d = await lookup(trackId, { country: 'US', timeout: 2500 });
      return (d.results && d.results[0] && d.results[0].artistName) || '';
    } catch { return ''; }
  }

  /* 統合回答から括弧の中身を拾って検索語にする。回答のたびに鉤括弧・隅付き
     括弧・引用符のどれで囲まれるかが変わるので、いずれも受け取る。 */
  const SONG_RE = /[「『【〔"“]([^「」『』【】〔〕"”\n]{2,60})[」』】〕"”]/g;
  const songLabel = (s) => s.trim().replace(/\s+/g, ' ');
  const LABEL_SEP = /\s+[-–—]\s+/;   // 「アーティスト名 - 曲名」の区切り

  /* 句読点を含むのは、ふつうは括弧で囲んだ文章なので捨てる。ただし「アーティスト名 - 曲名」の
     形なら名前の一部として残す（モーニング娘。・Wham!・Panic! At The Disco など） */
  function pickSongs(text) {
    const out = [];
    for (const m of text.matchAll(SONG_RE)) {
      const s = songLabel(m[1]);
      if (s.length < 2 || out.includes(s)) continue;
      if (!LABEL_SEP.test(s) && /[。、！？!?]/.test(s)) continue;
      out.push(s);
    }
    return out.slice(0, 4);
  }

  /* 挙げられた曲を、検索タブと同じ iTunes Search API（Apple Music と同じ曲目録）で引く。
     Apple Music API そのものは開発者登録と署名済みトークンが要るうえ、中身は同じなので使わない。
     Worker から引くと Cloudflare の IP で回数制限を食い合うので、ブラウザから直接引く。
     ok = 見つかった（track 付き）/ missing = 見つからない / unknown = 通信の失敗で確かめられない */
  const bare = (s) => norm(s).replace(/\s/g, '');

  /* 曲名は完全一致だけを認める（前方一致にすると「Animal」が「Animals」に化ける）。
     括弧の版表記は splitVariant で外してあるので、ここでは「- Remastered 2011」のような
     ハイフン区切りの版表記を外した形も比べる */
  const titleKeys = (s) => new Set([bare(s), bare(String(s).replace(/\s+[-–—]\s+.*$/, ''))].filter(Boolean));
  const sameTitle = (got, want) => [...titleKeys(got)].some((k) => want.has(k));

  /* アーティストは連名を1人ずつに分けて比べ、挙げた全員がそろっていれば本人とみなす。
     feat. で参加している人も数える（「Sia - Titanium」は David Guetta feat. Sia で当たる）。
     分けると名前が壊れる名義（X JAPAN → 「」と「JAPAN」）は分けずに1人として扱う */
  const ARTIST_SEP = /\s*(?:&|,|、|\/|\+|\bx\b|\bvs\.?|\bfeat\.?|\bft\.?|\bwith\b)\s*/i;
  function artistKeys(s) {
    s = String(s || '');
    const parts = s.split(ARTIST_SEP).map(bare);
    return parts.some((k) => !k) ? [bare(s)].filter(Boolean) : parts;
  }
  const featOf = (s) => { const m = /feat\.?\s([^)\]\/]*)/i.exec(s || ''); return m ? m[1] : ''; };

  /* 0 = 別人、1 = 連名や feat. の一員として参加、2 = 名義がそのまま一致。
     2 を優先しないと「Earth, Wind & Fire - September」が映画の共演版に化ける */
  function artistScore(want, name, withFeat) {
    const main = artistKeys(name);
    const all = new Set([...main, ...artistKeys(featOf(withFeat))]);
    if (!want.length || !want.every((k) => all.has(k))) return 0;
    return main.length === want.length && main.every((k) => want.includes(k)) ? 2 : 1;
  }

  /* 照合は2段。まず日本のストアで1曲ずつ引き、曲名の合う候補に絞る。日本のストアは洋楽の
     アーティスト名をカナで返すので、名義がそのまま合わなかった分は、trackId 共通の US ストアで
     英字の名前を引いて比べ直す。US は全曲まとめて1本で引く。 */
  async function verifyRecommendations(labels) {
    const jobs = await Promise.all(labels.map(async (label) => {
      const cut = label.split(LABEL_SEP);
      // アーティスト名の無い挙げ方は、同名の別の曲と見分けられないので照合しない
      if (cut.length < 2) return { label, state: 'missing' };
      const artist = cut[0], title = cut.slice(1).join(' - ');
      const want = titleKeys(splitVariant(title).base || title);
      try {
        const d = await search(artist + ' ' + title, { country: 'JP', limit: 25, timeout: 8000 });
        const wantArtist = artistKeys(artist);
        // 並びは関連度順のまま
        const titled = toTracks(d.results || []).filter((t) => sameTitle(t.title, want));
        const score = new Map(titled.map((t) => [t.trackId, artistScore(wantArtist, t.artist, t.variant)]));
        return { label, wantArtist, titled, score, needUS: titled.length > 0 && ![...score.values()].includes(2) };
      } catch {
        return { label, state: 'unknown' };
      }
    }));

    const ids = [...new Set(jobs.filter((j) => j.needUS).flatMap((j) => j.titled.slice(0, 10).map((t) => t.trackId)))];
    let us = null;   // trackId → US ストアの結果。null は引けなかった
    if (ids.length) {
      try {
        const d = await lookup(ids, { country: 'US', timeout: 6000 });
        us = new Map((d.results || []).map((r) => [r.trackId, r]));
      } catch { /* US で確かめられなかった分は unknown に回る */ }
    }
    return jobs.map((j) => settle(j, us));
  }

  function settle(j, us) {
    if (j.state) return j;
    const { label, titled, score } = j;
    const latin = new Map();   // カナ名義 → US での英字名義
    if (j.needUS && us) {
      // 日本限定の盤は US に無く、原曲がそこにしか無いことがある。US で確かめた一致度は
      // 同じカナ名義の曲すべてに広げる
      const byName = new Map();
      for (const t of titled) {
        const r = us.get(t.trackId);
        const s = r ? artistScore(j.wantArtist, r.artistName, r.trackName) : 0;
        if (s > (byName.get(t.artist) || 0)) { byName.set(t.artist, s); latin.set(t.artist, r.artistName); }
      }
      for (const t of titled) score.set(t.trackId, Math.max(score.get(t.trackId), byName.get(t.artist) || 0));
    }
    // 原曲（バージョン表記なし、または feat. だけ）を最優先にし、その中で名義がそのまま合うものを
    // 先にする。名義を先にすると「Sia - Titanium」が Sia 名義の別録音に化ける
    const isOrig = (t) => !t.variant || /^feat\.?\s[^/]*$/i.test(t.variant);
    const rank = (t) => score.get(t.trackId) ? (isOrig(t) ? 2 : 0) + score.get(t.trackId) : 0;
    let track = null;
    for (const t of titled) if (rank(t) && (!track || rank(t) > rank(track))) track = t;   // 同点は関連度順
    if (!track) return { label, state: j.needUS && !us ? 'unknown' : 'missing' };
    // 送信時に rekordbox 向けの英字名義を引き直さずに済むよう持たせておく
    if (latin.has(track.artist)) track.artistEn = latin.get(track.artist);
    return { label, state: 'ok', track };
  }

  global.DJRequestCatalog = Object.freeze({ latinArtist, pickSongs, refine, search, verifyRecommendations });
})(window);
