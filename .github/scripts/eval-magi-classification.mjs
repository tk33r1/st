// 固定した合成入力で公開前の分類品質を確認する。キー・応答本文は出力しない。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(['languages.js', 'personas.js', 'classification.js'].map(p => strip(read('workers/magi2/' + p))).join('\n')
  + '\nglobalThis.cfg=INTENT_CLASSIFY;globalThis.payload=classificationPayload;globalThis.accept=acceptedChoice;', ctx);
const cfg = ctx.cfg;
let saved = '';
try { saved = read('workers/magi2/.dev.vars'); } catch (_) { /* Actions では環境変数から読む */ }
const key = process.env[cfg.key] || saved.match(/^\s*MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
assert(key, 'TypeSafe key is required');
// 各群20文。ラベルはAPIを呼ぶ前に固定し、失敗後に変更しない。
const groups = {
  consult: [
    'こんにちは', '今日は良い天気ですね', 'おはようございます', 'ありがとう、助かった', '最近ちょっと疲れています',
    'Hello, how are you?', 'Good morning!', 'Thanks, that helps.', 'I had a nice day today.', 'OK, thanks!',
    '転職するか迷っています。判断材料を整理して', '仕事と生活のバランスについて相談したい', '友人との付き合い方に悩んでいます',
    '新しい趣味を始めたいけど迷っています', 'プレゼンで緊張しない方法を考えて',
    'Help me think through a career change.', 'How can I balance work and life?', 'I need advice about a disagreement with a friend.',
    'Help me plan my weekend.', 'How can I feel less nervous during a presentation?',
  ],
  site: [
    'PDFを結合するツールを探している', 'このサイトのゲームを見たい', 'Shinya Takedaのプロフィールを教えて',
    'Shinyaの仕事について教えて', 'ShinyaのDJ活動を紹介して', 'このサイトの技術ブログはどこ？',
    'QRコードを作るページを探して', 'このサイトのお問い合わせ先を教えて', 'ニトリの日刊ニュースを読みたい', 'Shinyaのバイク動画はどこ？',
    'Where can I merge PDF files on this site?', 'Show me the games on this website.', 'Tell me about Shinya Takeda.',
    'What does Shinya do for work?', "Tell me about Shinya's DJ activities.", 'Where is the technical blog on this site?',
    'Find the QR code generator on this website.', 'How do I contact the owner of this site?',
    'Where can I read the daily Nitori news?', "Where are Shinya's motorcycle videos?",
  ],
  music: [
    '今夜聴く曲を3曲おすすめして', 'ドラムンベースのおすすめ曲を教えて', 'ロックとジャズの違いを説明して',
    'BPM120の曲を選びたい', 'DJセットの選曲を相談したい', 'この曲の後に何をかけると良い？',
    'ハウスミュージックの特徴は？', 'ギターを練習する曲を教えて', '朝のプレイリストを作りたい', '静かなピアノ曲をおすすめして',
    'Recommend three songs for tonight.', 'Which drum and bass tracks should I listen to?', 'Explain the difference between rock and jazz.',
    'Help me choose a track around 120 BPM.', 'Help me select music for a DJ set.', 'What song should I play next?',
    'What are the characteristics of house music?', 'Suggest a song for guitar practice.', 'Help me make a morning playlist.',
    'Recommend some quiet piano music.',
  ],
};
const cases = Object.entries(groups).flatMap(([intent, texts]) => texts.map((text, index) => ({
  text, intent, language: index < 10 ? 'ja' : 'en',
})));
// consultの前半は日英が5文ずつ。言語の期待値も先に固定する。
for (let i = 0; i < 20; i++) cases[i].language = i < 5 || (i >= 10 && i < 15) ? 'ja' : 'en';
// 「日刊」と書かないニュースの質問（サイトに日刊ブリーフがあるので site）と、ニトリ・ニュースの語を含む一般の相談（2026-10-08 に追加）
for (const [text, intent, language] of [
  ['ニトリの出店のニュースある？', 'site', 'ja'], ['リテールテックの最新ニュースを教えて', 'site', 'ja'], ['小売のセルフレジの動向は？', 'site', 'ja'],
  ['ニトリの値下げのニュースを知りたい', 'site', 'ja'], ['Any news about Nitori opening new stores?', 'site', 'en'],
  ['ニトリで買ったソファの手入れ方法は？', 'consult', 'ja'], ['ニュースを読む習慣をつけたい', 'consult', 'ja'], ['How do I stop doomscrolling the news?', 'consult', 'en'],
]) cases.push({ text, intent, language });
const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const payload = ctx.payload({ texts: [c.text], seed: c.text });
  const started = performance.now();
  const res = await fetch(cfg.endpoint, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(payload) });
  assert.equal(res.status, 200, 'classification HTTP failure');
  const body = await res.json();
  const answers = Object.fromEntries(Object.keys(payload.questions).map(name => [name, ctx.accept(name, body.answers?.[name])]));
  results.push({ case: i + 1, expected: c.intent, intent: answers.intent || 'consult', language: answers.language,
    expected_language: c.language, site_pages: answers.site_pages, elapsed_ms: Math.round(performance.now() - started),
    votable: answers.votable || 'uncertain',
    confidence: Object.fromEntries(Object.entries(body.answers || {}).map(([name, a]) => [name, a.confidence])), usage: body.usage });
  if ((i + 1) % 20 === 0) console.log(JSON.stringify({ completed: i + 1, total: cases.length }));
}
const mistakes = results.filter(r => r.intent !== r.expected);
const languageErrors = results.filter(r => r.language !== r.expected_language);
const consultWrong = results.filter(r => r.expected === 'consult' && r.intent !== 'consult');
const unrelatedNotNo = results.filter(r => r.expected === 'consult' && r.site_pages !== 'no').length;
const relevantNo = results.filter(r => r.expected === 'site' && r.site_pages === 'no').length;
const times = results.map(r => r.elapsed_ms).sort((a, b) => a - b);
const quantile = (values, fraction) => values[Math.ceil(values.length * fraction) - 1] ?? null;
const confidences = Object.fromEntries(Object.keys(cfg.questions).map(name => {
  const values = results.map(r => r.confidence[name]).filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return [name, { count: values.length, min: values[0] ?? null, median: quantile(values, .5), p90: quantile(values, .9), max: values.at(-1) ?? null }];
}));
const candidates = results.filter(r => r.votable === 'yes').length;
const output = new URL('../../workers/.wrangler/classification-audit.json', import.meta.url);
mkdirSync(new URL('.', output), { recursive: true });
writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), revision: cfg.revision,
  source_hash: createHash('sha256').update(['languages.js', 'personas.js', 'classification.js'].map(p => read('workers/magi2/' + p)).join('\n')).digest('hex'),
  count: results.length, candidate_count: candidates, candidate_rate: candidates / results.length, confidences, results }, null, 2));
console.log(JSON.stringify({ revision: cfg.revision, count: cases.length, intent_mistakes: mistakes,
  language_errors: languageErrors, consult_wrong: consultWrong.length, unrelated_not_no: unrelatedNotNo,
  relevant_no: relevantNo, median_ms: quantile(times, .5), p90_ms: quantile(times, .9), within_budget: times.filter(t => t <= cfg.timeout_ms).length / times.length,
  candidate_count: candidates, candidate_rate: candidates / results.length, confidences,
  relevant_no_cases: results.filter(r => r.expected === 'site' && r.site_pages === 'no').map(r => ({ case: r.case, confidence: r.confidence.site_pages })),
  confusion: Object.fromEntries(Object.keys(groups).map(expected => [expected,
    Object.fromEntries(Object.keys(groups).map(actual => [actual, results.filter(r => r.expected === expected && r.intent === actual).length]))])) }));
assert.equal(consultWrong.length, 0, '通常相談がサイト・音楽へ誤分類されています');
assert(unrelatedNotNo <= 3 && relevantNo === 0, 'サイト案内の分類が公開目標を満たしません');
// 既存の多言語77文の代わりとは扱わない。
