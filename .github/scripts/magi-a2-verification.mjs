// 出典の番号検査と最終本文の組立てを本番から読む。ネットワーク・キーを持たない再生用。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const ctx=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),URL,
  fetch(){throw new Error('Network is disabled in recorded verification replay.');}});
vm.runInContext(['languages.js','personas.js','classification.js'].map(p=>strip(read('workers/magi2/'+p))).join('\n'),ctx);
vm.runInContext(strip(read('workers/magi2/research.js')),ctx);
const worker=read('workers/magi2/src/index.js'),start=worker.indexOf('function researchVerificationFormat('),end=worker.indexOf('async function verifyResearchAnswer(');
if(start<0||end<=start)throw new Error('Verification block not found');
// 出典検査が共用するキー検査も、本番と同じ定義を読む。
vm.runInContext(worker.slice(worker.indexOf('const exactKeys ='),worker.indexOf('const questionText =')),ctx);
vm.runInContext(worker.slice(start,end)+'\nfunction stageError(_stage,code){return new Error(code);}\nglobalThis.validate=verifiedResearchResult;',ctx);
const begin=worker.indexOf('function requestBody('),finish=worker.indexOf('\nasync function callModel(',begin);
vm.runInContext(worker.slice(begin,finish),ctx);
vm.runInContext(worker.slice(worker.indexOf('function researchMessages('),worker.indexOf('// pause_turnで送り返す')),ctx);
vm.runInContext(worker.slice(worker.indexOf('const withLangNote ='),worker.indexOf('\n',worker.indexOf('const withLangNote ='))),ctx);
vm.runInContext(worker.slice(worker.indexOf('const withCard ='),worker.indexOf('// 統合の本文と正常',worker.indexOf('const withCard ='))),ctx);
vm.runInContext(worker.slice(worker.indexOf('function factAnswerMessages('),worker.indexOf('async function runFactAnswer(')),ctx);
ctx.cards=Object.fromEntries(Object.entries(JSON.parse(read('data/magi-context.json')).personas).map(([n,v])=>[n,v.card]));
vm.runInContext(`globalThis.build=(question,draft,evidence,language,theme,date)=>{
  const cards=Object.fromEntries(Object.entries(globalThis.cards).map(([n,v])=>[n,v.slice(0,PERSONA_CONTEXT.max_chars)]));
  const messages=factAnswerMessages({cards,messages:[{role:'user',content:question}],
    langNote:languageNote(language),theme,research:true});
  const request=researchVerificationRequest({...DEFAULTS.models.synthesizer,reasoning_effort:RESEARCH.reasoning_effort},
    researchMessages(messages,new Date(date)),new Date(date),{text:draft},evidence,language);
  return requestBody(request.cfg,{messages:request.messages,stream:false,response_format:request.response_format});
};`,ctx);
export const verifiedResearchResult=(value,evidence,replyLanguage)=>JSON.parse(JSON.stringify(ctx.validate(value,evidence,replyLanguage)));
export const recordedVerificationRequest=(...args)=>JSON.parse(JSON.stringify(ctx.build(...args)));
