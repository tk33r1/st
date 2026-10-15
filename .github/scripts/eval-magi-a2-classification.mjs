// 計画§0.2の分類単体。本人の確認前は--inspectのみ。本文・キーは表示しない。
// --run --input=<JSON>。判定用は調整済み記録--freeze=<JSON>が必要。
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {baselineConfig, candidate, contractHash, payloadFor, groups, allCases, validateFixture} from './magi-a2-classification.mjs';
import {paidEvaluationGate} from './magi-eval-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = path => readFileSync(resolve(root, path), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const inputPath = arg('input') || '.github/scripts/fixtures/magi-dialogue-a2-tune.json';
const inputText = read(inputPath), fixture = JSON.parse(inputText), ready = validateFixture(fixture);
const cases = allCases(fixture);
const metadata = {split: fixture.split, count: fixture.cases.length, boundary_count: fixture.boundary_cases.length, groups, ready, input_hash: hash(inputText),
  contract_hash: contractHash, revision: candidate.revision, thresholds: candidate.min_confidence,
  authored_by: fixture.authored_by, reviewed_by: fixture.reviewed_by, reviewed_at: fixture.reviewed_at};
if (process.argv.includes('--inspect')) {
  console.log(JSON.stringify({...metadata, question_count: Object.keys(payloadFor(fixture.cases[0]).questions).length}));
  process.exit(0);
}
assert(process.argv.includes('--run'), 'use --inspect or --run');
assert(ready, '本人による文面・期待値・静的な正解の確認をreviewed_by/reviewed_atへ記録してから実行する');
const budget=paidEvaluationGate();
if (fixture.split === 'final') {
  assert(arg('freeze'), 'final requires --freeze=<確定後のtune記録>');
  const frozen = JSON.parse(read(arg('freeze')));
  assert(frozen.split === 'tune' && frozen.complete && frozen.freeze_ready, 'tuning must be complete and confirmed');
  assert.equal(frozen.contract_hash, contractHash, '問い・閾値・材料は調整後に変更しない');
  assert.notEqual(frozen.input_hash, metadata.input_hash, 'separate final input is required');
  assert(Array.isArray(frozen.case_hashes) && frozen.case_hashes.length === 75, 'tuning text hashes required');
  assert(cases.every(c => !frozen.case_hashes.includes(hash(c.text))), 'final cannot reuse tuning input');
}
let vars = '';
try {vars = read('workers/magi2/.dev.vars');} catch {}
const key = process.env[baselineConfig.key] || process.env.TYPESAFE_API_KEY
  || vars.match(/^\s*MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
assert(key, 'TypeSafe key is required');
const dir = resolve(root, 'workers/.wrangler/magi2-dialogue-a2');
mkdirSync(dir, {recursive: true});
const output = resolve(dir, 'classification-' + fixture.split + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
const report = {...metadata, date: new Date().toISOString(),
  evaluator_hash: hash(read('.github/scripts/eval-magi-a2-classification.mjs')),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  case_hashes: cases.map(c => hash(c.text)), complete: false, freeze_ready: false, results: []};
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const ordinary = fixture.cases.filter(c => c.group !== 'clarification');
const tasks = [1, 2].flatMap(run => cases.flatMap(c => [
  {run, c, variant: 'candidate'},
  ...(fixture.split === 'tune' ? [{run, c, variant: c.clarification ? 'without-clarification' : 'baseline'}] : []),
]));
if (fixture.split === 'tune') for (let i = 0; i < 30; i++) tasks.push({run: i + 1, c: ordinary[i], variant: 'timing-six'});
persist();
try {
  for (const {run, c, variant} of tasks) {
    const payload = payloadFor(c, {baseline: variant === 'baseline', withoutClarification: variant === 'without-clarification'});
    const started = performance.now();
    budget.reserve('typesafe',payload);
    const res = await fetch(baselineConfig.endpoint, {method: 'POST', signal: AbortSignal.timeout(5000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key}, body: JSON.stringify(payload)});
    assert.equal(res.status, 200, 'Jev HTTP ' + res.status);
    const value = await res.json();
    assert(typeof value.model === 'string' && value.model, 'actual Jev model version required');
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([name, q]) => {
      const a = value.answers?.[name];
      return [name, a && a.type === q.type && Object.hasOwn(q.criteria, a.choice)
        && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1
        ? {choice: a.choice, confidence: a.confidence} : null];
    }));
    report.results.push({run, id: c.id, group: c.group, expected: c.expected, variant,
      model: value.model, usage: value.usage, question_count: Object.keys(payload.questions).length,
      elapsed_ms: Math.round(performance.now() - started), answers});
    persist();
    if (report.results.length % 20 === 0) console.log(JSON.stringify({completed: report.results.length, total: tasks.length}));
  }
  const accepted = (r, name, threshold) => r.answers[name]?.confidence >= threshold ? r.answers[name].choice : null;
  const intent = (r, t = candidate.min_confidence.intent) => accepted(r, 'intent', t) || 'consult';
  const fresh = (r, t = candidate.min_confidence.fresh) => accepted(r, 'fresh', t) || 'no';
  const rows = report.results.filter(r => r.variant === 'candidate');
  report.per_run = [1, 2].map(run => {
    const actual = rows.filter(r => r.run === run && r.group !== 'music-boundary'), facts = actual.filter(r => ['stable', 'fresh', 'site'].includes(r.group));
    const boundary = rows.filter(r => r.run === run && r.group === 'music-boundary');
    const falseFacts = actual.filter(r => ['consult', 'music'].includes(r.group) && ['research', 'site'].includes(intent(r)));
    const matchedFacts = facts.filter(r => ['research', 'site'].includes(intent(r))).length;
    return {run, fact_route: matchedFacts, fact_count: facts.length, fact_route_rate: matchedFacts / facts.length,
      false_fact_route: falseFacts.length, intent_correct: actual.filter(r => intent(r) === r.expected.intent).length,
      fresh_correct: actual.filter(r => fresh(r) === r.expected.fresh).length,
      clarify_correct: actual.filter(r => r.group === 'clarification' && intent(r) === r.expected.intent && fresh(r) === r.expected.fresh).length,
      boundary_correct: boundary.filter(r => intent(r) === r.expected.intent && fresh(r) === r.expected.fresh).length,
      boundary_count: boundary.length};
  });
  report.variants = ['baseline', 'without-clarification'].map(variant => {
    const actual = report.results.filter(r => r.variant === variant);
    return {variant, count: actual.length, intent_correct: actual.filter(r => intent(r) === r.expected.intent).length,
      ...(variant === 'without-clarification' ? {fresh_correct: actual.filter(r => fresh(r) === r.expected.fresh).length} : {})};
  });
  report.fresh_thresholds = Array.from({length: 101}, (_, i) => {
    const threshold = i / 100;
    return {threshold, false_yes: rows.filter(r => r.expected.fresh === 'no' && fresh(r, threshold) === 'yes').length,
      detected_yes: rows.filter(r => r.expected.fresh === 'yes' && fresh(r, threshold) === 'yes').length,
      correct: rows.filter(r => fresh(r, threshold) === r.expected.fresh).length};
  });
  const timing = report.results.filter(r => r.variant === 'timing-six').map(r => r.elapsed_ms).sort((a, b) => a - b);
  report.timing = {count: timing.length, median_ms: timing[14] ?? null, p90_ms: timing[26] ?? null,
    budget_ms: baselineConfig.timeout_ms, within_budget: timing.filter(ms => ms <= baselineConfig.timeout_ms).length};
  report.models = [...new Set(report.results.map(r => r.model))];
  report.changed_cases = cases.filter(c => {
    const [a, b] = rows.filter(r => r.id === c.id);
    return intent(a) !== intent(b) || fresh(a) !== fresh(b);
  }).map(c => c.id);
  report.gate = report.per_run.every(r => r.fact_route_rate >= .9 && r.false_fact_route === 0 && r.boundary_correct === r.boundary_count);
  report.complete = true;
  // この段階の分類の合格だけでWorker品質や本人採用を完了にしない。
  // 閾値の選定は調整用の分布を本人と確認して記録する。自動freezeはしない。
  persist();
  console.log(JSON.stringify({output, complete: true, classification_gate: report.gate, per_run: report.per_run,
    timing: report.timing, models: report.models, freeze_ready: false}));
} catch (error) {
  report.failure = error.name;
  persist();
  console.error(JSON.stringify({output, complete: false, failure: error.name}));
  process.exitCode = 1;
}
