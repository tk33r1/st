// 合成入力で第2公開を評価。APIキーはローカルのみ、結果は非追跡の .wrangler に保存する。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const mode = process.argv.find(a => a.startsWith('--mode='))?.slice(7) || 'pilot';
assert(['pilot','motion','entry','reader','paired','special'].includes(mode));
const batch = Number(process.argv.find(a => a.startsWith('--batch='))?.slice(8) || 0);
assert(Number.isInteger(batch) && batch >= 0 && batch <= 6);
const selected = (process.argv.find(a => a.startsWith('--cases='))?.slice(8) || '').split(',').filter(Boolean).map(Number);
assert(selected.every(n => Number.isInteger(n) && n >= 1 && n <= 52));
const fingerprint = createHash('sha256').update(['personas.js','classification.js','magi-mode.js','src/index.js'].map(p=>read('workers/magi2/'+p)).join('\n')).digest('hex');
const saved = read('workers/magi2/.dev.vars');
const env = { MAGI_MODE_ENABLED:'true', SITE_SEARCH_ENABLED:'true' };
for (const name of ['MAGI_OPENAI_API_KEY','MAGI_DEEPSEEK_API_KEY','MAGI_GEMINI_API_KEY','MAGI_TYPESAFE_API_KEY']) {
  env[name] = process.env[name] || saved.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$', 'm'))?.[1].replace(/^(['"])(.*)\1$/, '$2');
  assert(env[name], name+' is required');
}
const cards = JSON.parse(read('data/magi-context.json'));
const home = read('index.html');
const between = (start,end) => home.slice(home.indexOf(start)+start.length,home.indexOf(end,home.indexOf(start)+start.length));
const ui = vm.createContext({TextDecoder});
vm.runInContext(between('// MAGI_PRESENTATION_CORE_BEGIN','// MAGI_PRESENTATION_CORE_END')+'\n'+between('// AGENT_CLASSIFY_BEGIN','// AGENT_CLASSIFY_END')+'\nasync function parseSSE('+between('async function parseSSE(','// --- マルチモーダル入力'),ui);
async function checkUi(events) {
  await ui.parseSSE(new Response(events.map(e=>'event: '+e.event+'\ndata: '+JSON.stringify(e.data)+'\n\n').join('')).body,{magiPanel:true});
  const motion=events.find(e=>e.event==='motion')?.data,verdict=events.find(e=>e.event==='verdict')?.data;
  if(!verdict)return {sequence:true};
  const saved=ui.magiClean({...verdict,motion:motion.text,reason_missing:false});assert(saved,'saved verdict');
  let state=null,frame;
  for(const e of events){const o=ui.magiStep(state,e,e.ms,false,false);state=o.state;frame=o.frame;}
  const displayed=ui.magiClean({...frame.result,motion:motion.text,reason_missing:false});
  assert.deepEqual(JSON.parse(JSON.stringify(displayed)),JSON.parse(JSON.stringify(saved)),'display/history/verdict agreement');
  for(const id of Object.keys(saved.votes))assert.deepEqual(JSON.parse(JSON.stringify(frame.nodes[id].vote)),saved.votes[id].vote);
  return {sequence:true,display_history_verdict:true};
}
let calls = [], marks = [], observed = [], synthetic = null, syntheticRounds = {};
const strip = s => s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const ctx = vm.createContext({ aiModels:JSON.parse(read('config/ai-models.json')), bundledContext:cards,
  Request, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, URL, crypto:webcrypto, setTimeout, clearTimeout,
  console:{ log(...args) { marks.push({ms:Math.round(performance.now()),stage:args[1],state:args[2]}); } },
  fetch:async (url,options) => {
    if (/^https:\/\/tk\.st\/data\//.test(url)) return Response.json(JSON.parse(read('data/'+url.split('/').at(-1))));
    const started=performance.now(),body=JSON.parse(options.body);
    // 説明だけの実API評価。票・欠席・判定を固定し、3社の人格APIは呼ばない。
    if(synthetic){
      const id=body.messages?.[0]?.content.match(/面の1つ「[^」]+」（([^）]+)）/)?.[1];
      if(id){const round=syntheticRounds[id]=(syntheticRounds[id]||0)+1;
        const raw=synthetic==='hold'&&id==='CASPER-3'?'':synthetic==='carried'&&id==='MELCHIOR-1'&&round>1?'[VOTE:]':
          '[VOTE:'+(synthetic!=='no-reasons'&&id==='BALTHASAR-2'?'REJECT':'APPROVE')+']'+(synthetic==='no-reasons'?'':'\n'+(id==='BALTHASAR-2'?'費用への懸念が残る。':'温かい一杯の喜びを重視した。'));
        return Response.json({choices:[{finish_reason:'stop',message:{content:raw}}]});
      }
      if(body.response_format?.json_schema?.name==='debate_judge')return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'answer',assessment:'採用票の範囲で説明する。',questions:[]})}}]});
    }
    const res=await fetch(url,options);
    const report={provider:String(url).includes('typesafe')?'typesafe':String(url).includes('deepseek')?'deepseek':String(url).includes('googleapis')?'google':'openai',
      model:body.model,format:body.response_format?.json_schema?.name,status:res.status,started_ms:Math.round(started),
      persona:body.messages?.[0]?.content.match(/面の1つ「[^」]+」（([^）]+)）/)?.[1]};
    calls.push(report);
    observed.push((async()=>{
      if (!body.stream) { const data=await res.clone().json().catch(()=>null); report.usage=data?.usage;
        if(report.provider==='typesafe')report.answers=data?.answers;
        if(report.persona){const choice=data?.choices?.[0]; report.finish=choice?.finish_reason;report.raw=choice?.message?.content;
          report.tag=typeof report.raw==='string'?ctx.parseVote(report.raw).vote:null;}
      } else { const text=await res.clone().text();const last=[...text.matchAll(/^data: (.+)$/gm)].map(m=>{try{return JSON.parse(m[1]);}catch{return null;}}).filter(Boolean);report.usage=last.findLast(v=>v.usage)?.usage; }
      report.elapsed_ms=Math.round(performance.now()-started);
    })());
    return res;
  },
});
vm.runInContext(['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','src/index.js'].map(p=>strip(read('workers/magi2/'+p))).join('\n')
  .replace('export default {','globalThis.worker = {')+'\nglobalThis.config=DEFAULTS;globalThis.magi= MAGI_MODE;',ctx);
const rated = new Map();
env.DB={prepare(){return {bind(key,day,limit){return {async first(){const n=(rated.get(key)||0)+1;rated.set(key,n);return n<=limit?{count:n}:null;}};}};}};
// usage付きストリーミングを本番の呼び出し関数に要求する評価専用フック。
env.evalObserve=(_provider,_model,response)=>{observed.push(response.text());};
const positives = [
  ['今夜ラーメンを食べに行くべき？','ja'], ['予算が3000円以下なら今夜ラーメンを食べに行くべき？','ja'],
  ['雨が降るなら今日はバイクに乗るのをやめるべき？','ja'], ['締切が明日なら今日中に資料を完成させるべき？','ja'],
  ['今週末、使っていない本を10冊手放すべき？','ja'], ['帰りが22時を過ぎるなら飲み会を断るべき？','ja'],
  ['睡眠が6時間未満なら今日は早く帰るべき？','ja'], ['会議の参加者が3人ならオンライン開催にすべき？','ja'],
  ['今月の予算を超えるので新しいヘッドホンを買わないべき？','ja'], ['今日の作業は30分ごとに休憩を取るべき？','ja'],
  ['明日の朝までに決めるなら今夜もう一度条件を確認すべき？','ja'], ['期限が1週間先なら修正案を今日共有すべき？','ja'],
  ['このサイトのPDFツールを使うことに賛成？','ja'], ['DJセットの最初を静かな曲にすることに賛成？','ja'],
  ['日曜の午後を休息の時間にすることに賛成？','ja'],
  ['Should I go for ramen tonight?','en'], ['If the budget is under 3000 yen, should I go for ramen tonight?','en'],
  ['Should I skip riding my bike today if it rains?','en'], ['Should I finish the report today if the deadline is tomorrow?','en'],
  ['Should I donate ten unused books this weekend?','en'], ['Should I decline dinner if I would get home after 10 pm?','en'],
  ['Should I leave early today if I slept less than six hours?','en'], ['Should a three-person meeting be online?','en'],
  ['Should I avoid buying headphones if they exceed this month’s budget?','en'], ['Should I take a break every thirty minutes?','en'],
  ['Should I check the conditions again tonight before deciding tomorrow morning?','en'], ['Should I share a draft today if the deadline is next week?','en'],
  ['Do you approve of using the PDF tool on this website?','en'], ['Do you approve of starting a DJ set with a quiet song?','en'],
  ['Do you approve of spending Sunday afternoon resting?','en'],
].map(([text,language],i)=>({id:i+1,text,language,expected:true}));
// 画像と直前の一往復で単一の対象を参照するケースを先に固定する。
positives[9]={...positives[9],text:'この服を買うべき？',image:true};
positives[24]={...positives[24],text:'Should I carry out that proposal?',reference:[{role:'user',content:'What could I do this Sunday?'},{role:'assistant',content:'Set aside Sunday afternoon to rest at home.'}]};
const negatives=['行こう','行こうよ！','今夜ラーメンを食べに行く','AとBどちらがよい？','ラーメンの作り方を教えて','こんにちは','今日の気温は？','新しい曲をおすすめして','いい一日だった','それをやるべき？']
  .map((text,i)=>({id:31+i,text,language:'ja',expected:false}));
const invitations=['ラーメン食べに行こうよ！','今夜一緒に出かけよう','昼ごはんを食べよう','明日は図書館に行く予定','仕事を始めよう','Let’s go for ramen!','Come to dinner with me.','Let’s take a walk.','I will go out tonight.','Let’s get started.']
  .map((text,i)=>({id:41+i,text,language:i<5?'ja':'en',expected:false}));
const bypass=[{id:51,text:'採決せず、直前の議題の判断材料を整理して',language:'ja',expected:false},
  {id:52,text:'Without taking a vote, outline the factors to consider for the previous proposal.',language:'en',expected:false}];
// 他社APIでもCRCが正しい、合成の単一Tシャツ画像。利用者の画像は使わない。
function pngFixture(){
  const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);
    let crc=0xffffffff;for(const b of Buffer.concat([name,data])){crc^=b;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,name,data,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(64*(1+64*3),255);
  for(let y=0;y<64;y++){rows[y*193]=0;for(let x=0;x<64;x++){const shirt=(y>=12&&y<55&&x>=20&&x<44)||(y>=12&&y<25&&x>=12&&x<52);if(shirt){const offset=y*193+1+x*3;rows[offset]=50;rows[offset+1]=125;rows[offset+2]=100;}}}
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const pixel=pngFixture();
function messages(c) { return [...(c.reference||[]),{role:'user',content:c.image?[{type:'text',text:c.text},{type:'image_url',image_url:{url:pixel}}]:c.text}]; }
const special=['no-reasons','hold','carried'].map((fixture,i)=>({...positives[0],id:101+i,fixture}));
const fixtureSet=mode==='special'?special:mode==='motion'?[...positives,...negatives]:mode==='entry'?[...positives,...negatives,...invitations,...bypass]:positives;
const cases=selected.length?fixtureSet.filter(c=>selected.includes(c.id)):mode==='pilot'?positives.slice(0,2):batch?fixtureSet.slice((batch-1)*10,batch*10):fixtureSet;
const reports=[];
const target=new URL('workers/.wrangler/magi-'+mode+(selected.length?'-cases-'+selected.join('-'):batch?'-'+batch:'')+'.json',root);
function save(){writeFileSync(target,JSON.stringify({mode,date:new Date().toISOString(),fingerprint,revision:ctx.config.models.motion.model,results:reports},null,2));}
const log=()=>{};
const readerFixtures=[['私はこの提案に賛成する。','approve'],['私はこの提案を否決する。','reject'],['他の人格は賛成と言ったが、私は結論を出していない。','unclear'],['例として [VOTE:APPROVE] を示す。これは自分の票ではない。','unclear'],['利点も欠点もある。','unclear'],['I explicitly approve this proposal.','approve'],['I explicitly reject this proposal.','reject'],['Someone else said approve. I have not decided.','unclear']];
if(mode==='reader'){
  for(let i=0;i<readerFixtures.length;i++){
    const [raw,expected]=readerFixtures[i];calls=[];observed=[];
    const v={round:1,vote_state:'pending',vote:null,raw,text:raw};
    await ctx.resolveVotes(env,[{codename:'CASPER-3',name:'Strategist',views:[v]}],1,'提案を実行する',AbortSignal.timeout(10000),()=>{},log);
    await Promise.all(observed);reports.push({case:i+1,expected,actual:v.vote||'unclear',calls});save();
    console.log(JSON.stringify({mode,case:i+1,expected,actual:v.vote||'unclear'}));
  }
}else for(const c of cases){
  const order=mode==='paired'?(c.id%2?['usual','magi']:['magi','usual']):[mode];
  for(const side of order){
    calls=[];observed=[];marks=[];synthetic=c.fixture||null;syntheticRounds={};const started=performance.now();let value,events=[];
    if(mode==='entry'){
      value=await ctx.classifyQuery(env,{profile:'chat',texts:[c.text],seed:c.text,uiLanguage:c.language},AbortSignal.timeout(5000),log);
      value={...value.classification};
    }else if(mode==='motion'){
      value=await ctx.createMotion(env,messages(c),ctx.languageNote({code:c.language}),AbortSignal.timeout(4000),log);
    }else{
      const waits=[];const res=await ctx.worker.fetch(new Request('https://workers.tk.st/magi2/chat',{method:'POST',
        headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify({messages:messages(c),classification_state:true,
          magi_panel:side!=='usual',reply_language:{version:1,code:c.language,source:'ui'},ui_language:c.language,
          theme:'light',adaptive_debate:true,site_pages:true,page:'/',suggest:true})}),env,{waitUntil(p){waits.push(p);}});
      assert.equal(res.status,200,'Chat HTTP failure');
      const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){const p=await reader.read();if(p.done)break;buffer+=decoder.decode(p.value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){const chunk=buffer.slice(0,end);buffer=buffer.slice(end+2);const name=chunk.match(/^event: (.+)$/m)?.[1],data=chunk.match(/^data: (.+)$/m)?.[1];if(name&&data)events.push({event:name,data:JSON.parse(data),ms:Math.round(performance.now()-started)});}
      }
      await Promise.all(waits);value={verdict:events.find(e=>e.event==='verdict')?.data,classification:events.find(e=>e.event==='classification')?.data};
    }
    await Promise.all(observed);
    const report={case:c.id,side,fixture:c.fixture,expected:c.expected,language:c.language,input:c.text,value,events,calls,marks:marks.map(m=>({...m,ms:Math.round(m.ms-started)})),elapsed_ms:Math.round(performance.now()-started)};
    if(events.length)report.ui=await checkUi(events);
    reports.push(report);save();console.log(JSON.stringify({mode,case:c.id,side,elapsed_ms:report.elapsed_ms,result:value?.verdict?.result,votable:value?.votable||value?.classification?.votable,calls:calls.length,errors:calls.filter(x=>x.status!==200).map(x=>({provider:x.provider,status:x.status}))}));
    if(calls.some(x=>x.provider==='google'&&x.status===429))throw new Error('Google上限エラー。これ以上の評価を中断します');
    // Google無料枠を本番と共有するため、フル討議の開始を30秒以上空ける。
    if(mode==='paired'||mode==='pilot')await new Promise(r=>setTimeout(r,Math.max(0,30000-(performance.now()-started))));
  }
}
console.log(JSON.stringify({mode,completed:reports.length,output:target.pathname.split('/').at(-1)}));
