// BALTHASAR-2（Humanist）の第1回・第2回だけを実APIで測る。本番の /magi2/chat をそのまま通し、BALTHASAR の呼び出しだけを
// Anthropic へ送る。ほかの人格・判定・統合・タイトル・予測は固定の応答にする（プロンプトの組み立てを書き写さない）。
// 自分の面の発言だけを書かず、他の面や本人の発言まで書いた件（【MELCHIOR-1】のような話者の札）と、120字の指示を大きく外した件を数える。
// --ref=<git commit> で旧版を読む。--repeat=<n> で各入力を n 回（報告のあった入力は --repeat-reported=<n> 回）。本番DB・生成物は変更しない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url);
const opt=(key,fallback='')=>process.argv.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3)||fallback;
const ref=opt('ref'),label=opt('label',ref?'persona-baseline':'persona-candidate');
const repeat=Number(opt('repeat','3')),repeatReported=Number(opt('repeat-reported','10'));
assert.match(label,/^[a-z0-9-]+$/);assert(Number.isInteger(repeat)&&repeat>=1&&repeat<=10);assert(Number.isInteger(repeatReported)&&repeatReported>=1&&repeatReported<=20);
const current=p=>readFileSync(new URL(p,root),'utf8');
const read=p=>ref?execFileSync('git',['show',ref+':'+p],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}):current(p);
const files=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const key=process.env.MAGI_ANTHROPIC_API_KEY;assert(key,'MAGI_ANTHROPIC_API_KEY is required');

// 固定の応答。他の人格は1人分の短い意見だけを返す
const OTHER={deepseek:'俺は直感で選ぶ。好きな方に飛び込むのが一番だ。',openai:'自分は目的で決める。得たいものが安定なら近い相手、視野なら遠い相手だ。'};
const sse=t=>`data: ${JSON.stringify({choices:[{delta:{content:t},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`;
const anthropicText=t=>Response.json({content:[{type:'text',text:t}],stop_reason:'end_turn',usage:{}});
const isBalthasar=body=>(body.system||[]).some(b=>b.text.includes('「Humanist」（BALTHASAR-2）'));
let calls=[];
const cards=JSON.parse(current('data/magi-context.json'));
const context=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),bundledContext:cards,
 Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,AbortSignal,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
 console:{log(){}},
 fetch:async(url,options)=>{
  url=String(url);
  if(url==='https://tk.st/data/magi-context.json')return Response.json(cards);
  if(/^https:\/\/tk\.st\/data\/[a-z-]+\.json$/.test(url))return Response.json(JSON.parse(current('data/'+url.split('/').at(-1))));
  const body=JSON.parse(options.body);
  if(url.includes('api.anthropic.com')){
   if(isBalthasar(body)){
    const res=await fetch(url,{...options,signal:AbortSignal.timeout(45000)});
    const data=await res.clone().json().catch(()=>null);
    const text=(data?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    calls.push({status:res.status,stop:data?.stop_reason,user:body.messages.at(-1).content.filter(p=>p.type==='text').map(p=>p.text).join(''),text});
    return res;
   }
   if(body.stream)return new Response(`data: ${JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'答え'}})}\n\ndata: ${JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'}})}\n\ndata: {"type":"message_stop"}\n\n`);
   return anthropicText(body.output_config?.format?'{"motion":"","votable":false}':'題');
  }
  if(body.stream)return new Response(sse('答え'));
  if(body.response_format?.json_schema?.name==='debate_judge')return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'十分',action:'answer',questions:[]})}}]});
  if(body.response_format)return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({selections:[]})}}]});
  return Response.json({choices:[{finish_reason:'stop',message:{content:url.includes('deepseek')?OTHER.deepseek:OTHER.openai}}]});
 }});
vm.runInContext(files.map(p=>strip(read('workers/magi2/'+p))).join('\n').replace('export default {','globalThis.worker = {'),context);
const env={MAGI_ANTHROPIC_API_KEY:key,MAGI_OPENAI_API_KEY:'fixture',MAGI_DEEPSEEK_API_KEY:'fixture'};

// 報告のあった入力（2026-10-13、トップページ）と、同じ「どちらを選ぶ」形・ふつうの相談
const reported='異世代の異性の友達が多い\n同世代の同性の友達が多い\nどちらかを選ぶならどっちを選ぶ？';
const inputs=[[reported,repeatReported],...[
 'お金と時間、どちらかしか増やせないならどっちを選ぶ？',
 '住むなら都会と田舎、どっち？',
 '一つの仕事を続けるのと、何度も転職するのと、どっちがいい？',
 'Would you rather have a few close friends or many casual friends?',
 '友人からの誘いを断るのが苦手で、疲れてしまう。関係を大切にしながら伝える方法を相談したい。',
 '寝る前にスマートフォンを別の部屋に置くべき？',
].map(q=>[q,repeat])];
// 他の面や本人の発言を書いた印：行頭の話者の札（【MELCHIOR-1】・CASPER-3: など）
const speaker=/(^|\n)\s*[【\[［]?\s*(MELCHIOR-1|BALTHASAR-2|CASPER-3|Shinya Takeda|Enthusiast|Humanist|Strategist)\s*[】\]］：:]/;
const others=/(^|\n)\s*[【\[［]?\s*(MELCHIOR-1|CASPER-3|Shinya Takeda|Enthusiast|Strategist)\s*[】\]］：:]/;
const results=[];
for(const [id,[q,n]] of inputs.entries())for(let run=1;run<=n;run++){
 calls=[];
 const res=await context.worker.fetch(new Request('https://workers.tk.st/magi2/chat',{method:'POST',
  headers:{Origin:'https://tk.st','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+(1+results.length%200)},
  body:JSON.stringify({messages:[{role:'user',content:q}],theme:'light',suggest:true,site_pages:true,page:'/',adaptive_debate:true})}),env,{waitUntil(){}});
 const stream=await res.text();
 if(calls.some(c=>[401,402,403,429].includes(c.status)))throw new Error('Evaluation stopped at upstream authentication, billing, or rate limit');
 const rounds=calls.map((c,i)=>({round:i+1,status:c.status,stop:c.stop,chars:[...c.text].length,speaker:speaker.test(c.text),others:others.test(c.text),text:c.text}));
 results.push({id:id+1,run,input:q,done:/event: done/.test(stream),rounds});
 console.log(JSON.stringify({label,id:id+1,run,done:results.at(-1).done,rounds:rounds.map(r=>({round:r.round,status:r.status,chars:r.chars,speaker:r.speaker,others:r.others}))}));
}
const r1=results.map(r=>r.rounds[0]).filter(Boolean),r2=results.map(r=>r.rounds[1]).filter(Boolean);
const count=(list,f)=>list.filter(f).length;
const summary={label,ref:ref||'working-tree',date:new Date().toISOString(),runs:results.length,
 r1:{total:r1.length,others:count(r1,r=>r.others),speaker_tag:count(r1,r=>r.speaker),over_200_chars:count(r1,r=>r.chars>200)},
 r2:{total:r2.length,others:count(r2,r=>r.others),speaker_tag:count(r2,r=>r.speaker),over_200_chars:count(r2,r=>r.chars>200)},
 reported:{total:repeatReported,r1_others:count(results.filter(r=>r.id===1),r=>r.rounds[0]?.others)}};
const directory=new URL('workers/.wrangler/magi-persona/',root);mkdirSync(directory,{recursive:true});
writeFileSync(new URL(label+'.json',directory),JSON.stringify({...summary,results},null,2)+'\n');
console.log('SUMMARY '+JSON.stringify(summary));
