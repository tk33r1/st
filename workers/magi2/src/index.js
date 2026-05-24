import { DEFAULTS, PERSONAS, PERSONA_TEMPERATURE, SYNTHESIZER, SYNTH_BIAS, TITLER } from '../personas.js';

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];
// Native app shells (Capacitor/Ionic) and local dev all serve from a localhost
// origin fixed by the WebView — not spoofable from another web page — so we trust
// them like tk.st. Covers http/https/capacitor/ionic schemes. The MAGI mobile app
// (magi-app/) runs on https://localhost (capacitor.config iosScheme/androidScheme).
const APP_ORIGIN_RE = /^(https?|capacitor|ionic):\/\/localhost(:\d+)?$/;
const isAllowedOrigin = (o) => ALLOWED_ORIGINS.includes(o) || APP_ORIGIN_RE.test(o);

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

// --- 統一エラー設計: stage 付きエンベロープ + request_id ---
const STAGES = ['auth', 'bad_request', 'rate_limit', 'persona_call', 'synthesizer_call', 'upstream', 'internal'];
function stageError(stage, code, message, extra = {}) {
  const e = new Error(message);
  e.envelope = { stage, code, message, ...extra };
  return e;
}
function toEnvelope(err, requestId) {
  if (err && err.envelope) return { ...err.envelope, request_id: requestId };
  return {
    stage: 'internal', code: 'internal_error', message: '内部エラーが発生しました',
    detail: String(err && err.message || err).slice(0, 200), request_id: requestId, retryable: false,
  };
}
function httpError(status, envelope, requestId, cors) {
  return new Response(JSON.stringify({ error: { ...envelope, request_id: requestId } }), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function callDeepSeek({ env, messages, cfg, stream, signal, temperature }) {
  return fetch(DEFAULTS.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: cfg.model,
      // 推論制御は公式仕様の thinking.type（enabled|disabled）で行う
      ...(cfg.thinking ? { thinking: cfg.thinking } : {}),
      // reasoning_effort は thinking 有効時のみ意味を持つ（high|max）
      ...(cfg.reasoning_effort ? { reasoning_effort: cfg.reasoning_effort } : {}),
      max_tokens: cfg.max_tokens,
      temperature: temperature != null ? temperature : DEFAULTS.temperature,
      top_p: DEFAULTS.top_p,
      stream: !!stream,
      messages,
    }),
    signal,
  });
}

// 1人格ぶんの呼び出し。空応答 / 5xx は1回だけ自動リトライ（リトライ後も不可なら致命）。
// temperature はテーマ依存の「揺らぎ」（未指定なら DEFAULTS.temperature）。
async function fetchPersonaText(env, p, messages, signal, log, round = 1, temperature) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callDeepSeek({
      env, cfg: DEFAULTS.models.persona, stream: false, signal, temperature,
      messages: [{ role: 'system', content: p.system_prompt }, ...messages],
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      log('persona_call', p.codename, `r${round}`, `HTTP ${res.status}`, `attempt=${attempt}`);
      if (res.status >= 500 && attempt < 2) continue; // 一時的なサーバ起因のみ再試行
      throw stageError('persona_call', `deepseek_http_${res.status}`, `${p.codename} への呼び出しが失敗しました (HTTP ${res.status})`, { persona: p.codename, round, detail, retryable: res.status >= 500 });
    }
    const choice = (await res.json()).choices?.[0] || {};
    const text = (choice.message?.content || '').trim();
    log('persona_call', p.codename, `r${round}`, `finish_reason=${choice.finish_reason}`, `len=${text.length}`, `attempt=${attempt}`);
    if (text) return text;
    if (attempt < 2) continue; // 空応答も1回だけ再試行
    throw stageError('persona_call', 'empty_persona_output', `${p.codename} が空の応答を返しました (finish_reason=${choice.finish_reason})`, { persona: p.codename, round, retryable: true });
  }
  // ループは attempt=2 で必ず return/throw に到達するためここには来ない（防御的）
  throw stageError('persona_call', 'unreachable', `${p.codename} の応答取得に失敗しました`, { persona: p.codename, round, retryable: true });
}

// 会話の初回ユーザー発言からチャットタイトルを要約生成（非クリティカル：失敗しても null）。
async function fetchTitle(env, lastUser, signal, log) {
  try {
    const res = await callDeepSeek({
      env, cfg: DEFAULTS.models.titler, stream: false, signal,
      messages: [{ role: 'system', content: TITLER.system_prompt }, { role: 'user', content: lastUser }],
    });
    if (!res.ok) { log('title_call', `HTTP ${res.status}`); return null; }
    const raw = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    // タイトルは1行・記号類を除去し、保険として長さを制限
    const clean = raw.replace(/[\r\n"'`「」『』]/g, '').trim().slice(0, 24);
    log('title_call', `len=${clean.length}`);
    return clean || null;
  } catch (e) {
    log('title_call', 'failed', e && e.message);
    return null;
  }
}

// 指定 ms でアボートするタイマ付き signal
function withTimeout(ms) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, ac, clear: () => clearTimeout(id) };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const requestId = crypto.randomUUID();
    const log = (...a) => console.log(requestId, ...a);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // --- リアクション保存: いいね/絵文字が付いたら request/response を DB に記録 ---
    if (request.method === 'POST' && url.pathname === '/magi2/react') {
      // chat と同じ認可（tk.st/localhost は Origin 許可、それ以外は x-api-key 必須）
      if (!isAllowedOrigin(origin)) {
        if (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
          log('auth', 'rejected (react)', origin);
          return httpError(401, { stage: 'auth', code: 'unauthorized', message: '許可されていない Origin です', retryable: false }, requestId, cors);
        }
      }
      let body;
      try { body = await request.json(); }
      catch (_) { return httpError(400, { stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false }, requestId, cors); }

      const op = body.op === 'remove' ? 'remove' : 'add';
      const target = typeof body.target === 'string' ? body.target.slice(0, 40) : '';
      if (!env.DB) {
        log('reaction', 'skipped (no DB binding)');
        return httpError(500, { stage: 'internal', code: 'no_db', message: 'DB binding がありません', retryable: false }, requestId, cors);
      }

      // 取り消し：登録時に返した行 ID で該当行のみ削除（target を保険のフィルタに）
      if (op === 'remove') {
        const id = Number(body.id);
        if (!target || !Number.isFinite(id)) {
          return httpError(400, { stage: 'bad_request', code: 'invalid_remove', message: 'target と id（数値）が必要です', retryable: false }, requestId, cors);
        }
        try {
          const res = await env.DB.prepare(`DELETE FROM reactions WHERE id = ?1 AND target = ?2`).bind(id, target).run();
          const deleted = (res.meta && res.meta.changes) || 0;
          log('reaction', 'removed', target, id, `changes=${deleted}`);
          return new Response(JSON.stringify({ ok: true, deleted, request_id: requestId }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
        } catch (err) {
          log('reaction', 'db_error (remove)', err.message);
          return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの取り消しに失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
        }
      }

      // 登録
      const reaction = typeof body.reaction === 'string' ? body.reaction.slice(0, 64) : '';
      const reqText = typeof body.request === 'string' ? body.request.slice(0, 8000) : '';
      const resText = typeof body.response === 'string' ? body.response.slice(0, 16000) : '';
      if (!target || !reaction || !resText) {
        return httpError(400, { stage: 'bad_request', code: 'invalid_reaction', message: 'target, reaction, response は必須です', retryable: false }, requestId, cors);
      }
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const res = await env.DB.prepare(
          `INSERT INTO reactions (created_at, ip, target, reaction, request, response) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(new Date().toISOString(), ip, target, reaction, reqText, resText).run();
        const id = res.meta && res.meta.last_row_id;
        log('reaction', target, reaction, `id=${id}`);
        return new Response(JSON.stringify({ ok: true, id, request_id: requestId }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (err) {
        log('reaction', 'db_error', err.message);
        return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの保存に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
      }
    }

    if (!(request.method === 'POST' && url.pathname === '/magi2/chat')) {
      return httpError(404, { stage: 'bad_request', code: 'not_found', message: 'Not Found', retryable: false }, requestId, cors);
    }

    // 1) auth: tk.st/localhost は Origin で許可、それ以外は x-api-key 必須
    if (!isAllowedOrigin(origin)) {
      if (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
        log('auth', 'rejected', origin);
        return httpError(401, {
          stage: 'auth', code: 'unauthorized',
          message: `許可されていない Origin です（許可: ${ALLOWED_ORIGINS.join(', ')}, localhost）。外部利用は x-api-key が必要です`,
          retryable: false,
        }, requestId, cors);
      }
    }

    // 2) bad_request: body 検証
    let messages;
    let theme = null; // 'light' | 'dark'：統合の揺らぎに使用
    try {
      const body = await request.json();
      messages = body && body.messages;
      theme = (body && (body.theme === 'light' || body.theme === 'dark')) ? body.theme : null;
      if (!Array.isArray(messages) || messages.length === 0) {
        throw stageError('bad_request', 'invalid_messages', 'messages は1件以上の配列が必要です', { retryable: false });
      }
      const ok = messages.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
      if (!ok) throw stageError('bad_request', 'invalid_message_shape', '各 message は {role:"user"|"assistant", content:string} 形式が必要です', { retryable: false });
      if (messages[messages.length - 1].role !== 'user') {
        throw stageError('bad_request', 'last_not_user', '最後の message は role:"user" である必要があります', { retryable: false });
      }
    } catch (err) {
      if (err.envelope) return httpError(400, err.envelope, requestId, cors);
      return httpError(400, { stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false }, requestId, cors);
    }
    // サーバ側でも防御的に trim
    if (messages.length > DEFAULTS.history_max_messages) messages = messages.slice(-DEFAULTS.history_max_messages);

    // 3) rate_limit: IP×UTC日次（DB 未設定の dev では skip）
    if (env.DB) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const day = new Date().toISOString().slice(0, 10);
        const row = await env.DB.prepare(
          `INSERT INTO rate_limit (ip, day, count) VALUES (?1, ?2, 1)
           ON CONFLICT(ip, day) DO UPDATE SET count = count + 1
           RETURNING count`
        ).bind(ip, day).first();
        const count = row && row.count || 1;
        log('rate_limit', ip, day, count);
        if (count > DEFAULTS.daily_limit) {
          return httpError(429, {
            stage: 'rate_limit', code: 'daily_limit_exceeded',
            message: `本日の利用上限（${DEFAULTS.daily_limit}回/日）に達しました`,
            retry_after_day: day, legacy_url: 'https://tk.st/magi/', retryable: false,
          }, requestId, cors);
        }
      } catch (err) {
        log('rate_limit', 'db_error', err.message);
        return httpError(500, { stage: 'internal', code: 'ratelimit_db_error', message: 'レート制限の記録に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
      }
    } else {
      log('rate_limit', 'skipped (no DB binding)');
    }

    // 4-5) SSE: 3人格（並列・1つでも失敗で即エラー）→ 統合（stream）
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event, data) => { if (closed) return; try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch (_) {} };
        const close = () => { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } };

        try {
          const history = messages.slice(0, -1);
          const lastUser = messages[messages.length - 1].content;

          // --- タイトル要約：会話の初回ユーザー発言時のみ、本流と並列で生成 ---
          let titlePromise = null;
          if (!history.some(m => m.role === 'assistant')) {
            const tt = withTimeout(DEFAULTS.timeouts.persona_ms);
            titlePromise = fetchTitle(env, lastUser, tt.signal, log)
              .then(t => { tt.clear(); if (t) send('title', { text: t }); })
              .catch(() => { tt.clear(); });
          }

          // 揺らぎ：3人格の temperature を UI テーマで変える（light=1.0 / dark=1.3、未指定は既定）
          const personaTemp = theme ? PERSONA_TEMPERATURE[theme] : undefined;
          if (personaTemp != null) log('persona_call', 'temperature', theme, personaTemp);

          // --- R1: 3人格が並列に初回意見（互いの意見は見ない）---
          log('persona_call', 'round1 start');
          const t1 = withTimeout(DEFAULTS.timeouts.persona_ms);
          let opinions;
          try {
            opinions = await Promise.all(PERSONAS.map(async (p) => {
              const text = await fetchPersonaText(env, p, messages, t1.signal, log, 1, personaTemp);
              send('persona', { round: 1, codename: p.codename, name: p.name, text });
              return { ...p, r1: text };
            }));
          } finally { t1.clear(); }
          log('persona_call', 'round1 ok');

          // --- R2: 各人格が他2人格のR1意見を踏まえて討議・更新 ---
          log('persona_call', 'round2 start');
          const t2 = withTimeout(DEFAULTS.timeouts.persona_ms);
          try {
            await Promise.all(opinions.map(async (p) => {
              const others = opinions.filter(o => o.codename !== p.codename)
                .map(o => `- ${o.name}（${o.codename}）: ${o.r1}`).join('\n');
              const dmsg = `${lastUser}\n\n[あなたの初回意見]\n${p.r1}\n\n[討議メモ：他の人格の初回意見は以下。これを踏まえ、賛同・反論・補強のいずれかで自分の考えを更新せよ。単なる繰り返しは避ける]\n${others}`;
              p.r2 = await fetchPersonaText(env, p, [...history, { role: 'user', content: dmsg }], t2.signal, log, 2, personaTemp);
              send('persona', { round: 2, codename: p.codename, name: p.name, text: p.r2 });
            }));
          } finally { t2.clear(); }
          log('persona_call', 'round2 ok');

          // --- 統合コール（thinking・stream）---
          const memo = opinions.map(o => `- ${o.name}（${o.codename}）\n  初回: ${o.r1}\n  討議後: ${o.r2}`).join('\n');
          const augmented = `${lastUser}\n\n[内部討議メモ：以下は3人格の初回意見と討議後の見解。これらを統合し、私(Shinya Takeda)として一人称で答える。人格名は出さない]\n${memo}`;
          // 揺らぎ：UI テーマに応じて優先人格を少し強める（light=Strategist / dark=Enthusiast）
          const bias = theme ? SYNTH_BIAS[theme] : null;
          if (bias) log('synthesizer_call', 'bias', theme);
          const synthMessages = [
            { role: 'system', content: SYNTHESIZER.system_prompt },
            ...(bias ? [{ role: 'system', content: bias }] : []),
            ...history,
            { role: 'user', content: augmented },
          ];

          const synthTimer = withTimeout(DEFAULTS.timeouts.synthesizer_ms);
          let synthRes;
          try {
            log('synthesizer_call', 'start');
            // 成功時は reader 完了後に clear。throw 時はここで確実に解除しておく
            synthRes = await callDeepSeek({ env, cfg: DEFAULTS.models.synthesizer, stream: true, signal: synthTimer.signal, messages: synthMessages });
          } catch (e) { synthTimer.clear(); throw e; }
          if (!synthRes.ok) {
            const detail = (await synthRes.text().catch(() => '')).slice(0, 200);
            synthTimer.clear();
            throw stageError('synthesizer_call', `deepseek_http_${synthRes.status}`, `統合人格の呼び出しが失敗しました (HTTP ${synthRes.status})`, { detail, retryable: synthRes.status >= 500 });
          }

          // DeepSeek の SSE をパースし、delta.content のみ中継（reasoning は出さない）
          const reader = synthRes.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                if (delta) send('integrated', { delta });
              } catch (_) { /* 部分行は次ループで再構成 */ }
            }
          }
          synthTimer.clear();
          log('synthesizer_call', 'ok');
          // 並列生成したタイトルが未送出なら送出を待つ（通常は既に完了）
          if (titlePromise) { try { await titlePromise; } catch (_) {} }
          send('done', { request_id: requestId });
          close();
        } catch (err) {
          // タイムアウト(AbortError)は upstream として表現
          if (err && err.name === 'AbortError') {
            const env2 = stageError('upstream', 'timeout', 'DeepSeek への応答がタイムアウトしました', { retryable: true });
            log('error', 'upstream', 'timeout');
            send('error', toEnvelope(env2, requestId));
          } else {
            const e = toEnvelope(err, requestId);
            log('error', e.stage, e.code, e.message);
            send('error', e);
          }
          close();
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Request-Id': requestId, ...cors },
    });
  },
};
