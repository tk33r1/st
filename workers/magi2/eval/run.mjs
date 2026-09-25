#!/usr/bin/env node
// MAGI（magi2）の答えが本人らしいかを測る評価スクリプト。
//
// 本人が自分の言葉で書いた答え（cases.json）と MAGI の統合人格の答えを、LLM の審査員に比べさせて
// 1〜5 で採点する。personas.js や人格カードを変えた前後で走らせ、点数の上下で良し悪しを判断する。
//
// - MAGI は本番を呼ばず、Worker のコード（src/index.js）をこの Node に読み込んで動かす。
//   本番の利用枠（IP×日次）を減らさず、デプロイ前の手元の変更をそのまま評価できる。
// - 人格カードは本番の URL ではなく手元の data/magi-context.json を使う（カードの変更も反映前に測れる）。
// - cases.json（本人の答え）と results/ は .gitignore 済み。公開リポジトリなのでコミットしない。
//
// 使い方（PowerShell）:
//   git pull   # 人格カードは bot が main に書き込むので、最新を取り込んでから測る
//   Copy-Item workers/magi2/eval/cases.example.json workers/magi2/eval/cases.json   # 初回のみ。答えを書く
//   $env:OPENAI_API_KEY = Read-Host -MaskInput 'OpenAI API key'   # または workers/magi2/.dev.vars に MAGI_OPENAI_API_KEY=...
//   node workers/magi2/eval/run.mjs [--runs 2] [--theme light|dark] [--only id1,id2] [--cases path]
//
// --runs: MAGI は temperature 1.0 前後で揺れるので、1問を何回答えさせて平均するか（既定 1）。
//         変更の前後を比べるときは 2〜3 にすると、偶然の上下に惑わされにくい。
// --theme: 本番の UI テーマ（light=戦略寄り / dark=衝動寄り）で統合の重み付けが変わる。既定は指定なし。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const RESULTS_DIR = join(HERE, 'results');
const JUDGE_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const CONCURRENCY = 3; // 1問あたり人格6回＋統合1回を呼ぶので、並列は控えめに

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const casesPath = opt('cases', join(HERE, 'cases.json'));
const runs = Math.max(1, Number(opt('runs', 1)) || 1);
const theme = opt('theme', null);
const only = opt('only', null)?.split(',');

const out = console.log.bind(console);
const die = (msg) => { console.error(`[ERROR] ${msg}`); process.exit(1); };

// キーは環境変数か、Worker の手元用シークレット（workers/magi2/.dev.vars。.gitignore 済み）の MAGI_OPENAI_API_KEY から取る
const devVarsKey = () => {
  try { return readFileSync(join(ROOT, 'workers/magi2/.dev.vars'), 'utf8').match(/^MAGI_OPENAI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1]; } catch { return ''; }
};
const apiKey = (process.env.OPENAI_API_KEY || devVarsKey() || '').trim();
if (!apiKey) die('OpenAI のキーが無い。OPENAI_API_KEY を設定するか、workers/magi2/.dev.vars に MAGI_OPENAI_API_KEY=... を書くこと');
if (!existsSync(casesPath)) die(`${casesPath} が無い。cases.example.json をコピーして本人の答えを書くこと`);
if (theme && theme !== 'light' && theme !== 'dark') die('--theme は light か dark');

const allCases = JSON.parse(readFileSync(casesPath, 'utf8')).cases;
const cases = allCases.filter(c => c.answer && c.answer.trim() && (!only || only.includes(c.id)));
const skipped = allCases.length - cases.length;
if (!cases.length) die('答えが書かれたケースが無い（answer が空のケースは飛ばす）');

// --- MAGI を手元で動かす準備 ---
// Worker は人格カードを本番の URL から取るので、その取得だけ手元の JSON に差し替える
const { PERSONA_CONTEXT } = await import(pathToFileURL(join(ROOT, 'workers/magi2/personas.js')));
const localCards = readFileSync(join(ROOT, 'data/magi-context.json'), 'utf8');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return url === PERSONA_CONTEXT.url ? Promise.resolve(new Response(localCards)) : realFetch(input, init);
};
const worker = (await import(pathToFileURL(join(ROOT, 'workers/magi2/src/index.js')))).default;
console.log = () => {}; // Worker のリクエストごとのログを黙らせる（結果は out で出す）

async function askMagi(question) {
  const pending = [];
  const res = await worker.fetch(new Request('https://workers.tk.st/magi2/chat', {
    method: 'POST',
    headers: { Origin: 'https://tk.st', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], ...(theme ? { theme } : {}) }),
  }), { MAGI_OPENAI_API_KEY: apiKey }, { waitUntil: p => pending.push(p) });
  const sse = await res.text();
  await Promise.all(pending);
  const personas = {};
  let integrated = '';
  for (const block of sse.split('\n\n')) {
    const m = block.match(/^event: (\w+)\ndata: (.*)$/s);
    if (!m) continue;
    const data = JSON.parse(m[2]);
    if (m[1] === 'persona') (personas[data.codename] ||= {})[`r${data.round}`] = data.text;
    if (m[1] === 'integrated') integrated += data.delta;
    if (m[1] === 'error') throw new Error(`MAGI: ${data.stage} ${data.code} ${data.message}`);
  }
  if (!integrated.trim()) throw new Error('MAGI の統合の答えが空');
  return { integrated: integrated.trim(), personas };
}

// --- 審査員 ---
const JUDGE_SYSTEM = `あなたは、ある人物（Shinya Takeda）の分身として動く対話 AI「MAGI」の答えが、本人らしいかを判定する審査員。
本人が同じ質問に自分で書いた答え（見本）と、本人が「自分なら言わない」と挙げた答え方を基準に、MAGI の答えを採点する。
MAGI は内部で3つの人格（MELCHIOR-1＝熱量・直感、BALTHASAR-2＝人間・哲学、CASPER-3＝合理・戦略）が討議し、それを統合して答える。

採点（各 1〜5 の整数。5 は本人の答えと同じと言える水準）:
- stance: 結論・立場が本人と一致しているか
- values: 理由づけや、大事にしている価値観が本人と一致しているか
- tone: 言葉づかい・温度感・語り口が本人らしいか
- overall: 本人が読んで「自分が言いそう」と思えるか（上3つの平均ではなく総合判断）
never_violations: 「言わないこと」に当てはまった項目を、与えられた文言のまま列挙（無ければ空配列）。違反があれば overall は 2 以下にする。
pulled_by: MAGI の答えを本人からずらした原因と思われる人格のコードネーム（内部の人格の意見を見て判断。ずれていない、または特定できなければ null）
comment: 本人とのずれの要点を60字以内で（ずれが無ければ一致している点）

次のキーを持つ JSON だけを出力する: stance, values, tone, overall, never_violations, pulled_by, comment`;

async function judge(c, magi) {
  const opinions = Object.entries(magi.personas).map(([k, v]) => `- ${k}: ${v.r2 || v.r1}`).join('\n');
  const user = [
    `【質問】\n${c.question}`,
    `【本人の答え】\n${c.answer}`,
    `【本人が言わないこと】\n${(c.never || []).map(n => `- ${n}`).join('\n') || '（指定なし）'}`,
    `【MAGI の答え】\n${magi.integrated}`,
    `【内部の3人格の意見（討議後）】\n${opinions}`,
  ].join('\n\n');
  for (let attempt = 1; ; attempt++) {
    const res = await realFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        // 採点は比較と判断なので推論させる（推論ありでは temperature を送れない）
        reasoning_effort: 'medium',
        max_completion_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
      }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, attempt * 5000)); continue; }
    if (!res.ok) throw new Error(`審査員 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const v = JSON.parse((await res.json()).choices[0].message.content);
    for (const k of ['stance', 'values', 'tone', 'overall']) {
      if (!Number.isInteger(v[k]) || v[k] < 1 || v[k] > 5) throw new Error(`審査員の ${k} が不正: ${v[k]}`);
    }
    return { ...v, never_violations: v.never_violations || [], pulled_by: v.pulled_by || null };
  }
}

// --- 実行 ---
const DIMS = ['overall', 'stance', 'values', 'tone'];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x) => x.toFixed(2);

async function evalCase(c) {
  const trials = [];
  for (let i = 0; i < runs; i++) {
    const magi = await askMagi(c.question);
    trials.push({ magi, judge: await judge(c, magi) });
  }
  const score = Object.fromEntries(DIMS.map(d => [d, mean(trials.map(t => t.judge[d]))]));
  return { id: c.id, question: c.question, tags: c.tags || [], score, trials };
}

out(`評価: ${cases.length} 問 × ${runs} 回${theme ? `（theme=${theme}）` : ''}${skipped ? `／答えが空の ${skipped} 問は飛ばす` : ''}`);
const results = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, async () => {
  while (next < cases.length) {
    const i = next++;
    try {
      results[i] = await evalCase(cases[i]);
      out(`  ${cases[i].id}: overall ${fmt(results[i].score.overall)}`);
    } catch (e) {
      results[i] = { id: cases[i].id, error: String(e.message || e) };
      out(`  ${cases[i].id}: 失敗 — ${results[i].error}`);
    }
  }
}));

// 直前の結果（同じ theme・runs）と比べる。変更の前後比較がこのスクリプトの本来の使い道
const prevFile = existsSync(RESULTS_DIR) && readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).sort().reverse()
  .find(f => { const p = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')); return p.theme === theme && p.runs === runs; });
const prev = prevFile ? JSON.parse(readFileSync(join(RESULTS_DIR, prevFile), 'utf8')) : null;
const prevById = Object.fromEntries((prev?.cases || []).filter(c => c.score).map(c => [c.id, c.score]));
const delta = (now, before) => before == null ? '' : ` (${now - before >= 0 ? '+' : ''}${fmt(now - before)})`;

const ok = results.filter(r => r.score);
out('\n問ごとの結果（overall / stance / values / tone、括弧内は前回との差）');
for (const r of ok) {
  const last = r.trials[r.trials.length - 1].judge;
  const ng = r.trials.flatMap(t => t.judge.never_violations);
  out(`- ${r.id}: ${DIMS.map(d => fmt(r.score[d])).join(' / ')}${delta(r.score.overall, prevById[r.id]?.overall)}`
    + `${ng.length ? `  言わないこと違反: ${[...new Set(ng)].join('、')}` : ''}`
    + `${last.pulled_by ? `  ずらした人格: ${last.pulled_by}` : ''}\n    ${last.comment}`);
}
const summary = Object.fromEntries(DIMS.map(d => [d, mean(ok.map(r => r.score[d]))]));
// 前回との比較は、両方で答えた問だけで平均を取る（問の増減で見かけの差が出ないように）
const common = ok.filter(r => prevById[r.id]);
out(`\n平均: ${DIMS.map(d => `${d} ${fmt(summary[d])}`).join(' / ')}`);
if (common.length) {
  out(`前回（${prevFile}）と共通の ${common.length} 問での overall: ${fmt(mean(common.map(r => prevById[r.id].overall)))} → ${fmt(mean(common.map(r => r.score.overall)))}`);
}
const failed = results.length - ok.length;
if (failed) out(`失敗: ${failed} 問（上の一覧を参照）`);

let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() + (execSync('git status --porcelain', { cwd: ROOT }).toString().trim() ? '+dirty' : ''); } catch {}
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(RESULTS_DIR, `${stamp}.json`);
writeFileSync(file, JSON.stringify({
  at: new Date().toISOString(), commit, theme, runs, judge_model: JUDGE_MODEL,
  cards_updated_at: Object.fromEntries(Object.entries(JSON.parse(localCards).personas).map(([k, v]) => [k, v.updated_at])),
  summary, cases: results,
}, null, 2));
out(`\n保存: ${file}`);
if (failed) process.exit(1);
