// A2のローカルWorker評価。承認済み合成入力・現在の固定カードのみ。本文はGit管理外。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
import {paidEvaluationGate} from './magi-eval-budget.mjs';
const budget=paidEvaluationGate();
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const opt=(name,fallback='')=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
const ref=opt('ref'),set=opt('set','stable'),label=opt('label',`${set}-${ref?'baseline':'current'}`),theme=opt('theme','both'),fault=opt('fault');
const effort=opt('effort');assert(!effort||['low','medium'].includes(effort));
const webProvider=opt('web-provider');assert(!webProvider||['openai','anthropic'].includes(webProvider));
const allowIncomplete=process.argv.includes('--allow-incomplete');
const captureWeb=process.argv.includes('--capture-web');
const paceMs=Number(opt('pace-ms','0'));assert(Number.isInteger(paceMs)&&paceMs>=0&&paceMs<=60000);
assert.match(label,/^[a-z0-9-]+$/);assert(['stable','fresh','site','music-boundary','route','404'].includes(set));assert(['both','light','dark'].includes(theme));assert(!fault||['openai','anthropic'].includes(fault));
const fixture=JSON.parse(read('.github/scripts/fixtures/magi-dialogue-a2-final.json'));
assert(fixture.reviewed_at && fixture.reviewed_by,'final fixture must be reviewed');
const modules=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js',...(!ref?['research.js']:[]),'src/index.js'];
const source=modules.map(p=>ref?execFileSync('git',['show',ref+':workers/magi2/'+p],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}):read('workers/magi2/'+p));
const registry=JSON.parse(ref?execFileSync('git',['show',ref+':config/ai-models.json'],{cwd:root,encoding:'utf8'}):read('config/ai-models.json'));
const cards=JSON.parse(read('data/magi-context.json')),vars=read('workers/magi2/.dev.vars');
const keys=Object.fromEntries(['MAGI_OPENAI_API_KEY','MAGI_ANTHROPIC_API_KEY','MAGI_DEEPSEEK_API_KEY','MAGI_TYPESAFE_API_KEY'].map(name=>{
  const value=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(value,name+' required');return [name,value];
}));
if(fault)keys[fault==='openai'?'MAGI_OPENAI_API_KEY':'MAGI_ANTHROPIC_API_KEY']='invalid-a2-evaluation-key';
const dir=new URL('workers/.wrangler/magi2-dialogue-a2/',root);mkdirSync(dir,{recursive:true});
const target=new URL(`worker-${label}.json`,dir),strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const report={date:new Date().toISOString(),ref:ref||'working-tree',set,theme,effort,pace_ms:paceMs,web_provider_override:webProvider||null,fault:fault||null,worker_hash:createHash('sha256').update(source.join('\n')).digest('hex'),cards_hash:createHash('sha256').update(JSON.stringify(cards)).digest('hex'),fixture_hash:createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),results:[]};
const save=()=>writeFileSync(target,JSON.stringify(report,null,2)+'\n');
const selected=opt('cases').split(',').filter(Boolean);
const cases=(set==='404'?JSON.parse(read('.github/scripts/fixtures/magi47-site-search.json')).map(([text,locale,expected],i)=>({id:'s'+(i+1),text,locale,expected}))
  :[...fixture.cases,...fixture.boundary_cases].filter(c=>set==='route'?['consult','music'].includes(c.group):c.group===set))
  .filter(c=>!selected.length||selected.includes(c.id));
assert(cases.length,'no cases');
async function run(c,theme){
  const started=performance.now(),calls=[],observations=[],events=[],logs=[];
  const ctx=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
    console:{log(...args){logs.push(args.slice(1));}},
    async fetch(url,options){
      if(/^https:\/\/tk\.st\/data\//.test(String(url)))return Response.json(JSON.parse(read('data/'+String(url).split('/').at(-1))));
      if(!options?.body){const startedSource=performance.now(),res=await fetch(url,options);calls.push({provider:'source',url:String(url),status:res.status,ms:Math.round(performance.now()-started),elapsed_ms:Math.round(performance.now()-startedSource)});return res;}
      const body=JSON.parse(options.body),provider=String(url).includes('anthropic.com')?'anthropic':String(url).includes('typesafe')?'typesafe':String(url).includes('deepseek')?'deepseek':'openai';
      const call={provider,model:body.model,stream:!!body.stream,web:!!body.tools,ms:Math.round(performance.now()-started)};calls.push(call);
      try {call.budget=budget.reserve(provider,body);} catch(error) {call.budget_error=error.message;throw error;}
      const res=await fetch(url,options);call.status=res.status;
      if(!res.ok){call.retry_after=res.headers.get('retry-after');}
      observations.push((async()=>{try{
        if(!body.stream){
          const data=await res.clone().json();call.usage=data.usage;
          if(data.error)call.error={type:data.error.type,code:data.error.code};
          if(captureWeb&&(body.response_format?.json_schema?.name==='research_verified_reply'
            ||body.output_config?.format?.schema?.properties?.parts)) {
            // 固定の合成評価だけ。カード・会話全体・キー・推論は保存せず、その時点の根拠と最終JSONを監査する。
            const input=body.messages.at(-1)?.content;
            call.verification_reply=provider==='anthropic'?data.content?.filter(b=>b.type==='text').map(b=>b.text).join(''):data.choices?.[0]?.message?.content;
            const joined=typeof input==='string'?input:input.filter(p=>p.type==='text').map(p=>p.text).join('');
            // Anthropicは隣り合うuserを本番のrequestBodyで結合するため、最後に加えたJSONから読む。
            call.verification_evidence=JSON.parse(joined.slice(joined.indexOf('{"question":')));
          }
          return;
        }
        const raw=await res.clone().text();
        const frames=[...raw.matchAll(/^data: (.+)$/gm)].flatMap(m=>{try{return [JSON.parse(m[1])];}catch{return [];}});
        const failure=frames.find(e=>e.type==='error'||e.error||e.type==='response.failed');
        const detail=failure?.error||failure?.response?.error||failure;
        if(failure)call.error={type:detail.type,code:detail.code};
        // 引用と本文の監査用。キー・リクエスト・thinkingは残さず、合成評価の検索結果と回答だけ保存。
        if(captureWeb&&call.web)call.web_evidence=frames.filter(e=>provider==='anthropic'
          ? e.type==='content_block_start'&&['web_search_tool_result','web_fetch_tool_result','text'].includes(e.content_block?.type)
            ||e.type==='content_block_delta'&&['text_delta','citations_delta'].includes(e.delta?.type)
            ||['content_block_stop','message_delta','message_stop'].includes(e.type)
          : ['response.output_item.done','response.output_text.annotation.added'].includes(e.type)&&e.item?.type!=='reasoning');
        call.usage=Object.assign({},...frames.map(e=>e.message?.usage||e.usage||e.response?.usage||{}));
        call.searches=provider==='anthropic'?frames.filter(e=>e.content_block?.type==='server_tool_use'&&e.content_block.name==='web_search').length:frames.filter(e=>e.type==='response.output_item.done'&&e.item?.type==='web_search_call'&&e.item.action?.type==='search').length;
        if(provider==='anthropic')call.fetches=frames.filter(e=>e.content_block?.type==='server_tool_use'&&e.content_block.name==='web_fetch').length;
      }catch{call.observation_error=true;}})());return res;
    }});
  vm.runInContext(source.map(strip).join('\n').replace('export default {','globalThis.worker = {'),ctx);
  if(!ref){
    if(effort)vm.runInContext(`RESEARCH.reasoning_effort=${JSON.stringify(effort)}`,ctx);
    if(webProvider)vm.runInContext(`RESEARCH.primary_provider.light=RESEARCH.primary_provider.dark=${JSON.stringify(webProvider)}`,ctx);
    report.effort=vm.runInContext('RESEARCH.reasoning_effort',ctx);
  }
  const body={classification_state:true,...(!ref?{fact_mode:true}:{}),theme,adaptive_debate:true,magi_panel:true,site_pages:true,page:'/',ui_language:'ja',messages:[{role:'user',content:c.text}]};
  const waits=[],request=new Request('https://workers.tk.st/magi2/'+(set==='404'?'site-search?site_debate=1':'chat'),{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(set==='404'?{query:c.text,locale:c.locale}:body)});
  // 404の起動に必要な評価専用DB。各合成要求は独立したカウンタを持ち、本番DBを読まない。
  const DB=set==='404'?{prepare(){return {bind(){return {async first(){return {count:1};}};}};}}:undefined;
  const res=await ctx.worker.fetch(request,{...keys,DB,MAGI_MODE_ENABLED:'true',SITE_SEARCH_ENABLED:'true'},{waitUntil(p){waits.push(p);}});
  let buffer='';
  if(set==='404'){const data=await res.json();events.push({name:'site_result',data,ms:Math.round(performance.now()-started)},{name:['results','no_results'].includes(data.status)?'done':'error',data:{},ms:Math.round(performance.now()-started)});}
  else {
  const reader=res.body.getReader(),decoder=new TextDecoder();
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replaceAll('\r','');let at;
    while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const name=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];if(name&&data)events.push({name,data:JSON.parse(data),ms:Math.round(performance.now()-started)});}}
  }
  await Promise.allSettled([...waits,...observations]);
  const result={id:c.id,theme,input:c.text,expected:c.expected,reference:c.answer_reference||null,events,calls,logs,elapsed_ms:Math.round(performance.now()-started),first_text_ms:events.find(e=>e.name==='integrated'&&e.data.delta)?.ms??null,text:events.filter(e=>e.name==='integrated').map(e=>e.data.delta||'').join(''),completed:events.at(-1)?.name==='done'};
  report.results.push(result);save();console.log(`${label}: ${c.id}/${theme} completed=${result.completed} first=${result.first_text_ms}ms`);
  if(calls.some(c=>c.budget_error)){report.stopped='budget';save();throw new Error('Paid evaluation stopped by the budget guard.');}
  if(calls.some(x=>x.provider!=='source'&&([402,403,429].includes(x.status)||x.status===401&&x.provider!==fault
    ||/quota|rate_limit|billing|authentication|permission/i.test((x.error?.code||'')+' '+(x.error?.type||''))))){report.stopped='authentication_billing_or_rate_limit';save();throw new Error('evaluation stopped at upstream limit');}
  if(!result.completed&&!allowIncomplete)throw new Error('evaluation stopped at incomplete response');
}
// Webは両テーマ同じ会社なので、評価の負荷を分けたいときは1列・指定間隔で実行する。
const themes=theme==='both'?['light','dark']:[theme];
if(paceMs){
  for(const [i,{c,t}] of cases.flatMap(c=>themes.map(t=>({c,t}))).entries()){
    if(i)await new Promise(r=>setTimeout(r,paceMs));await run(c,t);
  }
} else await Promise.all(themes.map(async t=>{for(const c of cases)await run(c,t);}));
console.log(`Saved ${report.results.length} synthetic results (not a quality approval).`);
