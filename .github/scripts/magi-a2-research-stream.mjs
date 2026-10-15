// 本番の読取と設定を使う。評価側に出典の上限・変換を複製しない。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
const ctx = vm.createContext({aiModels: JSON.parse(read('config/ai-models.json')), URL});
vm.runInContext(['languages.js','personas.js','research.js'].map(p => strip(read('workers/magi2/' + p))).join('\n')
  + '\nglobalThis.read=researchReader;globalThis.error=ResearchStreamError;globalThis.max=RESEARCH.sources_max;',ctx);
export const ResearchStreamError = ctx.error;
export const researchReader = (provider, onText = () => {}) => {
  const reader = ctx.read(provider, onText, ctx.max);
  return { push: event => reader.push(event), get paused() { return reader.paused; },
    beginTurn: () => reader.beginTurn(), finish: () => JSON.parse(JSON.stringify(reader.finish())) };
};
