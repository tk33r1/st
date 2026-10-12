// 公開1のモデル比較。合成入力・固定カード・ローカルカウンタのみ。本番DB/通知/生成物は変更しない。
// --ref=<git commit> で旧構成を読む。本文はGit対象外の .wrangler/ にだけ保存する。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url);
const opt=(key,fallback='')=>process.argv.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3)||fallback;
const ref=opt('ref'), label=opt('label',ref?'baseline':'candidate');
const siteSearch=process.argv.includes('--site-search'),faultProvider=opt('fault-provider');
assert(!faultProvider||['anthropic','openai'].includes(faultProvider));
assert.match(label,/^[a-z0-9-]+$/);
const current=p=>readFileSync(new URL(p,root),'utf8');
const read=p=>ref?execFileSync('git',['show',ref+':'+p],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}):current(p);
const files=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const cards=JSON.parse(current('data/magi-context.json'));
const registry=JSON.parse(read('config/ai-models.json'));
const source=files.map(p=>read('workers/magi2/'+p));
const directory=new URL('workers/.wrangler/magi47-quality/',root);mkdirSync(directory,{recursive:true});
const target=new URL(label+'.json',directory);
const report={label,ref:ref||'working-tree',date:new Date().toISOString(),fingerprint:createHash('sha256').update(source.join('\n')).digest('hex'),cards_hash:createHash('sha256').update(JSON.stringify(cards)).digest('hex'),site_index_hash:createHash('sha256').update(current('data/site-search.json')).digest('hex'),fault_provider:faultProvider||null,registry,results:[]};
const save=()=>writeFileSync(target,JSON.stringify(report,null,2)+'\n');
let calls=[],observed=[],marks=[];
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const context=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
 console:{log(...args){marks.push({ms:performance.now(),stage:args[1],state:args[2]});}},
 fetch:async(url,options)=>{
  if(/^https:\/\/tk\.st\/data\//.test(String(url)))return Response.json(JSON.parse(current('data/'+String(url).split('/').at(-1))));
  const started=performance.now(),body=JSON.parse(options.body),system=body.system||body.messages?.[0]?.content;
  const provider=String(url).includes('anthropic.com')?'anthropic':String(url).includes('typesafe')?'typesafe':String(url).includes('deepseek')?'deepseek':String(url).includes('googleapis')?'google':'openai';
  const call={provider,model:body.model,stream:body.stream===true,started_ms:started,persona:typeof system==='string'?system.match(/面の1つ「[^」]+」（([^）]+)）/)?.[1]:null};
  if(call.persona==='BALTHASAR-2'&&!calls.some(c=>c.persona==='BALTHASAR-2'))call.request=body;
  calls.push(call);
  let response;try{response=await fetch(url,options);}catch{call.error='transport_or_timeout';call.elapsed_ms=performance.now()-started;throw new Error('Upstream transport failure');}
  call.status=response.status;
  // 認証・本文・個人入力は標準出力へ出さない。合成入力の本文は比較用成果物のみに保存。
  observed.push((async()=>{try{
   if(body.stream){const reader=response.clone().body.getReader(),decoder=new TextDecoder();let raw='';
    while(true){const {value,done}=await reader.read();if(done)break;raw+=decoder.decode(value,{stream:true});
     if(call.first_text_ms===undefined&&[...raw.matchAll(/^data: (.+)$/gm)].some(m=>{try{const v=JSON.parse(m[1]);return Boolean(v.delta?.type==='text_delta'&&v.delta.text||v.choices?.[0]?.delta?.content);}catch{return false;}}))call.first_text_ms=performance.now()-started;}
    const events=[...raw.matchAll(/^data: (.+)$/gm)].flatMap(m=>{try{return [JSON.parse(m[1])];}catch{return [];}});
    call.usage=Object.assign({},...events.map(e=>e.message?.usage||e.usage||{}));
   }else{const value=await response.clone().json();call.usage=value.usage;call.finish=value.stop_reason||value.choices?.[0]?.finish_reason;
    if(call.persona||body.output_config?.format||body.response_format?.json_schema){call.raw=provider==='anthropic'?(value.content||[]).filter(p=>p.type==='text').map(p=>p.text).join(''):value.choices?.[0]?.message?.content;if(call.persona)call.vote=typeof call.raw==='string'?context.parseVote(call.raw).vote:null;}}
  }catch{call.observation_error=true;}finally{call.elapsed_ms=performance.now()-started;}})());
  return response;
 }});
vm.runInContext(source.map(strip).join('\n').replace('export default {','globalThis.worker = {'),context);
const env={MAGI_MODE_ENABLED:'true',SITE_SEARCH_ENABLED:'true'};
const counts=new Map();env.DB={prepare(){return{bind(key,day,limit){return{async first(){const n=(counts.get(key)||0)+1;counts.set(key,n);return n<=limit?{count:n}:null;}};}};}};
if(process.argv.includes('--check')){const r=await context.worker.fetch(new Request('https://workers.tk.st/magi2/models',{headers:{Origin:'https://tk.st'}}),env,{});assert.equal(r.status,200);if(opt('models-output'))writeFileSync(opt('models-output'),JSON.stringify(await r.json()));console.log('Model evaluation VM: OK (no API calls)');process.exit(0);}
const saved=existsSync(new URL('workers/magi2/.dev.vars',root))?current('workers/magi2/.dev.vars'):'';
for(const name of ['MAGI_OPENAI_API_KEY','MAGI_DEEPSEEK_API_KEY',registry.google?'MAGI_GEMINI_API_KEY':'MAGI_ANTHROPIC_API_KEY','MAGI_TYPESAFE_API_KEY']){
 env[name]=process.env[name]||saved.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1].replace(/^(['"])(.*)\1$/,'$2');assert(env[name],name+' is required');}
// 評価VMだけの失効キー。実APIのHTTP失敗から、反対側へ本文を返せることを確認する。
if(faultProvider)env[faultProvider==='anthropic'?'MAGI_ANTHROPIC_API_KEY':'MAGI_OPENAI_API_KEY']='invalid-magi47-evaluation-key';
const consult=[
 ['仕事の締切が重なり、休むと遅れるのが怖い。優先順位と休み方を一緒に整理して。','ja'],
 ['友人からの誘いを断るのが苦手で、疲れてしまう。関係を大切にしながら伝える方法を相談したい。','ja'],
 ['新しい職場で質問するタイミングがわからない。自分で考える時間と人に聞く基準を整理して。','ja'],
 ['週末に読書とバイクの時間を作りたいが、いつも家事だけで終わる。無理なく両立する工夫を相談したい。','ja'],
 ['店の売上が伸びない。SNSの投稿と常連向けイベントの利点と弱点を整理して。予算は月2万円、平日は一人です。','ja'],
 ['DJを始めたばかりで、練習を録音すると失敗ばかり気になる。楽しみと上達のバランスを相談したい。','ja'],
 ['会議で自分の意見を言う前に話題が変わることが多い。準備と伝え方を相談したい。','ja'],
 ['I feel guilty taking breaks when deadlines pile up. Help me choose a realistic priority and rest plan.','en'],
 ['A friend keeps cancelling at the last minute. How can I discuss it without making assumptions about them?','en'],
 ['I want to learn DJing but only have twenty minutes a day. Help me design a small, enjoyable practice routine.','en'],
 ['平日は10分しか取れない場合は、どこから変えると続けられそう？','ja',[{role:'user',content:'読書の習慣をつけたい。'},{role:'assistant',content:'毎日、決まった時間に短いページ数から始め、読んだ内容を一行で残す方法を考えてみましょう。'}]],
 ['費用を抑えるなら最初の一か月は何を測ればいい？','ja',[{role:'user',content:'小さな書店の集客で、SNSと読書会を比べたい。'},{role:'assistant',content:'来店理由と再来店の数を記録し、小さな規模で両方を試す方法があります。'}]],
];
const cases=consult.map(([text,language,previous],i)=>({id:'c'+(i+1),kind:'consult',text,language,previous}));
const images=JSON.parse(current('.github/scripts/fixtures/anthropic-images.json'));
for(let i=0;i<3;i++)cases.push({id:'i'+(i+1),kind:'image',text:i===2?'Describe the color and shape, and suggest one improvement to make this icon readable.':'画像の色と形を説明して、アイコンとして見やすくする改善案を一つ教えて。',language:i===2?'en':'ja',image:images[i]});
const motions=['寝る前にスマートフォンを別の部屋に置くべき？','月の予算が2万円なら、常連向けの小さな読書会を試すべき？','Should I reserve Sunday afternoon for rest?'];
const extra=['雨が降るなら今日はバイクに乗るのをやめるべき？','締切が明日なら今日中に資料を完成させるべき？','今週末、使っていない本を10冊手放すべき？','帰りが22時を過ぎるなら飲み会を断るべき？','睡眠が6時間未満なら今日は早く帰るべき？','参加者が3人なら会議をオンラインにすべき？','Should I skip riding my bike today if it rains?','Should I finish the report today if the deadline is tomorrow?','Should I donate ten unused books this weekend?','Should I decline dinner if I would get home after 10 pm?','Should a three-person meeting be online?','Should I share a draft today if the deadline is next week?'];
for(const [i,text]of [...motions,...(ref?[]:extra)].entries())cases.push({id:'m'+(i+1),kind:'magi',text,language:/^[A-Z]/.test(text)?'en':'ja'});
const dj=['夕方の落ち着いた雰囲気に合うソウルを3曲提案して。','ファンク中心のセットの序盤に合う曲を3曲、理由も短く教えて。','世代の違う人がいるカフェでかける、親しみやすい曲を3曲相談したい。','ハウスの前に自然につなげられるディスコを3曲提案して。','Suggest three mellow songs for the opening of a small evening DJ set.'];
dj.forEach((text,i)=>cases.push({id:'d'+(i+1),kind:'dj',text,language:i===4?'en':'ja'}));
const selected=opt('cases').split(',').filter(Boolean);
// 既存404評価器と同じ固定20問を読む。索引も旧・新で同じ現在の正本を使う。
const siteFixtures=siteSearch?JSON.parse(current('.github/scripts/fixtures/magi47-site-search.json')):[];
const work=(siteSearch?siteFixtures.map(([text,language,expected],i)=>({id:'s'+(i+1),kind:'site',text,language,expected,theme:'default'})):[...cases.map(c=>({...c,theme:'dark'})),...cases.filter(c=>c.kind==='consult').map(c=>({...c,theme:'light'}))]).filter(c=>!selected.length||selected.includes(c.id+'-'+c.theme));
if(process.argv.includes('--resume')&&existsSync(target)){const previous=JSON.parse(readFileSync(target,'utf8'));assert.equal(previous.fingerprint,report.fingerprint);assert.equal(previous.cards_hash,report.cards_hash);assert.equal(previous.site_index_hash,report.site_index_hash);report.results=previous.results;report.failed_attempts=previous.failed_attempts||[];}
for(const c of work){if(report.results.some(r=>r.id===c.id&&r.theme===c.theme))continue;
 calls=[];observed=[];marks=[];counts.clear();const waits=[],started=performance.now(),events=[];
 const content=c.image?[{type:'image_url',image_url:{url:'data:'+c.image.media_type+';base64,'+c.image.data}},{type:'text',text:c.text}]:c.text;
 const body={messages:[...(c.previous||[]),{role:'user',content}],classification_state:true,magi_panel:c.kind==='magi',reply_language:{version:1,code:c.language,source:'ui'},ui_language:c.language,theme:c.theme,adaptive_debate:true,suggest:true,site_pages:c.kind!=='dj',...(c.kind==='dj'?{entry:'dj-request',context:'小さなカフェのDJイベント。受付中で、特別なリクエストはまだありません。音楽の相談だけをします。'}:{page:'/'})};
 const response=await context.worker.fetch(new Request('https://workers.tk.st/magi2/'+(siteSearch?'site-search?site_debate=1':'chat'),{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.47'},body:JSON.stringify(siteSearch?{query:c.text,locale:c.language}:body),signal:AbortSignal.timeout(310000)}),env,{waitUntil:p=>waits.push(p)});
 if(response.status!==200){const envelope=await response.json();await Promise.allSettled([...waits,...observed]);(report.failed_attempts??=[]).push({id:c.id,theme:c.theme,status:response.status,envelope,calls,marks});save();console.log(JSON.stringify({label,id:c.id,status:response.status,calls:calls.map(x=>({provider:x.provider,status:x.status,finish:x.finish,error:x.error})),marks:marks.map(x=>({stage:x.stage,state:x.state}))}));throw new Error('Evaluation stopped at HTTP '+response.status);}
 let siteResult;
 if(siteSearch){siteResult=await response.json();events.push({event:'done',data:{},ms:performance.now()-started});assert(['results','no_results'].includes(siteResult.status));}
 else {
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
  while((end=buffer.indexOf('\n\n'))>=0){const chunk=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=chunk.match(/^event: (.+)$/m)?.[1],data=chunk.match(/^data: (.+)$/m)?.[1];if(event&&data)events.push({event,data:JSON.parse(data),ms:performance.now()-started});}}}
 await Promise.allSettled([...waits,...observed]);
 const result={id:c.id,kind:c.kind,theme:c.theme,language:c.language,input:c.text,events,calls:calls.map(call=>({...call,started_ms:call.started_ms-started})),marks:marks.map(m=>({...m,ms:m.ms-started})),elapsed_ms:performance.now()-started,
 answer:events.filter(e=>e.event==='integrated').map(e=>e.data.delta||'').join(''),completed:events.some(e=>e.event==='done')&&!events.some(e=>e.event==='error')};
 if(siteSearch){result.response=siteResult;result.expected=c.expected;result.answer=siteResult.comment;result.expected_link=c.expected?siteResult.results.some(r=>new URL(r.url,'https://tk.st').pathname===c.expected):null;}
 if(faultProvider){const streams=calls.filter(x=>x.stream);assert.equal(streams.length,2,'One integration fallback');assert.equal(streams[0].provider,faultProvider);assert.equal(streams[0].status,401);assert.equal(streams[1].provider,faultProvider==='anthropic'?'openai':'anthropic');assert.equal(streams[1].status,200);assert(result.answer.trim(),'Fallback must return text');result.fallback_verified=true;}
 report.results.push(result);save();console.log(JSON.stringify({label,id:c.id,theme:c.theme,completed:result.completed,elapsed_ms:Math.round(result.elapsed_ms),calls:calls.length,...(siteSearch?{expected_link:result.expected_link,result_count:siteResult.results.length}:{}),failures:calls.filter(x=>x.error||x.status!==200).map(x=>({provider:x.provider,status:x.status,error:x.error}))}));
 if(calls.some(x=>[401,402,403,429].includes(x.status)&&!(x.provider===faultProvider&&x.status===401))){report.stopped='upstream_auth_billing_or_rate_limit';save();throw new Error('Evaluation stopped at upstream authentication, billing, or rate limit');}
 if(!result.completed)throw new Error('Evaluation stopped at incomplete answer');
 if(ref||siteSearch)await new Promise(r=>setTimeout(r,Math.max(0,30000-(performance.now()-started))));
}
if(!ref&&!selected.length&&!siteSearch&&!faultProvider){
 report.effort=[];
 for(const result of report.results.filter(r=>r.kind==='consult'&&r.theme==='dark').slice(0,10)){
  const low=result.calls.find(c=>c.persona==='BALTHASAR-2'),payload=structuredClone(low?.request);assert(payload,'Effort comparison input');
  payload.output_config.effort='medium';const started=performance.now();
  const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':env.MAGI_ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
  const value=await response.json();assert.equal(response.status,200,'Effort comparison HTTP');assert.equal(value.stop_reason,'end_turn','Effort comparison completion');
  report.effort.push({id:result.id,low:low.raw,low_ms:low.elapsed_ms,medium:(value.content||[]).filter(p=>p.type==='text').map(p=>p.text).join(''),medium_ms:performance.now()-started,usage:value.usage});save();
  console.log(JSON.stringify({label,effort:result.id,status:response.status}));
 }
}
report.completed=true;save();console.log(JSON.stringify({label,completed:report.results.length}));
