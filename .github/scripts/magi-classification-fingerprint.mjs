// 返答の文面を直しても、判定の問い・入力・言語規則が同じであることを検査する。
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
export function classificationFingerprint() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const read=p=>readFileSync(resolve(root,p),'utf8'), hash=s=>createHash('sha256').update(s).digest('hex');
  const paths=['config/ai-models.json','workers/magi2/languages.js','workers/magi2/personas.js','workers/magi2/classification.js'];
  const contents=paths.map(read);
  const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
  const ctx=vm.createContext({aiModels:JSON.parse(contents[0])});
  vm.runInContext(contents.slice(1).map(strip).join('\n')
    +'\nglobalThis.contract={INTENT_CLASSIFY,REPLY_LANGUAGE,BIDI_CONTROL_CHARS};',ctx);
  return {source_hash:hash(contents.join('\n')),
    contract_hash:hash(contents[0]+'\n'+contents[1]+'\n'+contents[3]+'\n'
      +JSON.stringify(ctx.contract,(_key,value)=>typeof value==='function'?value.toString():value))};
}
