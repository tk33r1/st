// 本番の設定をスモークテストへ渡す。スキーマをPython側へ複製しない。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
vm.runInContext(read('workers/magi2/personas.js').replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ')
  + '\nglobalThis.config = { model: SITE_SEARCH.model, temperature: SITE_SEARCH.temperature, top_p: DEFAULTS.top_p, chat_max_tokens: SITE_SEARCH.chat_max_tokens, formats: SITE_SEARCH.formats };', ctx);
process.stdout.write(JSON.stringify(ctx.config));
