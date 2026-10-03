// 本番の設定（magi2 のサイト案内・討議の判定・言語の判定）をスモークテストへ渡す。スキーマをPython側へ複製しない。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ');
vm.runInContext(strip(read('workers/magi2/languages.js')) + '\n' + strip(read('workers/magi2/personas.js'))
  + '\nglobalThis.config = { model: SITE_SEARCH.model, temperature: SITE_SEARCH.temperature, top_p: DEFAULTS.top_p, chat_max_tokens: SITE_SEARCH.chat_max_tokens, formats: SITE_SEARCH.formats,'
  + ' judge: { model: DEFAULTS.models.judge, format: DEBATE.format },'
  + ' language: { endpoint: LANGUAGE_DETECT.endpoint, instructions: LANGUAGE_DETECT.instructions,'
  + '   criteria: Object.fromEntries(Object.entries(LANGUAGE_DETECT.languages).map(([code, l]) => [code, l.criteria])) } };', ctx);
process.stdout.write(JSON.stringify(ctx.config));
