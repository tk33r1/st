// 3人格（MELCHIOR-1・BALTHASAR-2・CASPER-3）の第1回・第2回だけを実APIで測る。本番の /magi2/chat をそのまま通し、人格の呼び出しだけを
// 各社へ送る。判定・統合・タイトル・予測・ページ選びは固定の応答にする（プロンプトの組み立てを書き写さない）。
// 自分の面の意見だけを書かず、他の面や本人の発言まで書いた件（話者の見出し）、画面に名前の見出しが残る件、長すぎる件を人格ごとに数える。
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
const files=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js',...(!ref || execFileSync('git',['ls-tree','--name-only',ref,'workers/magi2/research.js'],{cwd:root,encoding:'utf8'}).trim() ? ['research.js'] : []),'src/index.js'];
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const env={MAGI_ANTHROPIC_API_KEY:process.env.MAGI_ANTHROPIC_API_KEY,MAGI_OPENAI_API_KEY:process.env.MAGI_OPENAI_API_KEY,MAGI_DEEPSEEK_API_KEY:process.env.MAGI_DEEPSEEK_API_KEY};
for(const [k,v] of Object.entries(env))assert(v,k+' is required');

const PERSONAS=[{name:'Enthusiast',codename:'MELCHIOR-1'},{name:'Humanist',codename:'BALTHASAR-2'},{name:'Strategist',codename:'CASPER-3'}];
// 人格の呼び出しは、system が「…3つの面の1つ」で始まり、最初に出てくるコード名が自分（新旧どちらの枠でも同じ）
const personaOf=system=>{
 if(typeof system!=='string'||!system.startsWith('あなたは、Shinya Takeda という一人の人間の中にある3つの面の1つ'))return null;
 return /（(MELCHIOR-1|BALTHASAR-2|CASPER-3)）/.exec(system)?.[1]||null;
};
const sse=t=>`data: ${JSON.stringify({choices:[{delta:{content:t},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`;
let calls=[];
const cards=JSON.parse(current('data/magi-context.json'));
const context=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),bundledContext:cards,
 Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,AbortSignal,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
 console:{log(){}},
 fetch:async(url,options)=>{
  url=String(url);
  if(url==='https://tk.st/data/magi-context.json')return Response.json(cards);
  if(/^https:\/\/tk\.st\/data\/[a-z-]+\.json$/.test(url))return Response.json(JSON.parse(current('data/'+url.split('/').at(-1))));
  const body=JSON.parse(options.body),native=url.includes('api.anthropic.com');
  const system=native?(body.system||[]).map(b=>b.text).join(''):body.messages?.find(m=>m.role==='system')?.content;
  const who=!body.stream&&personaOf(system);
  if(who){
   const res=await fetch(url,{...options,signal:AbortSignal.timeout(45000)});
   const data=await res.clone().json().catch(()=>null);
   const text=native?(data?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''):data?.choices?.[0]?.message?.content||'';
   calls.push({who,status:res.status,text});
   return res;
  }
  if(native){
   if(body.stream)return new Response(`data: ${JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'答え'}})}\n\ndata: ${JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'}})}\n\ndata: {"type":"message_stop"}\n\n`);
   return Response.json({content:[{type:'text',text:body.output_config?.format?'{"motion":"","votable":false}':'題'}],stop_reason:'end_turn',usage:{}});
  }
  if(body.stream)return new Response(sse('答え'));
  if(body.response_format?.json_schema?.name==='debate_judge')return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'十分',action:'answer',questions:[]})}}]});
  if(body.response_format)return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({selections:[]})}}]});
  return Response.json({choices:[{finish_reason:'stop',message:{content:'意見'}}]});
 }});
vm.runInContext(files.map(p=>strip(read('workers/magi2/'+p))).join('\n').replace('export default {','globalThis.worker = {'),context);

// 報告のあった入力（2026-10-13、トップページ）と、同じ「どちらを選ぶ」形・ふつうの相談・英語
const reported='異世代の異性の友達が多い\n同世代の同性の友達が多い\nどちらかを選ぶならどっちを選ぶ？';
const inputs=[[reported,repeatReported],...[
 'お金と時間、どちらかしか増やせないならどっちを選ぶ？',
 '住むなら都会と田舎、どっち？',
 '一つの仕事を続けるのと、何度も転職するのと、どっちがいい？',
 'Would you rather have a few close friends or many casual friends?',
 'Should I take a quiet weekend alone or go to a festival with friends?',
 '友人からの誘いを断るのが苦手で、疲れてしまう。関係を大切にしながら伝える方法を相談したい。',
 '寝る前にスマートフォンを別の部屋に置くべき？',
].map(q=>[q,repeat])];
// 話者の見出し：行頭の【…】・**…**・[…]・「名前：」。大文字や（コード名）付きも数える
const heading=names=>new RegExp(`(^|\\n)\\s*(?:\\*\\*|【|\\[|［)?\\s*(?:${names})[^\\n]{0,24}?(?:\\*\\*|】|\\]|］|[:：])`,'i');
const all=PERSONAS.flatMap(p=>[p.name,p.codename]).concat(['Shinya Takeda','Takeda','本人の答え']).join('|');
const othersOf=codename=>heading(PERSONAS.filter(p=>p.codename!==codename).flatMap(p=>[p.name,p.codename]).concat(['Shinya Takeda','Takeda','本人の答え']).join('|'));
const speaker=heading(all);
// 画面に出る本文（版にあれば自分の名前の見出しを落とす処理を通す）
let shown=t=>t;try{const f=vm.runInContext('stripOwnHeader',context);shown=(t,who)=>f(t,PERSONAS.find(p=>p.codename===who));}catch(_){}
// 長すぎる：英語は60語超、それ以外は200字超（指示は2〜3文・日本語120字・英語40語ほど）
const tooLong=t=>/[ぁ-んァ-ン一-龥]/.test(t)?[...t].length>200:t.split(/\s+/).filter(Boolean).length>60;
// 英語の質問に、かなを含む答えを返した（出力の言語の食い違い）
const english=q=>!/[^\x00-\x7f]/.test(q);
const kana=t=>/[ぁ-んァ-ン]/.test(t);

const results=[];
for(const [id,[q,n]] of inputs.entries())for(let run=1;run<=n;run++){
 calls=[];
 const res=await context.worker.fetch(new Request('https://workers.tk.st/magi2/chat',{method:'POST',
  headers:{Origin:'https://tk.st','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+(1+results.length%200)},
  body:JSON.stringify({messages:[{role:'user',content:q}],theme:'light',suggest:true,site_pages:true,page:'/',adaptive_debate:true})}),env,{waitUntil(){}});
 const stream=await res.text();
 if(calls.some(c=>[401,402,403,429].includes(c.status)))throw new Error('Evaluation stopped at upstream authentication, billing, or rate limit');
 const rounds={};
 for(const c of calls){
  const list=(rounds[c.who]||=[]);
  const view=shown(c.text,c.who);
  list.push({round:list.length+1,status:c.status,chars:[...c.text].length,others:othersOf(c.who).test(c.text),shown_tag:speaker.test(view),long:tooLong(view),lang:english(q)&&kana(view),text:c.text});
 }
 results.push({id:id+1,run,input:q,done:/event: done/.test(stream),rounds});
 console.log(JSON.stringify({label,id:id+1,run,done:results.at(-1).done,rounds:Object.fromEntries(Object.entries(rounds).map(([k,v])=>[k,v.map(r=>[r.chars,r.others?'O':'',r.shown_tag?'T':'',r.long?'L':'',r.lang?'J':''].join(''))]))}));
 // 引っかかった回答と、各入力の1回目は本文もログに出す（入力は合成。成果物を取れない環境でも目で確かめられるように）
 for(const [who,list] of Object.entries(rounds))for(const r of list)if(r.others||r.shown_tag||r.long||r.lang||run===1)
  console.log('TEXT '+JSON.stringify({label,id:id+1,run,who,round:r.round,chars:r.chars,text:r.text}));
}
const count=(who,round,f)=>results.map(r=>r.rounds[who]?.[round-1]).filter(Boolean).filter(f).length;
const total=(who,round)=>results.map(r=>r.rounds[who]?.[round-1]).filter(Boolean).length;
const summary={label,ref:ref||'working-tree',date:new Date().toISOString(),runs:results.length,
 personas:Object.fromEntries(PERSONAS.map(({codename:w})=>[w,Object.fromEntries([1,2].map(n=>['r'+n,{total:total(w,n),others:count(w,n,r=>r.others),shown_tag:count(w,n,r=>r.shown_tag),long:count(w,n,r=>r.long),lang_mismatch:count(w,n,r=>r.lang)}]))]))};
const directory=new URL('workers/.wrangler/magi-persona/',root);mkdirSync(directory,{recursive:true});
writeFileSync(new URL(label+'.json',directory),JSON.stringify({...summary,results},null,2)+'\n');
console.log('SUMMARY '+JSON.stringify(summary));
