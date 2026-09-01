/**
 * 曲リクエスト受付 Worker  —  tk.st/dj/api/req/*
 *
 * 公開API（Origin 制限のみ）
 *   GET    /dj/api/req/event           いま受付中のイベント
 *   POST   /dj/api/req/requests        リクエスト投稿
 *   GET    /dj/api/req/board           みんなのリクエスト（再生済かどうかだけ見せる）
 *   GET    /dj/api/req/events          過去のイベント一覧（曲がかかった回だけ）
 *   GET    /dj/api/req/events/:code    その回でかかった曲
 *   GET    /dj/api/req/songs/:id       曲の詳細（Authorization: Bearer <鍵> で自分の投稿も返る）
 *   PATCH  /dj/api/req/songs/:id/mine  自分の投稿のひとこと・名前を直す
 *   DELETE /dj/api/req/songs/:id/mine  自分の投稿を取り下げる
 *   POST   /dj/api/req/songs/:id/like  いいねを押す（1端末1曲1回）
 *   DELETE /dj/api/req/songs/:id/like  いいねを取り消す
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
 *
 * 投稿の修正・取り下げは edit_token でしか通さない。鍵はヘッダでだけ受け取る。
 * クエリに載せるとアクセスログや Referer に残り、そのまま使い回されるため。
 * また DJ が採用・見送り・再生済のどれかに動かした曲と、受付が終わった回の曲は
 * 触らせない。並べ替えたあとで足元の内容が変わると困るため。
 *
 * いいねは votes とは別物。votes は「リクエストした人数」で投稿しないと増えないが、
 * いいねは曲を送っていない人でも押せる。ブースは REQ と LIKE を並べて出し、
 * 人気順は LIKE で並べる。どちらも同じ端末からは1曲につき1回しか増えない。
 *
 * ip_hash は保存するだけで、判定には一切使わない。会場の Wi-Fi では来場者全員が
 * 同じ値になるので、本人確認にも連投の判定にも使えない。「同じ人か」はブラウザが
 * 持つ device_key で見る。連打の判定は requests ではなく post_log で数える
 * （requests は取り下げで消えるため、数えると上限がすり抜けられる）。
 */

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

// 連打の抑止。IP ではなく端末単位で数える（会場の Wi-Fi では IP が全員同じ）。
// 鍵はブラウザが持つので作り直せば逃げられるが、止めたいのは面白半分の連打で、
// そこは端末単位で十分に効く。どんどん送ってほしいので枠は広めに取る。
const RATE_WINDOW_MIN = 1;    // 直近この分数で
const RATE_MAX        = 6;    // 1つの端末から投稿できる件数
const RATE_KEEP_MIN   = 60;   // 元帳をこの分数だけ残す（端末の鍵を持ち続けない）
const BOARD_WAITING   = 10;   // 公開一覧に出す「受付済」の件数
const PAST_EVENTS     = 20;   // 「過去のイベント」に並べる回の数

const LIMITS = { title: 200, artist: 200, album: 200, name: 20, message: 140, url: 500 };

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Authorization を許すと GET にも preflight が付く。会場の回線で毎回
    // 往復させたくないので、プリフライトはブラウザに1日持たせる。
    'Access-Control-Max-Age': '86400',
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

/** 投稿の修正・取り下げに使う鍵。当てずっぽうで通らない長さがあればよい。 */
function newEditToken() {
  const r = crypto.getRandomValues(new Uint8Array(16));
  return [...r].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** Authorization: Bearer <edit_token> を取り出す。クエリでは受け取らない。 */
function bearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec((request.headers.get('Authorization') || '').trim());
  return m ? clean(m[1], 64) : '';
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

/* ── BPM とキーの取得 ─────────────────────────
   GetSongBPM は type=both（曲名＋アーティスト名）でのみ引く。
   曲名だけで引くと 15曲中12曲で別アーティストの曲が返ることを実測したため、
   フォールバックは絶対に入れない。見つからなければ黙って諦める。
   BPM だけは Deezer で補完する（再生時間で照合を検証できるので比較的安全）。 */

const GSB_BASE = 'https://api.getsong.co';

/** lookup はフィールド内の空白が +、フィールド間の区切りが空白。 */
const gsbField = (s) => encodeURIComponent(String(s || '').trim()).replace(/%20/g, '+');

/** Open Key (Traktor) 表記を Camelot に直す。 2m -> 9A / 3d -> 10B */
function toCamelot(openKey) {
  const m = /^(\d{1,2})([md])$/.exec(String(openKey || '').trim());
  if (!m) return '';
  const n = ((Number(m[1]) + 6) % 12) + 1;
  return n + (m[2] === 'm' ? 'A' : 'B');
}

async function fetchJson(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || 6000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromGetSongBpm(env, artist, title) {
  if (!env.SONGBPM_KEY || !artist || !title) return null;
  const url = GSB_BASE + '/search/?api_key=' + env.SONGBPM_KEY +
    '&type=both&lookup=song:' + gsbField(title) + '%20artist:' + gsbField(artist);
  const d = await fetchJson(url);
  const hit = d && Array.isArray(d.search) ? d.search[0] : null;
  if (!hit) return null;
  const bpm = Number(hit.tempo);
  return {
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    songKey: hit.key_of || '',
    camelot: toCamelot(hit.open_key),
  };
}

async function bpmFromDeezer(artist, title, durationMs) {
  if (!artist || !title) return null;
  const sec = Math.round((durationMs || 0) / 1000);
  const q = 'artist:"' + artist.replace(/"/g, '') + '" track:"' + title.replace(/"/g, '') + '"';
  const d = await fetchJson('https://api.deezer.com/search?limit=10&q=' + encodeURIComponent(q));
  const list = (d && d.data) || [];
  // 再生時間が合うものだけ採用する。曲名が同じ別録音を掴まないための検証。
  const cand = sec ? list.find((x) => Math.abs(x.duration - sec) <= 3) : list[0];
  if (!cand) return null;
  const full = await fetchJson('https://api.deezer.com/track/' + cand.id);
  const bpm = full && Number(full.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/** 投稿のレスポンスを待たせないよう ctx.waitUntil から呼ぶ。失敗しても何も壊さない。 */
async function enrichSong(env, songId, artist, title, durationMs) {
  try {
    const gsb = await fromGetSongBpm(env, artist, title);
    if (gsb && (gsb.bpm || gsb.songKey)) {
      await env.DB.prepare(
        'UPDATE songs SET bpm = ?, song_key = ?, camelot = ? WHERE id = ?'
      ).bind(gsb.bpm, gsb.songKey, gsb.camelot, songId).run();
      return;
    }
    const bpm = await bpmFromDeezer(artist, title, durationMs);
    if (bpm) {
      await env.DB.prepare('UPDATE songs SET bpm = ? WHERE id = ?').bind(bpm, songId).run();
    }
  } catch {
    // 付帯情報が付かないだけなので握りつぶす
  }
}

/* ── 公開: 現在のイベント ───────────────── */
async function getEvent(env, cors) {
  const ev = await openEvent(env);
  return json(ev ? { open: true, code: ev.code, title: ev.title } : { open: false }, 200, cors);
}

/* ── 公開: 投稿 ─────────────────────────── */
async function postRequest(request, env, cors, ctx) {
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

  // 記録するだけ。荒らしを後から追う手掛かりで、判定には使わない。
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await hashIp(ip, ev.code, env.IP_SALT);

  // 端末の鍵はブラウザが作る。古いキャッシュのページから鍵なしで来たときは
  // その場で使い捨ての値を作って投稿自体は通す（空文字のままだと
  // UNIQUE(song_id, device_key) が別人の行と衝突して、投稿が黙って消える）。
  const deviceKey = clean(body.device, 64) || newEditToken();

  // 直近の投稿数で足切り。連打をここで止める。
  // 数えるのは requests ではなく post_log。requests は取り下げると行ごと消えるので、
  // それを数えると投稿→取り下げを繰り返すだけで上限がいくらでも戻ってしまう。
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM post_log
      WHERE device_key = ? AND created_at > datetime('now', ?)`
  ).bind(deviceKey, `-${RATE_WINDOW_MIN} minutes`).first();
  if (recent && recent.n >= RATE_MAX) {
    return json({
      error: 'rate_limited',
      message: `リクエストは${RATE_WINDOW_MIN}分に${RATE_MAX}曲までです。少し時間をおいてください`,
    }, 429, cors);
  }

  // 上限を通った時点で1件記録する。この先の結果（新規・重複・失敗）に関わらず
  // 「1回叩いた」ことは数える。取り下げてもこの行は残る。
  await env.DB.prepare(`INSERT INTO post_log (device_key) VALUES (?)`).bind(deviceKey).run();

  const key = dedupeKey(isFree ? { title } : track);

  // 既にある曲なら行を作らず votes を積む
  let isNewSong = false;
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
    isNewSong = true;
  }

  // 同じ端末が同じ曲を再送しても票は増えない（UNIQUE(song_id, device_key)）。
  // 別の人が同じ曲を送るのは弾かない。票が積まれ、ひとことも人数分残る。
  let editToken = newEditToken();
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO requests (song_id, event_code, from_name, message, ip_hash, device_key, edit_token)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    song.id, ev.code, clean(body.name, LIMITS.name), clean(body.message, LIMITS.message),
    ipHash, deviceKey, editToken
  ).run();

  const added = ins.meta.changes > 0;
  if (added) {
    await env.DB.prepare(`UPDATE songs SET votes = votes + 1 WHERE id = ?`).bind(song.id).run();
  } else {
    // 弾かれた＝この端末はもうこの曲を送っている。あとで直せるよう既存の鍵を返す。
    // 引くのは必ず device_key。ip_hash で引くと、同じ Wi-Fi にいる別人の行を掴んで
    // その人の鍵を渡してしまう（＝隣の人のひとことを読み書きできてしまう）。
    const row = await env.DB.prepare(
      `SELECT id, edit_token FROM requests WHERE song_id = ? AND device_key = ?`
    ).bind(song.id, deviceKey).first();
    if (row && row.edit_token) {
      editToken = row.edit_token;
    } else if (row) {
      // 鍵を持たない古い行。自分の行だと確かめられたので、ここで発行して埋める。
      await env.DB.prepare(`UPDATE requests SET edit_token = ? WHERE id = ?`).bind(editToken, row.id).run();
    } else {
      // 自分の行が無いのに弾かれた＝想定外。誰の鍵も渡さない。
      editToken = '';
    }
  }

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE event_code = ?`
  ).bind(ev.code).first();

  // 後始末はここまでの D1 操作が終わってから始める。本体の書き込みと並行させると
  // D1 が競合してタイムアウトするので、後始末どうしも直列に流す。
  if (ctx) {
    const artistForLookup = clean(track.artistEn, LIMITS.artist) || clean(track.artist, LIMITS.artist);
    ctx.waitUntil((async () => {
      // 連打の判定に効かなくなった元帳は捨てる。端末の鍵を必要以上に持たない。
      await env.DB.prepare(
        `DELETE FROM post_log WHERE created_at < datetime('now', ?)`
      ).bind(`-${RATE_KEEP_MIN} minutes`).run();
      if (isNewSong && !isFree) {
        await enrichSong(env, song.id, artistForLookup, title, Number(track.durationMs) || 0);
      }
    })());
  }

  return json({
    ok: true, songId: song.id, duplicate: !added,
    position: total ? total.n : 0, editToken,
  }, 200, cors);
}

/* ── 公開: 曲の詳細 ─────────────────────────
   Authorization に鍵を添えると、その鍵が指す自分の投稿だけが一緒に返る。
   他人のひとことは誰が見ても返さない（/board と同じ方針）。 */
async function getSong(id, request, env, cors) {
  const s = await env.DB.prepare(
    `SELECT id, event_code, title, artist, variant, album, duration_ms, artwork, apple_url, preview_url,
            is_free, genre, release_year, explicitness, votes, likes, status, played_at
       FROM songs WHERE id = ?`
  ).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);

  const names = await env.DB.prepare(
    `SELECT from_name FROM requests
      WHERE song_id = ? AND from_name <> '' ORDER BY id ASC LIMIT 1`
  ).bind(id).first();

  // 鍵はヘッダでだけ受け取る。クエリに載せるとアクセスログや Referer に残り、
  // 拾った側がそのまま PATCH / DELETE に使い回せてしまう。
  const token = bearer(request);
  const own = token
    ? await env.DB.prepare(
        `SELECT from_name, message, created_at FROM requests WHERE song_id = ? AND edit_token = ?`
      ).bind(id, token).first()
    : null;

  // 直せるのは「いま受付中の回」の「DJ がまだ触っていない」曲だけ。
  // 前回の鍵がブラウザに残っていても編集欄は出さない（ownRequest と同じ条件）。
  const ev = await openEvent(env);
  const live = !!ev && s.event_code === ev.code;
  const pending = s.status === 'pending';
  const editable = live && pending;

  // 終わった回の曲か。いいねを押せるのは「いちばん新しい回」だけなので
  // （setLike と同じ条件）、ボタンを出すかどうかの判断にそのまま使える。
  const latest = ev || await env.DB.prepare(
    `SELECT code FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  const past = !latest || s.event_code !== latest.code;

  return json({
    song: {
      id: s.id,
      title: s.title,
      artist: s.artist,
      variant: s.variant,
      album: s.album,
      durationMs: s.duration_ms,
      artwork: s.artwork,
      appleUrl: s.apple_url,
      previewUrl: s.preview_url,
      isFree: !!s.is_free,
      genre: s.genre,
      releaseYear: s.release_year,
      explicitness: s.explicitness,
      votes: s.votes,
      likes: s.likes || 0,
      playedAt: s.played_at,
      // /board と同じ。DJ が触ったかどうかだけで、採用か見送りかは出さない。
      seen: !pending,
      by: names ? names.from_name : '',
    },
    // queued か skipped かは外に出さない。畳んだ理由だけ closed / moved で伝える。
    editable,
    past,
    lock: editable ? '' : (live ? 'moved' : 'closed'),
    mine: own ? { name: own.from_name, message: own.message, at: own.created_at } : null,
  }, 200, cors);
}

const NOT_YOURS = ['forbidden', 'この投稿は、送信したブラウザからのみ変更できます', 403];

/** 修正・取り下げの共通チェック。曲・自分の投稿・DJ の進捗をまとめて見る。 */
async function ownRequest(id, token, env) {
  if (!token) return { error: NOT_YOURS };
  const s = await env.DB.prepare(`SELECT id, status FROM songs WHERE id = ?`).bind(id).first();
  if (!s) return { error: ['not_found', 'この曲は見つかりませんでした', 404] };
  const row = await env.DB.prepare(
    `SELECT id, event_code FROM requests WHERE song_id = ? AND edit_token = ?`
  ).bind(id, token).first();
  if (!row) return { error: NOT_YOURS };
  // 前回の鍵がブラウザに残っていても、終わった回には触らせない。
  // 履歴が後から書き換わったり、取り下げで曲ごと消えたりするのを防ぐ。
  const ev = await openEvent(env);
  if (!ev || row.event_code !== ev.code) {
    return { error: ['closed', 'この回の受付は終了しているため、変更・取り下げはできません', 409] };
  }
  if (s.status !== 'pending') {
    return { error: ['locked', 'DJ がすでに確認しているため、変更・取り下げはできません', 409] };
  }
  return { song: s, row };
}

/* ── 公開: 自分の投稿を直す ───────────────── */
async function patchMine(id, request, env, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const got = await ownRequest(id, bearer(request), env);
  if (got.error) return json({ error: got.error[0], message: got.error[1] }, got.error[2], cors);

  const name = clean(body.name, LIMITS.name);
  const message = clean(body.message, LIMITS.message);
  await env.DB.prepare(
    `UPDATE requests SET from_name = ?, message = ? WHERE id = ?`
  ).bind(name, message, got.row.id).run();

  return json({ ok: true, mine: { name, message } }, 200, cors);
}

/* ── 公開: 自分の投稿を取り下げる ───────────
   取り下げるのは自分の1票だけ。同じ曲を他の人も送っていれば曲は残る。 */
async function deleteMine(id, request, env, cors) {
  const got = await ownRequest(id, bearer(request), env);
  if (got.error) return json({ error: got.error[0], message: got.error[1] }, got.error[2], cors);

  await env.DB.prepare(`DELETE FROM requests WHERE id = ?`).bind(got.row.id).run();

  // votes は requests の件数そのもの。引き算ではなく数え直して合わせる。
  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE song_id = ?`
  ).bind(id).first();
  const votes = left ? left.n : 0;

  if (votes === 0) {
    // 曲の行が消えるので、その曲に付いたいいねも道連れにする（孤児を残さない）
    await env.DB.prepare(`DELETE FROM likes WHERE song_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM songs WHERE id = ?`).bind(id).run();
  } else {
    await env.DB.prepare(`UPDATE songs SET votes = ? WHERE id = ?`).bind(votes, id).run();
  }

  return json({ ok: true, votes, songRemoved: votes === 0 }, 200, cors);
}

/* ── 公開: いいね ───────────────────────────
   誰の票かは device_key で見る。ブラウザが作る値なので作り直せば増やせるが、
   止めたいのは面白半分の連打で、そこは端末単位で十分に効く（votes と同じ考え）。

   押せるのは「いちばん新しい回」の曲だけ。受付が終わったあとも会場は続くので
   open は条件にしないが、前の回の記録が後から動くのは防ぐ。

   合計は songs.likes に持つ。引き算ではなく likes を数え直して書き戻すので、
   途中で失敗して値がずれても、次に誰かが押した時点で正しい数に戻る。 */
async function setLike(id, on, request, env, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const deviceKey = clean(body.device, 64);
  if (!deviceKey) {
    return json({ error: 'no_device', message: 'この端末ではいいねを押せません' }, 400, cors);
  }

  const s = await env.DB.prepare(`SELECT id, event_code FROM songs WHERE id = ?`).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);

  const latest = await openEvent(env) || await env.DB.prepare(
    `SELECT code FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!latest || s.event_code !== latest.code) {
    return json({ error: 'closed', message: 'この回はもう終わっています' }, 409, cors);
  }

  if (on) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO likes (song_id, event_code, device_key) VALUES (?, ?, ?)`
    ).bind(id, s.event_code, deviceKey).run();
  } else {
    await env.DB.prepare(
      `DELETE FROM likes WHERE song_id = ? AND device_key = ?`
    ).bind(id, deviceKey).run();
  }

  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM likes WHERE song_id = ?`).bind(id).first();
  const likes = n ? n.n : 0;
  await env.DB.prepare(`UPDATE songs SET likes = ? WHERE id = ?`).bind(likes, id).run();

  return json({ ok: true, likes, liked: !!on }, 200, cors);
}

/* ── 公開: みんなのリクエスト ───────────────
   DJ の判断（queued / skipped）は外に出さない。played か否かと、
   DJ がもう触ったか（seen）だけ。seen は「まだ直せるか」を示すためのもので、
   採用か見送りかは区別できない。ひとことも返さない。UI で隠すのではなく、
   ここで返さないのが要点。 */

const BOARD_COLS = `id, title, artist, variant, artwork, is_free, votes, likes, played_at, status`;

/** 曲ごとの「最初に送った人」。名前を書かなかった投稿は数えない。 */
async function firstNames(code, env) {
  const rows = await env.DB.prepare(
    `SELECT song_id, from_name FROM requests
      WHERE event_code = ? AND from_name <> '' ORDER BY id ASC`
  ).bind(code).all();
  const m = new Map();
  for (const r of rows.results) if (!m.has(r.song_id)) m.set(r.song_id, r.from_name);
  return m;
}

/** 一覧に出す形。いまの回でも過去の回でも同じ形にそろえる。 */
const shapeSong = (s, firstName) => ({
  id: s.id,
  title: s.title,
  artist: s.artist,
  variant: s.variant,
  artwork: s.artwork,
  isFree: !!s.is_free,
  votes: s.votes,
  likes: s.likes || 0,
  playedAt: s.played_at,
  // 採用も見送りも同じ true。リクエストした側には「もう直せない」だけが伝わる。
  seen: s.status !== 'pending',
  by: firstName.get(s.id) || '',
});

async function getBoard(env, cors) {
  const ev = await openEvent(env);
  const latest = ev || await env.DB.prepare(
    `SELECT code, title FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!latest) return json({ event: null, now: null, played: [], waiting: [] }, 200, cors);

  const played = await env.DB.prepare(
    `SELECT ${BOARD_COLS} FROM songs
      WHERE event_code = ? AND status = 'played'
      ORDER BY played_at DESC, id DESC`
  ).bind(latest.code).all();

  const waiting = await env.DB.prepare(
    `SELECT ${BOARD_COLS} FROM songs
      WHERE event_code = ? AND status <> 'played'
      ORDER BY votes DESC, id ASC LIMIT ?`
  ).bind(latest.code, BOARD_WAITING).all();

  const firstName = await firstNames(latest.code, env);
  const shape = (s) => shapeSong(s, firstName);

  const p = played.results.map(shape);
  return json({
    event: { code: latest.code, title: latest.title, open: !!ev },
    now: p[0] || null,
    played: p,
    waiting: waiting.results.map(shape),
  }, 200, cors);
}

/* ── 公開: 過去のイベント ───────────────────
   /board が返す「いまの回」は除く。曲が1曲もかかっていない回も出さない
   （中身が空の回を開かせても、来場者には何も分からないため）。 */
async function getPastEvents(env, cors) {
  const latest = await openEvent(env) || await env.DB.prepare(
    `SELECT code FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();

  const rows = await env.DB.prepare(
    `SELECT e.code, e.title, e.created_at, COUNT(s.id) AS played
       FROM events e
       JOIN songs s ON s.event_code = e.code AND s.status = 'played'
      WHERE e.code <> ?
      GROUP BY e.code, e.title, e.created_at
      ORDER BY e.created_at DESC
      LIMIT ?`
  ).bind(latest ? latest.code : '', PAST_EVENTS).all();

  return json({
    events: rows.results.map((e) => ({
      code: e.code,
      title: e.title,
      // 日付は「開いた日」。終了時刻を使うと、日付をまたいだ回が翌日の
      // イベントとして並んでしまう（現場は深夜に終わることのほうが多い）。
      at: e.created_at,
      played: e.played,
    })),
  }, 200, cors);
}

/* ── 公開: 過去の回でかかった曲 ─────────────
   出すのは played だけ。受付済みのまま終わった曲は「かからなかった曲」で、
   終わったあとに並べて見せるものではない。
   並びは古い順。終わった回はセットリストとして読めるほうがよい。 */
async function getPastBoard(code, env, cors) {
  const ev = await env.DB.prepare(
    `SELECT code, title, created_at FROM events WHERE code = ?`
  ).bind(code).first();
  if (!ev) return json({ error: 'not_found', message: 'この回は見つかりませんでした' }, 404, cors);

  const played = await env.DB.prepare(
    `SELECT ${BOARD_COLS} FROM songs
      WHERE event_code = ? AND status = 'played'
      ORDER BY played_at ASC, id ASC`
  ).bind(code).all();

  const firstName = await firstNames(code, env);
  return json({
    event: { code: ev.code, title: ev.title, at: ev.created_at },
    played: played.results.map((s) => shapeSong(s, firstName)),
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
      likes: s.likes || 0,
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
  const title = clean(body.title, 60) || '今回のリクエスト';
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

/** BPM が空の曲をまとめて引き直す。API が落ちていた時の取りこぼし回収用。 */
async function adminEnrich(env, cors, ctx) {
  const ev = await openEvent(env) || await env.DB.prepare(
    `SELECT code FROM events ORDER BY created_at DESC LIMIT 1`
  ).first();
  if (!ev) return json({ ok: true, queued: 0 }, 200, cors);

  const { results } = await env.DB.prepare(
    `SELECT id, artist, artist_en, title, duration_ms FROM songs
      WHERE event_code = ? AND is_free = 0 AND bpm IS NULL LIMIT 30`
  ).bind(ev.code).all();

  // 同時に大量の UPDATE を投げると D1 が詰まるので直列に流す
  if (ctx) {
    ctx.waitUntil((async () => {
      for (const r of results) {
        await enrichSong(env, r.id, r.artist_en || r.artist, r.title, r.duration_ms);
      }
    })());
  }
  return json({ ok: true, queued: results.length }, 200, cors);
}

/* ── ルーティング ───────────────────────── */
export default {
  async fetch(request, env, ctx) {
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
      if (path === '/dj/api/req/events' && method === 'GET')    return await getPastEvents(env, cors);

      const past = path.match(/^\/dj\/api\/req\/events\/([0-9A-Za-z]{1,12})$/);
      if (past && method === 'GET') return await getPastBoard(past[1].toUpperCase(), env, cors);

      if (path === '/dj/api/req/requests' && method === 'POST') return await postRequest(request, env, cors, ctx);

      const song = path.match(/^\/dj\/api\/req\/songs\/(\d+)$/);
      if (song && method === 'GET') return await getSong(Number(song[1]), request, env, cors);

      const own = path.match(/^\/dj\/api\/req\/songs\/(\d+)\/mine$/);
      if (own && method === 'PATCH')  return await patchMine(Number(own[1]), request, env, cors);
      if (own && method === 'DELETE') return await deleteMine(Number(own[1]), request, env, cors);

      const like = path.match(/^\/dj\/api\/req\/songs\/(\d+)\/like$/);
      if (like && method === 'POST')   return await setLike(Number(like[1]), true, request, env, cors);
      if (like && method === 'DELETE') return await setLike(Number(like[1]), false, request, env, cors);

      if (path === '/dj/api/req/admin/songs' && method === 'GET')    return await adminSongs(env, cors);
      if (path === '/dj/api/req/admin/enrich' && method === 'POST')  return await adminEnrich(env, cors, ctx);
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
