import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';

const source = readFileSync(new URL('../../magi-app/www/native-history.js', import.meta.url), 'utf8');
function fixture() {
  const disk = nativeFilesystemFixture(), values = new Map(), errors = [];
  const legacy = { getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
  const ctx = vm.createContext({ crypto: webcrypto, FileReader: class { readAsDataURL(blob) { blob.arrayBuffer().then(b => { this.result = 'data:image/png;base64,' + Buffer.from(b).toString('base64'); this.onload(); }); } } });
  vm.runInContext(source, ctx);
  const cleanHistory = h => Array.isArray(h) ? h.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' || m?.role === 'user' && Array.isArray(m.content)) : [];
  const create = () => ctx.MagiNativeHistory.create({ fs: disk.fs, legacy, cleanHistory, onError: e => errors.push(e) });
  const seed = () => {
    values.set('magi_saved_sessions', JSON.stringify([{ id: 'session_1', title: '題名', timestamp: 10, history: [{ role: 'user', content: '質問' }, { role: 'assistant', content: '回答', mode: 'fact', closed: true }], reply_language: { version: 1, code: 'ja', source: 'ui' } }]));
    values.set('magi_current_history', JSON.parse(values.get('magi_saved_sessions'))[0] && JSON.stringify(JSON.parse(values.get('magi_saved_sessions'))[0].history));
    values.set('magi_current_session_id', 'session_1'); values.set('magi_current_title', '題名');
    values.set('magi_current_language', JSON.stringify({ id: 'session_1', reply_language: { version: 1, code: 'ja', source: 'ui' } }));
    values.set('magi_theme', 'dark');
  };
  return { ...disk, values, errors, create, seed };
}
test('B1: 全履歴・題名・言語を移し替え、再起動で繰り返さず設定を保持', async () => {
  const f = fixture(); f.seed(); const before = new Map(f.values), store = f.create();
  assert.equal(await store.init(), true);
  for (const [key, value] of before) if (key !== 'magi_theme') { assert.equal(store.get(key), value); assert.equal(f.values.has(key), false); }
  assert.equal(f.values.get('magi_theme'), 'dark');
  const next = f.create(); await next.init();
  for (const [key, value] of before) if (key !== 'magi_theme') assert.equal(next.get(key), value);
});
for (const method of ['write', 'rename', 'read']) test('B1: 移行の' + method + '失敗で元データ保持、次回再試行', async () => {
  const f = fixture(); f.seed(); const before = [...f.values]; f.setFailure(m => m === method);
  assert.equal(await f.create().init(), false); assert.deepEqual([...f.values], before);
  assert.equal(f.files.has('DATA:magi/meta.json'), false);
  f.setFailure(null); assert.equal(await f.create().init(), true);
});
test('B1: 読み直しの不一致でも元データを消さない', async () => {
  const f = fixture(); f.seed(); const read = f.fs.readFile;
  f.fs.readFile = async o => o.path === 'magi/current.json' ? { data: '{}' } : read(o);
  assert.equal(await f.create().init(), false); assert.ok(f.values.has('magi_current_history'));
});
test('B1: 壊れた履歴の項目を除去し、正常な会話は保存', async () => {
  const f = fixture(); f.seed(); f.values.set('magi_current_history', JSON.stringify([{ role: 'invalid', content: 9 }, { role: 'user', content: '正常' }]));
  const s = f.create(); await s.init(); assert.deepEqual(JSON.parse(s.get('magi_current_history')), [{ role: 'user', content: '正常' }]);
});
test('B1: 一時ファイルのrename失敗でも旧版を維持し、journalで再起動復旧', async () => {
  const f = fixture(); f.seed(); const s = f.create(); await s.init();
  const before = f.files.get('DATA:magi/current.json');
  f.setFailure((m, p) => m === 'rename' && p === 'magi/current.json');
  s.set('magi_current_title', '変更後'); await assert.rejects(s.flush());
  assert.equal(f.files.get('DATA:magi/current.json'), before);
  assert.ok(f.files.has('DATA:magi/pending.json'));
  f.setFailure(null); const next = f.create(); await next.init(); assert.equal(next.get('magi_current_title'), '変更後');
  assert.ok(f.operations.some(([m, p]) => m === 'write' && p === 'magi/current.json.tmp'));
});
test('B1: 移行済みファイルのI/O失敗で古いlocalStorageへ戻して上書きしない', async () => {
  const f = fixture(); f.seed(); await f.create().init(); f.setFailure(m => m === 'read');
  await assert.rejects(f.create().init());
});
test('B1: 完了印の直後に終了して残ったlocalStorageを次の起動で片付ける', async () => {
  const f = fixture(); f.seed(); await f.create().init();
  f.values.set('magi_current_title', '旧項目');
  const s = f.create(); await s.init(); assert.equal(s.get('magi_current_title'), '題名');
  assert.equal(f.values.has('magi_current_title'), false);
});
test('B1: 再送用に戻した画像を保持し、下書きを破棄すると消す', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const name = await s.storeImage(new Blob(['draft'], { type: 'image/png' }));
  s.set('magi_current_history', JSON.stringify([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'thumb' }, file: name }] }])); await s.flush();
  s.retainImage(name); s.set('magi_current_history', '[]'); await s.flush();
  assert.ok(f.files.has('DATA:magi/images/' + name));
  s.releaseImage(name); await s.flush(); assert.equal(f.files.has('DATA:magi/images/' + name), false);
});

test('B1: 古い保存が遅れても、新しい発言へ移した元画像を整理で消さない', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const name = await s.storeImage(new Blob(['original'], { type: 'image/png' })); s.retainImage(name);
  let entered, resume; const reached = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { resume = resolve; }), rename = f.fs.rename;
  let first = true;
  f.fs.rename = async options => {
    if (first && options.to === 'magi/current.json') { first = false; entered(); await held; }
    return rename(options);
  };
  s.set('magi_current_title', 'old batch'); await reached;
  s.set('magi_current_history', JSON.stringify([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' }, file: name }] }]));
  s.releaseImage(name); resume(); await s.flush();
  assert.equal(f.files.has('DATA:magi/images/' + name), true);
  assert.equal(JSON.parse(f.files.get('DATA:magi/current.json')).history[0].content[0].file, name);
});
test('B1: 6MB超・60会話を保持し、書き出しに画像本体を含めない', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const sessions = Array.from({ length: 60 }, (_, n) => ({ id: 'session_' + n, title: '会話' + n, history: [{ role: 'user', content: '文'.repeat(120000) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }));
  s.set('magi_saved_sessions', JSON.stringify(sessions)); await s.flush();
  assert.ok(await s.usage() > 6000000);
  const next = f.create(); await next.init(); assert.equal(JSON.parse(next.get('magi_saved_sessions')).length, 60);
  const exported = JSON.stringify(await next.exportData()); assert.ok(!exported.includes('data:image/')); assert.ok(exported.includes('[Image omitted]'));
});
test('B1: 元画像は同内容で1ファイル、参照する最後の会話を消した時だけ削除', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const blob = new Blob(['original image'], { type: 'image/png' });
  const name = await s.storeImage(blob); assert.equal(await s.storeImage(blob), name);
  assert.equal([...f.files.keys()].filter(k => k.includes('/images/')).length, 1);
  const session = id => ({ id, history: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' }, file: name }] }] });
  s.set('magi_saved_sessions', JSON.stringify([session('one'), session('two')])); await s.flush();
  s.set('magi_saved_sessions', JSON.stringify([session('two')])); await s.flush(); assert.ok(f.files.has('DATA:magi/images/' + name));
  s.set('magi_saved_sessions', '[]'); await s.flush(); assert.equal(f.files.has('DATA:magi/images/' + name), false);
  await s.clear(); assert.equal([...f.files.keys()].some(k => k.includes('/images/') || k.includes('/sessions/')), false);
  assert.deepEqual([...f.files.keys()].sort(), ['DATA:magi/current.json', 'DATA:magi/index.json', 'DATA:magi/meta.json']);
  const next = f.create(); await next.init(); assert.equal(next.get('magi_saved_sessions'), '[]');
});

test('B1: 全削除後に作った会話・画像・資料を再起動しても保持する', async () => {
  const f = fixture(); f.seed(); const s = f.create(); await s.init(); await s.clear();
  const empty = f.create(); await empty.init(); assert.equal(empty.get('magi_saved_sessions'), '[]');
  const name = await s.storeImage(new Blob(['new image'], { type: 'image/png' }));
  const history = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'thumb' }, file: name }] }, { role: 'assistant', content: '新しい回答' }];
  const shared = { title: '新しい資料', url: '', text: '本文' };
  s.set('magi_saved_sessions', JSON.stringify([{ id: 'after_clear', title: '新しい会話', history, shared }]));
  s.set('magi_current_history', JSON.stringify(history)); s.set('magi_current_session_id', 'after_clear');
  s.set('magi_current_shared', JSON.stringify(shared)); await s.flush();
  const next = f.create(); await next.init();
  assert.equal(JSON.parse(next.get('magi_saved_sessions'))[0].id, 'after_clear');
  assert.deepEqual(JSON.parse(next.get('magi_current_history')), history);
  assert.deepEqual(JSON.parse(next.get('magi_current_shared')), shared);
  assert.ok(f.files.has('DATA:magi/images/' + name));
});

for (const failure of ['partial_write', 'journal_cleanup']) test('B1: 保存失敗後に変更前へ戻して保存すると古いjournalを残さない (' + failure + ')', async () => {
  const f = fixture(); f.seed(); const s = f.create(); await s.init();
  const before = s.get('magi_saved_sessions'), title = s.get('magi_current_title');
  const changed = JSON.parse(before); changed[0].title = '変更後';
  f.setFailure((method, path) => failure === 'partial_write' ? method === 'rename' && path === 'magi/current.json' : method === 'delete' && path === 'magi/pending.json');
  s.set('magi_saved_sessions', JSON.stringify(changed)); s.set('magi_current_title', '変更後');
  await assert.rejects(s.flush()); assert.ok(f.files.has('DATA:magi/pending.json'));
  f.setFailure(null); s.set('magi_saved_sessions', before); s.set('magi_current_title', title); await s.flush();
  assert.equal(f.files.has('DATA:magi/pending.json'), false);
  const next = f.create(); await next.init();
  assert.equal(next.get('magi_saved_sessions'), before); assert.equal(next.get('magi_current_title'), title);
});
test('B2: 共有資料は会話JSONとcurrentへ保存し、再起動後も復元する', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const shared = { title: '共有記事', url: 'https://example.com/', text: '共有した本文' };
  s.set('magi_saved_sessions', JSON.stringify([{ id: 'shared_chat', title: '会話', history: [{ role: 'user', content: '要点は？' }], shared }]));
  s.set('magi_current_shared', JSON.stringify(shared)); await s.flush();
  assert.ok(!f.files.get('DATA:magi/index.json').includes('共有した本文'));
  const next = f.create(); await next.init();
  assert.deepEqual(JSON.parse(next.get('magi_current_shared')), shared);
  assert.deepEqual(JSON.parse(next.get('magi_saved_sessions'))[0].shared, shared);
});
test('B1: 変わった会話だけを書き直し、顔ぶれが同じなら片付けでディレクトリを読まない', async () => {
  const f = fixture(), s = f.create(); await s.init();
  s.setSessions(Array.from({ length: 3 }, (_, n) => ({ id: 'session_' + n, title: '会話' + n, history: [{ role: 'user', content: '質問' + n }] })));
  await s.flush();
  const list = s.sessions(); f.operations.length = 0;
  list[1] = { ...list[1], title: '変更後' }; s.setSessions(list); await s.flush();
  assert.deepEqual(f.operations.filter(([m]) => m === 'write').map(([, p]) => p).sort(), ['magi/index.json.tmp', 'magi/pending.json.tmp', 'magi/sessions/session_1.json.tmp']);
  assert.equal(f.operations.some(([m]) => m === 'readdir'), false);
  s.setSessions(s.sessions().filter(x => x.id !== 'session_2')); await s.flush();
  assert.equal(f.files.has('DATA:magi/sessions/session_2.json'), false);
  const next = f.create(); await next.init();
  assert.deepEqual([...next.sessions().map(x => x.title)], ['会話0', '変更後']);
});
test('B1: 画像の保存中に走った保存の片付けが、その画像を消さない', async () => {
  const f = fixture(), s = f.create(); await s.init();
  const blob = new Blob(['racing image'], { type: 'image/png' });
  let openBytes, openList, listing;
  const bytesGate = new Promise(r => { openBytes = r; }), listGate = new Promise(r => { openList = r; });
  const listed = new Promise(r => { listing = r; });
  const readdir = f.fs.readdir;
  f.fs.readdir = async o => { listing(); await listGate; return readdir(o); };
  const stored = s.storeImage({ type: blob.type, arrayBuffer: () => bytesGate.then(() => blob.arrayBuffer()) });
  s.setSessions([{ id: 'other', title: '別の会話', history: [{ role: 'user', content: '質問' }] }]);
  await listed; openBytes(); await new Promise(r => setTimeout(r, 20)); openList();
  const name = await stored; await s.flush();
  assert.ok(f.files.has('DATA:magi/images/' + name));
});
test('B1: 全削除の保存と同時に頼まれた保存を重ねて走らせない', async () => {
  const f = fixture(); f.seed(); const s = f.create(); await s.init();
  const cleared = s.clear(); s.set('magi_current_title', '削除中の変更');
  await cleared; await s.flush();
  assert.deepEqual(f.errors, []);
  assert.equal([...f.files.keys()].some(k => k.endsWith('.tmp') || k.endsWith('pending.json')), false);
  const next = f.create(); await next.init();
  assert.equal(next.get('magi_current_title'), s.get('magi_current_title'));
  assert.equal(next.get('magi_saved_sessions'), '[]');
});
