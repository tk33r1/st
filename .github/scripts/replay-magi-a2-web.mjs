// 実測済み合成SSEだけを共通の引用の形へ読む。APIを呼ばない。
// node .github/scripts/replay-magi-a2-web.mjs --report=<--preflightの記録>
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {researchReader} from './magi-a2-research-stream.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reportPath = process.argv.find(a => a.startsWith('--report='))?.slice(9);
assert(reportPath, '--report is required');
const fullPath = resolve(root, reportPath), original = readFileSync(fullPath, 'utf8'), report = JSON.parse(original);
assert(report.complete && report.scope === 'verification-plan-0.3-first-five', 'completed preflight required');
const stamp = report.date.replace(/[:.]/g, '-'), dir = dirname(fullPath), outputs = [];
for (let i = 1; i <= 5; i++) for (const provider of ['openai', 'anthropic']) {
  const id = 'fresh-0' + i, raw = readFileSync(resolve(dir, `${provider}-${id}-${stamp}.sse`), 'utf8');
  let emitted = '';
  const reader = researchReader(provider, text => emitted += text);
  try {
    for (const frame of raw.replace(/\r/g, '').split('\n\n')) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') reader.push(JSON.parse(data));
    }
    outputs.push({id, provider, pass: true, ...reader.finish()});
  } catch (error) { outputs.push({id, provider, pass: false, code: error.code || error.name, before_text: !emitted.length}); }
}
const summary = outputs.map(o => ({id: o.id, provider: o.provider, pass: o.pass,
  ...(o.pass ? {chars: o.text.length, sources: o.sources.items.length, marks: o.sources.marks.length}
    : {code: o.code, before_text: o.before_text})}));
const output = resolve(dir, 'web-replay-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
writeFileSync(output, JSON.stringify({date: new Date().toISOString(), source_report: reportPath,
  source_report_hash: createHash('sha256').update(original).digest('hex'),
  adapter_hash: createHash('sha256').update(readFileSync(new URL('magi-a2-research-stream.mjs', import.meta.url))).digest('hex'),
  scope: 'recorded-synthetic-sse; actual-provider-fallback-not-executed', summary, outputs}, null, 2) + '\n');
console.log(JSON.stringify({output, summary}));
