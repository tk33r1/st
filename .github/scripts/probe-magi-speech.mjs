// 読み上げ検証計画§0.2: Fish Audio の声のモデルと無料版の応答を確かめる（実 API。費用 0）。
// node .github/scripts/probe-magi-speech.mjs model|tts|errors|all
// キーは環境変数 FISH_AUDIO_API_KEY。モデルは無料版の s2.1-pro-free だけを送り、ほかは拒否する。
// 公正利用を守るため、計画全体の読み上げの区切り（最大60）を Git 管理外の台帳で数え、超える要求は送らない。
// 結果と音声は Git 管理外の workers/.wrangler/magi2-speech/ に置く（公開リポジトリに入れない）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(root, 'workers/.wrangler/magi2-speech');
const ledgerPath = join(dir, 'ledger.json');
const API = 'https://api.fish.audio';
const MODEL = 's2.1-pro-free';
const VOICE = 'c9eb5405fa784e61ae9b3b22621e9f6f';
const LIMIT = 60;
const PLAN_STEP = '0.2';

// 個人の情報を含まない固定の文。文字数は計画§0.2 の表（120・300文字）に合わせる
const TEXTS = {
  ja120: 'MAGIは、三つの人格がそれぞれの考えを出し合い、最後に一人の答えとしてまとめる対話の仕組みです。今日は読み上げの声と速さ、区切りのつなぎ目を確かめるために、この短い文を読んでいます。少し長めの文でも自然に聞こえるでしょうか。',
  ja300: '読み上げの確認では、数字や日付、英単語の混じる文をどう読むかも大切です。たとえば、2026年10月22日の午後3時に、300文字の文を64kbpsのMP3で受け取るとします。区切りの最初は短くして、押してから音が出るまでの時間を短くし、二つ目からは少し長めにして、途切れずにつなげます。速さは速すぎず遅すぎず、聞き取りやすいことを優先します。見出しや箇条書きの記号は読まず、表は行ごとに列の名前と値を読みます。コードの塊は省略し、URLは読みません。最後に、文の終わりで自然に間が空くか、声の高さや調子が区切りの間で急に変わらないかを、耳で確かめます。',
  en300: 'MAGI is a conversation system in which three personas share their views before one integrated answer is written. This sentence checks how the voice sounds in English, how numbers such as 2026, 64 kbps and 3:00 p.m. are read,, and whether the pace feels natural.',
};

function ledger() {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { version: 1, limit: LIMIT, used: 0, entries: [] };
}
// 送る前に予約する。失敗しても減らさない（公正利用の数え方が分からないため、保守的に数える）
function reserve(parts, label) {
  const book = ledger();
  if (book.used + parts > book.limit) throw new Error(`ledger_exhausted: used ${book.used} + ${parts} > ${book.limit}`);
  book.used += parts;
  book.entries.push({ at: new Date().toISOString(), step: PLAN_STEP, label, parts });
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(book, null, 1));
}

async function timed(url, init) {
  const started = performance.now();
  const res = await fetch(url, init);
  let first = null, bytes = 0;
  const chunks = [];
  if (res.body) {
    for await (const chunk of res.body) {
      if (first === null) first = performance.now() - started;
      bytes += chunk.length; chunks.push(chunk);
    }
  }
  return { status: res.status, type: res.headers.get('content-type'), first_ms: first && Math.round(first),
    total_ms: Math.round(performance.now() - started), bytes, body: Buffer.concat(chunks) };
}

function tts(text, { key = process.env.FISH_AUDIO_API_KEY, voice = VOICE } = {}) {
  const model = MODEL;
  if (model !== 's2.1-pro-free') throw new Error('paid_model_refused');
  return timed(`${API}/v1/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model },
    body: JSON.stringify({ text, reference_id: voice, format: 'mp3', mp3_bitrate: 64, latency: 'balanced', normalize: true }),
  });
}

const errorBody = r => { try { return JSON.parse(r.body.toString('utf8')); } catch { return r.body.toString('utf8').slice(0, 300); } };

async function main(mode) {
  if (!process.env.FISH_AUDIO_API_KEY) throw new Error('FISH_AUDIO_API_KEY is not set');
  const out = join(dir, 'probe-' + new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  const results = { at: new Date().toISOString(), model: MODEL, voice: VOICE, mode, checks: [] };
  const record = (name, r, extra = {}) => {
    const { body, ...rest } = r;
    results.checks.push({ name, ...rest, ...extra });
    console.log(name, rest.status, rest.type, `first=${rest.first_ms}ms total=${rest.total_ms}ms bytes=${rest.bytes}`);
  };

  if (mode === 'model' || mode === 'all') {
    const r = await timed(`${API}/model/${VOICE}`, { headers: { Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}` } });
    const info = r.status === 200 ? JSON.parse(r.body.toString('utf8')) : errorBody(r);
    record('model', r, { state: info.state, visibility: info.visibility, title: info.title, languages: info.languages, error: r.status === 200 ? undefined : info });
  }
  if (mode === 'tts' || mode === 'all') {
    for (const [name, text] of [...Object.entries(TEXTS), ['ja120-repeat', TEXTS.ja120]]) {
      reserve(1, name);
      const r = await tts(text);
      if (r.status === 200) writeFileSync(join(out, name + '.mp3'), r.body);
      record('tts:' + name, r, { chars: [...text].length, utf8_bytes: Buffer.byteLength(text), error: r.status === 200 ? undefined : errorBody(r) });
    }
  }
  if (mode === 'errors' || mode === 'all') {
    // 認証の無い要求は無料枠に数えられないので、台帳に入れない
    const bad = await tts('test', { key: 'invalid-key-for-probe' });
    record('error:bad-key', bad, { error: errorBody(bad) });
    reserve(1, 'unknown-voice');
    const missing = await tts('test', { voice: '00000000000000000000000000000000' });
    record('error:unknown-voice', missing, { error: errorBody(missing) });
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
  console.log('saved', out, 'ledger', ledger().used, '/', LIMIT);
}

const mode = process.argv[2] || 'all';
if (!['model', 'tts', 'errors', 'all'].includes(mode)) { console.error('usage: probe-magi-speech.mjs model|tts|errors|all'); process.exit(2); }
main(mode).catch(err => { console.error(err.message); process.exit(1); });
