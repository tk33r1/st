import {gameAiDb} from './fixtures/game-ai-db.mjs';
// 7ゲームの既存画面→Worker→Messages変換→描画を確認。AI・ランキング・解析の外部送信は止める。
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripAuxImports} from './aux-ai-config.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const outputArg=process.argv.find(a=>a.startsWith('--output-dir='))?.slice('--output-dir='.length);
const out=resolve(root,outputArg||'workers/.wrangler/auxiliary-haiku');
assert.ok(out.startsWith(resolve(root,'workers/.wrangler')+sep),'記録先はGit対象外のworkers/.wrangler配下だけ');
mkdirSync(out,{recursive:true});
const read=p=>readFileSync(resolve(root,p),'utf8');
const marker='動作確認できました';
const replay=process.argv.includes('--replay')?JSON.parse(readFileSync(resolve(out,'games-result.json'),'utf8')):null;
const server=createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),p=resolve(root,'.'+name+(name.endsWith('/')?'index.html':''));
  if(!p.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(p)]||'application/octet-stream');res.end(readFileSync(p));}
  catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(5500,'127.0.0.1',r));
let browser;
const results=[],requests=[];
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined,headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const allGames=['masala-tetris','omeme-tetris','masala-tetris-dx','masala-tetris-vindaloo','masala-tetris-tiffin','ascii-roguelike','kabuki-craft'];
 const gameArg=process.argv.find(a=>a.startsWith('--games='))?.slice('--games='.length);
 const games=gameArg?gameArg.split(','):allGames;
 assert.ok(games.length&&new Set(games).size===games.length&&games.every(g=>allGames.includes(g)),'既存の7ゲームだけを指定する');
 for(const game of games){
  const saved=replay?.results.find(r=>r.game===game);if(replay)assert.ok(saved?.completed,game+' recorded reply missing');
  const expected=saved?(game==='kabuki-craft'?JSON.parse(saved.text).say:saved.text).replace(/\s+/g,'').slice(0,14):marker;
  const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[],upstream=[];
  page.on('pageerror',e=>errors.push(e.message));
  const ctx=vm.createContext({crypto:globalThis.crypto,TextEncoder,AbortSignal,aiModels:JSON.parse(read('config/ai-models.json')),Request,Response,URL,Headers,AbortController,DOMException,TextDecoder,setTimeout,clearTimeout,
   fetch:async(_url,options)=>{const body=JSON.parse(options.body);upstream.push(body);assert.ok(_url.includes('anthropic'));
    const text=game==='kabuki-craft'?JSON.stringify({ping:1,say:marker,act:'idle',trust:0,fear:0,yen:0,info:''}):marker;
    return Response.json(saved?.reply||{stop_reason:'end_turn',content:[{type:'text',text}]});}});
  vm.runInContext(['workers/shared/anthropic.js','workers/games/anthropic.js','workers/games/src/index.js']
   .map(p=>stripAuxImports(read(p)).replace('export default {','globalThis.worker = {')).join('\n'),ctx);
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());
   if(['/api/gpt','/api/deepseek','/api/gemini'].includes(u.pathname)){
    const body=request.postDataJSON();requests.push({game,path:u.pathname,body});
    const response=await ctx.worker.fetch(new Request(request.url(),{method:'POST',headers:{Origin:'http://127.0.0.1:5500','Content-Type':'application/json'},body:JSON.stringify(body)}),
     {DB:gameAiDb(),GAME_AI_PROVIDER:'anthropic',GAME_ANTHROPIC_API_KEY:'fake-browser-only'});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
   }
   if(u.host==='127.0.0.1:5500'){await route.continue();return;}
   // Tailwindは表示用。解析・広告・画像・音声・ランキングは読み込まない。
   if(u.hostname==='cdn.tailwindcss.com'){await route.continue();return;}
   if(u.pathname.includes('/scores')){await route.fulfill({json:[]});return;}
   await route.abort();
  });
  await page.goto(`http://127.0.0.1:5500/game/${game}/`,{waitUntil:'domcontentloaded'});
  if(['masala-tetris','omeme-tetris'].includes(game)){
   await page.locator('#startPauseButton').click();await page.keyboard.press('ArrowDown');await page.locator('#aiCheerButton').click();
  }else if(['masala-tetris-dx','masala-tetris-vindaloo','masala-tetris-tiffin'].includes(game)){
   if(game==='masala-tetris-tiffin')await page.waitForFunction(text=>document.querySelector('#daily-order').innerText.replace(/\s+/g,'').includes(text),expected);
   await page.locator('#start-btn').click();await page.keyboard.press('ArrowDown');
  }else if(game==='ascii-roguelike'){
   await page.locator('#title-screen').click();await page.keyboard.press('ArrowRight');
   await page.evaluate(()=>openTerminal());await page.locator('#terminal-input').fill('階段はどの方角ですか');await page.locator('#terminal-send').click();
  }else{
   await page.locator('#g-yes').click();await page.locator('#t-start').click();await page.locator('#cg-name').fill('検証用');await page.locator('#cg-gang').fill('検証組');await page.locator('#cg-go').click();
   await page.keyboard.press('w');await page.evaluate(()=>Talk.start(NPCs[0]));
  }
  await page.waitForFunction(text=>document.body.textContent.replace(/\s+/g,'').includes(text),expected,{timeout:12000});
  assert.ok(upstream.length>0,game+' did not reach Messages');
  assert.deepEqual(errors,[],game+' page errors');
  await page.screenshot({path:resolve(out,game+(replay?'-replay':'')+'.png')});
  results.push({game,ok:true,calls:upstream.length,errors});console.log(game+': OK');await page.close();
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));
 writeFileSync(resolve(out,replay?'browser-replay.json':'browser.json'),JSON.stringify({results,requests},null,2)+'\n');}
