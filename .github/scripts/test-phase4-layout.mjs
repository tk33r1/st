// 出荷HTMLの小画面・CSS拡大・キーボード・同じ状態の通知を確認。実機IME／読み上げの代用にはしない。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const root=resolve('.'),built=resolve('_site'),out=resolve('.github/scripts/.search-reading-env/work/layout');
mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{
  let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  if(path.endsWith('/'))path+='index.html';
  // UIは作業中の最新版を検証し、生成JSON・出荷ツリーは_siteを使う。
  const working=path.startsWith('/assets/')?resolve(root,'.'+path):null;
  const file=working && existsSync(working)?working:resolve(built,'.'+path);
  if(!file.startsWith(root+sep) || !existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const cases=[['site','/404.html','ニトリ'],['tools','/tools/','PDF'],['game','/game/','tetris'],['nitori','/job/nitoridaily/','店舗'],['retail','/job/retailtechdaily/','店舗']];
const report={date:new Date().toISOString(),cases:[]};let browser;
try {
  browser=await chromium.launch({headless:true});
  for(const [scope,path,query] of cases) {
    const page=await browser.newPage({locale:'ja-JP'});let posts=0;
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){await route.abort();return;}
      if(route.request().method==='POST'){posts++;await route.abort();return;}
      await route.continue();
    });
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('[data-st-search-readings=ready]'));
    const input=page.locator('.st-search-input');await input.fill(query);
    assert.ok(await page.locator('.st-search-suggestions li').count()>0);
    await page.evaluate(()=>{
      window.statusChanges=[];
      window.statusObserver=new MutationObserver(entries=>window.statusChanges.push(...entries.map(e=>e.target.className)));
      for(const el of document.querySelectorAll('.st-search [role=status]')) window.statusObserver.observe(el,{childList:true,subtree:true,characterData:true});
    });
    await input.fill(query+' ');await input.fill(query);
    assert.deepEqual(await page.evaluate(()=>window.statusChanges),[],'同じ状態を入力のたびに読み上げ対象へ差し替えない');
    await input.press('ArrowDown');assert.ok(await input.getAttribute('aria-activedescendant'));
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.st-search-input')),true);
    await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');await input.fill(query+' ');
    for(const [width,zoom] of [[320,1],[768,1],[1440,1],[1440,2]]) {
      await page.setViewportSize({width,height:900});await page.evaluate(zoom=>document.body.style.zoom=String(zoom),zoom);await input.focus();
      const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth,
        count:document.querySelectorAll('.st-search-suggestions li').length}));
      assert.ok(dimensions.scroll<=dimensions.width+2,scope+'/'+width+'/'+zoom+': 横のはみ出し '+JSON.stringify(dimensions));
      const panel=await page.locator('.st-search-suggestions').boundingBox();
      assert.ok(panel.x>=-2 && panel.x+panel.width<=width+2,scope+': 候補枠が画面の内側');
      const targets=await page.locator('.st-search-submit,.st-search-clear').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width).map(n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})));
      assert.ok(targets.every(r=>r.w>=43 && r.h>=43),scope+': 44pxの的');
      assert.ok(dimensions.count<=7);report.cases.push({scope,width,cssZoom:zoom,...dimensions});
      await page.screenshot({path:resolve(out,scope+'-'+width+'-'+zoom+'.png')});
    }
    await page.evaluate(()=>document.body.style.zoom='1');await page.setViewportSize({width:320,height:900});await input.focus();
    if(scope==='nitori' || scope==='retail') {
      assert.equal(await page.locator('.brand').isVisible(),false);
      assert.ok((await page.locator('.header-search').boundingBox()).width>240);
      await input.evaluate(el=>el.blur());assert.equal(await page.locator('.brand').isVisible(),true);
      assert.ok((await page.locator('.header-search').boundingBox()).width<=150);
    }
    assert.equal(posts,0);await page.close();console.log(scope+': 320/768/1440px・CSS200%・焦点・重複通知ゼロ');
  }
  writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
} finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
