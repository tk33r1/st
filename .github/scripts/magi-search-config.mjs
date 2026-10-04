// 本番の設定（magi2 のサイト案内・討議の判定・言語の判定）をスモークテストへ渡す。スキーマをPython側へ複製しない。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(strip(read('workers/magi2/languages.js')) + '\n' + strip(read('workers/magi2/personas.js'))
  + '\n' + strip(read('workers/magi2/classification.js'))
  + '\nglobalThis.config = { model: SITE_SEARCH.model, temperature: SITE_SEARCH.temperature, top_p: DEFAULTS.top_p, chat_max_tokens: SITE_SEARCH.chat_max_tokens, formats: SITE_SEARCH.formats,'
  + ' judge: { model: DEFAULTS.models.judge, format: DEBATE.format },'
  + ' classify: INTENT_CLASSIFY, classify_smoke: ['
  + ' { input: { texts: ["Should I go for ramen tonight?"], seed: "日本語で話したいです。" }, expected: { language: "ja", votable: "yes", intent: "consult" } },'
  + ' { input: { texts: ["Which songs would you recommend for a DJ set?"], hasLanguage: true }, expected: { intent: "music" } },'
  + ' { input: { profile: "dj-request", texts: ["OK"], seed: "Please help me choose music." }, expected: { language: "en" } },'
  + ' { input: { profile: "legacy", texts: ["DJを始めたい", "OK"] }, expected: { language: "ja" } }'
  + ' ].map(test => ({ payload: classificationPayload(test.input), expected: test.expected })) };', ctx);
process.stdout.write(JSON.stringify(ctx.config));
