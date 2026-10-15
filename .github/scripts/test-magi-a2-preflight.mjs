// 評価前の確認ガードと、本番の契約を変えないことを外部APIなしで検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {baselineConfig, candidate, contractHash, payloadFor, allCases, validateFixture} from './magi-a2-classification.mjs';
const fixture = JSON.parse(readFileSync(new URL('fixtures/magi-dialogue-a2-tune.json', import.meta.url), 'utf8'));

test('本人確認前はreadyにならず、--runはAPIを呼ぶ前に拒否する', () => {
  const unreviewed = {...fixture, reviewed_by: null, reviewed_at: null};
  assert.equal(validateFixture(unreviewed), false);
  const temporary = mkdtempSync(join(tmpdir(), 'magi-a2-test-'));
  const input = join(temporary, 'unreviewed.json');
  try {
    writeFileSync(input, JSON.stringify(unreviewed));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('eval-magi-a2-classification.mjs', import.meta.url)), '--run', '--input=' + input], {encoding: 'utf8'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /本人による文面・期待値/);
  } finally { rmSync(input, {force: true}); rmdirSync(temporary); }
});

test('群の期待値を書き換えたデータと重複した入力を拒否する', () => {
  const wrong = structuredClone(fixture);
  wrong.cases[0].expected.intent = 'consult';
  assert.throws(() => validateFixture(wrong), /group expectation/);
  const duplicate = structuredClone(fixture);
  duplicate.cases[1].text = duplicate.cases[0].text;
  assert.throws(() => validateFixture(duplicate), /texts must be distinct/);
});

test('複数質問3件未満と不正な選択肢を拒否する', () => {
  const insufficient = structuredClone(fixture);
  for (const c of insufficient.cases.filter(c => c.clarification)) c.clarification.questions = c.clarification.questions.slice(0, 1);
  assert.throws(() => validateFixture(insufficient), /multi-question/);
  const wrong = structuredClone(fixture);
  wrong.cases.find(c => c.clarification).clarification.questions[0].options = ['東京', '東京'];
  assert.throws(() => validateFixture(wrong), /question\/options/);
});

test('候補の6問を組み立ててもA1の本番・旧契約の問いは変わらない', () => {
  const input = fixture.cases[0];
  const before = payloadFor(input, {baseline: true});
  const proposed = payloadFor(input);
  assert.equal(Object.keys(before.questions).length, 5);
  assert.equal(Object.keys(proposed.questions).length, 6);
  assert.equal(before.questions.fresh, undefined);
  assert.equal(before.questions.intent.criteria.research, undefined);
  assert.deepEqual(payloadFor(input, {baseline: true}), before);
  assert.equal(baselineConfig.min_confidence.malice, 0.55);
  assert.deepEqual(baselineConfig.profiles.legacy.questions, ['language']);
  for (const name of ['language', 'malice', 'votable', 'site_pages']) assert.deepEqual(proposed.questions[name], before.questions[name]);
});

test('正解や期待値をJevへ送らず、聞き返しの有無だけで対照を作る', () => {
  const c = fixture.cases.find(c => c.clarification);
  const withContext = payloadFor(c), without = payloadFor(c, {withoutClarification: true});
  assert.deepEqual(withContext.questions, without.questions);
  assert.deepEqual(withContext.state.clarification, c.clarification);
  assert.equal(without.state.clarification, undefined);
  delete withContext.state.clarification;
  assert.deepEqual(withContext.state, without.state);
  const ordinary = payloadFor(fixture.cases[0]);
  assert(!Object.hasOwn(ordinary.state, 'expected') && !Object.hasOwn(ordinary.state, 'answer_reference'));
});

test('freezeは未完了・契約ずれ・2回目欠落・期待改変を拒否する', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const base = {split: 'tune', complete: true, ready: true, input_hash: hash(readFileSync(new URL('fixtures/magi-dialogue-a2-tune.json', import.meta.url), 'utf8')),
    contract_hash: contractHash, thresholds: candidate.min_confidence,
    results: [1, 2].flatMap(run => allCases(fixture).map(c => ({variant: 'candidate', run, id: c.id, expected: c.expected,
      answers: {intent: {choice: c.expected.intent, confidence: 1}, fresh: {choice: c.expected.fresh, confidence: 1}}}))),
    timing: {count: 30, p90_ms: 200, budget_ms: 1000}};
  const incomplete = {...base, complete: false};
  const changed = {...base, contract_hash: 'changed'};
  const missing = {...base, results: base.results.slice(0, 75)};
  const expectation = structuredClone(base); expectation.results[0].expected.intent = 'consult';
  const temporary = mkdtempSync(join(tmpdir(), 'magi-a2-freeze-test-')), input = join(temporary, 'bad-report.json');
  try {
    for (const [report, error] of [[incomplete, /completed reviewed/], [changed, /changed since measurement/],
      [missing, /two full runs/], [expectation, /expectation changed/]]) {
      writeFileSync(input, JSON.stringify(report));
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('freeze-magi-a2-classification.mjs', import.meta.url)), '--report=' + input], {encoding: 'utf8'});
      assert.equal(run.status, 1); assert.match(run.stderr, error);
    }
  } finally {rmSync(input, {force: true}); rmdirSync(temporary);}
});
