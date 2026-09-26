// 白昼夢スケジュール調整 API
// route: tk.st/dj/api/schedule/*
//
// 白昼夢は毎月1回・日曜開催なので「月」がそのままイベント。
// 候補日は月から機械的に導けるため DB には持たず、月の状態・メモ・回答だけを保存する。
//
// ログイン無しの身内向けツール。アクセス制限は事実上かかっていない。
//
// 同一オリジンの GET には Origin ヘッダが飛ばないため `origin === ''` を許可しており、
// その結果ヘッダーを付けない curl も素通りする。CLIENT_API_KEY が効くのは
// 「Origin 付きで tk.st 以外から来たリクエスト」だけだが、それは JSON POST なら
// プリフライトの時点でブラウザが弾くので、キーの有無で挙動は変わらない。
// つまりこのページを守っているのは URL の非公開性と noindex だけ。
// 本気で絞るなら書き込み系で Origin を必須にするか、合言葉／ログインを足すこと。

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

// wrangler.toml の routes と対になるパスの接頭辞。ルートを変えたらここも変える
const BASE_PATH = '/dj/api/schedule';

const MAX_RESPONSES = 60;
const ANSWERS = new Set(['o', 't', 'x']); // ○ △ ×
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const CONTROL_CHARS_KEEP_LF = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f]', 'g');

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

// 表示側は textContent で描画するので、ここでは危険文字と制御文字を落とすだけ
function clean(value, maxLength) {
  return String(value ?? '')
    .replace(/[<>]/g, '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .slice(0, maxLength);
}

// メモだけは改行を残す（フロントは white-space: pre-wrap で表示）
function cleanMultiline(value, maxLength) {
  return String(value ?? '')
    .replace(/[<>]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_KEEP_LF, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

// 対象月は 2020-01 〜 2099-12 に限定（打ち間違いやクロールで無限に増やさないため）
function isMonth(ym) {
  if (typeof ym !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return false;
  const year = Number(ym.slice(0, 4));
  return year >= 2020 && year <= 2099;
}

// その月の日曜日を全部返す
function sundaysOf(ym) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7)) - 1;
  const out = [];
  const d = new Date(Date.UTC(year, month, 1));
  while (d.getUTCMonth() === month) {
    if (d.getUTCDay() === 0) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function parseAnswers(input, dates) {
  const out = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const date of dates) {
      const value = input[date];
      if (ANSWERS.has(value)) out[date] = value;
    }
  }
  return out;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToResponse(row) {
  return {
    id: row.id,
    name: row.name,
    answers: safeJsonParse(row.answers, {}),
    comment: row.comment,
    updated_at: row.updated_at,
  };
}

// month_memos の行から、確定日と開催不可日を取り出す。
// 候補日は月から導くので、月の日曜でなくなった値はここで落とす
function readStatus(row, dates) {
  const decided = row && dates.includes(row.decided) ? row.decided : null;
  const list = row ? safeJsonParse(row.blocked, []) : [];
  const blocked = Array.isArray(list) ? list.filter((d) => dates.includes(d) && d !== decided) : [];
  return { decided, blocked };
}

// 確定日と開催不可日が同じかを比べるための文字列（開催不可日の並び順と重複は問わない）
function statusKey(status) {
  const blocked = Array.isArray(status?.blocked) ? status.blocked : [];
  return `${status?.decided ?? ''}|${[...new Set(blocked)].sort().join(',')}`;
}

// 月のデータ。DB に行が無くても「空の月」として成立する。2本の SELECT は1往復で投げる
async function loadMonth(env, ym) {
  const dates = sundaysOf(ym);
  const [memo, responses] = await env.DB.batch([
    env.DB.prepare('SELECT memo, decided, blocked, updated_at FROM month_memos WHERE ym = ?').bind(ym),
    env.DB.prepare(
      'SELECT id, name, answers, comment, updated_at FROM month_responses WHERE ym = ? ORDER BY id ASC'
    ).bind(ym),
  ]);
  const row = memo.results?.[0] ?? null;
  const { decided, blocked } = readStatus(row, dates);

  return {
    month: ym,
    dates,
    memo: row ? row.memo : '',
    decided,
    blocked,
    status_updated_at: row ? row.updated_at : null,
    responses: (responses.results || []).map(rowToResponse),
  };
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

// /months/:ym 以下を1本で受ける。responses だけが末尾に :id を持てる
const MONTH_ROUTE = /^\/months\/(\d{4}-\d{2})(?:\/(memo|status|responses)(?:\/(\d+))?)?$/;

// 操作の失敗。400 はエラー文だけ、409 は画面を最新に戻せるよう月のデータも付けて返す
function fail(status, error) {
  return { status, error };
}

// /months/:ym 以下の操作。キーは「メソッド パス」。
// どれも成功したら最新の月データを返すので、ここでは失敗したときだけ fail() を返す
const MONTH_ACTIONS = {
  // 月のデータを返すだけ
  'GET /months/:ym': async () => {},

  // 外部クライアントとの互換性のため維持
  'PUT /months/:ym/memo': async (env, ym, body) => {
    const memo = cleanMultiline(body.memo, 500);
    // 確定日・開催不可日も同じ行に入っているので、空メモでも行は消さない
    await env.DB.prepare(
      `INSERT INTO month_memos (ym, memo) VALUES (?, ?)
       ON CONFLICT(ym) DO UPDATE SET memo = excluded.memo, updated_at = CURRENT_TIMESTAMP`
    ).bind(ym, memo).run();
  },

  // 確定した開催日と開催不可日。
  // base（画面が見ていた状態）が付いていれば、DB の状態がそれと同じときだけ書く。
  // 違えば、ほかの人が先に変えたということなので上書きせず 409 を返す。base が無ければ従来どおり上書き
  'PUT /months/:ym/status': async (env, ym, body) => {
    const dates = sundaysOf(ym);
    const decided = dates.includes(body.decided) ? body.decided : null;
    const blocked = Array.isArray(body.blocked)
      ? [...new Set(body.blocked.filter((d) => dates.includes(d) && d !== decided))].sort()
      : [];

    if (!body.base) {
      await env.DB.prepare(
        `INSERT INTO month_memos (ym, decided, blocked) VALUES (?, ?, ?)
         ON CONFLICT(ym) DO UPDATE SET decided = excluded.decided, blocked = excluded.blocked,
                                       updated_at = CURRENT_TIMESTAMP`
      ).bind(ym, decided, JSON.stringify(blocked)).run();
      return;
    }

    const conflict = fail(409, '開催日の設定がほかの画面で変更されています');
    const row = await env.DB.prepare('SELECT decided, blocked FROM month_memos WHERE ym = ?')
      .bind(ym).first();
    if (statusKey(readStatus(row, dates)) !== statusKey(body.base)) return conflict;

    // 読んでから書くまでの間に変わっていないことも、書くときの条件で確かめる
    const { meta } = row
      ? await env.DB.prepare(
        `UPDATE month_memos SET decided = ?, blocked = ?, updated_at = CURRENT_TIMESTAMP
         WHERE ym = ? AND decided IS ? AND blocked = ?`
      ).bind(decided, JSON.stringify(blocked), ym, row.decided, row.blocked).run()
      : await env.DB.prepare(
        'INSERT INTO month_memos (ym, decided, blocked) VALUES (?, ?, ?) ON CONFLICT(ym) DO NOTHING'
      ).bind(ym, decided, JSON.stringify(blocked)).run();
    if (!meta.changes) return conflict;
  },

  // 回答の登録・更新。(ym, name) が同じなら上書き。
  // 上限の確認と書き込みを1文にして、確認と書き込みの間に他の回答が割り込めないようにする
  'POST /months/:ym/responses': async (env, ym, body) => {
    const name = clean(body.name, 20);
    if (!name) return fail(400, '名前を入力してください');

    const answers = parseAnswers(body.answers, sundaysOf(ym));
    const comment = clean(body.comment, 200);

    const { meta } = await env.DB.prepare(
      `INSERT INTO month_responses (ym, name, answers, comment)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (SELECT 1 FROM month_responses WHERE ym = ?1 AND name = ?2)
          OR (SELECT COUNT(*) FROM month_responses WHERE ym = ?1) < ?5
       ON CONFLICT(ym, name) DO UPDATE SET
         answers = excluded.answers,
         comment = excluded.comment,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(ym, name, JSON.stringify(answers), comment, MAX_RESPONSES).run();
    if (!meta.changes) return fail(400, '回答数の上限に達しました');
  },

  'DELETE /months/:ym/responses/:id': async (env, ym, _body, id) => {
    await env.DB.prepare('DELETE FROM month_responses WHERE id = ? AND ym = ?')
      .bind(Number(id), ym).run();
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = getCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const fromSite = origin === '' || ALLOWED_ORIGINS.includes(origin);
    if (!fromSite && request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }

    // wrangler.toml のルート（tk.st/dj/api/schedule/*）に合わせてプレフィックスを剥がす
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith(BASE_PATH)) {
      return new Response('Not Found', { status: 404, headers: cors });
    }
    const route = path.slice(BASE_PATH.length) || '/';

    try {
      // ---- 回答が入っている月の一覧（外部クライアントとの互換性のため維持）----
      if (route === '/months') {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed', { status: 405, headers: cors });
        }
        const { results } = await env.DB.prepare(
          `SELECT ym, COUNT(*) AS response_count, MAX(updated_at) AS updated_at
           FROM month_responses GROUP BY ym ORDER BY ym DESC LIMIT 24`
        ).all();
        return json(results || [], 200, cors);
      }

      // ---- /months/:ym 以下 ----
      const monthMatch = route.match(MONTH_ROUTE);
      if (!monthMatch) return new Response('Not Found', { status: 404, headers: cors });

      const [, ym, sub, id] = monthMatch;
      const handler = MONTH_ACTIONS[
        `${request.method} /months/:ym${sub ? `/${sub}` : ''}${id ? '/:id' : ''}`
      ];
      // 月の下のパスは、受け付けていないメソッドなら 404。
      // /months/:ym だけは月を確かめてから 405 を返す
      if (!handler && sub) return new Response('Not Found', { status: 404, headers: cors });
      if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);
      if (!handler) return new Response('Method Not Allowed', { status: 405, headers: cors });

      let body = null;
      if (request.method === 'PUT' || request.method === 'POST') {
        body = await readBody(request);
        if (!body) return json({ error: 'リクエストが不正です' }, 400, cors);
      }

      const failed = await handler(env, ym, body, id);
      if (failed) {
        const month = failed.status === 409 ? await loadMonth(env, ym) : {};
        return json({ ...month, error: failed.error }, failed.status, cors);
      }
      return json(await loadMonth(env, ym), 200, cors);
    } catch (e) {
      // 利用者には一律の文言だけ返し、原因は wrangler tail で追えるようにログへ残す
      console.error('dj-schedule', request.method, url.pathname, e);
      return json({ error: 'サーバー側でエラーが発生しました' }, 500, cors);
    }
  },
};
