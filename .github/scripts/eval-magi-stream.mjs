// 先行0の実API・実時間評価。独立したローカルWorkerを先に起動する。
// 本文はGit対象外の.wrangler/へ保存し、標準出力には時間・イベント数だけを出す。
// node .github/scripts/eval-magi-stream.mjs --case pass|full|late|image|magi|dj|stall
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { createBufferProxy } from './sse-buffer-proxy.mjs';
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const name = option('--case','pass'), port = Number(option('--port','8787'));
const cases = {
  pass: {page:'home',mode:'pass',text:'休日に読書の時間を作りたい。毎日10分から始める工夫を教えて。'},
  full: {page:'home',dark:true,mode:'full',text:'仕事の休憩に短い散歩を取り入れたい。続けるコツを教えて。'},
  late: {page:'home',mode:'late',text:'小さな書店の運営者です。月の販促予算は2万円。平日は1人で店番し、週末だけ手伝いが来ます。新規客を増やすSNS投稿と、常連向け読書会のどちらに注力すべきか迷っています。両案の弱点と、3か月で判断する基準も検討してください。'},
  image: {page:'app',mode:'full',image:true,text:'添付した図の色と形を説明して、簡単なアイコンとしての見やすさを検討して。'},
  magi: {page:'home',dark:true,mode:'full',text:'平日の読書習慣を作るため、寝る前にスマホを別の部屋へ置くべき？'},
  dj: {page:'dj',mode:'chunk',text:'夕方の落ち着いた雰囲気に合う、聴きやすいソウルの曲を3曲提案して。'},
  stall: {page:'app',mode:'stall',text:'無応答時の期限を実時間で確認します。'},
};
assert.ok(cases[name],'unknown_case');
const cfg = {...cases[name],page:option('--page',cases[name].page),mode:option('--mode',cases[name].mode)};
assert.ok(['home','app','dj'].includes(cfg.page),'unknown_page');
const root = resolve(option('--root','.'));
const label = option('--label',name); assert.match(label,/^[a-z0-9-]+$/,'safe_report_name');
const output = resolve('workers/.wrangler/magi2-stream-eval/reports'); mkdirSync(output,{recursive:true});
const server = createServer((req,res) => {
  let path = new URL(req.url,'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root,'.'+path);
  if (!file.startsWith(root+sep) || !existsSync(file)) {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin = 'http://localhost:'+server.address().port;
const proxy = createBufferProxy({mode:cfg.mode,upstream:option('--upstream','http://localhost:8789')});
await new Promise(r=>proxy.listen(port,'127.0.0.1',r));
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:cfg.page==='home'?1280:390,height:900},serviceWorkers:'block'}), errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('st-analytics','off');
  window.__stream = {chunks:[],text:'',status:null,notes:[]};
  const original = window.fetch;
  window.fetch = async (...args) => {
    const chat = String(args[0]).includes('/magi2/chat');
    if (chat) window.__stream.start = performance.now();
    const response = await original(...args);
    if (chat) {
      window.__stream.headers = performance.now()-window.__stream.start;
      window.__stream.status = response.status;
      window.__stream.cache = response.headers.get('Cache-Control');
      const copy=response.clone();
      (async()=>{const reader=copy.body.getReader(),dec=new TextDecoder();try {while(true){const {value,done}=await reader.read();if(done)break;window.__stream.chunks.push({ms:performance.now()-window.__stream.start,bytes:value.byteLength});window.__stream.text+=dec.decode(value,{stream:true});}window.__stream.eof=performance.now()-window.__stream.start;} catch {window.__stream.disconnected=true;}})();
    }
    return response;
  };
});
await page.route('**/*',async route => {
  const url=new URL(route.request().url());
  if (!['localhost','127.0.0.1'].includes(url.hostname)) {await route.fulfill({status:200,body:''});return;}
  await route.continue();
});
try {
  if (cfg.page==='dj') {
    const res=await fetch('http://localhost:8788/dj/api/req/admin/event',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({title:'MAGI先行0ローカル検証'})});
    assert.equal(res.status,200,'local_DJ_event');
  }
  const path=cfg.page==='home'?'/':cfg.page==='app'?`/magi-app/www/?api=http://localhost:${port}`:`/dj/request/?api=http://localhost:${port}&req_api=http://localhost:8788`;
  await page.goto(origin+path,{waitUntil:'domcontentloaded'});
  if(cfg.dark) {await page.locator('[data-act="settings"]').click();await page.waitForTimeout(4800);}
  if(cfg.page==='dj') await page.locator('[data-tab="consult"]').click();
  const input=cfg.page==='dj'?'#chatInput':'#agent-input',send=cfg.page==='dj'?'#chatSend':'#agent-send';
  if(cfg.image) {
    // 評価用の青い円。入力だけに使い、ページの資産には追加しない。
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,128,128);x.fillStyle='blue';x.beginPath();x.arc(64,64,40,0,Math.PI*2);x.fill();return c.toDataURL('image/png').split(',')[1];});
    await page.locator('#agent-file').setInputFiles({name:'circle.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForTimeout(1000);
  }
  await page.locator(input).fill(cfg.text);await page.locator(send).click();
  const started=Date.now();let noteSeen=false,finished=false,stopped=false;
  while(Date.now()-started<325000) {
    if(await page.locator('.magi-stream-note').count()) noteSeen=true;
    if(process.argv.includes('--stop')&&!stopped&&await page.evaluate(()=>window.__stream.text.includes('event: done'))&&await page.locator(input).isDisabled()) {await page.locator(send).click();stopped=true;}
    const startedRequest=await page.evaluate(()=>Boolean(window.__stream.start));
    if(startedRequest && !await page.locator(input).isDisabled()) {finished=true;break;}
    await page.waitForTimeout(250);
  }
  const stream=await page.evaluate(()=>window.__stream), elapsed=Date.now()-started;
  const body=await page.locator(cfg.page==='dj'?'.ab':'.agent-reply-body').last().textContent().catch(()=>'');
  const saved=await page.evaluate(dj=>localStorage.getItem(dj?'tkdj.consults':'magi_current_history'),cfg.page==='dj');
  const names=[...stream.text.matchAll(/^event: (.+)$/gm)].map(m=>m[1]);
  // 保存値のJSONエスケープと、実際の改行入り本文を直接比べない。
  const hasAnswer = value => value === body || value && typeof value === 'object' && Object.values(value).some(hasAnswer);
  const answerSaved = Boolean(body && saved && hasAnswer(JSON.parse(saved)));
  const events=[...stream.text.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map(m=>({event:m[1],data:JSON.parse(m[2])}));
  const verdict=events.find(e=>e.event==='verdict')?.data;
  if(verdict) {
    const history=JSON.parse(saved),magi=history.at(-1).magi;
    for(const key of ['result','tally','rounds','votes']) assert.deepEqual(magi[key],verdict[key],'saved_verdict_'+key);
  }
  const deltaText=events.filter(e=>e.event==='integrated').map(e=>e.data.delta).join('');
  const uiFile=cfg.page==='app'?'magi-app/www/app.js':cfg.page==='dj'?'dj/request/index.html':'index.html';
  const uiHash=createHash('sha256').update(readFileSync(resolve(root,uiFile))).digest('hex');
  const counts=Object.fromEntries([...new Set(names)].map(ev=>[ev,names.filter(n=>n===ev).length]));
  const report={name,page:cfg.page,mode:cfg.mode,root,upstream:option('--upstream','http://localhost:8789'),date:new Date().toISOString(),elapsed,finished,stopped,noteSeen,answerSaved,headers:stream.headers,firstChunk:stream.chunks[0]?.ms,chunks:stream.chunks,counts,pings:[...stream.text.matchAll(/^: ping$/gm)].length,cache:stream.cache,input:await page.locator(input).inputValue(),answer:body,saved,errors,stream:stream.text};
  report.uiHash=uiHash;report.answerMatchesStream=body===deltaText;report.visibleText=cfg.mode==='stall'?await page.locator('body').innerText():undefined;
  writeFileSync(resolve(output,label+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({name,page:cfg.page,mode:cfg.mode,elapsed,finished,stopped,noteSeen,headers:stream.headers,firstChunk:stream.chunks[0]?.ms,chunks:stream.chunks.length,counts,pings:report.pings,answerChars:body.length,errors}));
  assert.ok(finished,'completion');assert.deepEqual(errors,[]);
  if(cfg.mode==='stall') {assert.ok(elapsed>=299000&&elapsed<315000,'real_300s_deadline');assert.equal(report.input,cfg.text);assert.ok(noteSeen);assert.match(report.visibleText,/timed out|タイムアウト/);}
  else {assert.equal(stream.status,200);assert.ok(names.includes('done'),'SSE_done');assert.ok(!names.includes('error'),'no_SSE_error');assert.ok(answerSaved,'answer_saved');assert.equal(body,deltaText,'display_matches_stream');assert.equal(report.input,'');if(cfg.mode==='pass'&&!process.argv.includes('--legacy'))assert.ok(!noteSeen,'pass_without_gap');if(cfg.mode==='full'&&elapsed>15000)assert.ok(noteSeen,'buffer_notice');if(name==='magi')assert.ok(names.includes('verdict'),'magi_verdict');if(name==='late')assert.ok([...stream.text.matchAll(/"round":(\d+)/g)].some(m=>Number(m[1])>=3),'third_round');if(process.argv.includes('--stop'))assert.ok(stopped,'stop_during_replay');}
} finally {
  await browser.close();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));
}
