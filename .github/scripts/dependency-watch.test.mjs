// APIへ送らず、検出漏れにつながる境界と通知の重複・誤解除を確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory, nodeFindings, vulnerabilityFindings, scan } from './dependency-watch.mjs';

const schedule = { v24: { end: '2028-04-30' } };
const releases = [
  { version: 'v24.22.2', date: '2026-10-26', security: true },
  { version: 'v24.22.1', date: '2026-10-21', security: true },
  { version: 'v24.23.0', date: '2026-10-23', security: false },
  { version: 'v24.22.0', date: '2026-10-14', security: false },
  { version: 'v26.10.0', date: '2026-10-21', security: true },
];

test('同じメジャーの最新版と途中のセキュリティ修正を検出し、未来の日付は除く', () => {
  const findings = nodeFindings('24.22.0', releases, schedule, '2026-10-24');
  assert.equal(findings.length, 1);
  assert.match(findings[0], /セキュリティ更新.*24\.23\.0/);
  assert.doesNotMatch(findings[0], /26\.10|24\.22\.2/);
  assert.deepEqual(nodeFindings('24.23.0', releases, schedule, '2026-10-24'), []);
});

test('期限90日前・終了済み・公式一覧にない版・不正な応答を区別する', () => {
  assert.match(nodeFindings('24.23.0', releases, schedule, '2028-02-01')[0], /90日以内/);
  assert.match(nodeFindings('24.23.0', releases, schedule, '2028-05-01')[0], /終了済み/);
  assert.throws(() => nodeFindings('24.99.0', releases, schedule, '2026-10-24'), /公式一覧/);
  assert.throws(() => nodeFindings('24', releases, schedule), /不正/);
  assert.throws(() => nodeFindings('24.23.0', releases, {}), /公式データ/);
});

test('実ファイルからnpm間接依存・scoped vendor・readability・Pythonを拾う', () => {
  const packages = inventory();
  assert.ok(packages.length > 100);
  assert.ok(packages.some(p => p.name.startsWith('@') && p.sources.includes('assets/vendor/SOURCES.json')));
  assert.ok(packages.some(p => p.name === '@mozilla/readability' && p.sources.includes('magi-app/www/vendor/SOURCES.json')));
  assert.ok(packages.some(p => p.ecosystem === 'PyPI' && p.name === 'SudachiPy'));
  assert.ok(packages.some(p => p.name === 'pdfjs-dist' && p.sources.includes('assets/vendor/SOURCES.json')));
  assert.equal(new Set(packages.map(p => JSON.stringify([p.ecosystem, p.name, p.version]))).size, packages.length);
});

const packages = [{ ecosystem: 'npm', name: 'sample', version: '1.0.0', sources: ['fixture'] }];

test('OSVのページ送りと重複ID・取り下げ済み情報を扱う', async () => {
  let calls = 0;
  const result = await vulnerabilityFindings(packages, async (url, body) => {
    calls++;
    if (url.endsWith('querybatch')) return { results: [{ vulns: [{ id: 'GHSA-test' }], next_page_token: 'page2' }] };
    assert.equal(body.page_token, 'page2');
    return { vulns: [{ id: 'GHSA-test' }, { id: 'CVE-test' }, { id: 'withdrawn', withdrawn: '2026-01-01' }] };
  });
  assert.equal(calls, 2);
  assert.equal(result.length, 1);
  assert.match(result[0], /CVE-test/);
  assert.equal(result[0].match(/\[GHSA-test\]/g).length, 1);
  assert.doesNotMatch(result[0], /withdrawn/);
});

test('OSVの欠落・エラー・循環するページ・通信失敗を見逃さない', async () => {
  for (const response of [{}, { results: [] }, { results: [null] }, { results: [{ error: 'bad' }] }]) {
    await assert.rejects(vulnerabilityFindings(packages, async () => response));
  }
  await assert.rejects(vulnerabilityFindings(packages, async url => url.endsWith('querybatch')
    ? { results: [{ next_page_token: 'same' }] } : { next_page_token: 'same' }), /繰り返/);
  await assert.rejects(vulnerabilityFindings(packages, async () => { throw new Error('offline'); }), /offline/);
  const report = await scan({ request: async () => { throw new Error('offline'); } });
  assert.equal(report.errors.length, 2);
  assert.deepEqual(report.checked, []);
});

const publish = createRequire(import.meta.url)('./publish-dependency-watch.cjs');

test('通知は新規・変化時だけ。検査エラーがあればIssueを閉じず、完全解消で閉じる', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-watch-'));
  const previous = process.env.DEPENDENCY_REPORT;
  process.env.DEPENDENCY_REPORT = path.join(temp, 'report.json');
  let issue;
  const events = [];
  const github = {
    paginate: async () => issue ? [issue] : [],
    rest: { issues: {
      listForRepo: {},
      create: async data => { issue = { ...data, number: 1, user: { login: 'github-actions[bot]' } }; events.push('create'); },
      update: async data => { issue = { ...issue, ...data }; events.push(data.state === 'closed' ? 'close' : 'update'); },
      createComment: async () => { events.push('comment'); },
    } },
  };
  const args = { github, context: { repo: { owner: 'sample', repo: 'test' }, serverUrl: 'https://github.com', runId: 1 }, core: { info() {} } };
  const write = report => fs.writeFileSync(process.env.DEPENDENCY_REPORT, JSON.stringify(report));
  try {
    write({ findings: ['finding'], errors: [], checked: ['check'] });
    await publish(args);
    await publish(args);
    assert.deepEqual(events, ['create']);
    write({ findings: [], errors: ['offline'], checked: [] });
    await publish(args);
    assert.deepEqual(events, ['create', 'update', 'comment']);
    fs.unlinkSync(process.env.DEPENDENCY_REPORT);
    await publish(args);
    assert.ok(!events.includes('close'));
    write({ findings: [], errors: [], checked: ['check'] });
    await publish(args);
    assert.equal(events.at(-1), 'close');
  } finally {
    if (previous === undefined) delete process.env.DEPENDENCY_REPORT;
    else process.env.DEPENDENCY_REPORT = previous;
    // 自分で作成したファイルだけを消す。ほかのファイルがあればフォルダは消さない。
    fs.unlinkSync(path.join(temp, 'report.json'));
    fs.rmdirSync(temp);
  }
});
