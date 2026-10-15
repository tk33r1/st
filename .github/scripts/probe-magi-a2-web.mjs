// A2実装前の対応確認。合成入力だけを送る。キー・応答本文は表示しない。
// --capability-only はModels APIだけ。--smoke は両社1件の通信形式を確認する。
// 生のSSEは引用位置の点検用にGit管理外へ置く。品質の合否とは別。
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateFixture} from './magi-a2-classification.mjs';
import {researchReader} from './magi-a2-research-stream.mjs';
import {paidEvaluationGate} from './magi-eval-budget.mjs';
const budget=paidEvaluationGate();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const registry = JSON.parse(read('config/ai-models.json'));
let vars = '';
try { vars = read('workers/magi2/.dev.vars'); } catch {}
const credential = (name, alternate) => process.env[name] || process.env[alternate]
  || vars.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*?)\\s*$', 'm'))?.[1].replace(/^(['"])(.*)\1$/, '$2');
const keys = {anthropic: credential('MAGI_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'),
  openai: credential('MAGI_OPENAI_API_KEY', 'OPENAI_API_KEY')};
const preflight = process.argv.includes('--preflight');
const fallbackWeather = process.argv.includes('--fallback-weather');
const smoke = process.argv.includes('--smoke') || preflight || fallbackWeather;
const limitProbe = process.argv.includes('--limit-probe');
const weatherPages = process.argv.includes('--weather-pages');
assert(smoke || process.argv.includes('--capability-only'), 'use --capability-only, --smoke or --preflight');
assert(!preflight || !limitProbe && !weatherPages && !process.argv.includes('--release'), 'preflight uses original reviewed inputs');
assert(!fallbackWeather || !preflight && !limitProbe && !weatherPages && !process.argv.includes('--release'), 'fallback weather uses reviewed original weather input');
assert(keys.anthropic, 'Anthropic key is required');
if (smoke && !limitProbe) assert(keys.openai, 'OpenAI key is required');
const outputDir = resolve(root, 'workers/.wrangler/magi2-dialogue-a2');
mkdirSync(outputDir, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(outputDir, 'web-probe-' + stamp + '.json');
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  probe_hash: createHash('sha256').update(read('.github/scripts/probe-magi-a2-web.mjs')).digest('hex'),
  registry_hash: createHash('sha256').update(read('config/ai-models.json')).digest('hex'),
  models: {anthropic: registry.anthropic.haiku.id, openai: registry.openai.luna.id},
  scope: fallbackWeather ? 'weather-provider-fallback-prototype' : preflight ? 'verification-plan-0.3-first-five' : smoke ? limitProbe ? 'anthropic-tool-limit' : 'technical-stream-smoke' : 'model-capability', checks: [], complete: false};
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const anthropicHeaders = {'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'};
const location = {type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo'};
const queryCase = limitProbe ? 'tool-limit' : weatherPages ? 'weather-public-pages' : process.argv.includes('--release') ? 'release' : 'weather';
report.query_case = queryCase;
report.parameters = {reasoning: 'low', stream: true, timeout_ms: 45000, anthropic_max_uses: limitProbe ? 1 : 3};
const query = limitProbe
  ? '必ず別々のWeb検索を2回行ってください。最初にGo言語の最新安定版を検索し、次に別の検索でPythonの最新安定版を調べ、両方を日本語で短く教えてください。'
  : weatherPages
  ? '東京の今日の天気を、気象庁などの公開Webページを検索して確認してください。天気専用データの値だけではなく、URLを持つページを根拠にし、情報の日付とクリックできる引用を付けて日本語で短く答えてください。'
  : queryCase === 'release'
  ? 'Go言語の最新安定版と公開日を公式のWebページで確認し、出典を付けて日本語で短く答えてください。'
  : '今日の東京の天気をWebで確認し、情報の日付と出典を付けて日本語で短く答えてください。';
const instructions = 'Use only web search results. Do not invent facts. State the date of time-sensitive information. Include citations. Answer briefly.'
  + (weatherPages ? ' Search public web pages with source URLs, rather than relying only on specialized data feeds without URLs.' : '');
const preflightInstructions = instructions
  + ' Current date in Asia/Tokyo: ' + new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()) + '.'
  + ' Search public web pages with source URLs, rather than relying only on specialized data feeds without URLs. Prefer official sources. Include clickable URL citations for the facts you state. If a current fact cannot be verified, say so rather than inventing a value.';
let probes = [{id: queryCase, text: query}];
if (preflight || fallbackWeather) {
  const fixtureText = read('.github/scripts/fixtures/magi-dialogue-a2-tune.json'), fixture = JSON.parse(fixtureText);
  assert.equal(fixture.split, 'tune');
  assert(validateFixture(fixture), 'preflight requires reviewed tuning inputs');
  probes = fixture.cases.filter(c => c.group === 'fresh').slice(0, fallbackWeather ? 1 : 5).map(c => ({id: c.id, text: c.text}));
  report.input_hash = createHash('sha256').update(fixtureText).digest('hex');
  report.reviewed_by = fixture.reviewed_by;
  report.instructions_hash = createHash('sha256').update(preflightInstructions).digest('hex');
}
report.adapter_hash = createHash('sha256').update(read('.github/scripts/magi-a2-research-stream.mjs')).digest('hex');

async function check(id, fn) {
  try { report.checks.push({id, ...await fn()}); }
  catch (error) { report.checks.push({id, pass: false, failure: error.name}); }
  persist();
  console.log(JSON.stringify(report.checks.at(-1)));
}

async function stream(provider, body, id = '') {
  const started = performance.now();
  budget.reserve(provider,body);
  const res = await fetch(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses', {
    method: 'POST', headers: provider === 'anthropic' ? anthropicHeaders
      : {'content-type': 'application/json', Authorization: 'Bearer ' + keys.openai},
    body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const value = await res.json();
    return {pass: false, status: res.status, error_type: value.error?.type || null};
  }
  const decoder = new TextDecoder(), events = [], results = [], citations = [], usage = {}, blocks = new Map();
  let adapterError = null, adapterChars = 0;
  const adapter = researchReader(provider, text => adapterChars += text.length);
  let buffer = '', raw = '', firstText = null, firstResult = null, textChars = 0, preSearchChars = 0, stopped = false,
    stopReason = null, streamError = false, searches = 0;
  const accept = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const e = JSON.parse(data);
    if (!adapterError) try {adapter.push(e);} catch (error) {adapterError = error;}
    if (!events.includes(e.type)) events.push(e.type);
    const ms = Math.round(performance.now() - started);
    if (provider === 'anthropic') {
      if (e.type === 'message_start') Object.assign(usage, e.message?.usage);
      if (e.type === 'message_delta') { stopReason = e.delta?.stop_reason || stopReason; Object.assign(usage, e.usage); }
      if (e.type === 'message_stop') stopped = true;
      if (e.type === 'error') streamError = true;
      if (e.type === 'content_block_start') {
        const b = e.content_block;
        blocks.set(e.index, {type: b.type, text: b.text || '', citations: b.citations || []});
        if (b.type === 'server_tool_use' && b.name === 'web_search') searches++;
        if (b.type === 'web_search_tool_result') {
          const count = Array.isArray(b.content) ? b.content.filter(v => v.type === 'web_search_result').length : 0;
          results.push({event: e.type, ms, count, error: b.content?.error_code || null});
          if (count) firstResult ??= ms;
        }
      }
      if (e.delta?.type === 'text_delta') {
        const text = e.delta.text || '';
        firstText ??= ms;
        textChars += text.length;
        if (firstResult === null) preSearchChars += text.length;
        blocks.get(e.index).text += text;
      }
      if (e.delta?.type === 'citations_delta') {
        const block = blocks.get(e.index);
        block.citations.push(e.delta.citation);
        citations.push({event: e.type, block: e.index, at_in_block: block.text.length,
          type: e.delta.citation?.type, has_url: !!e.delta.citation?.url});
      }
    } else {
      if (e.type === 'response.output_item.done' && e.item?.type === 'web_search_call') {
        searches++;
        const count = e.item.status === 'completed' ? e.item.action?.sources?.length || 0 : 0;
        results.push({event: e.type, ms, count, search_status: e.item.status});
        if (count) firstResult ??= ms;
      }
      if (e.type === 'response.output_text.delta') {
        firstText ??= ms;
        textChars += (e.delta || '').length;
        if (firstResult === null) preSearchChars += (e.delta || '').length;
      }
      if (e.type === 'response.output_text.annotation.added') citations.push({event: e.type,
        type: e.annotation?.type, start_index: e.annotation?.start_index, end_index: e.annotation?.end_index,
        has_url: !!e.annotation?.url});
      if (e.type === 'response.completed') { stopped = true; stopReason = e.response?.status; Object.assign(usage, e.response?.usage); }
      if (['error', 'response.failed', 'response.incomplete'].includes(e.type)) streamError = true;
    }
  };
  try {
    for await (const chunk of res.body) {
      const text = decoder.decode(chunk, {stream: true}); raw += text; buffer += text.replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {accept(buffer.slice(0, end)); buffer = buffer.slice(end + 2);}
    }
    const tail = decoder.decode(); raw += tail; buffer += tail;
    if (buffer.trim()) accept(buffer);
  } finally {
    // 合成入力の返しだけ。通常利用者の本文は扱わない。
    writeFileSync(resolve(outputDir, provider + (id ? '-' + id : '') + '-' + stamp + '.sse'), raw);
  }
  if (!adapterError) try {adapter.finish();} catch (error) {adapterError = error;}
  return {pass: limitProbe ? stopped && !streamError && results.some(r => r.error === 'max_uses_exceeded')
      : stopped && !streamError && firstResult !== null && textChars > preSearchChars && citations.length > 0
        && stopReason === (provider === 'anthropic' ? 'end_turn' : 'completed'), status: res.status,
    first_text_ms: firstText, first_search_result_ms: firstResult, elapsed_ms: Math.round(performance.now() - started),
    text_chars: textChars, pre_search_text_chars: preSearchChars, stop_reason: stopReason, searches, results, citations, events, usage,
    adapter_pass: !adapterError, adapter_emitted_chars: adapterChars,
    ...(adapterError ? {adapter_error: adapterError.code || adapterError.name, adapter_before_text: !adapterChars} : {})};
}

await check('haiku-web-capability', async () => {
  budget.reserve('anthropic',{model:registry.anthropic.haiku.id,operation:'models-read'});
  const res = await fetch('https://api.anthropic.com/v1/models/' + encodeURIComponent(registry.anthropic.haiku.id),
    {headers: anthropicHeaders, signal: AbortSignal.timeout(15000)});
  const value = await res.json();
  const supported = value.capabilities?.server_tools?.web_search?.supported;
  return {pass: res.ok && supported === true, status: res.status, supported: supported ?? null,
    error_type: value.error?.type || null};
});
if (fallbackWeather && report.checks[0].pass) {
  await check('weather-provider-fallback', async () => {
    const probe = probes[0];
    const primary = await stream('openai', {model: registry.openai.luna.id, max_output_tokens: 4096, stream: true, store: false,
      instructions: preflightInstructions, input: [{role: 'user', content: [{type: 'input_text', text: probe.text}]}], reasoning: {effort: 'low'},
      tools: [{type: 'web_search', user_location: location}], tool_choice: 'required', include: ['web_search_call.action.sources']}, probe.id + '-primary');
    if (primary.adapter_pass) return {pass: true, chosen_provider: 'openai', fallback_called: false, primary};
    if (!primary.adapter_before_text) return {pass: false, fallback_called: false, primary};
    const fallback = await stream('anthropic', {model: registry.anthropic.haiku.id, max_tokens: 2048, stream: true, system: preflightInstructions,
      thinking: {type: 'adaptive'}, output_config: {effort: 'low'},
      tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: location}],
      messages: [{role: 'user', content: probe.text}]}, probe.id + '-fallback');
    return {pass: fallback.adapter_pass === true, chosen_provider: 'anthropic', fallback_called: true, primary, fallback};
  });
} else if (smoke && !fallbackWeather) {
  for (const probe of probes) {
  const system = preflight ? preflightInstructions : instructions;
  const label = preflight ? probe.id : '';
  if (report.checks[0].pass) await check((label ? label + '-' : '') + 'anthropic-web-stream', () => stream('anthropic', {
    model: registry.anthropic.haiku.id, max_tokens: 2048, stream: true, system,
    thinking: {type: 'adaptive'}, output_config: {effort: 'low'},
    tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: limitProbe ? 1 : 3, user_location: location}],
    messages: [{role: 'user', content: probe.text}],
  }, label));
  if (!limitProbe) await check((label ? label + '-' : '') + 'openai-web-stream', () => stream('openai', {
    model: registry.openai.luna.id, max_output_tokens: 4096, stream: true, store: false,
    instructions: system, input: [{role: 'user', content: [{type: 'input_text', text: probe.text}]}], reasoning: {effort: 'low'},
    tools: [{type: 'web_search', user_location: location}], tool_choice: 'required', include: ['web_search_call.action.sources'],
  }, label));
  }
}
report.complete = true;
report.passed = report.checks.every(c => c.pass) && (!smoke || report.checks.length === (fallbackWeather ? 2 : preflight ? 11 : limitProbe ? 2 : 3));
persist();
console.log(JSON.stringify({output, passed: report.passed, scope: report.scope}));
if (!report.passed) process.exitCode = 1;
