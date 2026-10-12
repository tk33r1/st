// 公開1の実装前確認。合成入力だけを送り、入力・応答本文・キーは記録しない。
// モデルIDは正本、議題化・ページ選びのスキーマと統合入力は現在のWorkerから読む。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const registry = JSON.parse(readFileSync('config/ai-models.json', 'utf8'));
const model = registry.anthropic.haiku.id;
const config = JSON.parse(execFileSync(process.execPath, ['.github/scripts/magi-search-config.mjs'], {encoding: 'utf8'}));
const images = JSON.parse(readFileSync('.github/scripts/fixtures/anthropic-images.json', 'utf8'));
const report = {date: new Date().toISOString(), commit: process.env.GITHUB_SHA || null, model,
  credential: process.env.GITHUB_ACTIONS ? 'repository secret ANTHROPIC_API_KEY' : 'environment ANTHROPIC_API_KEY', checks: []};
const output = 'workers/.wrangler/anthropic-probe.json';
const headers = key => ({'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'});
const key = process.env.ANTHROPIC_API_KEY;
const basic = {model, max_tokens: 1024, system: 'Reply briefly in English.',
  thinking: {type: 'disabled'}, output_config: {effort: 'low'},
  messages: [{role: 'user', content: 'Say READY.'}]};

function record(id, value) {
  report.checks.push({id, ...value});
  mkdirSync('workers/.wrangler', {recursive: true});
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${id}: ${value.pass ? 'PASS' : value.skipped ? 'SKIP' : 'FAIL'}`);
}
async function request(body, suppliedKey = key) {
  const started = performance.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: headers(suppliedKey), body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const json = await response.json();
  const text = (json.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  const meta = {status: response.status, ms: Math.round(performance.now() - started),
    stop_reason: json.stop_reason || null, error_type: json.error?.type || null,
    block_types: (json.content || []).map(block => block.type), usage: json.usage || null};
  return {meta, text, json};
}
async function check(id, run) {
  try { record(id, await run()); }
  catch (error) { record(id, {pass: false, failure: error.name || 'Error'}); }
}
// API非対応の制約だけ落とし、受信時には元の上限（3件）を検査する。
function schemaForApi(value) {
  if (Array.isArray(value)) return value.map(schemaForApi);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !['maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum'].includes(name))
    .map(([name, child]) => [name, schemaForApi(child)]));
}
async function stream() {
  const messages = config.discussion.synthesizer.body.messages;
  const body = {model, max_tokens: 8192, stream: true,
    system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: messages.filter(message => message.role !== 'system'),
    thinking: {type: 'adaptive'}, output_config: {effort: 'medium'}};
  const started = performance.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const json = await response.json();
    return {pass: false, status: response.status, error_type: json.error?.type || null};
  }
  let buffer = '', firstTextMs = null, chars = 0, stopped = false, stopReason = null, streamError = false;
  const events = [], usage = {};
  const decoder = new TextDecoder();
  const accept = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const event = JSON.parse(data);
    if (!events.includes(event.type)) events.push(event.type);
    if (event.type === 'message_start') Object.assign(usage, event.message?.usage);
    if (event.type === 'message_delta') {stopReason = event.delta?.stop_reason || stopReason; Object.assign(usage, event.usage);}
    if (event.type === 'message_stop') stopped = true;
    if (event.type === 'error') streamError = true;
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      firstTextMs ??= Math.round(performance.now() - started);
      chars += [...event.delta.text].length;
    }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, {stream: true}).replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {accept(buffer.slice(0, end)); buffer = buffer.slice(end + 2);}
  }
  buffer += decoder.decode();
  if (buffer.trim()) accept(buffer);
  return {pass: stopped && stopReason === 'end_turn' && chars > 0 && !streamError,
    status: response.status, first_text_ms: firstTextMs, ms: Math.round(performance.now() - started),
    chars, stop_reason: stopReason, events, usage};
}

if (!key) {
  record('credential', {pass: false, failure: 'missing_api_key'});
} else {
  await check('0-1-models', async () => {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {headers: headers(key), signal: AbortSignal.timeout(15000)});
    const json = await response.json();
    const found = json.data?.find(item => item.id === model);
    return {pass: response.ok && !!found?.display_name, status: response.status, display_name: found?.display_name || null,
      error_type: json.error?.type || null};
  });
  await check('0-2-persona', async () => {
    const {meta, text} = await request(basic);
    return {...meta, pass: meta.status === 200 && meta.stop_reason === 'end_turn' && meta.block_types.every(type => type === 'text') && /READY/.test(text)};
  });
  // 認証・モデルの前提が崩れたら、同じ失敗のリクエストを増やさない。
  if (report.checks.every(item => item.pass)) {
    for (const image of images) await check(`0-3-${image.media_type}`, async () => {
      const {meta, text} = await request({...basic, messages: [{role: 'user', content: [
        {type: 'image', source: {type: 'base64', media_type: image.media_type, data: image.data}},
        {type: 'text', text: 'Name the color and shape shown, in English.'},
      ]}]});
      return {...meta, pass: meta.status === 200 && meta.stop_reason === 'end_turn' && /blue/i.test(text) && /circle/i.test(text)};
    });
    await check('0-4-sampling', async () => {
      const {meta} = await request({...basic, temperature: 1.3});
      return {...meta, pass: meta.status === 400 && meta.error_type === 'invalid_request_error'};
    });
    for (let i = 1; i <= 5; i++) await check(`0-5-6-stream-${i}`, stream);
    for (const name of ['motion', 'pages']) for (let i = 1; i <= 5; i++) await check(`0-9-${name}-${i}`, async () => {
      const source = name === 'motion' ? config.magi.motion.body : config.site_schema_smoke[i % 2].body;
      const schema = source.response_format?.json_schema.schema || source.output_config.format.schema;
      const {meta, text} = await request({...basic, max_tokens: name === 'motion' ? 400 : 300,
        system: source.system || source.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
        messages: source.messages.filter(message => message.role !== 'system'),
        output_config: {effort: 'low', format: {type: 'json_schema', schema: schemaForApi(schema)}}});
      let valid = false;
      try {
        const value = JSON.parse(text);
        valid = name === 'motion' ? typeof value.motion === 'string' && typeof value.votable === 'boolean' && Object.keys(value).length === 2
          : Array.isArray(value.selections) && value.selections.length <= 3 && value.selections.every(id => typeof id === 'string') && Object.keys(value).length === 1;
        if (name === 'pages') valid &&= JSON.stringify(value) === JSON.stringify(config.site_schema_smoke[i % 2].expected);
      } catch {}
      return {...meta, pass: meta.status === 200 && meta.stop_reason === 'end_turn' && valid, schema_valid: valid};
    });
    const materialFile=process.argv.find(a=>a.startsWith('--image-urls-file='))?.slice(18);
    const urls = materialFile ? JSON.parse(readFileSync(materialFile,'utf8')).image_urls.slice(0,3)
      : (process.env.ANTHROPIC_PROBE_IMAGE_URLS || '').split(/\s+/).filter(Boolean);
    if (urls.length !== 3 || urls.some(url => {try {const parsed = new URL(url); return parsed.protocol !== 'https:' || parsed.hostname !== 'pbs.twimg.com';} catch {return true;}})) {
      record('0-10-x-images', {skipped: true, reason: 'three_public_pbs_image_urls_required'});
    } else for (let i = 0; i < urls.length; i++) await check(`0-10-x-image-${i + 1}`, async () => {
      const {meta, text} = await request({...basic, messages: [{role: 'user', content: [
        {type: 'image', source: {type: 'url', url: urls[i]}}, {type: 'text', text: 'Describe the visible contents in one sentence.'},
      ]}]});
      return {...meta, pass: meta.status === 200 && meta.stop_reason === 'end_turn' && text.trim().length > 0,
        // 内容に触れているかの人の確認は別。本文を成果物へ保存しない。
        visual_quality: 'requires_manual_review'};
    });
  }
  await check('0-7-invalid-key', async () => {
    const {meta} = await request(basic, 'invalid-probe-key');
    return {...meta, pass: meta.status === 401 && meta.error_type === 'authentication_error'};
  });
}
report.passed = report.checks.filter(item => !item.skipped).every(item => item.pass);
report.complete = report.passed && report.checks.every(item => !item.skipped);
const times = report.checks.filter(item => item.id.startsWith('0-5-6-')).map(item => item.first_text_ms).filter(Number.isFinite);
report.first_text_max_ms = times.length ? Math.max(...times) : null;
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
