// Phase 4の実通信・URL・計測を確認。解析送信は記録して止め、--liveだけ②を5回実行する。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const remote=option('--base',null),root=resolve(option('--root','_site')),live=process.argv.includes('--live');
const out=resolve(option('--report','.github/scripts/.search-reading-env/work/publication.json'));
if(live && remote!=='https://tk.st')throw new Error('実検索は本番の固定Originだけ');
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json','.css':'text/css',
  '.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
let server;
if(!remote) {
  server=createServer((req,res)=>{
    let file=resolve(root,'.'+new URL(req.url,'http://local').pathname);
    if(!file.startsWith(root+sep)){res.writeHead(400);res.end();return;}
    if(existsSync(file) && statSync(file).isDirectory())file=resolve(file,'index.html');
    const found=existsSync(file);if(!found)file=resolve(root,'404.html');
    res.writeHead(found?200:404,{'Content-Type':mime[extname(file)] || 'application/octet-stream'});res.end(readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
}
const base=remote || `http://127.0.0.1:${server.address().port}`,origin=new URL(base).origin;
const marker='zqxphase4mark',query=marker+' 収納',pii='a.b@example.com 090-1234-5678';
const decode=text=>{let value=(text || '').replace(/\+/g,' ');for(let i=0;i<2;i++){try{value=decodeURIComponent(value);}catch{break;}}return value;};
const analyticsScript=url=>/^https:\/\/www\.googletagmanager\.com\/(?:gtm\.js|gtag\/js)\?/.test(url)
  || url==='https://analytics.ahrefs.com/analytics.js';
const google=host=>/(^|\.)google-analytics\.com$|^analytics\.google\.com$|^stats\.g\.doubleclick\.net$|^www\.google\.[a-z.]+$/.test(host);
const report={started:new Date().toISOString(),base,live,liveRequests:0,analyticsLoaded:[],cases:[],limitations:'Chromiumのみ。OSのIMEと実機読み上げは含まない。解析送信は記録して停止。'};
const loaded=new Set();let browser;
const scripts=new Map();
const close=async ctx=>{await ctx.unrouteAll({behavior:'wait'});await ctx.close();};
async function context(off=false,allowLive=false) {
  const ctx=await browser.newContext({locale:'ja-JP'}),log=[],posts=[];
  if(off)await ctx.addInitScript(()=>localStorage.setItem('st-analytics','off'));
  await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),headers=await req.allHeaders();
    if(url.origin===origin && url.pathname==='/search/api/rank') {
      assert.equal(req.method(),'POST');assert.equal(url.search,'');assert.ok(!decode(headers.referer).includes(marker));
      posts.push(req.postDataJSON());
      if(allowLive){report.liveRequests++;return route.continue();}
      return route.fulfill({json:{status:'failed',reason:'disabled',complete:false,cached:false,searched:null,results:[]}});
    }
    if(url.origin===origin && !url.pathname.startsWith('/cdn-cgi/'))return route.continue();
    const body=req.postData() || '',referer=headers.referer || '';
    log.push({host:url.host,url:req.url(),body,referer});
    if(analyticsScript(req.url())) {
      if(off)throw new Error('解析停止中に計測スクリプトを取得');
      if(!scripts.has(req.url()))scripts.set(req.url(),(async()=>{
        const response=await route.fetch({timeout:8000});assert.ok(response.ok(),'実計測スクリプトの取得');
        loaded.add(url.host+url.pathname);return {status:response.status(),headers:response.headers(),body:await response.body()};
      })());
      return route.fulfill(await scripts.get(req.url()));
    }
    return route.abort();
  });
  return {ctx,log,posts};
}
const ready=page=>page.locator('.st-search-data-status').filter({hasText:/文字と読みで検索できます|Text and reading search is ready/}).waitFor();
const locationSafe=async page=>assert.ok(!decode(await page.evaluate(()=>location.href)).includes(marker),'検索語をURLに残さない');
function checkLog(log) {
  for(const entry of log) {
    const remove=text=>google(entry.host)?text.replace(/(^|[?&\n])ep\.search_term=[^&\n]*/g,'$1'):text;
    for(const text of [remove(entry.url),remove(entry.body),entry.referer])
      assert.ok(!decode(text).includes(marker),'計測のsearch_term以外に検索語を載せない');
    const text=decode(entry.url+'\n'+entry.body+'\n'+entry.referer);
    assert.ok(!text.includes('a.b@example.com') && !text.includes('090-1234-5678'),'計測の個人情報を伏せる');
    assert.ok(!/(?:^|[?&\n])en=view_search_results(?:&|$)/.test(entry.url+'\n'+entry.body),'自動検索イベントを送らない');
  }
}
const screens=[['site','/phase4-validation/missing/deep/','Thought'],['tools','/tools/','PDF'],['game','/game/','MASALA'],
  ['nitori','/job/nitoridaily/','収納'],['retail','/job/retailtechdaily/','AI']];
try {
  browser=await chromium.launch({headless:true});
  for(const [scope,path,text] of screens) {
    const {ctx,log,posts}=await context(),page=await ctx.newPage();
    const response=await page.goto(base+path,{waitUntil:'domcontentloaded'});if(scope==='site')assert.equal(response.status(),404);
    await ready(page);const field=page.locator('.st-search-input');
    await field.fill(query+' '+pii);assert.equal(posts.length,0);
    const sort=page.locator('[data-sort]');if(await sort.count())await sort.selectOption({index:1});
    assert.equal(posts.length,0);await field.press('Enter');
    await page.locator('.st-search-rank-status').filter({hasText:/停止中|disabled/}).waitFor();assert.equal(posts.length,1);
    await locationSafe(page);await page.waitForTimeout(1000);checkLog(log);
    if(scope!=='site') {
      const suffixes=['?keep=1&q='+encodeURIComponent(query)+'#shelf','?keep=1#q='+encodeURIComponent(query)];
      for(const suffix of suffixes) {
        await page.goto(base+path+suffix,{waitUntil:'domcontentloaded'});await ready(page);
        assert.equal(await field.inputValue(),query);await locationSafe(page);assert.equal(posts.length,1);
        assert.equal(new URL(page.url()).search,'?keep=1');
      }
      await page.evaluate(q=>location.hash='#q='+encodeURIComponent(q),query);await page.waitForTimeout(100);
      assert.equal(await field.inputValue(),query);await locationSafe(page);assert.equal(posts.length,1);
      await page.reload({waitUntil:'domcontentloaded'});await ready(page);assert.equal(await field.inputValue(),'');
      // 不正な受け渡しも取得・計測より先にURLから除く。
      for(const suffix of ['?q='+marker+'&q=x','#q='+marker+'%E0%A4','#q='+marker+'a'.repeat(201), '?q='+marker+'#q=x']) {
        await page.goto(base+path+suffix,{waitUntil:'domcontentloaded'});await ready(page);
        await locationSafe(page);assert.equal(await field.inputValue(),'');assert.equal(posts.length,1);
      }
      if(scope==='nitori' || scope==='retail') {
        const link=page.locator('[data-archive-month] a').first();const issue=await link.getAttribute('href');
        await page.goto(new URL(issue,page.url()).href,{waitUntil:'domcontentloaded'});
        const header=page.locator('.header-search input[type=search]');await header.fill(query);await header.press('Enter');
        await page.waitForURL(url=>url.pathname===path);await ready(page);assert.equal(await field.inputValue(),query);
        await locationSafe(page);assert.equal(posts.length,1);
        await page.locator('[data-archive-month] a').first().click();
        await page.waitForURL(url=>/\/\d{8}\/$/.test(url.pathname));
        assert.ok(!decode(await page.evaluate(()=>document.referrer)).includes(marker));await locationSafe(page);
      }
    }
    checkLog(log);report.cases.push({scope,urlAndPrivacy:true,analyticsRequestsStopped:log.length,explicitPosts:posts.length});await close(ctx);
    const off=await context(true),offPage=await off.ctx.newPage();await offPage.goto(base+path,{waitUntil:'domcontentloaded'});await ready(offPage);
    await offPage.locator('.st-search-input').fill(query);await offPage.locator('.st-search-input').press('Enter');await offPage.waitForTimeout(250);
    assert.equal(off.posts.length,1);assert.equal(await offPage.evaluate(()=>(window.dataLayer || []).filter(e=>/rank_run|search_used/.test(e.event || '')).length),0);
    checkLog(off.log);await close(off.ctx);
    if(live) {
      const actual=await context(true,true),livePage=await actual.ctx.newPage();await livePage.goto(base+path,{waitUntil:'domcontentloaded'});await ready(livePage);
      let payload;const responsePromise=livePage.waitForResponse(r=>new URL(r.url()).pathname==='/search/api/rank' && r.request().method()==='POST');
      await livePage.locator('.st-search-input').fill(text);await livePage.locator('.st-search-input').press('Enter');payload=await (await responsePromise).json();
      assert.ok(['results','no_results'].includes(payload.status),scope+': '+payload.reason);assert.equal(payload.complete,true);assert.equal(payload.searched.scope,scope);
      assert.equal(actual.posts.length,1);for(const row of payload.results)assert.ok(row.url.startsWith(scope==='site'?'/':scope==='tools'?'/tools/':scope==='game'?'/game/':path));
      await livePage.locator('.st-search').screenshot({path:resolve(out,'..','live-'+scope+'.png')});
      report.cases.at(-1).live={status:payload.status,count:payload.results.length,complete:payload.complete,cached:payload.cached,generation:payload.searched.generation};
      await close(actual.ctx);
    }
    console.log(scope+': URL・計測・明示操作・解析停止'+(live?'・本番②':''));
  }
  report.analyticsLoaded=[...loaded];
  if(remote) {
    assert.ok([...loaded].some(s=>s.startsWith('www.googletagmanager.com/')),'本物のGTMが読み込めたこと');
    assert.ok(loaded.has('analytics.ahrefs.com/analytics.js'),'本物のAhrefsが読み込めたこと');
  }
  report.pass=true;
} catch(error) {report.pass=false;report.error=error.message;throw error;}
finally {
  mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  await browser?.close();if(server)await new Promise(r=>server.close(r));
}
