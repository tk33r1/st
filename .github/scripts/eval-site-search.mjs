// 評価用ホストだけで計測。認証値・検索語・応答本文を出力しない。
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const origin = new URL(process.env.MAGI_EVAL_ORIGIN || 'https://magi2-eval.tk.st');
assert(origin.protocol === 'https:' && origin.hostname === 'magi2-eval.tk.st' && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash,
  '評価専用ホストを指定してください');
const headers = { 'x-api-key': process.env.MAGI_EVAL_CLIENT_API_KEY,
  'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET };
assert(Object.values(headers).every(v => typeof v === 'string' && v.length > 0), '評価用APIキーとAccessサービス認証が必要です');
if (process.argv.includes('--delay')) {
  for (const ms of [149000, 151000]) {
    const started = performance.now();
    const res = await fetch(new URL('/magi2/eval-delay?ms=' + ms, origin), { headers, signal: AbortSignal.timeout(165000) });
    const body = await res.json();
    assert.equal(res.status, ms === 149000 ? 200 : 503);
    assert(ms === 149000 ? body.status === 'no_results' : body.error?.code === 'search_unavailable');
    console.log(JSON.stringify({ fixture_ms: ms, status: res.status, elapsed_ms: Math.round(performance.now() - started) }));
  }
} else {
  const fixtures = [
    ['PDFを結合したい', 'ja', '/tools/pdf-studio/'],
    ['PDFのページを分割したい', 'ja', '/tools/pdf-studio/'],
    ['QRコードを作りたい', 'ja', '/tools/qr-palette/'],
    ['CSVの文字コードを変換したい', 'ja', '/tools/csv-charset-converter/'],
    ['CSVをJSONに変換したい', 'ja', '/tools/csv-json-bridge/'],
    ['二つの文章の差分を確認したい', 'ja', '/tools/text-diff/'],
    ['SVGを軽くするツールを探している', 'ja', '/tools/light-svg/'],
    ['ハーレーのモトブログを読みたい', 'ja', '/motovlog/'],
    ['ニトリの出店のニュース', 'ja', '/job/nitoridaily/'],
    ['このサイトで航空券を予約できますか？', 'ja', null],
    ['I want to merge PDF files', 'en', '/tools/pdf-studio/'],
    ['How can I split a PDF into separate pages?', 'en', '/tools/pdf-studio/'],
    ['Where can I create a QR code?', 'en', '/tools/qr-palette/'],
    ['I need to convert CSV character encoding', 'en', '/tools/csv-charset-converter/'],
    ['Convert CSV into JSON', 'en', '/tools/csv-json-bridge/'],
    ['Compare two texts and show differences', 'en', '/tools/text-diff/'],
    ['Find a tool for optimizing SVG files', 'en', '/tools/light-svg/'],
    ['Show me the Harley-Davidson motovlog', 'en', '/motovlog/'],
    ['Tell me about Shinya Takeda', 'en', '/'],
    ['Can I book airline tickets on this website?', 'en', null],
  ];
  const batch = Number(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || 0);
  assert(Number.isInteger(batch) && batch >= 0 && batch <= 4);
  const cases = batch ? [...fixtures, ...fixtures].slice((batch - 1) * 10, batch * 10)
    .map(([query, locale, expected]) => ({ query, locale, expected }))
    : [{ query: 'PDFを結合したい', locale: 'ja' }, { query: 'Tell me about Shinya Takeda', locale: 'en' },
      { query: 'ニトリの出店のニュース', locale: 'ja' }];
  const reports = [];
  for (let i = 0; i < cases.length; i++) {
    const started = performance.now();
    const res = await fetch(new URL('/magi2/site-search?site_debate=1', origin), { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: cases[i].query, locale: cases[i].locale }), signal: AbortSignal.timeout(165000) });
    const body = await res.json();
    assert.equal(res.status, 200); assert(['results', 'no_results'].includes(body.status));
    const metadata = res.headers.get('x-magi-eval');
    const report = { case: batch ? (batch - 1) * 10 + i + 1 : i + 1, locale: cases[i].locale,
      expected: cases[i].expected, status: res.status, result_count: body.results?.length,
      elapsed_ms: Math.round(performance.now() - started), calls: metadata ? JSON.parse(atob(metadata)) : [] };
    reports.push({ ...report, response: body }); console.log(JSON.stringify(report));
    writeFileSync(new URL('../../workers/.wrangler/site-search-' + (batch ? 'batch-' + batch : 'pilot') + '.json', import.meta.url), JSON.stringify(reports, null, 2));
    if (report.calls.some(c => c.provider === 'google' && c.status === 429)) throw new Error('Googleの上限エラーで評価を中断しました');
    // 評価でも通常利用と無料枠を共有する。1検索の開始を30秒以上空ける。
    if (i + 1 < cases.length) await new Promise(r => setTimeout(r, Math.max(0, 30000 - (performance.now() - started))));
  }
}
