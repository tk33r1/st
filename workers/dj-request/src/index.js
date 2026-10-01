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
 *   POST  /dj/api/req/admin/event        新しいイベントを開始（前の回は締まる。reopen で戻せる）
 *   PATCH /dj/api/req/admin/event        受付の開始／停止
 *   GET   /dj/api/req/admin/events       全イベント（削除の対象を選ぶための一覧）
 *   DELETE /dj/api/req/admin/events/:code 過去の回を曲・投稿・いいねごと消す
 *   POST  /dj/api/req/admin/events/:code/reopen  過去の回を受付中に戻す（いまの回は締める）
 *   PATCH /dj/api/req/admin/songs/:id/analysis  プレビューから推定した BPM・キー（空欄のときだけ入る）
 *   POST  /dj/api/req/admin/songs/:id/info      背景カードを作り直す（料金は1日の上限 SONG_INFO.dailyCap の内側）
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

// モデルIDの正本。wrangler がデプロイ時にバンドルへ取り込む（.github/AI_MODELS.md）
import aiModels from '../../../config/ai-models.json';

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];
const API_BASE = '/dj/api/req';

// 連打の抑止。IP ではなく端末単位で数える（会場の Wi-Fi では IP が全員同じ）。
// 鍵はブラウザが持つので作り直せば逃げられるが、止めたいのは面白半分の連打で、
// そこは端末単位で十分に効く。どんどん送ってほしいので枠は広めに取る。
const RATE_WINDOW_MIN = 1;    // 直近この分数で
const RATE_MAX        = 6;    // 1つの端末から投稿できる件数
const RATE_KEEP_MIN   = 60;   // 元帳をこの分数だけ残す（端末の鍵を持ち続けない）
const BOARD_WAITING   = 10;   // 公開一覧に出す「受付済」の件数
const PAST_EVENTS     = 20;   // 「過去のイベント」に並べる回の数

// message は来場者ページの入力欄（maxlength）と同じ値にする
const LIMITS = { title: 200, artist: 200, album: 200, name: 20, message: 50, url: 500 };
const URL_DOMAINS = {
  artwork: ['mzstatic.com'],
  apple: ['music.apple.com', 'itunes.apple.com'],
  preview: ['itunes.apple.com'],
};

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

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

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

/** 利用者の投稿値をそのまま読み込み先にしない。用途ごとに Apple の配信ドメインだけを通す。 */
function trustedHttpsUrl(v, domains) {
  const raw = clean(v, LIMITS.url);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return domains.some((domain) => host === domain || host.endsWith('.' + domain)) ? url.href : '';
  } catch {
    return '';
  }
}

/** 同じ曲をまとめるためのキー。trackId があればそれが一番確実。
    渡すのは clean 済みの値（長さが詰めてあるので、キーも長くならない）。 */
function dedupeKey({ trackId, artist, title }) {
  if (trackId) return 'id:' + trackId;
  const squash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const norm = (s) => squash(String(s ?? '').replace(/[^\p{L}\p{N}\s]/gu, ''));
  // 記号や絵文字だけの曲名は正規化すると空になり、別々の依頼が1曲に束ねられてしまう。
  // そのときは記号を残したまま比べる
  return 'txt:' + norm(artist) + '|' + (norm(title) || squash(title));
}

/** Apple の trackId（数字だけ）。それ以外はブラウザが作った値なので、曲を特定できたとはみなさない */
const appleTrackId = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? String(v) : '');

/** 範囲外の数値は 0（不明）にする。値は来場者のブラウザが送るので、負の値や桁外れの値も届く */
function intIn(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : 0;
}

/** IP は生で保存しない。イベント単位でソルトを混ぜて追跡性も下げる。 */
async function hashIp(ip, eventCode, salt) {
  // Secret が未設定なら公開の固定値へフォールバックせず、追跡可能なハッシュ自体を残さない。
  if (!ip || !salt) return '';
  const data = new TextEncoder().encode(`${salt}|${eventCode}|${ip}`);
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

/** 受付中の回を優先し、なければ最後まで使っていた回（締めた時刻が一番新しい回）を返す。
    公開一覧とブースの基準はここに揃える。
    作った順ではなく締めた順で見るのは、ブースで過去の回に戻したあと受付を止めても、
    あとから作った回（戻す前に使っていた回）へ切り替わらないようにするため。
    新しい回を作ると前の回は同じ時刻に締まるので、同着は作った順で新しいほうを採る。 */
async function currentEvent(env) {
  return env.DB.prepare(
    `SELECT code, title, status, created_at FROM events
      ORDER BY (status = 'open') DESC, COALESCE(closed_at, created_at) DESC, created_at DESC LIMIT 1`
  ).first();
}

/* ── BPM とキーの取得 ─────────────────────────
   GetSongBPM は type=both（曲名＋アーティスト名）でのみ引く。
   曲名だけで引くと 15曲中12曲で別アーティストの曲が返ることを実測したため、
   フォールバックは絶対に入れない。見つからなければ黙って諦める。
   BPM だけは Deezer で補完する（再生時間で照合を検証できるので比較的安全）。
   どちらでも取れなかった値は、ブースがプレビューを解析して埋める（adminPatchAnalysis）。
   外部サービスの値のほうが確かなので、推定値が先に入っていても上書きする。 */

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

const COVER_WORDS = /tribute|karaoke|instrumental|cover|originally performed/i;
const looseName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** artists は表記違いの候補（英語名・日本のストア表記）。Deezer は日本からだと片仮名で返すことがある。 */
async function bpmFromDeezer(artists, title, durationMs) {
  const sec = Math.round((durationMs || 0) / 1000);
  const names = artists.map(looseName).filter(Boolean);
  // 照合の要は再生時間。尺の分からない曲は、別の曲を掴んでも見分けられないので引かない。
  if (!names.length || !title || !sec) return null;
  // artist:"…" track:"…" の絞り込み検索は、日本から引くと有名曲でも 0 件になる
  // （2026-09 実測。Billie Jean も One More Time も 0 件）。ふつうの検索で引いて絞る。
  // 「(Single Version)」のような括弧書きが付くと、ふつうの検索でも 0 件になる。
  const bare = title.replace(/\s*[(\[（【][^)\]）】]*[)\]）】]/g, '').trim() || title;
  const d = await fetchJson('https://api.deezer.com/search?limit=10&q=' + encodeURIComponent(artists[0] + ' ' + bare));
  const list = (d && d.data) || [];
  // 再生時間とアーティストが合うものだけ採用する。尺だけだと、同じ長さのトリビュート盤
  // （別人のカバー）を掴む（Bloody Mary で実際に起きた）。
  // 部分一致は3文字以上のときだけ。1〜2文字の名前（"B" など）だと、ほとんどの名前に含まれてしまう。
  const sameArtist = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
  const cand = list.find((x) => {
    const got = looseName(x.artist && x.artist.name);
    return Math.abs(x.duration - sec) <= 3
      && !!got && names.some((n) => sameArtist(got, n))
      && (!COVER_WORDS.test(x.title) || COVER_WORDS.test(title));
  });
  if (!cand) return null;
  const full = await fetchJson('https://api.deezer.com/track/' + cand.id);
  const bpm = full && Number(full.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/** 投稿のレスポンスを待たせないよう ctx.waitUntil から呼ぶ。失敗しても何も壊さない。
    artist は英語名を優先した検索用の表記、altArtist は日本のストア表記（Deezer の照合だけに使う）。 */
async function enrichSong(env, songId, artist, title, durationMs, altArtist) {
  try {
    const gsb = await fromGetSongBpm(env, artist, title);
    const hasKey = !!(gsb && (gsb.songKey || gsb.camelot));
    if (gsb && (gsb.bpm || hasKey)) {
      // 取れた値だけ書く。BPM が無いのに NULL で上書きすると、先に入った推定値まで消える。
      await env.DB.prepare(
        `UPDATE songs
            SET bpm      = COALESCE(?1, bpm),
                bpm_src  = CASE WHEN ?1 IS NULL THEN bpm_src ELSE 'gsb' END,
                song_key = CASE WHEN ?2 THEN ?3 ELSE song_key END,
                camelot  = CASE WHEN ?2 THEN ?4 ELSE camelot END,
                key_src  = CASE WHEN ?2 THEN 'gsb' ELSE key_src END
          WHERE id = ?5`
      ).bind(gsb.bpm, hasKey ? 1 : 0, gsb.songKey, gsb.camelot, songId).run();
      // キーだけ取れた場合は、BPM を埋めるため Deezer の照合も続ける。
      if (gsb.bpm) return;
    }
    const bpm = await bpmFromDeezer([artist, altArtist], title, durationMs);
    if (bpm) {
      await env.DB.prepare(`UPDATE songs SET bpm = ?, bpm_src = 'deezer' WHERE id = ?`).bind(bpm, songId).run();
    }
  } catch {
    // 付帯情報が付かないだけなので握りつぶす
  }
}

/* ── 曲の背景カード ─────────────────────────
   OpenAI（Responses API）に Web 検索を必ずさせて、タイアップ・SNS での流行・リバイバルなどを
   短く答えさせる。検索させても検索結果に無いことを書くことはあるので、事実には出典 URL を
   付けさせ、その URL が実際に取得した検索結果（sources）に無ければ保存する前に捨てる。

   曲（Apple の trackId）ごとに1枚を、イベントをまたいで使い回す。作るのは投稿で新しい曲が
   入ったとき（ctx.waitUntil）、ブースが一覧を読んだときにまだカードの無い曲（describeMissing）、
   ブースの「作り直す」の3か所。ブースの操作には鍵を掛けていないので、料金の歯止めは
   1日の生成数の上限（dailyCap）が受け持つ。trackId は来場者の
   ブラウザが送る値なので、iTunes で本物の曲か確かめ、LLM に渡す曲の情報もそちらを使う（lookupTrack）。
   送るのは曲のメタ情報だけで、来場者の名前やひとことは送らない。 */

const SONG_INFO = {
  model: aiModels.openai.luna,
  reasoning: 'high',
  // ctx.waitUntil は応答を返してからおよそ30秒で打ち切られる。実測は 8〜19秒/曲
  timeoutMs: 25000,
  // ブースの「作り直す」はリクエストの中で待てるので長めに取る
  refreshTimeoutMs: 45000,
  maxOutputTokens: 6000,
  dailyCap: 1000,      // 24時間で OpenAI を呼んでよい回数（作り直しも1回と数える）
  maxAttempts: 2,      // 自動で作るのは失敗しても2回まで。以降はブースの「もう一度調べる」だけ
  lookupRetryMin: 10,  // 曲を確かめられなかった曲を、自動で確かめ直すまでの分数（OpenAI は呼ばないので上限に数えない）
  retrySec: 60,        // OpenAI で失敗した曲を、自動でやり直すまでの秒数
  minWaitMs: 12000,    // OpenAI を待てる時間がこれより短ければ、生成を始めない（実測 8〜19秒/曲）
  staleSec: 90,        // pending のまま残った行（途中で落ちた）を取り直せるまでの秒数
};

const INFO_KINDS = ['tieup', 'viral', 'chart', 'revival', 'other'];

const nullable = (type, description) => ({ type: [type, 'null'], description });
const SONG_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['identified', 'original_year', 'year_note', 'facts', 'viral_version', 'floor_tip', 'floor_tip_source', 'mix_hint'],
  properties: {
    identified: { type: 'boolean', description: '検索でこの曲そのものを確認できたか' },
    original_year: nullable('integer', '原曲の初出年。確認できなければ null'),
    year_note: nullable('string', 'iTunes の年と原曲の年が違う理由（リマスター・再録など）。同じなら null'),
    facts: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'source_url'],
        properties: {
          kind: { type: 'string', enum: INFO_KINDS },
          text: { type: 'string', description: '40字以内の日本語' },
          source_url: { type: 'string', description: 'この記述の根拠にした検索結果の URL' },
        },
      },
    },
    viral_version: nullable('string', 'SNS で広まったのが原曲以外の版なら、その版（sped up、リミックスなど）'),
    floor_tip: nullable('string', 'フロアで反応を取りやすい使いどころ（SNS で使われたパートなど）。50字以内'),
    floor_tip_source: nullable('string', 'floor_tip の根拠にした検索結果の URL'),
    mix_hint: nullable('string', 'この曲へ繋ぎ入れるときの具体的な助言（イントロの構成など）。50字以内'),
  },
};

const SONG_INFO_INSTRUCTIONS = `あなたは DJ ブースの補助係。渡された曲について、必ず Web 検索で確かめてから JSON で答える。
- 事実（年・タイアップ・SNS での流行・チャート・リバイバル）は検索結果に書いてあることだけを書く。facts の各項目には根拠にした検索結果の URL を入れる。
- 確認できない項目は null か空配列にする。推測で埋めない。facts は少なくてよい。
- 渡した iTunes の年はこの音源の発売年。原曲の年と違うときは year_note に理由を書く。
- SNS で広まったのが sped up 版やリミックスなど原曲以外なら viral_version に書く。
- floor_tip は「どこを使うと沸くか」。SNS で使われたパートなど、出典で裏付けられることだけ書く。「サビで盛り上げる」のような、どの曲にも言えることは書かない。
- mix_hint は、この曲へ繋ぎ入れるときの具体的な助言（ドラムだけのイントロが長い、アカペラで始まる、など）。確かなことが無ければ null。一般論は書かない。
- 文章は日本語、短く。`;

/** 出典の照合に使う形。末尾のスラッシュ・www・#・utm_ の違いは同じ URL とみなす。 */
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    [...x.searchParams.keys()].filter((k) => k.startsWith('utm_')).forEach((k) => x.searchParams.delete(k));
    return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search).toLowerCase();
  } catch {
    return '';
  }
}

/** 画面でリンクにする URL。http(s) 以外は捨てる。 */
function linkUrl(v) {
  const raw = clean(v, LIMITS.url);
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

/** Responses API の応答から、出典を照合したカードを作る。検索していなければ失敗にする。 */
function buildSongCard(d) {
  const output = Array.isArray(d && d.output) ? d.output : [];
  const searches = output.filter((o) => o && o.type === 'web_search_call');
  if (!searches.length) throw new Error('検索が実行されませんでした');

  const sources = new Set();
  for (const s of searches) {
    for (const src of (s.action && s.action.sources) || []) if (src && src.url) sources.add(normUrl(src.url));
  }
  const msg = output.find((o) => o && o.type === 'message');
  const part = msg && Array.isArray(msg.content) ? msg.content.find((c) => c && c.type === 'output_text') : null;
  for (const a of (part && part.annotations) || []) if (a && a.url) sources.add(normUrl(a.url));
  sources.delete('');

  let raw;
  try {
    raw = JSON.parse(part ? part.text : '');
  } catch {
    throw new Error('応答を JSON として読めませんでした');
  }

  const verified = (u) => !!linkUrl(u) && sources.has(normUrl(u));
  const allFacts = Array.isArray(raw.facts) ? raw.facts : [];
  const facts = allFacts
    .filter((f) => f && verified(f.source_url) && clean(f.text, 80))
    .slice(0, 4)
    .map((f) => ({
      kind: INFO_KINDS.includes(f.kind) ? f.kind : 'other',
      text: clean(f.text, 80),
      url: linkUrl(f.source_url),
    }));
  const year = Number(raw.original_year);
  const originalYear = Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
  const tipOk = verified(raw.floor_tip_source);

  return {
    identified: !!raw.identified,
    originalYear,
    yearNote: originalYear ? clean(raw.year_note, 80) : '',
    facts,
    // 「どの版が流行ったか」は出典を持たない項目なので、流行の事実が残ったときだけ出す
    viralVersion: facts.some((f) => f.kind === 'viral') ? clean(raw.viral_version, 60) : '',
    floorTip: tipOk ? clean(raw.floor_tip, 80) : '',
    floorTipUrl: tipOk ? linkUrl(raw.floor_tip_source) : '',
    // 出典の無い見立て。ブースでは「AI の見立て」として事実と分けて出す
    mixHint: clean(raw.mix_hint, 80),
    dropped: allFacts.length - facts.length,
    sources: sources.size,
    at: new Date().toISOString(),
  };
}

async function requestSongInfo(env, song, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SONG_INFO.model,
        reasoning: { effort: SONG_INFO.reasoning },
        tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' } }],
        // 検索を任意にすると、知っているつもりの曲で検索を飛ばして記憶で書く
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        instructions: SONG_INFO_INSTRUCTIONS,
        input: '曲の情報（iTunes JP）:\n' + JSON.stringify({
          title: song.title,
          artist: song.artist,
          artistEn: song.artistEn || undefined,
          album: song.album || undefined,
          genre: song.genre || undefined,
          releaseYear: song.releaseYear || undefined,
          durationSec: song.durationMs ? Math.round(song.durationMs / 1000) : undefined,
        }),
        text: { format: { type: 'json_schema', name: 'song_background', strict: true, schema: SONG_INFO_SCHEMA } },
        max_output_tokens: SONG_INFO.maxOutputTokens,
        store: false,
      }),
    });
    let d = null;
    try { d = await res.json(); } catch { /* JSON でないエラー応答 */ }
    if (!res.ok) {
      throw new Error('OpenAI ' + res.status + (d && d.error && d.error.message ? ': ' + d.error.message : ''));
    }
    return d;
  } finally {
    clearTimeout(timer);
  }
}

/** 生成の権利を取る。同じ曲を二重に作らない・1日の上限を越えない、を1文で判定する。
    force はブースの「作り直す」。できあがっているカードや、失敗を重ねた曲もやり直す。
    上限は行数ではなく attempts の合計で数える。行数だと、同じ曲の作り直しが何度でも1枚に見える
    （過去の日の attempts も混ざるので多めに数えるが、料金の歯止めとしてはそのほうが安全）。 */
async function claimSongInfo(env, trackId, force) {
  const r = await env.DB.prepare(
    `INSERT INTO song_info (track_id, status, attempts, updated_at)
     SELECT ?1, 'pending', 1, CURRENT_TIMESTAMP
      WHERE (SELECT COALESCE(SUM(attempts), 0) FROM song_info
              WHERE updated_at > datetime('now', '-1 day')) < ?2
     ON CONFLICT(track_id) DO UPDATE
        SET status = 'pending', attempts = song_info.attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE (song_info.status = 'pending' AND song_info.updated_at < datetime('now', ?3))
         OR (song_info.status = 'failed' AND (?4 OR song_info.attempts < ?5))
         OR (song_info.status = 'ok' AND ?4)`
  ).bind(trackId, SONG_INFO.dailyCap, `-${SONG_INFO.staleSec} seconds`, force ? 1 : 0, SONG_INFO.maxAttempts).run();
  return !!(r.meta && r.meta.changes > 0);
}

/** 失敗しても前のカードは残す（作り直しの失敗で、読めていた情報まで消さない）。 */
async function saveSongInfo(env, trackId, result) {
  const card = result.card ? JSON.stringify(result.card) : null;
  await env.DB.prepare(
    `UPDATE song_info
        SET status = CASE WHEN ?1 IS NOT NULL OR card IS NOT NULL THEN 'ok' ELSE 'failed' END,
            card = COALESCE(?1, card), model = ?2, error = ?3, updated_at = CURRENT_TIMESTAMP
      WHERE track_id = ?4`
  ).bind(card, SONG_INFO.model, result.error || '', trackId).run();
}

/** カードを作れる曲か。trackId はブラウザが送る値なので、Apple の数字の ID だけ通す。 */
const canDescribe = (env, song) => !!env.OPENAI_API_KEY && !song.isFree && !!appleTrackId(song.trackId);

/** ISO 8601 の長さ（"PT4M49S"）をミリ秒に。読めなければ 0 */
function isoDurationMs(v) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(v || ''));
  return m ? Math.round(((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000) : 0;
}

/** iTunes の lookup は、Apple の前段キャッシュ（Akamai）に載っている曲しか Workers に返さない。
    載っていない曲は Cloudflare の IP からだと 403 になる（2026-09-27 実測。未取得の6曲がすべて 403、
    同じ曲の Apple Music の曲ページはすべて 200）。このため背景カードが1枚も作れていなかった。
    User-Agent を変えても 403 は変わらない（同日実測）。
    iTunes が返さなかったときは、曲ページに埋め込まれた構造化データ（schema:song）から
    lookup と同じ形の値を組み立てる。別の曲のページを読まないよう、構造化データの URL の末尾の
    曲 ID も照合する。曲名かアーティストが取れないページは使わない（取り違えの元になる）。 */
async function songFromPage(trackId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch('https://music.apple.com/jp/song/' + encodeURIComponent(trackId),
      { headers: { Accept: 'text/html' }, signal: ac.signal });
    if (!r.ok) return null;
    const html = await r.text();
    const ld = /<script[^>]*\bid=["']?schema:song["']?[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!ld) return null;
    const song = JSON.parse(ld[1]);
    const rec = song.audio || {};
    const idOf = (u) => (/\/(\d+)(?:[?#]|$)/.exec(String(u || '')) || [])[1];
    if (idOf(rec.url || song.url) !== trackId) return null;
    const artists = [].concat(rec.byArtist || []).map((a) => a && a.name).filter(Boolean);
    if (!(rec.name || song.name) || !artists.length) return null;
    return {
      trackName: rec.name || song.name,
      artistName: artists.join(' & '),
      collectionName: rec.inAlbum && rec.inAlbum.name,
      primaryGenreName: [].concat(rec.genre || [])[0],
      releaseDate: rec.datePublished || song.datePublished,
      trackTimeMillis: isoDurationMs(rec.duration || song.timeRequired),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** trackId が本当にその曲の ID か、iTunes で引いて確かめる。trackId も曲名もブラウザが送る値なので、
    有名曲の ID に別の曲名（や、曲名欄に仕込んだ指示）を付けて送られると、取り違えたカードが
    その ID に保存され、イベントをまたいで出続ける。確かめたうえで、カードの入力も iTunes の値を使う。
    英語のアーティスト名は検索の手掛かりに US のストアからも引く（取れなくても構わない）。
    iTunes が返さなかった曲は Apple Music の曲ページで確かめる（songFromPage）。 */
async function lookupTrack(trackId, title) {
  const [jp, us] = await Promise.all([
    fetchJson('https://itunes.apple.com/lookup?country=JP&id=' + encodeURIComponent(trackId)),
    fetchJson('https://itunes.apple.com/lookup?country=US&id=' + encodeURIComponent(trackId)),
  ]);
  const pick = (d) => (d && Array.isArray(d.results) ? d.results.find((x) => x && String(x.trackId) === trackId) : null);
  const r = pick(jp) || await songFromPage(trackId);
  if (!r || !r.trackName) return null;
  const got = looseName(r.trackName), sent = looseName(title);
  if (!got || !sent || !(got.includes(sent) || sent.includes(got))) return null;
  const en = pick(us);
  return {
    trackId,
    title: clean(r.trackName, LIMITS.title),
    artist: clean(r.artistName, LIMITS.artist),
    artistEn: en && en.artistName !== r.artistName ? clean(en.artistName, LIMITS.artist) : '',
    album: clean(r.collectionName, LIMITS.album),
    genre: clean(r.primaryGenreName, 60),
    // iTunes も曲ページも ISO 形式だが、形が変わっても先頭の4桁を拾えるように
    releaseYear: Number((/\d{4}/.exec(String(r.releaseDate || '')) || [])[0]) || 0,
    durationMs: Number(r.trackTimeMillis) || 0,
  };
}

/** 権利を取れたら { promise } を返す。promise は OpenAI の応答を待ち、{ card } か { error } に解決する
    （D1 には書かず、投げない。保存は呼び出し側が saveSongInfo で行う）。取れなければ { skip: 理由 }。
    Promise をそのまま返さないのは、async 関数の戻り値に取り込まれて、呼び出し側の await が
    応答まで待ってしまうため（BPM の取得と並べられなくなる）。
    timeoutMs は呼んだ時点からの持ち時間。曲の照合（曲ページの取得は数秒かかる）に使ったぶんは
    OpenAI の待ち時間から引く。ctx.waitUntil の打ち切り（約30秒）を越えないように。
    残りが minWaitMs に満たなければ、権利を取らずに { skip: 'time' } を返す（取ってから打ち切られると、
    attempts と1日の上限だけ減って行が pending のまま残る）。 */
async function startSongInfo(env, song, { force = false, timeoutMs = SONG_INFO.timeoutMs } = {}) {
  const t0 = Date.now();
  if (!canDescribe(env, song)) return { skip: 'unavailable' };
  const real = await lookupTrack(String(song.trackId), song.title);
  if (!real) return { skip: 'lookup' };
  const left = timeoutMs - (Date.now() - t0);
  if (left < SONG_INFO.minWaitMs) return { skip: 'time' };
  if (!(await claimSongInfo(env, real.trackId, force))) return { skip: 'claim' };
  const promise = requestSongInfo(env, real, left)
    .then((d) => ({ card: buildSongCard(d) }))
    .catch((e) => ({ error: e && e.name === 'AbortError' ? '時間切れ' : String((e && e.message) || e).slice(0, 200) }));
  return { promise };
}

/** songs の行から、startSongInfo の照合に使う値だけを取り出す（中身は iTunes で引き直す） */
const songForInfo = (s) => ({ trackId: s.track_id, isFree: !!s.is_free, title: s.title });

/** 画面に出す形。pending のまま時間が経った行を failed に見せる読み替えは、adminSongs の SQL で行う。 */
function shapeInfo(s) {
  if (!s.info_status) return null;
  let card = null;
  try { card = s.info_card ? JSON.parse(s.info_card) : null; } catch { /* 壊れた行は無いものとする */ }
  return { status: s.info_status, card, error: s.info_error || '' };
}

/* ── 公開: 現在のイベント ───────────────── */
async function getEvent(env, cors) {
  const ev = await currentEvent(env);
  return json(ev && ev.status === 'open'
    ? { open: true, code: ev.code, title: ev.title, at: ev.created_at }
    : { open: false }, 200, cors);
}

/* ── 公開: 投稿 ─────────────────────────── */
async function postRequest(request, env, cors, ctx) {
  const ev = await currentEvent(env);
  if (!ev || ev.status !== 'open') {
    return json({ error: 'closed', message: 'ただいまリクエストの受付時間外です' }, 409, cors);
  }

  const body = await readJson(request);
  if (!body) {
    return json({ error: 'bad_request', message: '内容を読み取れませんでした' }, 400, cors);
  }

  const track = body.track || {};
  // 数字でない trackId は捨てて、曲名とアーティスト名でまとめる曲として扱う。
  // 残すと背景カードの対象に選ばれ続けて（describeMissing）、ほかの曲のカードが作られなくなる
  const trackId = appleTrackId(track.trackId);
  const isFree = !trackId && !track.title;
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

  // 判定と記録を1文で行う。同時投稿が SELECT をそろって通り、上限を越える隙を作らない。
  // 数えるのは requests ではなく post_log。requests は取り下げると行ごと消えるため。
  const logged = await env.DB.prepare(
    `INSERT INTO post_log (device_key)
     SELECT ?
      WHERE (SELECT COUNT(*) FROM post_log
              WHERE device_key = ? AND created_at > datetime('now', ?)) < ?`
  ).bind(deviceKey, deviceKey, `-${RATE_WINDOW_MIN} minutes`, RATE_MAX).run();
  if (!logged.meta || logged.meta.changes < 1) {
    return json({
      error: 'rate_limited',
      message: `リクエストは${RATE_WINDOW_MIN}分に${RATE_MAX}曲までです。少し時間をおいてください`,
    }, 429, cors);
  }

  const artist = clean(track.artist, LIMITS.artist);
  const key = dedupeKey(isFree ? { title } : { trackId, artist, title });
  const artistEn = clean(track.artistEn, LIMITS.artist);
  const durationMs = intIn(track.durationMs, 0, 3 * 60 * 60 * 1000);   // 3時間まで
  const name = clean(body.name, LIMITS.name);
  const message = clean(body.message, LIMITS.message);
  const artwork = trustedHttpsUrl(track.artwork, URL_DOMAINS.artwork);
  const appleUrl = trustedHttpsUrl(track.appleUrl, URL_DOMAINS.apple);
  const previewUrl = trustedHttpsUrl(track.previewUrl, URL_DOMAINS.preview);
  let editToken = newEditToken();

  /* 曲の作成・端末票の作成・集計を1つの batch にまとめる。曲IDをアプリ側で先に読むと、
     同じ曲の同時投稿や取り下げとの間に削除・重複作成の隙ができるため、SQL 内で曲を引く。 */
  const [songIns, requestIns] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO songs
         (event_code, dedupe_key, track_id, title, artist, artist_en, variant, album,
          duration_ms, artwork, apple_url, preview_url, is_free,
          genre, release_year, explicitness, votes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(event_code, dedupe_key) DO NOTHING`
    ).bind(
      ev.code, key,
      trackId || null,
      title,
      artist,
      artistEn,
      clean(track.variant, 80),
      clean(track.album, LIMITS.album),
      durationMs,
      artwork,
      appleUrl,
      previewUrl,
      isFree ? 1 : 0,
      clean(track.genre, 60),
      intIn(track.releaseYear, 1900, 2100),
      clean(track.explicitness, 20)
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO requests
         (song_id, event_code, from_name, message, ip_hash, device_key, edit_token)
       SELECT id, ?, ?, ?, ?, ?, ? FROM songs WHERE event_code = ? AND dedupe_key = ?`
    ).bind(ev.code, name, message, ipHash, deviceKey, editToken, ev.code, key),
    env.DB.prepare(
      `UPDATE songs
          SET votes = (SELECT COUNT(*) FROM requests WHERE requests.song_id = songs.id)
        WHERE event_code = ? AND dedupe_key = ?`
    ).bind(ev.code, key),
  ]);

  const song = await env.DB.prepare(
    `SELECT id FROM songs WHERE event_code = ? AND dedupe_key = ?`
  ).bind(ev.code, key).first();
  if (!song) throw new Error('song write did not persist');

  const isNewSong = !!(songIns.meta && songIns.meta.changes > 0);
  const added = !!(requestIns.meta && requestIns.meta.changes > 0);
  // 送り直しで書いたニックネーム・ひとことを、前の投稿に反映できたか。
  // updated = 差し替えた / locked = DJ が触ったあとなので差し替えなかった
  let updated = false, locked = false;
  if (!added) {
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

    // 送り直した人は、いま書いた内容を届けたいはず。黙って捨てずに前の投稿へ入れる。
    // 空欄の項目は前の値を残す（ひとことだけ書き足した人の名前を消さない）。
    // 修正（patchMine）と同じく、受付中で DJ がまだ触っていない曲だけ。
    // 冒頭の確認後にも状態は変わりうるため、実際の UPDATE でも確かめる
    if (row && (name || message)) {
      // 状態を読んでから書くと、その間に DJ が曲を確認したり受付を閉じたりできてしまう。
      // open + pending の判定を UPDATE 自体に入れ、ロック後の内容を競合で書き換えない。
      const changed = await env.DB.prepare(
        `UPDATE requests
            SET from_name = CASE WHEN ?1 <> '' THEN ?1 ELSE from_name END,
                message   = CASE WHEN ?2 <> '' THEN ?2 ELSE message END
          WHERE id = ?3
            AND EXISTS (
              SELECT 1 FROM songs s JOIN events e ON e.code = s.event_code
               WHERE s.id = requests.song_id
                 AND s.status = 'pending' AND e.status = 'open'
            )`
      ).bind(name, message, row.id).run();
      updated = !!(changed.meta && changed.meta.changes > 0);
      if (!updated) {
        const live = await env.DB.prepare(
          `SELECT 1 AS ok FROM events WHERE code = ? AND status = 'open'`
        ).bind(ev.code).first();
        if (!live) {
          return json({ error: 'closed', message: 'ただいまリクエストの受付時間外です' }, 409, cors);
        }
        locked = true;
      }
    }
  }

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE event_code = ?`
  ).bind(ev.code).first();

  // 後始末はここまでの D1 操作が終わってから始める。本体の書き込みと並行させると
  // D1 が競合してタイムアウトするので、後始末どうしも直列に流す。
  if (ctx) {
    const artistForLookup = artistEn || artist;
    ctx.waitUntil((async () => {
      // 連打の判定に効かなくなった元帳は捨てる。端末の鍵を必要以上に持たない。
      await env.DB.prepare(
        `DELETE FROM post_log WHERE created_at < datetime('now', ?)`
      ).bind(`-${RATE_KEEP_MIN} minutes`).run();
      if (isNewSong && !isFree) {
        // 背景カードは OpenAI の応答待ちが長いので、権利だけ先に取って BPM の取得と並べる。
        // D1 への書き込みは直列のまま（応答が届いてから保存する）。
        // 曲の中身は startSongInfo が iTunes で引き直すので、ここで渡すのは照合に使う ID と曲名だけ。
        const info = await startSongInfo(env, { trackId, isFree, title }).catch(() => null);
        await enrichSong(env, song.id, artistForLookup, title, durationMs, artist);
        if (info && info.promise) await saveSongInfo(env, trackId, await info.promise);
      }
    })());
  }

  return json({
    ok: true, songId: song.id, duplicate: !added, updated, locked,
    position: total ? total.n : 0, editToken,
  }, 200, cors);
}

/* 公開一覧・詳細に出す「最初に送った人」。別クエリで投稿を全件読む代わりに、
   曲の SELECT ごとに同じ規則で1件だけ拾う。idx_requests_song で song_id を引ける。 */
const FIRST_NAME_COL = `(SELECT r.from_name FROM requests r
  WHERE r.song_id = s.id AND r.from_name <> '' ORDER BY r.id ASC LIMIT 1) AS first_name`;
const BOARD_COLS = `s.id, s.title, s.artist, s.variant, s.artwork, s.is_free,
  s.votes, s.likes, s.played_at, s.status, ${FIRST_NAME_COL}`;

/* ── 公開: 曲の詳細 ─────────────────────────
   Authorization に鍵を添えると、その鍵が指す自分の投稿だけが一緒に返る。
   他人のひとことは誰が見ても返さない（/board と同じ方針）。 */
async function getSong(id, request, env, cors) {
  const s = await env.DB.prepare(
    `SELECT s.id, s.event_code, s.title, s.artist, s.variant, s.album, s.duration_ms,
            s.artwork, s.apple_url, s.preview_url, s.is_free, s.genre, s.release_year,
            s.explicitness, s.votes, s.likes, s.status, s.played_at, ${FIRST_NAME_COL}
       FROM songs s WHERE s.id = ?`
  ).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);

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
  const ev = await currentEvent(env);
  const live = !!ev && ev.status === 'open' && s.event_code === ev.code;
  const pending = s.status === 'pending';
  const editable = live && pending;

  // 終わった回の曲か。いいねを押せるのは「いちばん新しい回」だけなので
  // （setLike と同じ条件）、ボタンを出すかどうかの判断にそのまま使える。
  const past = !ev || s.event_code !== ev.code;

  return json({
    song: shapePublicSong(s, s.first_name, { detailed: true }),
    // queued か skipped かは外に出さない。畳んだ理由だけ closed / moved で伝える。
    editable,
    past,
    lock: editable ? '' : (live ? 'moved' : 'closed'),
    mine: own ? { name: own.from_name, message: own.message, at: own.created_at } : null,
  }, 200, cors);
}

const NOT_YOURS = {
  code: 'forbidden',
  message: 'この投稿は、送信したブラウザからのみ変更できます',
  status: 403,
};

const errorResponse = (error, cors) =>
  json({ error: error.code, message: error.message }, error.status, cors);

/** 修正・取り下げの共通チェック。曲・自分の投稿・DJ の進捗をまとめて見る。 */
async function ownRequest(id, token, env) {
  if (!token) return { error: NOT_YOURS };
  const s = await env.DB.prepare(`SELECT id, status FROM songs WHERE id = ?`).bind(id).first();
  if (!s) return { error: { code: 'not_found', message: 'この曲は見つかりませんでした', status: 404 } };
  const row = await env.DB.prepare(
    `SELECT id, event_code FROM requests WHERE song_id = ? AND edit_token = ?`
  ).bind(id, token).first();
  if (!row) return { error: NOT_YOURS };
  // 前回の鍵がブラウザに残っていても、終わった回には触らせない。
  // 履歴が後から書き換わったり、取り下げで曲ごと消えたりするのを防ぐ。
  const ev = await currentEvent(env);
  if (!ev || ev.status !== 'open' || row.event_code !== ev.code) {
    return { error: { code: 'closed', message: 'この回の受付は終了しているため、変更・取り下げはできません', status: 409 } };
  }
  if (s.status !== 'pending') {
    return { error: { code: 'locked', message: 'DJ がすでに確認しているため、変更・取り下げはできません', status: 409 } };
  }
  return { song: s, row };
}

/* ── 公開: 自分の投稿を直す ───────────────── */
async function patchMine(id, request, env, cors) {
  const body = await readJson(request) || {};
  const token = bearer(request);

  const got = await ownRequest(id, token, env);
  if (got.error) return errorResponse(got.error, cors);

  const name = clean(body.name, LIMITS.name);
  const message = clean(body.message, LIMITS.message);
  const changed = await env.DB.prepare(
    `UPDATE requests SET from_name = ?, message = ?
      WHERE song_id = ? AND edit_token = ?
        AND EXISTS (
          SELECT 1 FROM songs s JOIN events e ON e.code = s.event_code
           WHERE s.id = requests.song_id
             AND s.status = 'pending' AND e.status = 'open'
        )`
  ).bind(name, message, id, token).run();
  if (!changed.meta || changed.meta.changes < 1) {
    const now = await ownRequest(id, token, env);
    if (now.error) return errorResponse(now.error, cors);
    return json({ error: 'locked', message: '状態が変わったため、内容を変更できませんでした' }, 409, cors);
  }

  return json({ ok: true, mine: { name, message } }, 200, cors);
}

/* ── 公開: 自分の投稿を取り下げる ───────────
   取り下げるのは自分の1票だけ。同じ曲を他の人も送っていれば曲は残る。 */
async function deleteMine(id, request, env, cors) {
  const token = bearer(request);
  const got = await ownRequest(id, token, env);
  if (got.error) return errorResponse(got.error, cors);

  // 票の削除・再集計・空になった曲の後始末を不可分にし、同時投稿の票を消さない。
  // 最初の DELETE 自体でも open + pending を確かめ、事前確認との間に DJ が動かした曲を消さない。
  const [removed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM requests
        WHERE song_id = ? AND edit_token = ?
          AND EXISTS (
            SELECT 1 FROM songs s JOIN events e ON e.code = s.event_code
             WHERE s.id = requests.song_id
               AND s.status = 'pending' AND e.status = 'open'
          )`
    ).bind(id, token),
    env.DB.prepare(
      `UPDATE songs SET votes = (SELECT COUNT(*) FROM requests WHERE song_id = ?) WHERE id = ?`
    ).bind(id, id),
    env.DB.prepare(
      `DELETE FROM likes WHERE song_id = ? AND NOT EXISTS (SELECT 1 FROM requests WHERE song_id = ?)`
    ).bind(id, id),
    env.DB.prepare(
      `DELETE FROM songs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM requests WHERE song_id = ?)`
    ).bind(id, id),
  ]);
  if (!removed.meta || removed.meta.changes < 1) {
    const now = await ownRequest(id, token, env);
    if (now.error) return errorResponse(now.error, cors);
    return json({ error: 'locked', message: '状態が変わったため、リクエストを取り下げられませんでした' }, 409, cors);
  }
  const left = await env.DB.prepare(`SELECT votes FROM songs WHERE id = ?`).bind(id).first();
  const songRemoved = !left;
  const votes = left ? left.votes : 0;

  return json({ ok: true, votes, songRemoved }, 200, cors);
}

/* ── 公開: いいね ───────────────────────────
   誰の票かは device_key で見る。ブラウザが作る値なので作り直せば増やせるが、
   止めたいのは面白半分の連打で、そこは端末単位で十分に効く（votes と同じ考え）。

   押せるのは「いちばん新しい回」の曲だけ。受付が終わったあとも会場は続くので
   open は条件にしないが、前の回の記録が後から動くのは防ぐ。

   合計は songs.likes に持つ。引き算ではなく likes を数え直して書き戻すので、
   途中で失敗して値がずれても、次に誰かが押した時点で正しい数に戻る。 */
async function setLike(id, on, request, env, cors) {
  const body = await readJson(request) || {};
  const deviceKey = clean(body.device, 64);
  if (!deviceKey) {
    return json({ error: 'no_device', message: 'この端末ではいいねを押せません' }, 400, cors);
  }

  const s = await env.DB.prepare(`SELECT id, event_code FROM songs WHERE id = ?`).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);

  const current = await currentEvent(env);
  if (!current || s.event_code !== current.code) {
    return json({ error: 'closed', message: 'この回はもう終わっています' }, 409, cors);
  }

  const change = on
    ? env.DB.prepare(
      `INSERT OR IGNORE INTO likes (song_id, event_code, device_key)
       SELECT id, event_code, ? FROM songs WHERE id = ? AND event_code = ?`
    ).bind(deviceKey, id, s.event_code)
    : env.DB.prepare(`DELETE FROM likes WHERE song_id = ? AND device_key = ?`).bind(id, deviceKey);
  await env.DB.batch([
    change,
    env.DB.prepare(
      `UPDATE songs SET likes = (SELECT COUNT(*) FROM likes WHERE song_id = ?) WHERE id = ?`
    ).bind(id, id),
  ]);

  const n = await env.DB.prepare(`SELECT likes FROM songs WHERE id = ?`).bind(id).first();
  const likes = n ? n.likes : 0;

  return json({ ok: true, likes, liked: !!on && !!n }, 200, cors);
}

/* ── 公開: みんなのリクエスト ───────────────
   DJ の判断（queued / skipped）は外に出さない。played か否かと、
   DJ がもう触ったか（seen）だけ。seen は「まだ直せるか」を示すためのもので、
   採用か見送りかは区別できない。ひとことも返さない。UI で隠すのではなく、
   ここで返さないのが要点。 */

/** 公開画面に出す曲。詳細だけに必要な項目も同じ関数で足し、一覧との名前ずれを防ぐ。 */
const shapePublicSong = (s, firstName, { detailed = false } = {}) => ({
  id: s.id,
  title: s.title,
  artist: s.artist,
  variant: s.variant,
  ...(detailed ? { album: s.album, durationMs: s.duration_ms } : {}),
  // 過去に保存済みの行も、返す直前にもう一度検証する。
  artwork: trustedHttpsUrl(s.artwork, URL_DOMAINS.artwork),
  ...(detailed ? {
    appleUrl: trustedHttpsUrl(s.apple_url, URL_DOMAINS.apple),
    previewUrl: trustedHttpsUrl(s.preview_url, URL_DOMAINS.preview),
  } : {}),
  isFree: !!s.is_free,
  ...(detailed ? {
    genre: s.genre,
    releaseYear: s.release_year,
    explicitness: s.explicitness,
  } : {}),
  votes: s.votes,
  likes: s.likes || 0,
  playedAt: s.played_at,
  // 採用も見送りも同じ true。リクエストした側には「もう直せない」だけが伝わる。
  seen: s.status !== 'pending',
  by: firstName || '',
});

async function getBoard(env, cors) {
  const ev = await currentEvent(env);
  if (!ev) return json({ event: null, now: null, played: [], waiting: [] }, 200, cors);

  const [played, waiting] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${BOARD_COLS} FROM songs s
        WHERE s.event_code = ? AND s.status = 'played'
        ORDER BY s.played_at DESC, s.id DESC`
    ).bind(ev.code),
    env.DB.prepare(
      `SELECT ${BOARD_COLS} FROM songs s
        WHERE s.event_code = ? AND s.status <> 'played'
        ORDER BY s.votes DESC, s.id ASC LIMIT ?`
    ).bind(ev.code, BOARD_WAITING),
  ]);

  const shape = (s) => shapePublicSong(s, s.first_name);

  const p = played.results.map(shape);
  return json({
    event: { code: ev.code, title: ev.title, open: ev.status === 'open', at: ev.created_at },
    now: p[0] || null,
    played: p,
    waiting: waiting.results.map(shape),
  }, 200, cors);
}

/* ── 公開: 過去のイベント ───────────────────
   /board が返す「いまの回」は除く。曲が1曲もかかっていない回も出さない
   （中身が空の回を開かせても、来場者には何も分からないため）。 */
async function getPastEvents(env, cors) {
  const current = await currentEvent(env);

  const rows = await env.DB.prepare(
    `SELECT e.code, e.title, e.created_at, COUNT(s.id) AS played
       FROM events e
       JOIN songs s ON s.event_code = e.code AND s.status = 'played'
      WHERE e.code <> ?
      GROUP BY e.code, e.title, e.created_at
      ORDER BY e.created_at DESC
      LIMIT ?`
  ).bind(current ? current.code : '', PAST_EVENTS).all();

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
    `SELECT ${BOARD_COLS} FROM songs s
      WHERE s.event_code = ? AND s.status = 'played'
      ORDER BY s.played_at ASC, s.id ASC`
  ).bind(code).all();

  return json({
    event: { code: ev.code, title: ev.title, at: ev.created_at },
    played: played.results.map((s) => shapePublicSong(s, s.first_name)),
  }, 200, cors);
}

/* ── 管理: イベントの一覧 ───────────────────
   削除する回を選ぶための一覧。曲が1件も無い回も、いまの回も返す。
   公開側の /events とは別物で、あちらは「来場者に見せられる回」だけを返す。 */
async function adminEvents(env, cors) {
  const cur = await currentEvent(env);

  const rows = await env.DB.prepare(
    `SELECT e.code, e.title, e.status, e.created_at, e.closed_at,
            (SELECT COUNT(*) FROM songs s    WHERE s.event_code = e.code) AS songs,
            (SELECT COUNT(*) FROM songs s    WHERE s.event_code = e.code AND s.status = 'played') AS played,
            (SELECT COUNT(*) FROM requests r WHERE r.event_code = e.code) AS requests
       FROM events e
      ORDER BY e.created_at DESC`
  ).all();

  return json({
    events: rows.results.map((e) => ({
      code: e.code,
      title: e.title,
      open: e.status === 'open',
      at: e.created_at,
      closedAt: e.closed_at,
      songs: e.songs,
      played: e.played,
      requests: e.requests,
      // 消せるかどうかを決めるのはサーバ。ブースはこの答えをそのまま出すので、
      // 同じ規則が2か所に散らばらない。
      current: !!cur && e.code === cur.code,
    })),
  }, 200, cors);
}

/* ── 管理: 過去の回を消す ───────────────────
   曲・投稿・いいねをまとめて落とす。取り消せる操作ではないので、消せるのは
   終わった回だけにする。いまの回（受付中か、/board が映している最新の回）は
   対象外。開催中の記録が足元から消えると、来場者の画面もブースも破綻する。
   ほかのブースAPI と同じく鍵は掛けない。押し間違いの歯止めは、ブースで回のコードを打たせる確認だけ。 */
async function adminDeleteEvent(code, env, cors) {
  const ev = await env.DB.prepare(
    `SELECT code, title FROM events WHERE code = ?`
  ).bind(code).first();
  if (!ev) return json({ error: 'not_found', message: 'この回は見つかりませんでした' }, 404, cors);

  const cur = await currentEvent(env);
  if (cur && cur.code === code) {
    return json({
      error: 'current',
      message: 'いまの回は削除できません。新しい回を開始してから消してください',
    }, 409, cors);
  }

  // 消した件数は取り消しの代わりにならないが、何が落ちたかは伝える
  const n = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM songs    WHERE event_code = ?) AS songs,
            (SELECT COUNT(*) FROM requests WHERE event_code = ?) AS requests`
  ).bind(code, code).first();

  // likes → requests → songs → events の順。曲の行より先に子を落とす
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM likes    WHERE event_code = ?`).bind(code),
    env.DB.prepare(`DELETE FROM requests WHERE event_code = ?`).bind(code),
    env.DB.prepare(`DELETE FROM songs    WHERE event_code = ?`).bind(code),
    env.DB.prepare(`DELETE FROM events   WHERE code = ?`).bind(code),
  ]);

  return json({
    ok: true, code, title: ev.title,
    songs: n ? n.songs : 0, requests: n ? n.requests : 0,
  }, 200, cors);
}

/* ── 管理: まだ背景カードの無い曲を裏で作る ───────
   投稿時の生成は、iTunes の照合に落ちた・1日の上限に掛かった・機能より前に入った、などで
   カードが無いまま残ることがある。ブースは5秒ごとに一覧を読むので、そのついでに新しい曲から
   1曲ずつ作り始める（ブースは押さずに待っていれば出てくる）。1回に1曲なのは、ctx.waitUntil の
   持ち時間（約30秒）を1曲で使い切れるようにするため。次の曲は次の読み込みが並行して受け持つ。
   作るのはこれから掛けるかもしれない曲（新着・採用済）だけで、再生済・見送りの曲は作らない。
   失敗した曲をいつやり直すか（info_retry）は adminSongs の SQL が決める。
   同じ曲を二重に作らないのは claimSongInfo の役目。 */
async function describeMissing(env, rows) {
  if (!env.OPENAI_API_KEY) return;
  // canDescribe で作れない曲（数字でない trackId など）を選ぶと、startSongInfo が何も記録せずに戻るので
  // 毎回同じ曲を選び続け、それより前に入った曲のカードが作られなくなる。はじめから候補に入れない
  const s = rows.find((r) => (r.status === 'pending' || r.status === 'queued')
    && canDescribe(env, songForInfo(r)) && (!r.info_status || r.info_retry));
  if (!s) return;

  // 上限に達していたら照合もしない（5秒ごとに空振りの照合を重ねない）。判定の本番は claimSongInfo
  const used = await env.DB.prepare(
    `SELECT COALESCE(SUM(attempts), 0) AS n FROM song_info WHERE updated_at > datetime('now', '-1 day')`
  ).first();
  if (used && used.n >= SONG_INFO.dailyCap) return;

  const trackId = String(s.track_id);
  const r = await startSongInfo(env, songForInfo(s)).catch(() => null);
  if (r && r.promise) {
    await saveSongInfo(env, trackId, await r.promise);
  } else if (r && r.skip === 'lookup') {
    // 確かめられない曲は失敗の行を残し、確かめた時刻を更新する（残さないと5秒ごとに同じ照合を
    // 繰り返す）。やり直しは info_retry の間隔を空けてから。attempts は変えないので、
    // 照合だけの失敗は1日の上限にも自動のやり直し回数にも数えない
    await env.DB.prepare(
      `INSERT INTO song_info (track_id, status, attempts, error, updated_at)
       VALUES (?1, 'failed', 0, ?2, CURRENT_TIMESTAMP)
       ON CONFLICT(track_id) DO UPDATE SET status = 'failed', error = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE song_info.status <> 'ok'`
    ).bind(trackId, 'Apple Music のカタログで確かめられませんでした').run();
  }
}

/* ── 管理 ───────────────────────────────── */
async function adminSongs(env, cors, ctx) {
  const ev = await currentEvent(env);
  if (!ev) return json({ event: null, songs: [] }, 200, cors);

  // 背景カードは曲ごとの別表。pending のまま時間が経った行は途中で落ちたものなので failed に見せる
  const songs = await env.DB.prepare(
    `SELECT s.*,
            CASE WHEN i.status = 'pending' AND i.updated_at < datetime('now', ?1)
                 THEN 'failed' ELSE i.status END AS info_status,
            i.card AS info_card, i.error AS info_error,
            -- 自動でやり直してよいか（describeMissing が見る）。できあがった曲と、OpenAI の失敗が
            -- maxAttempts に達した曲は除く。待つ時間は、照合だけの失敗（attempts 0）なら lookupRetryMin、
            -- 途中で落ちた pending なら staleSec、OpenAI の失敗なら retrySec
            (i.status <> 'ok' AND i.attempts < ?4 AND i.updated_at < datetime('now',
               CASE WHEN i.attempts = 0 THEN ?2 WHEN i.status = 'pending' THEN ?1 ELSE ?3 END)) AS info_retry
       FROM songs s LEFT JOIN song_info i ON i.track_id = s.track_id
      WHERE s.event_code = ?5 ORDER BY s.id DESC`
  ).bind(`-${SONG_INFO.staleSec} seconds`, `-${SONG_INFO.lookupRetryMin} minutes`,
    `-${SONG_INFO.retrySec} seconds`, SONG_INFO.maxAttempts, ev.code).all();

  const voices = await env.DB.prepare(
    `SELECT song_id, from_name, message, created_at FROM requests
      WHERE event_code = ? ORDER BY id ASC`
  ).bind(ev.code).all();

  // 読み込みが済んでから始める（本体の読み書きと並べると D1 が詰まる）。失敗しても一覧は返す
  if (ctx) ctx.waitUntil(describeMissing(env, songs.results).catch(() => {}));

  const bySong = new Map();
  for (const v of voices.results) {
    if (!bySong.has(v.song_id)) bySong.set(v.song_id, []);
    bySong.get(v.song_id).push({ name: v.from_name, message: v.message, at: v.created_at });
  }

  return json({
    event: { code: ev.code, title: ev.title, open: ev.status === 'open' },
    songs: songs.results.map((s) => ({
      id: s.id,
      trackId: s.track_id,
      title: s.title,
      artist: s.artist,
      artistEn: s.artist_en,
      variant: s.variant,
      album: s.album,
      durationMs: s.duration_ms,
      artwork: trustedHttpsUrl(s.artwork, URL_DOMAINS.artwork),
      appleUrl: trustedHttpsUrl(s.apple_url, URL_DOMAINS.apple),
      previewUrl: trustedHttpsUrl(s.preview_url, URL_DOMAINS.preview),
      isFree: !!s.is_free,
      genre: s.genre || '',
      releaseYear: s.release_year || 0,
      explicitness: s.explicitness || '',
      bpm: s.bpm,
      songKey: s.song_key || '',
      camelot: s.camelot || '',
      bpmSrc: s.bpm_src || '',
      keySrc: s.key_src || '',
      info: shapeInfo(s),
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
  const body = await readJson(request) || {};
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
  const body = await readJson(request) || {};
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

/* ── 管理: 過去の回に戻す ───────────────────
   「新しいイベントを開始」は鍵なしで押せるので、押し間違いやいたずらで回が切り替わっても
   元の回へ戻せるようにする。指定した回を受付中にし、いま開いている回は締める。
   締めた回の曲・投稿・いいねはそのまま残るので、同じ操作でまた行き来できる。 */
async function adminReopenEvent(code, env, cors) {
  const ev = await env.DB.prepare(
    `SELECT code, title, status FROM events WHERE code = ?`
  ).bind(code).first();
  if (!ev) return json({ error: 'not_found', message: 'この回は見つかりませんでした' }, 404, cors);

  if (ev.status !== 'open') {
    // 新しい回を作るときと同じく「閉じてから開く」を1バッチで（open は部分ユニークで1件まで）
    await env.DB.batch([
      env.DB.prepare(`UPDATE events SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE status = 'open'`),
      env.DB.prepare(`UPDATE events SET status = 'open', closed_at = NULL WHERE code = ?`).bind(code),
    ]);
  }
  return json({ ok: true, code: ev.code, title: ev.title }, 200, cors);
}

async function adminToggleEvent(request, env, cors) {
  const body = await readJson(request) || {};
  const want = body.status === 'open' ? 'open' : 'closed';

  if (want === 'closed') {
    await env.DB.prepare(
      `UPDATE events SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE status = 'open'`
    ).run();
    return json({ ok: true, open: false }, 200, cors);
  }

  const current = await currentEvent(env);
  if (current && current.status === 'open') {
    return json({ ok: true, open: true, code: current.code }, 200, cors);
  }
  if (!current) return json({ error: 'no_event', message: 'イベントがまだありません' }, 409, cors);

  await env.DB.prepare(
    `UPDATE events SET status = 'open', closed_at = NULL WHERE code = ?`
  ).bind(current.code).run();
  return json({ ok: true, open: true, code: current.code }, 200, cors);
}

/* ── 管理: プレビューから推定した BPM・キー ─────
   ブースがブラウザの中で解析した値を受け取る。入れるのは空欄のときだけで、
   外部サービスの値は上書きしない（逆に、あとから外部サービスの値が届けばそちらが勝つ）。
   鍵なしの口だが、空欄を埋めることしかできないので、ほかの管理 API と同じ扱いにする。 */
async function adminPatchAnalysis(id, request, env, cors) {
  const body = await readJson(request) || {};
  const n = Number(body.bpm);
  const bpm = Number.isFinite(n) && n >= 40 && n <= 250 ? Math.round(n * 10) / 10 : null;
  const camelot = /^(1[0-2]|[1-9])[AB]$/.test(String(body.camelot || '')) ? String(body.camelot) : '';
  const songKey = camelot && /^[A-G][#b]?m?$/.test(String(body.songKey || '')) ? String(body.songKey) : '';
  if (!bpm && !camelot) {
    return json({ error: 'bad_request', message: '推定値が読み取れませんでした' }, 400, cors);
  }

  // SET の右辺はどれも更新前の値を見るので、判定の条件を各列で揃えて書ける
  const noKey = `(COALESCE(camelot, '') = '' AND COALESCE(song_key, '') = '')`;
  await env.DB.prepare(
    `UPDATE songs
        SET bpm      = CASE WHEN bpm IS NULL AND ?1 IS NOT NULL THEN ?1 ELSE bpm END,
            bpm_src  = CASE WHEN bpm IS NULL AND ?1 IS NOT NULL THEN 'est' ELSE bpm_src END,
            song_key = CASE WHEN ${noKey} AND ?2 <> '' THEN ?3 ELSE song_key END,
            camelot  = CASE WHEN ${noKey} AND ?2 <> '' THEN ?2 ELSE camelot END,
            key_src  = CASE WHEN ${noKey} AND ?2 <> '' THEN 'est' ELSE key_src END
      WHERE id = ?4`
  ).bind(bpm, camelot, songKey, id).run();

  const s = await env.DB.prepare(
    `SELECT bpm, bpm_src, song_key, camelot, key_src FROM songs WHERE id = ?`
  ).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);
  return json({
    ok: true, bpm: s.bpm, bpmSrc: s.bpm_src || '',
    songKey: s.song_key || '', camelot: s.camelot || '', keySrc: s.key_src || '',
  }, 200, cors);
}

/* ── 管理: 背景カードを作り直す ───────────────
   ほかのブースAPI と同じく鍵は掛けない。料金が掛かる操作なので、ループで叩かれても
   1日の生成数の上限（dailyCap。claimSongInfo が作り直しも1回と数える）で止まる。
   応答はリクエストの中で待つ（ブースは「調べています」を出して待つ）。 */
async function adminRefreshInfo(id, env, cors) {
  const s = await env.DB.prepare(`SELECT id, track_id, is_free, title FROM songs WHERE id = ?`).bind(id).first();
  if (!s) return json({ error: 'not_found', message: 'この曲は見つかりませんでした' }, 404, cors);
  const song = songForInfo(s);
  if (!canDescribe(env, song)) {
    return json({ error: 'unavailable', message: 'この曲は背景を調べられません（カタログ外の曲か、API キーが未設定です）' }, 400, cors);
  }

  const started = await startSongInfo(env, song, { force: true, timeoutMs: SONG_INFO.refreshTimeoutMs });
  if (started.skip === 'lookup') {
    return json({ error: 'lookup', message: 'Apple Music のカタログでこの曲を確かめられませんでした' }, 409, cors);
  }
  if (started.skip === 'time') {
    return json({ error: 'slow', message: '曲の確認に時間がかかりました。もう一度押してください' }, 504, cors);
  }
  if (!started.promise) {
    const row = await env.DB.prepare(`SELECT status FROM song_info WHERE track_id = ?`).bind(song.trackId).first();
    return row && row.status === 'pending'
      ? json({ error: 'busy', message: 'いま調べている最中です。少し待ってから開き直してください' }, 409, cors)
      : json({ error: 'limit', message: '今日調べられる曲数の上限に達しました' }, 429, cors);
  }
  const result = await started.promise;
  await saveSongInfo(env, song.trackId, result);

  const row = await env.DB.prepare(
    `SELECT status AS info_status, card AS info_card, error AS info_error FROM song_info WHERE track_id = ?`
  ).bind(song.trackId).first();
  return json({ ok: !result.error, info: row ? shapeInfo(row) : null, error: result.error || '' }, 200, cors);
}

/** BPM が空の曲（推定値しか無い曲も）をまとめて引き直す。API が落ちていた時の取りこぼし回収用。 */
async function adminEnrich(env, cors, ctx) {
  const ev = await currentEvent(env);
  if (!ev) return json({ ok: true, queued: 0 }, 200, cors);

  const { results } = await env.DB.prepare(
    `SELECT id, artist, artist_en, title, duration_ms FROM songs
      WHERE event_code = ? AND is_free = 0 AND (bpm IS NULL OR bpm_src = 'est')
      ORDER BY (bpm IS NULL) DESC, id DESC LIMIT 30`
  ).bind(ev.code).all();

  // 同時に大量の UPDATE を投げると D1 が詰まるので直列に流す
  if (ctx) {
    ctx.waitUntil((async () => {
      for (const r of results) {
        await enrichSong(env, r.id, r.artist_en || r.artist, r.title, r.duration_ms, r.artist);
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
    const fullPath = url.pathname.replace(/\/+$/, '');
    const path = fullPath.startsWith(API_BASE) ? (fullPath.slice(API_BASE.length) || '/') : '';
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // 状態を変更する操作（POST, PATCH, DELETE）はブラウザからのアクセスのみ通す（Origin 必須）。
    // GET は直アクセス等で Origin が付かない場合もあるため、付いている場合のみ検証する。
    const isWrite = ['POST', 'PATCH', 'DELETE'].includes(method);
    if (isWrite) {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: 'forbidden' }, 403, cors);
      }
    } else if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, cors);
    }

    try {
      if (path === '/event' && method === 'GET')     return await getEvent(env, cors);
      if (path === '/board' && method === 'GET')     return await getBoard(env, cors);
      if (path === '/events' && method === 'GET')    return await getPastEvents(env, cors);

      const past = path.match(/^\/events\/([0-9A-Za-z]{1,12})$/);
      if (past && method === 'GET') return await getPastBoard(past[1].toUpperCase(), env, cors);

      if (path === '/requests' && method === 'POST') return await postRequest(request, env, cors, ctx);

      const song = path.match(/^\/songs\/(\d+)$/);
      if (song && method === 'GET') return await getSong(Number(song[1]), request, env, cors);

      const own = path.match(/^\/songs\/(\d+)\/mine$/);
      if (own && method === 'PATCH')  return await patchMine(Number(own[1]), request, env, cors);
      if (own && method === 'DELETE') return await deleteMine(Number(own[1]), request, env, cors);

      const like = path.match(/^\/songs\/(\d+)\/like$/);
      if (like && method === 'POST')   return await setLike(Number(like[1]), true, request, env, cors);
      if (like && method === 'DELETE') return await setLike(Number(like[1]), false, request, env, cors);

      if (path === '/admin/songs' && method === 'GET')    return await adminSongs(env, cors, ctx);
      if (path === '/admin/enrich' && method === 'POST')  return await adminEnrich(env, cors, ctx);
      if (path === '/admin/event' && method === 'POST')   return await adminNewEvent(request, env, cors);
      if (path === '/admin/event' && method === 'PATCH')  return await adminToggleEvent(request, env, cors);
      if (path === '/admin/events' && method === 'GET')   return await adminEvents(env, cors);

      const adminEv = path.match(/^\/admin\/events\/([0-9A-Za-z]{1,12})$/);
      if (adminEv && method === 'DELETE') {
        return await adminDeleteEvent(adminEv[1].toUpperCase(), env, cors);
      }

      const reopen = path.match(/^\/admin\/events\/([0-9A-Za-z]{1,12})\/reopen$/);
      if (reopen && method === 'POST') return await adminReopenEvent(reopen[1].toUpperCase(), env, cors);

      const m = path.match(/^\/admin\/songs\/(\d+)$/);
      if (m && method === 'PATCH') return await adminPatchSong(Number(m[1]), request, env, cors);

      const an = path.match(/^\/admin\/songs\/(\d+)\/analysis$/);
      if (an && method === 'PATCH') return await adminPatchAnalysis(Number(an[1]), request, env, cors);

      const info = path.match(/^\/admin\/songs\/(\d+)\/info$/);
      if (info && method === 'POST') return await adminRefreshInfo(Number(info[1]), env, cors);

      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'internal', message: String(e && e.message || e).slice(0, 200) }, 500, cors);
    }
  },
};
