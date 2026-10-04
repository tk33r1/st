// 本番の問いと組立てを用いた実装前確認。キー・本文・応答本文は記録しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(['languages.js', 'personas.js', 'classification.js'].map(path => strip(read('workers/magi2/' + path))).join('\n')
  + '\nglobalThis.config = INTENT_CLASSIFY; globalThis.payload = classificationPayload;', ctx);
const cfg = ctx.config;
let key = process.env[cfg.key] || process.env.TYPESAFE_API_KEY;
if (!key) {
  try {
    const match = read('workers/magi2/.dev.vars').match(/^\s*MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m);
    key = match?.[1].replace(/^(['"])(.*)\1$/, '$2');
  } catch {}
}
if (!key || /^x+$|^sk-x+$/.test(key)) throw new Error('TypeSafeのキーが未設定です（環境変数または非追跡の .dev.vars）。');
const count = Number(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || 20);
assert(Number.isInteger(count) && count >= 20 && count <= 100, 'countは20〜100');
const cases = [
  { seed: 'Please help me think through a decision.', texts: ['おすすめの曲は？', '今夜ラーメンを食べに行くべき？'], language: 'en', intent: 'consult' },
  { seed: '判断材料を整理したいです。', texts: ['このサイトのツールを探したい', 'Which songs would you recommend for a DJ set?'], language: 'ja', intent: 'music' },
];
const reports = [];
for (const profile of ['first', 'continuing', 'dj-request', 'legacy']) {
  const times = [], usages = [];
  const n = ['first', 'continuing'].includes(profile) ? count : 2;
  for (let i = 0; i < n; i++) {
    const sample = cases[i % cases.length];
    const payload = ctx.payload({ profile: profile === 'first' || profile === 'continuing' ? 'chat' : profile,
      texts: sample.texts, seed: sample.seed, hasLanguage: profile === 'continuing' });
    const start = performance.now();
    const res = await fetch(cfg.endpoint, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(payload) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(profile + ': HTTP ' + res.status); }
    const body = await res.json();
    times.push(Math.round(performance.now() - start));
    for (const [name, question] of Object.entries(payload.questions)) {
      const answer = body.answers?.[name];
      assert(answer && Object.hasOwn(question.criteria, answer.choice), profile + ': invalid choice for ' + name);
      assert(typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1,
        profile + ': invalid confidence for ' + name);
    }
    if (['first', 'dj-request'].includes(profile)) assert.equal(body.answers.language.choice, sample.language, profile + ': language_seed reference');
    if (['first', 'continuing'].includes(profile)) assert.equal(body.answers.intent.choice, sample.intent, profile + ': latest_message reference');
    if (body.usage) usages.push(body.usage);
  }
  const ordered = [...times].sort((a, b) => a - b);
  const fraction = times.filter(t => t <= cfg.timeout_ms).length / n;
  const report = { profile, count: n, budget_ms: cfg.timeout_ms, within_budget: fraction,
    median_ms: ordered[Math.ceil(n / 2) - 1], p90_ms: ordered[Math.ceil(n * .9) - 1], times_ms: times, usage: usages };
  reports.push(report);
  console.log(JSON.stringify(report));
}
assert(reports.filter(r => ['first', 'continuing'].includes(r.profile)).every(r => r.within_budget >= .95), '時間予算内が95%未満です。設定を見直して再計測してください。');
console.log(JSON.stringify({ passed: true, date: new Date().toISOString().slice(0, 10), revision: cfg.revision, model: cfg.model.model }));
