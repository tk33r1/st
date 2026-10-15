// 調整用の確定後の再測定を検査し、判定用へ進む根拠を別ファイルへ保存する。
// node .github/scripts/freeze-magi-a2-classification.mjs --report=<tune記録>
// 判定用の本文・結果は読まない。測定元を書き換えない。
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidate, contractHash, allCases, validateFixture} from './magi-a2-classification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = text => createHash('sha256').update(text).digest('hex');
const path = process.argv.find(a => a.startsWith('--report='))?.slice(9);
assert(path, '--report=<確定後のtune記録> is required');
const inputText = readFileSync(resolve(root, '.github/scripts/fixtures/magi-dialogue-a2-tune.json'), 'utf8');
const fixture = JSON.parse(inputText);
assert(validateFixture(fixture), 'reviewed tuning input required');
const sourceText = readFileSync(resolve(root, path), 'utf8'), report = JSON.parse(sourceText);
assert(report.split === 'tune' && report.complete && report.ready, 'completed reviewed tuning measurement required');
assert.equal(report.input_hash, hash(inputText), 'input changed since measurement');
assert.equal(report.contract_hash, contractHash, 'questions/thresholds/state changed since measurement');
assert.deepEqual(report.thresholds, candidate.min_confidence, 'thresholds must be selected before confirmation measurement');
const actual = report.results.filter(r => r.variant === 'candidate');
assert.equal(actual.length, allCases(fixture).length * 2, 'two full runs required');
const choice = (r, key) => r.answers[key]?.confidence >= candidate.min_confidence[key] ? r.answers[key].choice : null;
for (const run of [1, 2]) for (const c of allCases(fixture)) {
  const matches = actual.filter(r => r.run === run && r.id === c.id);
  assert.equal(matches.length, 1, 'missing or duplicate measurement');
  const r = matches[0];
  assert.deepEqual(r.expected, c.expected, 'expectation changed');
  assert.equal(choice(r, 'intent') || 'consult', c.expected.intent, 'tuning intent not correct');
  assert.equal(choice(r, 'fresh') || 'no', c.expected.fresh, 'tuning freshness not correct');
}
assert.equal(report.timing?.count, 30, '30 timing samples required');
assert(report.timing.p90_ms <= report.timing.budget_ms, 'classification time budget exceeded');
const record = {split: 'tune', complete: true, freeze_ready: true, frozen_at: new Date().toISOString(),
  decision_by: 'agent (承認済み調整用の2回の測定に基づく)', source_report: path, source_report_hash: hash(sourceText),
  contract_hash: contractHash, input_hash: report.input_hash,
  selected_thresholds: candidate.min_confidence, revision: candidate.revision,
  case_hashes: allCases(fixture).map(c => hash(c.text)), models: report.models, per_run: report.per_run, timing: report.timing,
  rationale: {intent: '既存の0.5を維持。相談・音楽の誤振り分け0、事実確認40/40、intent70/70を各2回確認。',
    fresh: '先行する調整用の分布から0.5を選定。曲案内へ限定した更新後も本体70件と音楽の境界5件を各2回確認。'},
  scope: 'classification-preflight-only; Worker品質・Web回答・本人採用の合格を意味しない'};
const dir = resolve(root, 'workers/.wrangler/magi2-dialogue-a2');
mkdirSync(dir, {recursive: true});
const output = resolve(dir, 'classification-freeze-' + record.frozen_at.replace(/[:.]/g, '-') + '.json');
writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({output, contract_hash: contractHash, selected_thresholds: record.selected_thresholds,
  models: record.models, freeze_ready: true}));
