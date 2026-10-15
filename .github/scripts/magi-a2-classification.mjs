// A2の分類評価。本番のpersonas.jsから確定済みの問い・閾値を読む。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const paths = ['config/ai-models.json', 'workers/magi2/languages.js', 'workers/magi2/personas.js', 'workers/magi2/classification.js'];
const contents = paths.map(read);
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
const ctx = vm.createContext({aiModels: JSON.parse(contents[0])});
vm.runInContext(contents.slice(1).map(strip).join('\n')
  + '\nglobalThis.cfg=INTENT_CLASSIFY;globalThis.payload=classificationPayload;', ctx);
export const baselineConfig = JSON.parse(JSON.stringify(ctx.cfg));
// 採用後の正本はpersonas.js。評価に問いや閾値を複製しない。
export const candidate = {
  revision: 'a2-adopted-1',
  min_confidence: {intent: ctx.cfg.min_confidence.intent, fresh: ctx.cfg.min_confidence.fresh},
  questions: JSON.parse(JSON.stringify(ctx.cfg.fact_questions)),
};
export const contractHash = createHash('sha256').update(contents.join('\n') + '\n' + JSON.stringify(candidate)
  + '\n' + read('.github/scripts/magi-a2-classification.mjs')).digest('hex');

export function payloadFor(c, {baseline = false, withoutClarification = false} = {}) {
  const body = JSON.parse(JSON.stringify(ctx.payload({texts: [...(c.earlier_messages || []), c.text], seed: c.seed || c.text, factMode: !baseline})));
  if (baseline) return body;
  if (c.clarification && !withoutClarification) body.state.clarification = c.clarification;
  return body;
}

export const groups = {stable: 15, fresh: 15, site: 10, consult: 15, music: 5, clarification: 10};
export const allCases = fixture => [...fixture.cases, ...(fixture.boundary_cases || [])];
export function validateFixture(fixture) {
  assert(['tune', 'final'].includes(fixture.split), 'split must be tune or final');
  assert.equal(fixture.cases?.length, 70, '70 cases are required');
  assert.equal(new Set(fixture.cases.map(c => c.id)).size, 70, 'IDs must be unique');
  assert.equal(new Set(fixture.cases.map(c => c.text)).size, 70, 'texts must be distinct');
  for (const [name, n] of Object.entries(groups)) assert.equal(fixture.cases.filter(c => c.group === name).length, n, name + ': count');
  assert(Array.isArray(fixture.boundary_cases) && fixture.boundary_cases.length === 5, '5 music-boundary cases required');
  assert.equal(new Set(allCases(fixture).map(c => c.id)).size, 75, 'all IDs must be unique');
  assert.equal(new Set(allCases(fixture).map(c => c.text)).size, 75, 'all inputs must be distinct');
  for (const c of allCases(fixture)) {
    assert(/^[a-z0-9-]+$/.test(c.id) && typeof c.text === 'string' && c.text.trim() && c.text.length <= 1000, 'invalid input');
    assert(Object.hasOwn(candidate.questions.intent.criteria, c.expected?.intent), 'invalid expected intent');
    assert(['yes', 'no'].includes(c.expected?.fresh), 'invalid expected fresh');
    if (c.group === 'music-boundary') {
      assert(['research', 'consult'].includes(c.expected.intent), 'music-boundary must not recommend songs');
    } else if (c.group !== 'clarification') {
      const expectation = {stable: ['research', 'no'], fresh: ['research', 'yes'], site: ['site', 'no'], consult: ['consult', 'no'], music: ['music', 'no']}[c.group];
      assert.deepEqual([c.expected.intent, c.expected.fresh], expectation, 'group expectation');
      assert(!c.clarification, 'ordinary input cannot include clarification');
    } else {
      const cl = c.clarification;
      assert(typeof cl?.original_question === 'string' && cl.original_question.trim() && cl.original_question.length <= 1000, 'original question');
      assert(Array.isArray(cl.questions) && cl.questions.length >= 1 && cl.questions.length <= 3, '1-3 questions');
      for (const q of cl.questions) assert(typeof q.question === 'string' && q.question.trim()
        && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4
        && q.options.every(o => typeof o === 'string' && o.trim()) && new Set(q.options).size === q.options.length, 'question/options');
      assert.deepEqual(cl.prior, c.expected, 'prior must match preassigned expectation');
    }
    if (c.group === 'stable') assert(typeof c.answer_reference === 'string' && c.answer_reference.trim(), 'static answer reference');
  }
  assert(fixture.cases.filter(c => c.clarification?.questions.length >= 2).length >= 3, 'at least 3 multi-question cases');
  return !!(typeof fixture.reviewed_by === 'string' && fixture.reviewed_by.trim()
    && typeof fixture.reviewed_at === 'string' && Number.isFinite(Date.parse(fixture.reviewed_at)));
}
