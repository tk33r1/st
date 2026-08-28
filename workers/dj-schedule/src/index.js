// 白昼夢スケジュール調整 API
// route: tk.st/dj/api/*
//
// 白昼夢は毎月1回・日曜開催なので「月」がそのままイベント。
// 候補日は月から機械的に導けるため DB には持たず、回答とメモだけを保存する。
//
// ログイン無しの身内向けツール。ブラウザからのアクセスは Origin で、
// それ以外（curl 等）は CLIENT_API_KEY で絞る（comments worker と同方針）。
// 同一オリジンの GET は Origin ヘッダが飛ばないため、Origin 空も許可する。

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

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

// 月のデータ。DB に行が無くても「空の月」として成立する
async function loadMonth(env, ym) {
  const dates = sundaysOf(ym);
  const row = await env.DB.prepare(
    'SELECT memo, decided, blocked, updated_at FROM month_memos WHERE ym = ?'
  ).bind(ym).first();

  const { results } = await env.DB.prepare(
    'SELECT id, name, answers, comment, updated_at FROM month_responses WHERE ym = ? ORDER BY id ASC'
  ).bind(ym).all();

  // 候補日は月から導くので、月の日曜でなくなった値はここで落とす
  const decided = row && dates.includes(row.decided) ? row.decided : null;
  const blocked = row
    ? safeJsonParse(row.blocked, []).filter((d) => dates.includes(d) && d !== decided)
    : [];

  return {
    month: ym,
    dates,
    memo: row ? row.memo : '',
    decided,
    blocked,
    status_updated_at: row ? row.updated_at : null,
    responses: (results || []).map(rowToResponse),
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

    const path = url.pathname.replace(/\/+$/, '');

    try {
      // ---- 回答が入っている月の一覧（画面のショートカット用）----
      if (path === '/dj/api/months') {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed', { status: 405, headers: cors });
        }
        const { results } = await env.DB.prepare(
          `SELECT ym, COUNT(*) AS response_count, MAX(updated_at) AS updated_at
           FROM month_responses GROUP BY ym ORDER BY ym DESC LIMIT 24`
        ).all();
        return json(results || [], 200, cors);
      }

      // ---- /dj/api/months/:ym ----
      const monthMatch = path.match(/^\/dj\/api\/months\/(\d{4}-\d{2})$/);
      if (monthMatch) {
        const ym = monthMatch[1];
        if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);

        if (request.method === 'GET') {
          return json(await loadMonth(env, ym), 200, cors);
        }
        return new Response('Method Not Allowed', { status: 405, headers: cors });
      }

      // ---- /dj/api/months/:ym/memo ----
      const memoMatch = path.match(/^\/dj\/api\/months\/(\d{4}-\d{2})\/memo$/);
      if (memoMatch && request.method === 'PUT') {
        const ym = memoMatch[1];
        if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);

        const body = await readBody(request);
        if (!body) return json({ error: 'リクエストが不正です' }, 400, cors);

        const memo = cleanMultiline(body.memo, 500);
        // 確定日・開催不可日も同じ行に入っているので、空メモでも行は消さない
        await env.DB.prepare(
          `INSERT INTO month_memos (ym, memo) VALUES (?, ?)
           ON CONFLICT(ym) DO UPDATE SET memo = excluded.memo, updated_at = CURRENT_TIMESTAMP`
        ).bind(ym, memo).run();
        return json(await loadMonth(env, ym), 200, cors);
      }

      // ---- /dj/api/months/:ym/status ---- 確定した開催日と開催不可日
      const statusMatch = path.match(/^\/dj\/api\/months\/(\d{4}-\d{2})\/status$/);
      if (statusMatch && request.method === 'PUT') {
        const ym = statusMatch[1];
        if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);

        const body = await readBody(request);
        if (!body) return json({ error: 'リクエストが不正です' }, 400, cors);

        const dates = sundaysOf(ym);
        const decided = dates.includes(body.decided) ? body.decided : null;
        const blocked = Array.isArray(body.blocked)
          ? [...new Set(body.blocked.filter((d) => dates.includes(d) && d !== decided))].sort()
          : [];

        await env.DB.prepare(
          `INSERT INTO month_memos (ym, decided, blocked) VALUES (?, ?, ?)
           ON CONFLICT(ym) DO UPDATE SET decided = excluded.decided, blocked = excluded.blocked,
                                         updated_at = CURRENT_TIMESTAMP`
        ).bind(ym, decided, JSON.stringify(blocked)).run();

        return json(await loadMonth(env, ym), 200, cors);
      }

      // ---- /dj/api/months/:ym/responses ----
      const responsesMatch = path.match(/^\/dj\/api\/months\/(\d{4}-\d{2})\/responses$/);
      if (responsesMatch && request.method === 'POST') {
        const ym = responsesMatch[1];
        if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);

        const body = await readBody(request);
        if (!body) return json({ error: 'リクエストが不正です' }, 400, cors);

        const name = clean(body.name, 20);
        if (!name) return json({ error: '名前を入力してください' }, 400, cors);

        const answers = parseAnswers(body.answers, sundaysOf(ym));
        const comment = clean(body.comment, 200);

        const existing = await env.DB.prepare(
          'SELECT id FROM month_responses WHERE ym = ? AND name = ?'
        ).bind(ym, name).first();

        if (existing) {
          await env.DB.prepare(
            'UPDATE month_responses SET answers = ?, comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).bind(JSON.stringify(answers), comment, existing.id).run();
        } else {
          const counted = await env.DB.prepare(
            'SELECT COUNT(*) AS c FROM month_responses WHERE ym = ?'
          ).bind(ym).first();
          if ((counted?.c ?? 0) >= MAX_RESPONSES) {
            return json({ error: '回答数の上限に達しました' }, 400, cors);
          }
          await env.DB.prepare(
            'INSERT INTO month_responses (ym, name, answers, comment) VALUES (?, ?, ?, ?)'
          ).bind(ym, name, JSON.stringify(answers), comment).run();
        }

        return json(await loadMonth(env, ym), 200, cors);
      }

      // ---- /dj/api/months/:ym/responses/:responseId ----
      const oneResponse = path.match(/^\/dj\/api\/months\/(\d{4}-\d{2})\/responses\/(\d+)$/);
      if (oneResponse && request.method === 'DELETE') {
        const [, ym, responseId] = oneResponse;
        if (!isMonth(ym)) return json({ error: '対象の月が不正です' }, 400, cors);

        await env.DB.prepare('DELETE FROM month_responses WHERE id = ? AND ym = ?')
          .bind(Number(responseId), ym).run();
        return json(await loadMonth(env, ym), 200, cors);
      }

      return new Response('Not Found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: 'サーバー側でエラーが発生しました' }, 500, cors);
    }
  },
};
