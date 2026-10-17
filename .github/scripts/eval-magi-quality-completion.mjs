// 残る4種類の指摘を、保存入力と短い合成討議で限定確認。人格の全再生成・分類・検索は行わない。
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {extractDebate} from './prepare-magi-a3-review.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8'),json=p=>JSON.parse(read(p));
const iteration=process.argv.find(a=>a.startsWith('--iteration='))?.split('=')[1]||'1';assert(['1','2','3'].includes(iteration));
const dir=new URL('workers/.wrangler/magi2-quality-completion-20261017'+(iteration==='1'?'':'-v'+iteration)+'/',root);mkdirSync(dir,{recursive:true});
const hash=s=>createHash('sha256').update(s).digest('hex'),run=process.argv.includes('--run');
const registry=json('config/ai-models.json'),cards=json('data/magi-context.json');
const modules=['languages.js','personas.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const sources=modules.map(p=>read('workers/magi2/'+p));
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const code=sources.map(strip).join('\n').replace('export default {','globalThis.worker = {');
const collection=json('workers/.wrangler/magi2-dialogue-a3/collection-result.json'),tune=json('workers/.wrangler/magi2-dialogue-a3/tune-review.json');
const original=json('workers/.wrangler/magi2-compact-20261017/plan.json'),site=json('workers/.wrangler/magi2-compact-20261017/site-result.json');
const decode=s=>s.replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const texts=[...read('workers/.wrangler/magi2-android-20261017/compact-normal-final.xml').matchAll(/text="([^"]*)"/g)].map(m=>decode(m[1])).filter(Boolean);
const initials=['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(codename=>{const i=texts.indexOf(codename),j=texts.indexOf('Initial',i);assert(i>=0&&j>i);return {codename,text:texts[j+1]};});
const one=collection.results.find(r=>r.id==='collect-01'),two=tune.cases.find(r=>r.id==='tune-21');
const cases=[{id:'judge-count',kind:'judge',sample:{input:one.input,debate:extractDebate(one)},expected:'受付1人・20秒・10分の最大処理30人と、到着分布不明の待ち人数を区別。正しい30人処理・残30人という条件付き計算を誤りと呼ばない。'},
 {id:'judge-deadline',kind:'judge',sample:{input:two.input,debate:two.debate},expected:'期限・遅延影響・残作業など判断に必要な不足を推測せず扱う。'},
 {id:'persona-attribution',kind:'persona',input:original.cases.find(c=>c.id==='normal').text,initials,expected:'Humanistがタイマーを批判したなど、保存R1にない発言を既出意見として作らない。'},
 {id:'vote-evidence',kind:'vote',input:original.cases.find(c=>c.id==='vote').text,debate:'[MELCHIOR-1: APPROVE] Quiet screen-free reading fits the requested break.\n[BALTHASAR-2: APPROVE] A quiet break is consistent with the stated preference.\n[CASPER-3: APPROVE] Thirty minutes and no other commitments make reading feasible.\nResolution: APPROVE, 3 approve / 0 reject / 0 no vote.',expected:'合成3賛成の根拠を説明し、所有する動画を既視聴・既知と決めつけない。保存6発言の再現ではない。'},
 ...['pdf','qr'].map(theme=>{const row=site.results.find(r=>r.id===theme+'-2'),first=site.results.find(r=>r.id===theme+'-1');
  // 初版の保存記録ではhistory配列が後続のpushと共有された。実際の先行1往復から再構築し、未来の回答を混ぜない。
  const body={...row.body,history:[{role:'user',content:first.body.query},{role:'assistant',content:first.response.comment,pages:first.response.results.map(p=>({title:p.title,url:p.url}))}]};
  return {id:theme+'-steps',kind:'site',body,choice:row.response,expected:theme==='pdf'?'複数PDFを読み込み並べて、書き出し→PDF→書き出すの手順を説明。':'内容の入力と読み取り確認、PNGで保存/SVGで保存を説明。'};})];
let active=null,capture=false,fallback=false,gate=null,keys={},report;
const save=()=>writeFileSync(new URL('result.json',dir),JSON.stringify(report,null,2)+'\n');
const ctx=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
 fetch:async(url,options)=>{
  const provider=String(url).includes('anthropic.com')?'anthropic':String(url).includes('deepseek.com')?'deepseek':String(url).includes('api.openai.com')?'openai':null;
  assert(provider&&options?.body,'予定外の通信を禁止');const body=JSON.parse(options.body);if(provider==='openai')body.service_tier='default';
  const request_hash=evaluationRequestHash(provider,body);
  if(capture){active.requests.push({provider,body,request_hash});
   if(fallback&&active.requests.length===1)return new Response('planned failure',{status:503});
   if(body.stream){const text='planned answer';return new Response(provider==='anthropic'
    ?'data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text}})+'\n\ndata: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n'
    :'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
   const text=active.kind==='judge'?JSON.stringify({assessment:'mock',next_step:'answer',persona_questions:[],questions:[]}):'planned persona';
   return Response.json(provider==='anthropic'?{content:[{type:'text',text}],stop_reason:'end_turn'}:{choices:[{message:{content:text},finish_reason:'stop'}]});
  }
  const planned=active.requests[active.calls.length];assert(planned&&planned.request_hash===request_hash,'固定した要求順序以外は送らない');
  const call={provider,request_hash,reservation:gate.reserve(provider,body),status:null};active.calls.push(call);save();
  const response=await fetch(url,{...options,body:JSON.stringify(body)});call.status=response.status;save();return response;
 }});
vm.runInContext(code,ctx);ctx.cards=cards;
async function execute(sample,env){
 ctx.sample=sample;ctx.env=env;
 return vm.runInContext(sample.kind==='judge'?`withTimeout(20000,s=>fetchJudgement(env,{system:withLangNote(withCard({...SYNTHESIZER,system_prompt:DEBATE.system_prompt(2,5,true)},cards,PERSONA_CONTEXT.synth_header).system_prompt+'\\n\\n'+DEBATE.constraint_rules,languageNote({code:'ja'})),input:judgeInput([{role:'user',content:sample.sample.input}],null,sample.sample.debate,languageNote({code:'ja'})),active:sample.sample.debate.map(d=>d.codename),allowUser:true},s,()=>{}))`
 :sample.kind==='persona'?`withTimeout(45000,s=>{const p=PERSONAS.find(p=>p.codename==='MELCHIOR-1');const base=withCard({...p,system_prompt:p.system_prompt+'\\n\\n'+p.role.chat},cards);base.system_prompt=withLangNote(base.system_prompt,languageNote({code:'en'}));const others=sample.initials.filter(o=>o.codename!==p.codename).map(o=>'- '+PERSONAS.find(p=>p.codename===o.codename).name+'（'+o.codename+'）: '+o.text).join('\\n');const content=sample.input+'\\n\\n[あなたの初回意見]\\n'+sample.initials.find(o=>o.codename===p.codename).text+'\\n\\n[討議メモ：他の人格の初回意見は以下。これを踏まえ、賛同・反論・補強のいずれかで自分の考えを更新せよ。賛同するなら自分の理由で述べ、自分の関心と価値観は手放さない。単なる繰り返しは避ける]\\n'+others;return fetchPersonaText(env,base,personaThread(p.codename,[],joinContent(content,languageNote({code:'en'}))),s,()=>{},2,PERSONA_TEMPERATURE.dark);})`
 :sample.kind==='vote'?`withTimeout(45000,s=>synthesize({env,theme:'dark',signal:s,send:discardEvents,log:()=>{},messages:[{role:'system',content:withCard({...SYNTHESIZER,system_prompt:SYNTHESIZER.system_prompt+'\\n'+SYNTHESIZER.role.magi},cards,PERSONA_CONTEXT.synth_header).system_prompt},{role:'system',content:SYNTHESIZER.voice_rules},{role:'system',content:SYNTHESIZER.constraint_rules},{role:'user',content:joinContent(sample.input+'\\n\\n[合成の討議と確定した採決]\\n'+sample.debate,languageNote({code:'en'}))}]}))`
 :`withTimeout(45000,s=>runFactAnswer({upstream:env,cards,messages:[...sample.body.history.map(row=>({role:row.role,content:row.content})),{role:'user',content:sample.body.query}],langNote:languageNote({code:sample.body.locale}),pageChoice:sample.choice,siteOnly:true,signal:s,send:discardEvents,log:()=>{}}))`,ctx);
}
const dry={MAGI_OPENAI_API_KEY:'dry',MAGI_ANTHROPIC_API_KEY:'dry',MAGI_DEEPSEEK_API_KEY:'dry'};
capture=true;fallback=true;
for(const sample of cases){active=sample;sample.requests=[];await execute(sample,dry);assert.equal(sample.requests.length,2);
 for(const r of sample.requests){const bytes=Buffer.byteLength(JSON.stringify(r.body)),input=bytes*2+2048,output=r.body.max_tokens||r.body.max_completion_tokens;
  assert(bytes<=40000&&input<100000&&!r.body.tools&&output>0&&output<=8192);
  const rates={openai:[.25,.75],anthropic:[.20,.50],deepseek:[.30,1.20]}[r.provider];
  r.estimate={provider:r.provider,model:r.body.model,max_usd:Math.ceil((input*rates[0]+output*rates[1])*1.1)/1e6,pricing_checked_at:'2026-10-17',basis:`公式料金確認済みの保守的上側単価。UTF8 ${bytes} bytes*2+2048 input、最大出力${output}、10%余裕。保存合成入力だけ、Web・画像・分類なし。`,evaluation_batch:'quality-completion-20261017'};
 }}
capture=false;
const total=cases.flatMap(c=>c.requests).reduce((n,r)=>n+r.estimate.max_usd,0);assert(total<=.18,'限定確認の段階上限');
const plan={version:1,source_hash:hash(sources.join('\n')),script_hash:hash(read('.github/scripts/eval-magi-quality-completion.mjs')),cards_hash:hash(JSON.stringify(cards)),cases,maximum_usd:total};
const file=new URL('plan.json',dir);
if(!run){if(existsSync(file))assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(file)))),hash(JSON.stringify(plan)));else writeFileSync(file,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({cases:cases.length,maximum_calls:12,maximum_usd:total,network_calls:0}));process.exit(0);}
gate=paidEvaluationGate();assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(file)))),hash(JSON.stringify(plan)),'計画後の変更を拒否');assert(!existsSync(new URL('result.json',dir)),'再送・上書きしない');
const lock=openSync(evaluationBudgetPath+'.lock','wx');try{const ledger=JSON.parse(readFileSync(evaluationBudgetPath));for(const c of cases)for(const r of c.requests)ledger.estimates[r.request_hash]=r.estimate;writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');}finally{closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}
const vars=read('workers/magi2/.dev.vars');for(const name of Object.keys(dry)){keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[name]);}
report={plan_hash:hash(JSON.stringify(plan)),complete:false,results:[]};writeFileSync(new URL('result.json',dir),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
for(const sample of cases){active={...sample,calls:[]};report.results.push(active);save();active.answer=await execute(sample,keys);assert(active.answer);save();console.log(JSON.stringify({id:sample.id,completed:true,calls:active.calls.length}));}
report.complete=true;save();
