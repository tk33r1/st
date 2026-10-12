// 運用でtools/gameを停止してから実行する本番確認。設定はこのスクリプトから変えない。
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {chromium} from 'playwright';
assert.ok(process.argv.includes('--expect-disabled'),'本番停止の検査は --expect-disabled を明示する');
const index=process.argv.indexOf('--report'),out=resolve(index<0?'.github/scripts/.search-reading-env/work/scope-stop.json':process.argv[index+1]);
const report={started:new Date().toISOString(),base:'https://tk.st',cases:[],pass:false};let browser;
try {
  browser=await chromium.launch({headless:true});
  for(const [scope,query] of [['tools','PDF'],['game','MASALA']]) {
    const ctx=await browser.newContext({locale:'ja-JP'});await ctx.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    let posts=0;await ctx.route('**/*',route=>{
      const url=new URL(route.request().url());if(url.origin!=='https://tk.st')return route.abort();
      if(url.pathname==='/search/api/rank')posts++;return route.continue();
    });
    const page=await ctx.newPage();await page.goto('https://tk.st/'+scope+'/',{waitUntil:'domcontentloaded'});
    await page.locator('.st-search-data-status').filter({hasText:'文字と読みで検索できます'}).waitFor();
    const field=page.locator('.st-search-input');await field.fill(query);
    await page.locator('.st-search-suggestions li').first().waitFor();assert.equal(posts,0);
    const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/search/api/rank' && r.request().method()==='POST');
    await field.press('Enter');const response=await responsePromise,payload=await response.json();
    assert.equal(response.status(),200);assert.equal(payload.reason,'disabled');assert.equal(payload.complete,false);assert.equal(payload.searched,null);
    await page.locator('.st-search-rank-status').filter({hasText:'停止中'}).waitFor();
    assert.ok(await page.locator('.st-search-suggestions li').count());
    // 明示検索で①の全候補も開くため、停止後はその表示を検査する。
    const count=await page.locator('.st-search-local .st-search-link').count();
    assert.ok(count>0);await field.press('Enter');await page.waitForTimeout(100);assert.equal(posts,1);
    report.cases.push({scope,reason:payload.reason,searched:null,localResults:count,posts,automaticResend:false});await ctx.close();
  }
  report.pass=true;console.log(JSON.stringify(report));
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');await browser?.close();}
