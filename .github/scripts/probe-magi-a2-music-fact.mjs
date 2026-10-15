// 本人が挙げた4/4拍子の説明を、A2の討議なし・lowの形で両社へ送る。
// Workerへの接続前の試作。キー・本人カード・回答本文を表示しない。
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {paidEvaluationGate} from './magi-eval-budget.mjs';
const budget=paidEvaluationGate();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
const registry = JSON.parse(read('config/ai-models.json'));
const context = vm.createContext({aiModels: registry});
vm.runInContext(['languages.js', 'personas.js'].map(p => strip(read('workers/magi2/' + p))).join('\n')
  + '\nglobalThis.config={SYNTHESIZER,PERSONA_CONTEXT,DEFAULTS};', context);
const source = read('workers/magi2/src/index.js');
const begin = source.indexOf('function requestBody('), end = source.indexOf('\nasync function callModel(', begin);
assert(begin >= 0 && end > begin);
vm.runInContext(source.slice(begin, end) + '\nglobalThis.body=requestBody;', context);
const {SYNTHESIZER, PERSONA_CONTEXT, DEFAULTS} = context.config;
const card = JSON.parse(read('data/magi-context.json')).personas[SYNTHESIZER.codename].card.trim().slice(0, PERSONA_CONTEXT.max_chars);
const query = '楽譜の4分の4拍子はどういう意味？';
const expected = '下の4は四分音符を1拍の単位とし、上の4は1小節に4拍あること。小節内が必ず四分音符4個だけとは限らず、他の音価や休符の組合せでもよい。';
const messages = [
  {role: 'system', content: SYNTHESIZER.system_prompt + '\n\n' + PERSONA_CONTEXT.synth_header + '\n' + card},
  {role: 'system', content: '事実の確認の問い。討議はしていない。分かることを正確に、分からないことは分からないと答える。依頼された説明に直接答え、求められていない曲の推薦を加えない。'},
  {role: 'system', content: SYNTHESIZER.voice_rules + '\n日本語で答えてください。'},
  {role: 'user', content: query},
];
let vars = ''; try {vars = read('workers/magi2/.dev.vars');} catch {}
const key = name => process.env[name] || vars.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*?)\\s*$', 'm'))?.[1].replace(/^(['"])(.*)\1$/, '$2');
const keys = {openai: key('MAGI_OPENAI_API_KEY'), anthropic: key('MAGI_ANTHROPIC_API_KEY')};
assert(keys.openai && keys.anthropic, 'both keys required');
const report = {date: new Date().toISOString(), scope: 'fact-answer-prototype; production-Worker-not-tested', query, expected,
  script_hash: createHash('sha256').update(read('.github/scripts/probe-magi-a2-music-fact.mjs')).digest('hex'),
  card_hash: createHash('sha256').update(card).digest('hex'), checks: []};
const dir = resolve(root, 'workers/.wrangler/magi2-dialogue-a2'); mkdirSync(dir, {recursive: true});
const output = resolve(dir, 'music-fact-' + report.date.replace(/[:.]/g, '-') + '.json');
for (const name of ['synthesizer', 'synthesizer_dark']) {
  const cfg = {...DEFAULTS.models[name], reasoning_effort: 'low'}, provider = cfg.provider;
  const body = context.body(cfg, {messages, stream: true});
  const start = performance.now();
  try {
    budget.reserve(provider,body);
    const res = await fetch(provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {'Content-Type': 'application/json', ...(provider === 'openai'
        ? {Authorization: 'Bearer ' + keys.openai} : {'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01'})},
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {await res.body?.cancel(); throw new Error('http_failure');}
    let buffer = '', text = '', first = null, finished = null, stopped = false;
    const decoder = new TextDecoder();
    const frame = data => {
      if (data === '[DONE]') {stopped = true; return;}
      const event = JSON.parse(data);
      if (event.error || event.type === 'error') throw new Error('stream_error');
      const delta = provider === 'openai' ? event.choices?.[0]?.delta?.content
        : event.delta?.type === 'text_delta' ? event.delta.text : null;
      if (delta) {first ??= Math.round(performance.now() - start); text += delta;}
      if (provider === 'openai' && event.choices?.[0]?.finish_reason) finished = event.choices[0].finish_reason;
      if (provider === 'anthropic' && event.type === 'message_delta') finished = event.delta?.stop_reason;
      if (event.type === 'message_stop') stopped = true;
    };
    const drain = () => {let pos; while ((pos = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer.slice(0, pos).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) frame(data); buffer = buffer.slice(pos + 2);
    }};
    for await (const chunk of res.body) {buffer += decoder.decode(chunk, {stream: true}).replace(/\r/g, ''); drain();}
    buffer += decoder.decode(); if (buffer.trim()) {buffer += '\n\n'; drain();}
    report.checks.push({provider, model: cfg.model, reasoning: 'low', status: res.status,
      pass: stopped && finished === (provider === 'openai' ? 'stop' : 'end_turn') && !!text.trim(),
      first_text_ms: first, elapsed_ms: Math.round(performance.now() - start), finish_reason: finished, text});
  } catch (error) {report.checks.push({provider, pass: false, failure: error.name});}
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const {text, ...metadata} = report.checks.at(-1); console.log(JSON.stringify(metadata));
}
console.log(JSON.stringify({output, quality: 'requires_agent_review_against_preassigned_expected'}));
if (report.checks.some(c => !c.pass)) process.exitCode = 1;
