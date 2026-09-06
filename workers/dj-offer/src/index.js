/**
 * 出演オファー受付 Worker  —  tk.st/dj/api/offer/*
 *
 *   POST /dj/api/offer/send   オファーフォームの送信をメールで転送する
 *
 * DB は持たない。届いた内容はメールに載せてそのまま流すだけで、Worker 側には
 * 何も残さない。オファーは件数が知れているうえ、控えは受信箱に残るため、
 * D1 を足すと運用対象が増えるだけで得るものが無い。
 *
 * 宛先と差出人はコードにも wrangler.toml にも書かない（リポジトリは公開）。
 * OFFER_TO / OFFER_FROM を secret で渡す。contact/index.html が
 * 「アドレスそのものを URL にも HTML にも書かない」方針なのと同じ理由。
 *
 * スパム対策は Turnstile とハニーポットの二段。Turnstile はサーバー側で
 * siteverify を通すまで信用しない（クライアントのトークンは見た目だけなら
 * いくらでも作れる）。ハニーポットは人間には見えない入力欄で、埋まっていたら
 * 黙って成功を返す（弾いたと気付かせない）。
 *
 * レート制限は isolate のメモリだけで持つ best-effort。Cloudflare は isolate を
 * いくつも立てるので抜けられるが、止めたいのは連打とスクリプトの垂れ流しで、
 * 本命の Turnstile を抜けた先の保険として置いている。D1 も KV も足さない。
 *
 * 返信先には送信者のメールアドレスを Reply-To で載せる。From に載せると
 * ドメインが一致せず SPF/DKIM で落ちる。
 */

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

// 連打の抑止。オファーは1日に何通も来るものではないので枠は狭くてよい。
const RATE_WINDOW_MIN = 10;   // 直近この分数で
const RATE_MAX        = 3;    // 同じ IP から送れる件数
const RATE_KEEP_MIN   = 60;   // 元帳をこの分数だけ残す

// 入力欄ごとの上限。メール1通に収まる範囲で、書きたいことが切れない程度に取る。
const LIMITS = {
  name:    80,
  org:     80,
  email:   120,
  contact: 120,
  event:   120,
  date:    120,
  venue:   120,
  message: 2000,
};

// 機材の持ち込み。select の値はここにあるものだけ通す。
const GEAR_LABELS = {
  bring:  '持ち込み希望（機材・スピーカー一式）',
  venue:  '会場の常設機材を使用',
  unsure: '未定・相談したい',
};

/** IP ごとの送信履歴。isolate が生きている間だけ持つ。 */
const rateLog = new Map();

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/**
 * 制御文字を落として長さを詰める。改行だけは残す（相談内容が1行に潰れるため）。
 * コード内にエスケープ表記を持たせたくないのでコードポイントで判定する。
 */
function clean(v, max, keepBreaks = false) {
  const LF = 10;
  const CR = 13;
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0);
    if (c === CR) continue;                       // CRLF は LF に寄せる
    if (keepBreaks && c === LF) { out += ch; continue; }
    out += (c < 32 || c === 127) ? ' ' : ch;
  }
  // 3行以上の空行は詰める。コピペで貼られた署名などがそのまま伸びるのを防ぐ
  if (keepBreaks) out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim().slice(0, max);
}

/**
 * メールアドレスの体裁だけ見る。RFC どおりの検証はしない（正しくても届かない
 * アドレスはあるし、厳しくして正当な送信者を弾く方が損）。
 */
function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

/** ヘッダ注入の余地を残さない。件名に載せる文字列は必ずこれを通す。 */
function headerSafe(v, max) {
  return clean(v, max).replace(/[\r\n]/g, ' ');
}

/** 直近 RATE_WINDOW_MIN 分の件数を数え、超えていなければ1件積む。 */
function hitRateLimit(ip) {
  const now = Date.now();
  const keep = now - RATE_KEEP_MIN * 60_000;
  for (const [k, list] of rateLog) {
    const alive = list.filter((t) => t > keep);
    if (alive.length) rateLog.set(k, alive);
    else rateLog.delete(k);
  }
  const win = now - RATE_WINDOW_MIN * 60_000;
  const mine = (rateLog.get(ip) || []).filter((t) => t > win);
  if (mine.length >= RATE_MAX) return true;
  rateLog.set(ip, [...(rateLog.get(ip) || []), now]);
  return false;
}

/** Turnstile の siteverify。secret が無い環境では通さない（設定漏れを黙認しない）。 */
async function verifyTurnstile(token, ip, secret) {
  if (!secret) return { ok: false, reason: 'turnstile-secret-missing' };
  if (!token) return { ok: false, reason: 'turnstile-token-missing' };
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    return data.success ? { ok: true } : { ok: false, reason: (data['error-codes'] || []).join(',') };
  } catch (e) {
    return { ok: false, reason: 'turnstile-unreachable' };
  }
}

/** 本文。届いた側がそのまま読んで返信できる並びにする。 */
function buildMailText(f, meta) {
  const row = (label, value) => label + '：' + (value || '（未記入）');
  return [
    '人類踊狂計画（tk.st/dj/）の出演オファーフォームから送信がありました。',
    'この本文にそのまま返信すると送信者へ届きます。',
    '',
    '────────────────────────',
    row('お名前 / 団体名', f.name + (f.org ? '（' + f.org + '）' : '')),
    row('返信先メール', f.email),
    row('その他の連絡先', f.contact),
    '',
    row('イベント名', f.event),
    row('開催日時', f.date),
    row('会場', f.venue),
    row('機材', GEAR_LABELS[f.gear] || '（未選択）'),
    '',
    'ご相談内容：',
    f.message,
    '────────────────────────',
    '',
    '受信日時：' + meta.at,
    '送信元：' + meta.ua,
  ].join('\n');
}

/** Resend で送る。失敗はそのまま呼び出し元へ返し、握り潰さない。 */
async function sendMail(env, subject, text, replyTo) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.OFFER_FROM,
      to: [env.OFFER_TO],
      reply_to: replyTo,
      subject,
      text,
    }),
  });
  if (res.ok) return { ok: true };
  let detail = '';
  try { detail = JSON.stringify(await res.json()); } catch (e) { detail = String(res.status); }
  return { ok: false, status: res.status, detail };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== '/dj/api/offer/send') {
      return json({ error: 'not found' }, 404, cors);
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }
    // 同一オリジンの POST でも Origin は付く。付いていない＝ブラウザ以外なので通さない
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '送信内容を読み取れませんでした。' }, 400, cors);
    }

    // ハニーポット。人間には見えない欄なので、埋まっていれば機械。
    // 弾いたと分からせないため、成功と同じ応答を返す。
    if (clean(body.website, 100)) {
      return json({ ok: true }, 200, cors);
    }

    /*
     * 入力の検証を先に済ませる。レート制限と Turnstile より前に置くのは、
     * 書き間違いのやり直しで送信枠を潰さないため（Turnstile のトークンは
     * 使い捨てなので、検証を通してから弾くと引き直しも要る）。
     * ここで弾いた分はメールも外部リクエストも発生しないので、数え漏らしても損はない。
     */
    const f = {
      name:    clean(body.name, LIMITS.name),
      org:     clean(body.org, LIMITS.org),
      email:   clean(body.email, LIMITS.email),
      contact: clean(body.contact, LIMITS.contact),
      event:   clean(body.event, LIMITS.event),
      date:    clean(body.date, LIMITS.date),
      venue:   clean(body.venue, LIMITS.venue),
      gear:    Object.prototype.hasOwnProperty.call(GEAR_LABELS, body.gear) ? body.gear : '',
      message: clean(body.message, LIMITS.message, true),
    };

    if (!f.name)  return json({ error: 'お名前をご記入ください。' }, 400, cors);
    if (!f.email) return json({ error: '返信先のメールアドレスをご記入ください。' }, 400, cors);
    if (!looksLikeEmail(f.email)) {
      return json({ error: 'メールアドレスの形式をご確認ください。' }, 400, cors);
    }
    if (!f.message) return json({ error: 'ご相談内容をご記入ください。' }, 400, cors);

    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (hitRateLimit(ip)) {
      return json({ error: '送信が続いています。しばらく時間をおいてからお試しください。' }, 429, cors);
    }

    const verified = await verifyTurnstile(body.token, ip, env.TURNSTILE_SECRET_KEY);
    if (!verified.ok) {
      return json({ error: '認証を確認できませんでした。ページを再読み込みしてお試しください。' }, 403, cors);
    }

    if (!env.RESEND_API_KEY || !env.OFFER_TO || !env.OFFER_FROM) {
      // 設定漏れは送信者のせいではないので、内容は伝えず 500 で返す。
      // 代わりに、どれが欠けているかを wrangler tail 側へ出す（値は出さない）
      const missing = ['RESEND_API_KEY', 'OFFER_TO', 'OFFER_FROM'].filter((k) => !env[k]);
      console.log('secret missing:', missing.join(','));
      return json({ error: '送信処理を実行できませんでした。' }, 500, cors);
    }

    const at = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const text = buildMailText(f, { at, ua: headerSafe(request.headers.get('User-Agent') || '', 200) });
    const subject = '[DJ オファー] ' + headerSafe(f.name, 60) + (f.event ? ' / ' + headerSafe(f.event, 60) : '');

    const sent = await sendMail(env, subject, text, f.email);
    if (!sent.ok) {
      console.log('resend failed', sent.status, sent.detail);
      return json({ error: '送信に失敗しました。' }, 502, cors);
    }

    return json({ ok: true }, 200, cors);
  },
};
