/**
 * 曲リクエスト受付 Worker  —  tk.st/dj/api/req/*
 *
 * 公開API（Origin 制限のみ）
 *   GET  /dj/api/req/event      いま受付中のイベント
 *   POST /dj/api/req/requests   リクエスト投稿
 *   GET  /dj/api/req/board      みんなのリクエスト（再生済かどうかだけ見せる）
 *
 * ブースAPI（鍵なしの公開。ページをどこからもリンクしないことで運用上隠す）
 *   GET   /dj/api/req/admin/songs        全件（ひとこと・内部ステータス込み）
 *   PATCH /dj/api/req/admin/songs/:id    ステータス更新
 *   POST  /dj/api/req/admin/event        新しいイベントを開始
 *   PATCH /dj/api/req/admin/event        受付の開始／停止
 *
 * 文字列は素のまま保存し、エスケープは表示側で行う。DB に HTML エスケープ済みの
 * 文字列を入れると、DJ がコピーする曲名に &amp; が混ざって検索が外れるため。
 *
 * ひとことは /board では返さないが /admin/songs では返る。鍵が無い以上これは
 * 実質公開情報なので、来場者ページの文言もそれに合わせてある。
 */

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

// 荒らし対策のしきい値
const RATE_WINDOW_MIN = 10;   // 直近この分数で
const RATE_MAX        = 3;    // 1つの IP から投稿できる件数
const BOARD_WAITING   = 10;   // 公開一覧に出す「受付済」の件数

const LIMITS = { title: 200, artist: 200, album: 200, name: 20, message: 140, url: 500 };

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/** 制御文字を落として長さを詰める。表示側で必ずエスケープする前提。 */
function clean(v, max) {
  // 制御文字は空白に潰す。コード内にエスケープ表記を持たせたくないので
  // コードポイントで判定する。
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0);
    out += (c < 32 || c === 127) ? ' ' : ch;
  }
  return out.trim().slice(0, max);
}

/** 同じ曲をまとめるためのキー。trackId があればそれが一番確実。 */
function dedupeKey(track) {
  if (track.trackId) return 'id:' + String(track.trackId);
  const norm = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return 'txt:' + norm(track.artist) + '|' + norm(track.title);
}

/** IP は生で保存しない。イベント単位でソルトを混ぜて追跡性も下げる。 */
async function hashIp(ip, eventCode, salt) {
  const data = new TextEncoder().encode(`${salt || 'tk.st'}|${eventCode}|${ip}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 紛らわしい文字（0/O/1/I）を除いた6文字。口頭で伝えられるように。 */
function newEventCode() {
  const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return [...r].map((n) => A[n % A.length]).join('');
}

async function openEvent(env) {
  return env.DB.prepare(
    `SELECT code, title FROM events WHERE status = 'open' LIMIT 1`
  ).first();
}

/* ── 公開: 現在のイベント ───────────────── */
async function getEvent(env, cors) {
  const ev = await openEvent(env);
  return json(ev ? { open: true, code: ev.code, title: ev.title } : { open: false }, 200, cors);
}

/* ── 公開: 投稿 ─────────────────────────── */
async function postRequest(request, env, cors) {
  const ev = await openEvent(env);
  if (!ev) return json({ error: 'closed', message: 'ただいまリクエストの受付時間外です' }, 409, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', message: '内容を読み取れませんでした' }, 400, cors);
  }

  const track = body.track || {};
  const isFree = !track.trackId && !track.title;
  const title = clean(isFree ? body.free : track.title, LIMITS.title);
  if (title.length < 1) {
    return json({ error: 'bad_request', message: '曲名を入力してください' }, 400, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await hashIp(ip, ev.code, env.IP_SALT);

  // 直近の投稿数で足切り。連投とスパムをここで止める。
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM requests
      WHERE ip_hash = ? AND created_at > datetime('now', ?)`
  ).bind(ipHash, `-${RATE_WINDOW_MIN} minutes`).first();
  if (recent && recent.n >= RATE_MAX) {
    return json({
      error: 'rate_limited',
      message: `リクエストは${RATE_WINDOW_MIN}分に${RATE_MAX}曲までです。少し時間をおいてください`,
    }, 429, cors);
  }

  const key = dedupeKey(isFree ? { title } : track);

  // 既にある曲なら行を作らず votes を積む
  let song = await env.DB.prepare(
    `SELECT id FROM songs WHERE event_code = ? AND dedupe_key = ?`
  ).bind(ev.code, key).first();

  if (!song) {
    const res = await env.DB.prepare(
      `INSERT INTO songs
         (event_code, dedupe_key, track_id, title, artist, artist_en, variant, album,
          duration_ms, artwork, apple_url, preview_url, is_free,
          genre, release_year, explicitness, votes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      ev.code, key,
      track.trackId ? String(track.trackId) : null,
      title,
      clean(track.artist, LIMITS.artist),
      clean(track.artistEn, LIMITS.artist),
      clean(track.variant, 80),
      clean(track.album, LIMITS.album),
      Number(track.durationMs) || 0,
      clean(track.artwork, LIMITS.url),
      clean(track.appleUrl, LIMITS.url),
      clean(track.previewUrl, LIMITS.url),
      isFree ? 1 : 0,
      clean(track.genre, 60),
      Number(track.releaseYear) || 0,
      clean(track.explicitness, 20)
    ).run();
    song = { id: res.meta.last_row_id };
  }

  // 同じ人が同じ曲を再送しても票は増えない（UNIQUE(song_id, ip_hash)）
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO requests (song_id, event_code, from_name, message, ip_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(song.id, ev.code, clean(body.name, LIMITS.name), clean(body.message, LIMITS.message), ipHash).run();

  const added = ins.meta.changes > 0;
  if (added) {
    await env.DB.prepare(`UPDATE songs SET votes = votes + 1 WHERE id = ?`).bind(song.id).run();
  }

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE event_code = ?`
  ).bind(ev.code).first();

  return json({ ok: true, songId: song.id, duplicate: !added, position: total ? total.n : 0 }, 200, cors);
}

/* ── 公開: みんなのリクエスト ───────────────
   DJ の判断（queued / skipped）は外に出さない。played か否かだけ。
   ひとことも返さない。UI で隠すのではなく、ここで返さないのが要点。 */
async function getBoard(env, cors) {
  const ev = await openEvent(env);
  const latest = ev || await env.DB.prepare(
    `SELECT code, title FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!latest) return json({ event: null, now: null, played: [], waiting: [] }, 200, cors);

  const cols = `id, title, artist, variant, artwork, is_free, votes, played_at`;

  const played = await env.DB.prepare(
    `SELECT ${cols} FROM songs
      WHERE event_code = ? AND status = 'played'
      ORDER BY played_at DESC, id DESC`
  ).bind(latest.code).all();

  const waiting = await env.DB.prepare(
    `SELECT ${cols} FROM songs
      WHERE event_code = ? AND status <> 'played'
      ORDER BY votes DESC, id ASC LIMIT ?`
  ).bind(latest.code, BOARD_WAITING).all();

  const names = await env.DB.prepare(
    `SELECT song_id, from_name FROM requests
      WHERE event_code = ? AND from_name <> '' ORDER BY id ASC`
  ).bind(latest.code).all();

  // 曲ごとの「最初に送った人」だけ添える
  const firstName = new Map();
  for (const r of names.results) if (!firstName.has(r.song_id)) firstName.set(r.song_id, r.from_name);

  const shape = (s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    variant: s.variant,
    artwork: s.artwork,
    isFree: !!s.is_free,
    votes: s.votes,
    playedAt: s.played_at,
    by: firstName.get(s.id) || '',
  });

  const p = played.results.map(shape);
  return json({
    event: { code: latest.code, title: latest.title, open: !!ev },
    now: p[0] || null,
    played: p,
    waiting: waiting.results.map(shape),
  }, 200, cors);
}

/* ── 管理 ───────────────────────────────── */
async function adminSongs(env, cors) {
  const ev = await openEvent(env) || await env.DB.prepare(
    `SELECT code, title FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!ev) return json({ event: null, songs: [] }, 200, cors);

  const songs = await env.DB.prepare(
    `SELECT * FROM songs WHERE event_code = ? ORDER BY id DESC`
  ).bind(ev.code).all();

  const voices = await env.DB.prepare(
    `SELECT song_id, from_name, message, created_at FROM requests
      WHERE event_code = ? ORDER BY id ASC`
  ).bind(ev.code).all();

  const bySong = new Map();
  for (const v of voices.results) {
    if (!bySong.has(v.song_id)) bySong.set(v.song_id, []);
    bySong.get(v.song_id).push({ name: v.from_name, message: v.message, at: v.created_at });
  }

  const open = await openEvent(env);
  return json({
    event: { code: ev.code, title: ev.title, open: !!open },
    songs: songs.results.map((s) => ({
      id: s.id,
      trackId: s.track_id,
      title: s.title,
      artist: s.artist,
      artistEn: s.artist_en,
      variant: s.variant,
      album: s.album,
      durationMs: s.duration_ms,
      artwork: s.artwork,
      appleUrl: s.apple_url,
      previewUrl: s.preview_url,
      isFree: !!s.is_free,
      genre: s.genre || '',
      releaseYear: s.release_year || 0,
      explicitness: s.explicitness || '',
      bpm: s.bpm,
      songKey: s.song_key || '',
      camelot: s.camelot || '',
      votes: s.votes,
      status: s.status,
      createdAt: s.created_at,
      playedAt: s.played_at,
      voices: bySong.get(s.id) || [],
    })),
  }, 200, cors);
}

async function adminPatchSong(id, request, env, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const status = String(body.status || '');
  if (!['pending', 'queued', 'played', 'skipped'].includes(status)) {
    return json({ error: 'bad_request', message: 'status が不正です' }, 400, cors);
  }
  // played に入った瞬間の時刻が「今かかっている曲」の根拠になる。
  // played から戻したときは消して、順序が壊れないようにする。
  await env.DB.prepare(
    `UPDATE songs
        SET status = ?,
            played_at = CASE WHEN ? = 'played' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = ?`
  ).bind(status, status, id).run();
  return json({ ok: true }, 200, cors);
}

async function adminNewEvent(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const title = clean(body.title, 60) || '今夜のリクエスト';
  const code = newEventCode();
  // 「閉じてから開く」を1バッチで。部分ユニークインデックスがあるので
  // 順序が崩れると open が2件になって弾かれる。
  await env.DB.batch([
    env.DB.prepare(`UPDATE events SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE status = 'open'`),
    env.DB.prepare(`INSERT INTO events (code, title, status) VALUES (?, ?, 'open')`).bind(code, title),
  ]);
  return json({ ok: true, code, title }, 200, cors);
}

async function adminToggleEvent(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const want = body.status === 'open' ? 'open' : 'closed';

  if (want === 'closed') {
    await env.DB.prepare(
      `UPDATE events SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE status = 'open'`
    ).run();
    return json({ ok: true, open: false }, 200, cors);
  }

  const already = await openEvent(env);
  if (already) return json({ ok: true, open: true, code: already.code }, 200, cors);

  const last = await env.DB.prepare(
    `SELECT code FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!last) return json({ error: 'no_event', message: 'イベントがまだありません' }, 409, cors);

  await env.DB.prepare(
    `UPDATE events SET status = 'open', closed_at = NULL WHERE code = ?`
  ).bind(last.code).run();
  return json({ ok: true, open: true, code: last.code }, 200, cors);
}

/* ── ルーティング ───────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ブースコンソールは公開運用。鍵は掛けない（noindex で、どこからもリンクしない）。
    // 他サイトのページから叩かれるのだけ Origin で弾く。
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, cors);
    }

    try {
      if (path === '/dj/api/req/event' && method === 'GET')     return await getEvent(env, cors);
      if (path === '/dj/api/req/board' && method === 'GET')     return await getBoard(env, cors);
      if (path === '/dj/api/req/requests' && method === 'POST') return await postRequest(request, env, cors);

      if (path === '/dj/api/req/admin/songs' && method === 'GET')    return await adminSongs(env, cors);
      if (path === '/dj/api/req/admin/event' && method === 'POST')   return await adminNewEvent(request, env, cors);
      if (path === '/dj/api/req/admin/event' && method === 'PATCH')  return await adminToggleEvent(request, env, cors);

      const m = path.match(/^\/dj\/api\/req\/admin\/songs\/(\d+)$/);
      if (m && method === 'PATCH') return await adminPatchSong(Number(m[1]), request, env, cors);

      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'internal', message: String(e && e.message || e).slice(0, 200) }, 500, cors);
    }
  },
};
