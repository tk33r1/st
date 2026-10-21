import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../magi-app/www/native-input.js', import.meta.url), 'utf8');
function fixture() {
  const events = {}, calls = [], timers = new Map(); let generation = 0, draft = '', shared = null, interim = '', permission = 'granted';
  const cap = { Plugins: {
    MagiShare: { addListener: async () => ({ remove() {} }), takeShare: async () => ({}), releaseShare: async o => calls.push(['release', o]), getArticle: async () => { throw new Error('fixture unavailable'); } },
    SpeechRecognition: {
      available: async () => ({ available: true }), checkPermissions: async () => ({ speechRecognition: permission }), requestPermissions: async () => ({ speechRecognition: permission }),
      getSupportedLanguages: async () => { throw new Error('Android 13+'); },
      start: async o => calls.push(['start', o]), stop: async () => calls.push(['stop']),
      addListener: async (name, fn) => { events[name] = event => fn({ sessionId: calls.filter(([n]) => n === 'start').at(-1)?.[1].sessionId, ...event }); return { remove() {} }; }
    }
  } };
  const context = vm.createContext({ URL, Uint8Array, TextDecoder, atob, navigator: { language: 'ja-JP' }, setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  const input = context.MagiNativeInput.create({ cap,
    beginShare() { generation++; draft = ''; shared = null; }, generation: () => generation,
    setDraft(text) { draft = text; }, appendDraft(text) { draft += text; }, setShared(value) { shared = value; },
    notice(text) { calls.push(['notice', text]); }, attach: async files => calls.push(['attach', files]),
    interim(text) { interim = text; }, voiceState(on) { calls.push(['voiceState', on]); }
  });
  return { input, cap, events, calls, timers, api: context.MagiNativeInput, get draft() { return draft; }, get shared() { return shared; }, get interim() { return interim; }, setPermission(value) { permission = value; } };
}
test('B2: URLは私用IPv4・IPv6・localhost・認証・別schemeを拒み公開URLは許す', () => {
  const { api } = fixture();
  for (const url of ['file:///etc/passwd', 'content://image', 'https://localhost/', 'https://a.localhost./', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.0.1/', 'https://169.254.2.1/', 'https://[::]/', 'https://[::1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/', 'https://u:p@example.com/']) assert.equal(api.publicUrl(url), null, url);
  for (const url of ['https://example.com/', 'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/']) assert.ok(api.publicUrl(url), url);
});
test('B2: charsetはHTTP、meta、UTF-8の順でShift_JISとEUC-JPを読む', () => {
  const { api } = fixture();
  const encoded = (hex, contentType) => ({ base64: Buffer.from(hex, 'hex').toString('base64'), contentType });
  assert.equal(api.decodePage(encoded('93fa967b8cea', 'text/html; charset=Shift_JIS')), '日本語');
  assert.equal(api.decodePage(encoded('c6fccbdcb8ec', 'text/html; charset=EUC-JP')), '日本語');
  const meta = Buffer.concat([Buffer.from('<meta charset="Shift_JIS">'), Buffer.from('93fa967b8cea', 'hex')]);
  assert.ok(api.decodePage({ base64: meta.toString('base64'), contentType: 'text/html' }).endsWith('日本語'));
  assert.equal(api.decodePage({ base64: Buffer.from('日本語').toString('base64'), contentType: 'text/html' }), '日本語');
});
test('B2: 文字共有は新規の下書きだけ、長文は6000字の資料にする', async () => {
  const f = fixture(); await f.input.receive({ text: '共有した質問', images: [] }); assert.equal(f.draft, '共有した質問'); assert.equal(f.shared, null);
  await f.input.receive({ text: 'あ'.repeat(7000), images: [] }); assert.equal(f.draft, ''); assert.equal(f.shared.text.length, 6000);
  assert.ok(!f.calls.some(([name]) => name === 'start' || name === 'send'));
});
test('B2: 私用URLは取得せず、取得失敗でもURLの下書きを保つ', async () => {
  const f = fixture(); let gets = 0; f.cap.Plugins.MagiShare.getArticle = async () => { gets++; throw new Error('timeout'); };
  await f.input.receive({ text: 'http://127.0.0.1/', images: [] }); assert.equal(gets, 0);
  await f.input.receive({ text: 'https://example.com/', images: [] }); assert.equal(gets, 1); assert.equal(f.draft, 'https://example.com/');
});
test('B2: 音声の途中結果は薄い表示だけ、確定結果で下書きに追加し送信しない', async () => {
  const f = fixture(); await f.input.init(); await f.input.startVoice();
  assert.equal(f.calls.find(([n]) => n === 'start')[1].language, 'ja-JP');
  f.events.partialResults({ matches: ['途中'] }); assert.equal(f.interim, '途中'); assert.equal(f.draft, '');
  f.events.partialResults({ matches: ['確定した文章'], final: true }); assert.equal(f.draft, '確定した文章'); assert.equal(f.interim, '');
  assert.equal(f.timers.size, 0);
});
test('B2: マイク拒否では認識せず設定案内を出す', async () => {
  const f = fixture(); f.setPermission('denied'); await f.input.init(); await f.input.startVoice();
  assert.ok(!f.calls.some(([n]) => n === 'start')); assert.ok(f.calls.some(([n, text]) => n === 'notice' && text.includes('許可が必要')));
});
test('B2: 音声認識のサービスが無い環境ではマイクを出さず、開始を求められたら使えないと知らせる', async () => {
  const f = fixture(); f.cap.Plugins.SpeechRecognition.available = async () => ({ available: false }); await f.input.init();
  assert.equal(await f.input.voiceAvailable(), false); await f.input.startVoice();
  assert.ok(!f.calls.some(([n]) => n === 'start' || n === 'voiceState')); assert.ok(f.calls.some(([n, text]) => n === 'notice' && text.includes('音声入力を使えません')));
  f.cap.Plugins.SpeechRecognition.available = async () => { throw new Error('service_missing'); }; assert.equal(await f.input.voiceAvailable(), false);
  assert.equal(await fixture().input.voiceAvailable(), true);
});
for (const detectedBy of ['language_list', 'recognition_error']) test('B2: 非対応言語は英語で1回だけ切り替える (' + detectedBy + ')', async () => {
  const f = fixture();
  if (detectedBy === 'language_list') f.cap.Plugins.SpeechRecognition.getSupportedLanguages = async () => ({ languages: ['en-US'] });
  await f.input.init(); await f.input.startVoice();
  await f.events.recognitionError({ code: 12 }); await f.events.recognitionError({ code: 13 });
  const starts = f.calls.filter(([n]) => n === 'start');
  assert.deepEqual(starts.map(([, options]) => options.language), detectedBy === 'language_list' ? ['en-US'] : ['ja-JP', 'en-US']);
  assert.equal(f.calls.filter(([n, text]) => n === 'notice' && text.includes('Using English')).length, 1);
  assert.equal(f.timers.size, 0);
});
test('B2: 会話切替や停止の後に届く音声結果を入力へ戻さない', async () => {
  const f = fixture(); await f.input.init(); await f.input.startVoice(); await f.input.stopVoice();
  f.events.partialResults({ matches: ['古い結果'], final: true }); assert.equal(f.draft, '');
});

test('B2: 停止応答を待つ間と次の録音中にも古い認識結果・エラーを無視する', async () => {
  const f = fixture(); let releaseStop;
  f.cap.Plugins.SpeechRecognition.stop = () => new Promise(resolve => { releaseStop = resolve; });
  await f.input.init(); await f.input.startVoice();
  const oldSession = f.calls.find(([n]) => n === 'start')[1].sessionId;
  const stopping = f.input.stopVoice();
  assert.deepEqual(f.calls.at(-1), ['voiceState', false]); assert.equal(f.timers.size, 0);
  await f.input.receive({ text: '新しい会話', images: [] });
  f.events.partialResults({ sessionId: oldSession, matches: ['古い確定'], final: true });
  assert.equal(f.draft, '新しい会話');
  await f.input.startVoice();
  const currentSession = f.calls.filter(([n]) => n === 'start').at(-1)[1].sessionId;
  assert.notEqual(currentSession, oldSession);
  f.events.partialResults({ sessionId: oldSession, matches: ['古い途中'] });
  await f.events.recognitionError({ sessionId: oldSession, code: 12 });
  assert.equal(f.interim, ''); assert.equal(f.calls.filter(([n]) => n === 'start').length, 2);
  releaseStop(); await stopping;
  f.events.partialResults({ sessionId: currentSession, matches: ['新しい音声'], final: true });
  assert.equal(f.draft, '新しい会話新しい音声'); assert.equal(f.timers.size, 0);
});

test('B2: 停止した認識開始の応答が遅れて失敗しても次の録音を終了しない', async () => {
  const f = fixture(); let rejectStart;
  f.cap.Plugins.SpeechRecognition.start = options => { f.calls.push(['start', options]); return new Promise((_, reject) => { rejectStart = reject; }); };
  await f.input.init(); const first = f.input.startVoice();
  while (!rejectStart) await Promise.resolve();
  await f.input.stopVoice();
  f.cap.Plugins.SpeechRecognition.start = async options => { f.calls.push(['start', options]); };
  await f.input.startVoice(); rejectStart(new Error('old start failed')); await first;
  f.events.partialResults({ matches: ['現在の音声'], final: true });
  assert.equal(f.draft, '現在の音声'); assert.equal(f.calls.some(([n, text]) => n === 'notice' && text.includes('Could not start')), false);
});

test('B2: URLを含む長文は本人の文章を資料にし、記事を取りに行かない', async () => {
  const f = fixture(); let gets = 0; f.cap.Plugins.MagiShare.getArticle = async () => { gets++; return {}; };
  const text = '選んだ抜き出し'.repeat(200) + ' https://example.com/article';
  await f.input.receive({ text, images: [] });
  assert.equal(gets, 0); assert.equal(f.draft, ''); assert.equal(f.shared.text, text);
});
test('B2: 送信などで止めると確定結果を入力へ入れ、届かなければ途中結果を入れる', async () => {
  const f = fixture(); await f.input.init(); await f.input.startVoice();
  f.events.partialResults({ matches: ['途中'] });
  await f.input.finishVoice(); assert.ok(f.calls.some(([n]) => n === 'stop')); assert.equal(f.input.listening(), true);
  f.events.partialResults({ matches: ['確定'], final: true });
  assert.equal(f.draft, '確定'); assert.equal(f.input.listening(), false); assert.equal(f.timers.size, 0);
  await f.input.startVoice(); f.events.partialResults({ matches: ['届かない確定'] });
  await f.input.finishVoice(); [...f.timers.values()].forEach(fn => fn());
  assert.equal(f.draft, '確定届かない確定'); assert.equal(f.interim, ''); assert.equal(f.input.listening(), false);
});
test('B2: 時間切れと認識エラーでも話した途中結果を残す', async () => {
  const f = fixture(); await f.input.init(); await f.input.startVoice();
  f.events.partialResults({ matches: ['長い話'] });
  [...f.timers.values()].forEach(fn => fn()); await Promise.resolve();
  assert.ok(f.calls.some(([n]) => n === 'stop')); assert.ok(f.calls.some(([n, text]) => n === 'notice' && text.includes('timed out')));
  f.events.partialResults({ matches: ['長い話の確定'], final: true }); assert.equal(f.draft, '長い話の確定');
  await f.input.startVoice(); f.events.partialResults({ matches: ['途切れた声'] });
  await f.events.recognitionError({ code: 7 });
  assert.equal(f.draft, '長い話の確定途切れた声');
  assert.equal(f.calls.some(([n, text]) => n === 'notice' && text.includes('without a result')), false);
});
