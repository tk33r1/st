// テキスト・コード・PDF の添付を、両画面の実ブラウザと同梱の pdf.js で確かめる。
// 文字コード・形式・件数・合計1万字・履歴の復元・次の送信での配分を、送信内容（合成SSEで受ける）から検査する。外部APIは呼ばない。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd(), out = resolve(root, 'workers/.wrangler/magi-attach-browser');
mkdirSync(out, { recursive: true });
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// 標準フォントの英字の PDF（ページごとの文）か、フォントを埋め込まない日本語の PDF（japanese。古い Acrobat などが作る、
// 既定の文字コード対応表 UniJIS-UCS2-H に頼る形）。ページの文が null なら文字の層の無い図だけのページ（スキャンの代わり）。xref の位置は組み立てながら数える
function pdf(pages, japanese = false) {
  const font = japanese ? '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular'
    + ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor << /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -200 1000 900]'
    + ' /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> >>] >>' : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, font];
  pages.forEach((text, i) => {
    const shown = text === null ? '' : japanese ? `<${Buffer.from(text, 'utf16le').swap16().toString('hex')}>` : `(${text})`;
    const stream = text === null ? '0 0.4 1 rg 20 20 120 120 re f' : `BT /F1 14 Tf 20 150 Td ${shown} Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const files = [
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('メモの本文です。\r\n二行目', 'utf8') },
  { name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 3, 4]) },
  { name: 'sjis.csv', mimeType: 'text/csv', buffer: Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x2c, 0x31]) },
  { name: 'sample.pdf', mimeType: 'application/pdf', buffer: pdf(['Hello PDF page one', 'Second page text']) },
  { name: 'big.md', mimeType: 'text/markdown', buffer: Buffer.from('y'.repeat(12000)) },
  { name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('extra') },
];
const attachmentsOf = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'attachment') : []);
const imagesOf = message => Array.isArray(message.content) ? message.content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : [];

const browser = await chromium.launch({ headless: true });
try {
  for (const target of ['pwa', 'web']) {
    const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await context.addInitScript(() => { localStorage.setItem('lang', 'ja'); localStorage.setItem('st-analytics', 'off'); sessionStorage.setItem('magi_transport', 'sse'); });
    const requests = [], pageErrors = [], assets = new Set();
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/magi2/models') return route.fulfill({ json: { features: { privacy_contract: 1, temporary_chat: true, personalization: true, temporary_personalization: true } } });
      if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      if (url.pathname === '/magi2/chat') {
        const body = JSON.parse(request.postData()); requests.push(body);
        const stream = (body.privacy_contract ? event('session', { conversation_mode: body.conversation_mode, personalization_applied: false }) : '')
          + event('classification', { version: 1, intent: 'research', mode: 'fact', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } })
          + event('integrated', { delta: 'ANSWER-' + requests.length }) + event('done', { request_id: 'synthetic' });
        return route.fulfill({ contentType: 'text/event-stream', body: stream });
      }
      if (url.hostname === 'tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file) && extname(file)) {
          if (url.pathname.includes('pdfjs')) assets.add(url.pathname);
          return route.fulfill({ body: readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream' });
        }
      }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    const open = async () => {
      await page.goto('https://tk.st/' + (target === 'pwa' ? 'magi-app/www/' : ''));
      if (target === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
      await page.locator('#agent-input').waitFor();
    };
    const send = async (text, count) => {
      await page.locator('#agent-input').fill(text);
      await page.locator('#agent-send').click();
      await page.waitForFunction(n => document.querySelectorAll('.agent-turn .agent-reply:not(.streaming)').length >= n, count);
    };
    await open();

    // 6件を一度に選ぶ：ZIP は断り、5件目（4件の上限）は足さず、big.md は残りの文字数で切る。2ページの PDF は2枚の画像も足す
    await page.locator('#agent-file').setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll('#agent-attach-tray .attach-doc').length === 4 && document.querySelectorAll('#agent-attach-tray .attach-chip > img').length === 2
      && !document.querySelector('#agent-send').disabled);
    await page.waitForTimeout(100);
    assert.deepEqual(await page.locator('#agent-attach-tray .attach-doc > span').allTextContents(), ['notes.txt', 'sjis.csv', 'sample.pdf', 'big.md']);
    assert.match(await page.locator('#agent-attach-tray .attach-doc small').last().textContent(), /^(?:先頭[\d,]+字|[\d,]+ chars \(start\))$/);
    assert.ok(assets.has(target === 'pwa' ? '/magi-app/www/vendor/pdfjs/pdf.min.js' : '/assets/vendor/pdfjs-dist@6.4.299/pdf.min.js'), [...assets].join());
    await page.locator('#agent-attach-tray').screenshot({ path: resolve(out, `${target}-tray.png`) });

    await send('このファイルを見て', 1);
    const first = attachmentsOf(requests[0]);
    assert.deepEqual(first.map(p => p.name), ['notes.txt', 'sjis.csv', 'sample.pdf', 'big.md']);
    assert.equal(first[0].text, 'メモの本文です。\n二行目');
    assert.equal(first[1].text, '日本,1');
    assert.match(first[2].text, /Hello PDF page one[\s\S]*Second page text/);
    assert.equal(first[3].truncated, true);
    assert.equal(first.reduce((n, p) => n + p.text.length, 0), 10000);
    assert.equal(requests[0].messages.at(-1).content.find(p => p.type === 'text').text, 'このファイルを見て');
    const pages = imagesOf(requests[0].messages.at(-1));
    assert.equal(pages.length, 2, 'PDF の2ページを画像でも送る');
    assert.ok(pages.every(url => url.startsWith('data:image/jpeg;base64,')));
    assert.deepEqual(await page.evaluate(url => new Promise(ok => { const img = new Image(); img.onload = () => ok([img.naturalWidth, img.naturalHeight]); img.src = url; }), pages[0]), [1024, 683],
      '写真と同じ長辺1024で描く');
    // 埋め込みの無いフォントも端末のフォントで描く（白紙のページ画像にしない）
    assert.ok(await page.evaluate(url => new Promise(ok => { const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const px = cx.getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark++; ok(dark); }; img.src = url; }), pages[0]) > 500,
      'ページ画像に文字が描かれている');
    assert.deepEqual(await page.locator('.agent-user .agent-file > span').allTextContents(), ['notes.txt', 'sjis.csv', 'sample.pdf', 'big.md']);
    await page.screenshot({ path: resolve(out, `${target}-sent.png`) });

    // 開き直しても添付の札が残り、次の送信では新しい添付を優先して古い本文を名前だけにする
    await open();
    await page.locator('.agent-user .agent-file').first().waitFor();
    assert.equal(await page.locator('.agent-user .agent-file').count(), 4);
    await page.locator('#agent-file').setInputFiles([{ name: 'next.py', mimeType: 'text/x-python', buffer: Buffer.from('z'.repeat(9000)) },
      { name: '日本語.pdf', mimeType: 'application/pdf', buffer: pdf(['日本語の資料です。漢字とかなを読む'], true) },
      { name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf([null]) }]);
    await page.waitForFunction(() => document.querySelectorAll('#agent-attach-tray .attach-doc').length === 2 && document.querySelectorAll('#agent-attach-tray .attach-chip > img').length === 2
      && !document.querySelector('#agent-send').disabled);
    await send('続き', 2);
    const second = attachmentsOf(requests[1]);
    assert.deepEqual(second.map(p => [p.name, p.omitted === true]), [['notes.txt', false], ['sjis.csv', false], ['sample.pdf', false], ['big.md', true], ['next.py', false], ['日本語.pdf', false]]);
    assert.equal(second.at(-1).text, '日本語の資料です。漢字とかなを読む', 'フォントを埋め込まない日本語の PDF も文字コードの対応表で読む');
    assert.equal(imagesOf(requests[1].messages.at(-1)).length, 2, '文字の無い PDF は札を作らず、ページの画像だけを送る');
    assert.ok(assets.has(target === 'pwa' ? '/magi-app/www/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap' : '/assets/vendor/pdfjs-dist@6.4.299/cmaps/UniJIS-UCS2-H.bcmap'));
    assert.ok(second.reduce((n, p) => n + p.text.length, 0) <= 10000);

    // × で PDF の札を外すと、そのページ画像も一緒に外れる
    await page.locator('#agent-file').setInputFiles([{ name: 'remove.pdf', mimeType: 'application/pdf', buffer: pdf(['one', 'two']) }]);
    await page.waitForFunction(() => document.querySelectorAll('#agent-attach-tray .attach-chip').length === 3);
    await page.locator('#agent-attach-tray .attach-chip:has(.attach-doc) .attach-x').click();
    assert.equal(await page.locator('#agent-attach-tray .attach-chip').count(), 0);
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
} finally { await browser.close(); }
console.log('attachment browser checks passed');
