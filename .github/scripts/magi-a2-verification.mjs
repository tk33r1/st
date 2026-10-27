// 出典の番号検査と最終本文の組立てを本番から読む。ネットワーク・キーを持たない再生用。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {loadMagiWorker} from './magi-worker-vm.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const ctx=loadMagiWorker({fetch(){throw new Error('Network is disabled in recorded verification replay.');}});
ctx.cards=Object.fromEntries(Object.entries(JSON.parse(read('data/magi-context.json')).personas).map(([n,v])=>[n,v.card]));
vm.runInContext(`globalThis.build=(question,draft,evidence,language,theme,date)=>{
  const cards=Object.fromEntries(Object.entries(globalThis.cards).map(([n,v])=>[n,v.slice(0,PERSONA_CONTEXT.max_chars)]));
  const messages=factAnswerMessages({cards,messages:[{role:'user',content:question}],
    langNote:languageNote(language),theme,research:true});
  const request=researchVerificationRequest({...DEFAULTS.models.synthesizer,reasoning_effort:RESEARCH.reasoning_effort},
    researchMessages(messages,new Date(date)),new Date(date),{text:draft},evidence,language);
  return requestBody(request.cfg,{messages:request.messages,stream:false,response_format:request.response_format});
};`,ctx);
// 再生の記録には、照合の不正を封筒の code で残す（従来の記録と同じ値）。
export const verifiedResearchResult=(value,evidence,replyLanguage)=>{
  try{return JSON.parse(JSON.stringify(ctx.verifiedResearchResult(value,evidence,replyLanguage)));}
  catch(error){throw error.envelope?new Error(error.envelope.code):error;}
};
export const recordedVerificationRequest=(...args)=>JSON.parse(JSON.stringify(ctx.build(...args)));
