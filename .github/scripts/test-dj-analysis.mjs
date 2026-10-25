// ブースの推定キューを固定応答で確認。本番・外部API・音源には接続しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createAnalysisQueue, analysisNotice } from '../../dj/booth/analysis-queue.js';

const song = (id, extra = {}) => ({ id, previewUrl: 'https://audio.test/' + id, bpm: null,
  serverBpm: null, songKey: '', camelot: '', createdAt: new Date().toISOString(), ...extra });
const good = { bpm: 123, camelot: '3B', songKey: 'C#', bpmReason: '' };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(songs, options = {}) {
  let time = 0, sequence = 0;
  const timers = new Map(), calls = [], saved = [];
  const queue = createAnalysisQueue({
    getSongs: () => songs,
    analyze: async (url) => { calls.push(url); return good; },
    save: async (id, result) => {
      saved.push(id);
      const s = songs.find((s) => s.id === id);
      if (s.serverBpm == null && result.bpm != null) {
        s.serverBpm = result.bpm;
        if (!s.bpmTapped) s.bpm = result.bpm;
      }
      if (!(s.camelot || s.songKey) && result.camelot) {
        Object.assign(s, { camelot: result.camelot, songKey: result.songKey });
      }
    },
    onChange() {}, now: () => time,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    ...options,
  });
  return { queue, calls, saved, timers, async advance(ms) {
    time += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) { timers.delete(id); timer.fn(); }
    }
    await drain();
  } };
}

// 新着にも即着手。2曲までで、1曲が止まっても空いた枠で後続へ進む。
{
  let release, active = 0, maximum = 0;
  const seen = [];
  const s = [song(1), song(2), song(3), song(4)];
  const h = setup(s, { async analyze(url) {
    seen.push(url); maximum = Math.max(maximum, ++active);
    if (url.endsWith('/1')) await new Promise((resolve) => { release = resolve; });
    active--; return good;
  } });
  h.queue.pump();
  assert.equal(seen.length, 2);
  await drain();
  assert.equal(seen.length, 4);
  assert.deepEqual(h.saved, [2, 3, 4]);
  release(); await drain();
  assert.equal(maximum, 2);
  assert.equal(h.saved.length, 4);
  h.queue.pump(); await drain();
  assert.equal(seen.length, 4);
}

// タイムアウト等の通信失敗を2秒・5秒後に再試行。ポーリングで上限をリセットしない。
{
  const s = song(1); let attempts = 0;
  const h = setup([s], { async analyze() { attempts++; throw { code: 'preview_network' }; } });
  h.queue.pump(); await drain();
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /2\/3/);
  h.queue.pump(); await h.advance(1999); assert.equal(attempts, 1);
  await h.advance(1); assert.equal(attempts, 2);
  await h.advance(4999); assert.equal(attempts, 2);
  await h.advance(1); assert.equal(attempts, 3);
  for (let i = 0; i < 5; i++) h.queue.pump();
  await h.advance(60000);
  assert.equal(attempts, 3);
  assert.equal(analysisNotice(s, h.queue.getState(s)).retry, true);
  assert.equal(h.timers.size, 0);
  h.queue.retry(1); await drain(); assert.equal(attempts, 4);
}

// 保存失敗では音源の取得・FFTをやり直さず、解析結果だけを再送する。
{
  const s = song(1); let writes = 0;
  const h = setup([s], { async save(_id, r) {
    if (++writes === 1) throw { status: 503 };
    Object.assign(s, r, { serverBpm: r.bpm });
  } });
  h.queue.pump(); await drain();
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /保存.*503/);
  await h.advance(2000);
  assert.equal(h.calls.length, 1); assert.equal(writes, 2); assert.equal(s.bpm, 123);
}

// 確信度不足はBPMを表示せず、理由を残す。キーだけ保存してもループしない。
{
  const s = song(1);
  const h = setup([s], { async analyze() { h.calls.push('once'); return { ...good, bpm: null, bpmReason: 'low_confidence' }; } });
  h.queue.pump(); await drain();
  assert.equal(s.camelot, '3B'); assert.equal(s.bpm, null);
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /確信度不足.*TAP/);
  h.queue.pump(); await h.advance(60000); assert.equal(h.calls.length, 1);
  s.bpm = 121; s.bpmTapped = true;
  assert.equal(analysisNotice(s, h.queue.getState(s)), null);
}

// No.1の回帰: キー取得済み・BPM低確信度なら保存は不要。保存APIが落ちていても理由を隠さない。
for (const key of [{ camelot: '3B', songKey: 'C#' }, { camelot: '', songKey: 'C#' }, { camelot: '3B' }]) {
  const s = song(1, key); let reads = 0, writes = 0;
  const h = setup([s], {
    async analyze() { reads++; return { ...good, bpm: null, bpmReason: 'low_confidence' }; },
    async save() { writes++; throw { status: 503 }; },
  });
  h.queue.pump(); await drain();
  assert.equal(writes, 0);
  assert.equal(h.queue.getState(s).status, 'done');
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /確信度不足/);
  assert.equal(h.timers.size, 0);
  h.queue.pump(); await h.advance(60000); assert.equal(reads, 1);
}

// 保存するのは空欄を埋める項目だけ。取得済みのBPM・キーは送らない。
for (const [fields, expected] of [
  [{ bpm: 128, serverBpm: 128 }, { bpm: null, camelot: '3B', songKey: 'C#' }],
  [{ camelot: '9A', songKey: 'Em' }, { bpm: 123, camelot: '', songKey: '' }],
  [{ bpm: 125, bpmTapped: true }, { bpm: 123, camelot: '3B', songKey: 'C#' }],
]) {
  const s = song(1, fields), requests = [];
  const h = setup([s], { async save(_id, values) { requests.push(values); } });
  h.queue.pump(); await drain();
  assert.deepEqual(requests, [expected]);
}

// 再試行待ちに外部取得で欄が埋まれば、キャッシュ済みの結果でも不要な保存をしない。
{
  const s = song(1); let reads = 0, writes = 0;
  const h = setup([s], {
    async analyze() { reads++; return { ...good, bpm: null, bpmReason: 'low_confidence' }; },
    async save() { writes++; throw { status: 503 }; },
  });
  h.queue.pump(); await drain(); assert.equal(writes, 1);
  Object.assign(s, { camelot: '9A', songKey: 'Em' });
  await h.advance(2000);
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(s.camelot, '9A');
  assert.equal(h.queue.getState(s).status, 'done');
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /確信度不足/);
  assert.equal(h.timers.size, 0);
}

// BPM取得済み・キー推定不可も、保存せずキーの理由を表示する。
{
  const s = song(1, { bpm: 128, serverBpm: 128 });
  const h = setup([s], { async analyze() { return { ...good, camelot: '', songKey: '' }; } });
  h.queue.pump(); await drain();
  assert.equal(h.saved.length, 0);
  assert.match(analysisNotice(s, h.queue.getState(s)).text, /キーを推定できません/);
}

// HTTP 404・デコード失敗は自動再試行しない。429・5xxは再試行する。
for (const [error, retryable] of [
  [{ code: 'preview_http', status: 404 }, false], [{ code: 'audio_decode' }, false],
  [{ code: 'audio_unsupported' }, false], [{ code: 'preview_http', status: 429 }, true],
  [{ code: 'preview_http', status: 503 }, true],
]) {
  const s = song(1), h = setup([s], { async analyze() { throw error; } });
  h.queue.pump(); await drain();
  assert.equal(h.queue.getState(s).status, retryable ? 'retry' : 'failed');
  assert(analysisNotice(s, h.queue.getState(s)).text);
}

// 曲・URLが変わった後に戻った解析や、外部サービスが既に補完した値は保存しない。
for (const change of [(s) => s.splice(0), (s) => { s[0].previewUrl += '/new'; },
  (s) => Object.assign(s[0], good, { serverBpm: good.bpm })]) {
  const s = [song(1)]; let finish;
  const h = setup(s, { analyze: () => new Promise((resolve) => { finish = resolve; }) });
  h.queue.pump(); change(s); finish(good); await drain();
  assert.equal(h.saved.length, 0);
}

// プレビューなし・対象外・両項目が取得済みの曲へ通信しない。
{
  const s = [song(1, { previewUrl: '' }), song(2, { isFree: true }), song(3, { ...good, serverBpm: good.bpm })];
  const h = setup(s); h.queue.pump(); await drain(); assert.equal(h.calls.length, 0);
  assert.match(analysisNotice(s[0]).text, /プレビューがない/);
  assert.equal(analysisNotice(s[1]), null);
  assert.match(analysisNotice(song(4), { status: 'done', result: { bpmReason: 'short_audio' } }).text, /音源が短すぎます/);
}

// 音源取得と本文取得の中断・HTTP失敗・音声形式非対応を区別する。
const audioScript = readFileSync(new URL('../../dj/booth/audio-analysis.js', import.meta.url), 'utf8');
async function checkAudio(fetch, code, Ctx) {
  const context = vm.createContext({ window: { OfflineAudioContext: Ctx }, fetch });
  vm.runInContext(audioScript, context);
  await assert.rejects(context.window.DJAudioAnalysis.decode('https://audio.test/1'), (e) => e.code === code);
}
await checkAudio(async () => { throw new Error('timeout'); }, 'preview_network');
await checkAudio(async () => ({ ok: true, arrayBuffer: async () => { throw new Error('aborted body'); } }), 'preview_network');
await checkAudio(async () => ({ ok: false, status: 403 }), 'preview_http');
await checkAudio(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }), 'audio_unsupported');
await checkAudio(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }), 'audio_decode',
  class { async decodeAudioData() { throw new Error('codec'); } });

// HTMLに内包した全スクリプトと、新規モジュールの構文も検査する。
const html = readFileSync(new URL('../../dj/booth/index.html', import.meta.url), 'utf8');
{
  const context = vm.createContext({ pins: new Map(), analysisPins: new Map([[1, { done: 2,
    values: { bpm: 123, bpmSrc: 'est', camelot: '3B', songKey: 'C#', keySrc: 'est' } }]]), tapMap: new Map([[1, 125]]) });
  const code = html.slice(html.indexOf('    function applyLocalSongState('), html.indexOf('    async function load()'));
  vm.runInContext(code, context);
  const stale = song(1); context.applyLocalSongState(stale, 2);
  assert.equal(stale.serverBpm, 123); assert.equal(stale.bpm, 125); assert.equal(stale.bpmTapped, true);
  const fresh = song(1, { bpm: 124 }); context.applyLocalSongState(fresh, 3);
  assert.equal(fresh.serverBpm, 124); assert.equal(fresh.bpm, 125); assert.equal(context.analysisPins.size, 0);
}
for (const [, attrs, code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/application\/ld\+json/.test(attrs)) { JSON.parse(code); continue; }
  execFileSync(process.execPath, ['--check', '--input-type=' + (/type="module"/.test(attrs) ? 'module' : 'commonjs')], { input: code });
}
console.log('DJ解析: 並列数・待機撤廃・再試行と上限・保存再送・確信度不足・イベント切替・音源エラー・構文 OK');
