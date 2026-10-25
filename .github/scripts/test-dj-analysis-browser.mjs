// 実画面の表示・再試行操作を固定応答で確認。全通信をローカル応答に置き換える。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const songs = [1, 2, 3, 4, 5].map((id) => ({ id, trackId: id, title: id === 1 ? 'No.1' : 'テスト曲 ' + id,
  artist: id === 1 ? 'DISH//' : '検証用アーティスト', durationMs: 180000, genre: 'ポップ', releaseYear: 2026,
  album: '検証用アルバム', previewUrl: id === 4 ? '' : 'https://audio.test/' + id,
  bpm: null, songKey: 'C#', camelot: '3B', keySrc: 'est', bpmSrc: '',
  status: 'pending', votes: 1, likes: 0, createdAt: new Date().toISOString(), voices: [] }));
const audioMock = `
window.analysisCalls = {};
window.DJAudioAnalysis.analyzeUrl = async (url) => {
  const id = Number(url.split('/').pop());
  const attempt = window.analysisCalls[id] = (window.analysisCalls[id] || 0) + 1;
  await new Promise((r) => setTimeout(r, 30));
  if (id === 2 && attempt === 1) throw { code: 'preview_network' };
  if (id === 5 && attempt === 1) throw { code: 'preview_http', status: 404 };
  return { bpm: id === 1 ? null : 123, bpmReason: id === 1 ? 'low_confidence' : '', camelot: '3B', songKey: 'C#' };
};`;
const browser = await chromium.launch({ headless: true, channel: process.env.DJ_TEST_BROWSER || undefined });
const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
const errors = [], writes = new Map();
let firstAnalysisAt;
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'booth.test') return route.abort();
    if (url.pathname === '/dj/api/req/admin/songs') {
      return route.fulfill({ json: { event: { code: 'TEST', title: 'BPM解析の確認', open: true }, songs } });
    }
    const match = url.pathname.match(/^\/dj\/api\/req\/admin\/songs\/(\d+)\/analysis$/);
    if (match) {
      firstAnalysisAt ??= Date.now();
      const id = Number(match[1]), count = (writes.get(id) || 0) + 1;
      writes.set(id, count);
      if (id === 1 || (id === 3 && count === 1)) return route.fulfill({ status: 503, json: { message: '一時的な保存失敗' } });
      const values = route.request().postDataJSON();
      const s = songs.find((s) => s.id === id);
      if (s.bpm == null && values.bpm != null) Object.assign(s, { bpm: values.bpm, bpmSrc: 'est' });
      return route.fulfill({ json: { ok: true, bpm: s.bpm, bpmSrc: s.bpmSrc,
        songKey: s.songKey, camelot: s.camelot, keySrc: s.keySrc } });
    }
    if (url.pathname.startsWith('/dj/api/')) throw new Error('想定外のAPI: ' + url.pathname);
    const pathname = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(root) || !existsSync(filename)) return route.fulfill({ status: 404, body: '' });
    const extension = path.extname(filename);
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extension];
    const body = url.pathname.endsWith('/audio-analysis.js') ? readFileSync(filename, 'utf8') + audioMock : readFileSync(filename);
    return route.fulfill({ body, contentType: contentType || 'application/octet-stream' });
  });
  const start = Date.now();
  await page.goto('https://booth.test/dj/booth/', { waitUntil: 'domcontentloaded' });
  const card = (id) => page.locator('.card[data-id="' + id + '"]');
  await card(1).getByText(/確信度不足/).waitFor();
  assert.equal(writes.has(1), false, '取得済みキーと低確信度BPMは保存しない');
  assert(firstAnalysisAt - start < 2000, '投稿直後も20秒待機しない');
  await card(2).getByText(/通信に失敗.*自動再試行/).waitFor();
  await card(3).getByText(/保存に失敗.*自動再試行/).waitFor();
  await card(4).getByText(/プレビューがない/).waitFor();
  await card(5).getByText(/HTTP 404/).waitFor();
  await page.screenshot({ path: path.join(os.tmpdir(), 'dj-analysis-desktop.png'), fullPage: true });
  await card(2).getByText('123 BPM · 推定', { exact: true }).waitFor();
  await card(3).getByText('123 BPM · 推定', { exact: true }).waitFor();
  assert.equal(writes.get(3), 2);
  assert.equal(await page.evaluate(() => window.analysisCalls[3]), 1, '保存だけの失敗では再解析しない');
  await card(5).getByRole('button', { name: '解析を再試行' }).click();
  await card(5).getByText('123 BPM · 推定', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.analysisCalls[5]), 2);
  // 5秒ポーリングをまたいでも保存済み値を保ち、確信度不足の曲を再解析しない。
  await page.waitForResponse((response) => response.url().endsWith('/admin/songs'));
  await card(1).getByText(/確信度不足/).waitFor();
  assert.equal(await page.evaluate(() => window.analysisCalls[1]), 1);
  assert.equal(writes.has(1), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(os.tmpdir(), 'dj-analysis-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('DJ解析画面: 即開始・理由表示・自動/手動再試行・保存結果再利用・ポーリング・モバイル幅 OK');
  console.log('画面: ' + path.join(os.tmpdir(), 'dj-analysis-desktop.png') + ', ' + path.join(os.tmpdir(), 'dj-analysis-mobile.png'));
} finally {
  await browser.close();
}
