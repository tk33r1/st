// A3の期待値を付けるため、現行Workerの第1・第2回の人格呼出しだけを収集する。
// --plan / --check は通信・キー・予算台帳を使わない。--run は共通予算台帳が必須。
// 分類・採決・サイト案内・統合・タイトルは課金しない。判定結果は採点資料へ混ぜない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';

const root=new URL('../../',import.meta.url), read=p=>readFileSync(new URL(p,root),'utf8');
const dir=new URL('workers/.wrangler/magi2-dialogue-a3/',root);
const hash=s=>createHash('sha256').update(s).digest('hex');
const json=(url,value)=>writeFileSync(url,JSON.stringify(value,null,2)+'\n');
const opt=(name,otherwise='')=>process.argv.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3)||otherwise;
const mode=process.argv.includes('--run')?'run':process.argv.includes('--check')?'check':'plan';
const chosen=opt('cases','collect-01,collect-03,collect-05').split(',');
assert(chosen.length>=1&&chosen.length<=3&&new Set(chosen).size===chosen.length,'1回の収集は異なる最大3件');
const proposalPath='workers/magi2/A3追加評価入力案.md', proposal=read(proposalPath);
const pool=[...proposal.matchAll(/^\| (collect-\d+) \| ([^\r\n|]+) \|/gm)].map(m=>({id:m[1],input:m[2].trim()}));
const cases=chosen.map(id=>{const c=pool.find(c=>c.id===id);assert(c,'unknown input');return c;});
const files=['languages.js','personas.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const sources=files.map(p=>read('workers/magi2/'+p)),registry=JSON.parse(read('config/ai-models.json'));
const cards=JSON.parse(read('data/magi-context.json'));
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const code=sources.map(strip).join('\n').replace('export default {','globalThis.worker = {');
// テキストのみ。UTF8バイト数の2倍+2,048を入力トークンの保守的な上限とする。
// 16,000バイトを超える実要求は送らない。上流の出力を切って第2回を作ることもしない。
const maxRequestBytes=16000, inputCeiling=maxRequestBytes*2+2048;
const rates={
  openai:{input:.25,output:.75,source:'https://developers.openai.com/api/docs/pricing',basis:'Standard・長文cache write側の高い単価'},
  anthropic:{input:.20,output:.50,source:'https://platform.claude.com/docs/en/about-claude/pricing',basis:'入力上限32,048 tokensで100,000未満。1時間cache writeの高い単価'},
  deepseek:{input:.30,output:1.20,source:'https://api-docs.deepseek.com/quick_start/pricing/',basis:'USD・ピーク時間・cache missの高い単価'},
};
const price=(provider,input,output)=>Math.ceil((input*rates[provider].input+output*rates[provider].output)/1e6*1.1*1e6)/1e6;
const configContext=vm.createContext({aiModels:registry});
vm.runInContext(sources.slice(0,2).map(strip).join('\n')+'\nglobalThis.config=DEFAULTS.models.persona',configContext);
const configs=JSON.parse(JSON.stringify(configContext.config));
const fingerprint={worker_hash:hash(sources.join('\n')),cards_hash:hash(JSON.stringify(cards)),registry_hash:hash(JSON.stringify(registry)),
  collector_hash:hash(read('.github/scripts/collect-magi-a3-debates.mjs')),proposal_hash:hash(proposal)};
const perCase=Object.fromEntries(Object.values(configs).map(cfg=>[cfg.provider,price(cfg.provider,inputCeiling,cfg.max_tokens)*4]));
const ceiling=Object.fromEntries(Object.entries(perCase).map(([p,n])=>[p,Math.ceil(n*cases.length*1e6)/1e6]));
ceiling.total=Object.values(ceiling).reduce((a,b)=>a+b,0);
const plan={version:1,scope:'A3の合成相談、第1・第2回の3人格だけ。判定・統合・分類等は固定。',
  fingerprint,pricing_checked_at:'2026-10-15',rates,max_request_bytes:maxRequestBytes,input_ceiling:inputCeiling,
  attempts_per_persona_round:2,models:configs,cases,maximum_usd:ceiling};
const planUrl=new URL('collection-plan.json',dir);
const outputUrl=new URL('collection-result.json',dir);
const totalReserved=ledger=>ledger.reservations.reduce((sum,r)=>sum+r.max_usd,0);
function checkBalance(ledger){
  assert(totalReserved(ledger)+ceiling.total<=.80,'総予算を超える収集計画');
  for(const [provider,cap] of [['openai',.40],['anthropic',.40]]){
    const spent=ledger.reservations.filter(r=>r.provider===provider).reduce((n,r)=>n+r.max_usd,0);
    assert(spent+(ceiling[provider]||0)<=cap,provider+'の予算を超える収集計画');
  }
}

// 鍵やヘッダーは記録しない。要求の式と上限を検査してから共通台帳へ見積もりを登録する。
function registerEstimate(provider,body){
  assert(!body.tools&&!body.stream&&body.messages.every(m=>typeof m.content==='string'||Array.isArray(m.content)&&m.content.every(p=>p.type==='text')));
  const bytes=Buffer.byteLength(JSON.stringify(body));assert(bytes<=maxRequestBytes,'要求のバイト上限');
  const output=body.max_completion_tokens||body.max_tokens,input=bytes*2+2048;
  assert(Object.values(configs).some(c=>c.provider===provider&&c.model===body.model&&c.max_tokens===output),'想定外のモデル・出力上限');
  const max_usd=price(provider,input,output),request_hash=evaluationRequestHash(provider,body);
  let lock;
  try{
    lock=openSync(evaluationBudgetPath+'.lock','wx');
    const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
    assert.equal(ledger.scope,'magi-dialogue-20261015');assert.equal(ledger.version,1);
    ledger.estimates[request_hash]={provider,model:body.model,max_usd,pricing_checked_at:plan.pricing_checked_at,
      basis:`${rates[provider].basis}; ${rates[provider].source}; UTF8 ${bytes} bytes*2+2048=${input} input tokens; output<=${output}; 10%余裕。`,
      input_ceiling:input,output_ceiling:output,collection_plan_hash:hash(JSON.stringify(plan))};
    json(evaluationBudgetPath,ledger);
  }finally{if(lock!==undefined){closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}}
  return request_hash;
}

let report=null,budget=null,keys={};
if(mode==='run'){
  budget=paidEvaluationGate(); // キーを読む前に既定拒否・共通台帳を検査する。
  assert(!existsSync(outputUrl),'収集済み・中断済みの記録は上書きせず、先に記録を確認する');
  assert.deepEqual(JSON.parse(readFileSync(planUrl,'utf8')),plan,'費用確認後に計画やコードが変わった');
  const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));checkBalance(ledger);
  const vars=read('workers/magi2/.dev.vars');
  for(const name of ['MAGI_OPENAI_API_KEY','MAGI_ANTHROPIC_API_KEY','MAGI_DEEPSEEK_API_KEY']){
    keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');
    assert(keys[name],name+' required');
  }
  report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    ...fingerprint,plan_hash:hash(JSON.stringify(plan)),scope:plan.scope,complete:false,results:[]};
  json(outputUrl,report);
}

const completion=text=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`;
async function collect(c){
  const row={id:c.id,input:c.input,theme:'light',events:[],calls:[],completed:false};
  if(report){report.results.push(row);json(outputUrl,report);}
  const persist=()=>{if(report)json(outputUrl,report);};
  let fatal=null;
  const ctx=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,
    AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
    fetch:async(url,options)=>{
      if(url==='https://tk.st/data/magi-context.json')return Response.json(cards);
      const body=JSON.parse(options.body),native=String(url)==='https://api.anthropic.com/v1/messages';
      const system=native?body.system.map(b=>b.text).join(''):body.messages?.find(m=>m.role==='system')?.content;
      const who=typeof system==='string'&&system.startsWith('あなたは、Shinya Takeda という一人の人間の中にある3つの面の1つ')
        && /（(MELCHIOR-1|BALTHASAR-2|CASPER-3)）/.exec(system)?.[1];
      if(who&&!body.stream){
        const cfg=configs[who],provider=cfg.provider;
        assert.equal(String(url),{openai:'https://api.openai.com/v1/chat/completions',anthropic:'https://api.anthropic.com/v1/messages',deepseek:'https://api.deepseek.com/chat/completions'}[provider]);
        assert(!body.tools);assert.equal(body.model,cfg.model);
        // 既定の処理枠に固定。プロンプト・sampling・出力上限は現行Workerのまま。
        if(provider==='openai')body.service_tier='default';
        assert(Buffer.byteLength(JSON.stringify(body))<=maxRequestBytes,'予定を超える要求');
        if(fatal)throw new Error('収集停止済み');
        assert(row.calls.length<12&&row.calls.filter(c=>c.who===who).length<4,'人格呼出しと再試行の上限');
        const call={provider,who,model:body.model,request_hash:evaluationRequestHash(provider,body),status:null};
        row.calls.push(call);persist();
        if(mode==='run'){
          try{
            registerEstimate(provider,body);call.reservation=budget.reserve(provider,body);persist();
            const started=performance.now();
            const response=await fetch(url,{...options,body:JSON.stringify(body)});
            call.status=response.status;
            const data=await response.clone().json();call.elapsed_ms=Math.round(performance.now()-started);
            call.usage=data.usage;call.finish=native?data.stop_reason:data.choices?.[0]?.finish_reason;
            if(!response.ok){call.error={type:data.error?.type,code:data.error?.code};fatal='upstream_http';}
            persist();return response;
          }catch(e){call.error={type:e.name};fatal='budget_or_transport';persist();throw new Error('収集は予算・通信の問題で停止');}
        }
        // --check/--planは形の確認だけ。課金・認証・ネットワークは行わない。
        return native?Response.json({content:[{type:'text',text:'形の確認用の意見'}],stop_reason:'end_turn',usage:{}})
          :Response.json({choices:[{message:{content:'形の確認用の意見'},finish_reason:'stop'}]});
      }
      // 人格以外の要求は固定。未知の宛先を実APIへ流さない。
      assert(['https://api.openai.com/v1/chat/completions','https://api.anthropic.com/v1/messages'].includes(String(url)),'想定外の通信先');
      if(native)return body.stream?new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"固定の統合"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n')
        :Response.json({content:[{type:'text',text:'固定の題'}],stop_reason:'end_turn',usage:{}});
      return body.stream?new Response(completion('固定の統合')):Response.json({choices:[{message:{content:'固定の題'},finish_reason:'stop'}]});
    }});
  vm.runInContext(code,ctx);
  const request=new Request('https://workers.tk.st/magi2/chat',{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},
    body:JSON.stringify({messages:[{role:'user',content:c.input}],theme:'light',classification_state:true,
      reply_language:{version:1,code:'ja',source:'ui'},ui_language:'ja',adaptive_debate:false,site_pages:false,magi_panel:false})});
  const waits=[],response=await ctx.worker.fetch(request,mode==='run'?keys:{MAGI_OPENAI_API_KEY:'mock',MAGI_ANTHROPIC_API_KEY:'mock',MAGI_DEEPSEEK_API_KEY:'mock'},
    {waitUntil(p){waits.push(p);}});
  const text=await response.text();await Promise.allSettled(waits);
  for(const frame of text.replaceAll('\r','').split('\n\n')){
    const name=frame.match(/^event: (.+)$/m)?.[1],raw=frame.match(/^data: (.+)$/m)?.[1];
    if(name==='persona'&&raw)row.events.push({name,data:JSON.parse(raw)});
  }
  const persons=Object.keys(configs);
  const complete=persons.every(who=>[1,2].every(round=>row.events.some(e=>e.data.codename===who&&e.data.round===round&&!e.data.absent&&e.data.text?.trim())));
  row.completed=response.ok&&complete&&/event: done\n/.test(text)&&!fatal;
  row.error=fatal||(row.completed?null:'incomplete_persona_rounds');persist();
  assert(row.completed,'討議の収集が完了しなかった。保存記録を確認してから再開する');
  assert(row.calls.every(c=>!c.stream));
  assert(row.calls.length>=6&&row.calls.length<=12);
  return row;
}

for(const c of cases){const row=await collect(c);console.log(JSON.stringify({mode,id:c.id,persona_calls:row.calls.length,completed:row.completed}));}
if(mode==='run'){report.complete=true;json(outputUrl,report);}
else if(mode==='plan'){
  mkdirSync(dir,{recursive:true});
  if(existsSync(planUrl))assert.deepEqual(JSON.parse(readFileSync(planUrl,'utf8')),plan,'既存計画と異なる。記録を確認する');
  else writeFileSync(planUrl,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({mode,maximum_usd:ceiling,network_calls:mode==='run'?report.results.reduce((n,r)=>n+r.calls.length,0):0}));
