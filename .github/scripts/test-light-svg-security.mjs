// 公開HTMLと同じCSPでSVGの隔離・最適化・中断を検証する。外部通信は遮断する。
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined,headless:true});
const marker='document.documentElement.dataset.securityProbe=String(731)';
const sample='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#aa3bff"/></svg>';
async function open(hang=false){
 const context=await browser.newContext({serviceWorkers:'block'}),requests=[],errors=[];
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());requests.push(u.pathname);
  if(u.hostname!=='tk-st-security.test')return route.abort();
  if(hang&&u.pathname.endsWith('/optimizer-worker.js'))return route.fulfill({body:'self.onmessage=()=>{};',contentType:'application/javascript'});
  const file=resolve(root,'.'+decodeURIComponent(u.pathname)+(u.pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(resolve(root)+sep)||!existsSync(file))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'}[extname(file)];
  await route.fulfill({body:readFileSync(file),...(type?{contentType:type}:{})});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://tk-st-security.test/tools/light-svg/');
 return {context,page,requests,errors,upload:text=>page.locator('#file-input').setInputFiles({name:'security-check.svg',mimeType:'image/svg+xml',buffer:Buffer.from(text)})};
}
try{
 const w=await open();
 await w.upload(sample);await w.page.locator('#opt-result').filter({hasText:'✓'}).waitFor();
 assert.equal(await w.page.locator('#svg-dims').textContent(),'100 × 50');
 assert.equal(await w.page.locator('#compare-before img, #compare-after img').count(),2);
 await w.page.waitForFunction(()=>[...document.querySelectorAll('#compare-before img,#compare-after img')].every(img=>img.complete&&img.naturalWidth>0));
 assert.match(await w.page.locator('#opt-code').textContent(),/<svg/);
 const downloadEvent=w.page.waitForEvent('download');
 await w.page.locator('#btn-download').click();
 const download=await downloadEvent;
 assert.equal(download.suggestedFilename(),'security-check.min.svg');
 assert.match(readFileSync(await download.path(),'utf8'),/<svg/);
 await w.page.locator('#slider-number').fill('2');await w.page.locator('#slider-number').dispatchEvent('input');
 await w.page.waitForFunction(()=>document.querySelector('#opt-cmd').textContent.includes('--precision 2'));
 assert.ok(w.requests.some(x=>x.includes('svgo@3.3.5/')));
 const malicious='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><foreignObject width="100" height="50"><body xmlns="http://www.w3.org/1999/xhtml"><img src="/security-marker-image" onerror="'+marker+'"/></body></foreignObject></svg>';
 await w.upload(malicious);await w.page.locator('#opt-result').filter({hasText:'✓'}).waitFor();await w.page.waitForTimeout(200);
 assert.equal(await w.page.evaluate(()=>document.documentElement.dataset.securityProbe),undefined);
 assert.equal(await w.page.locator('#compare-before svg,#compare-after svg').count(),0);
 assert.ok(!w.requests.includes('/security-marker-image'));
 assert.ok((await w.page.locator('#compare-before img').getAttribute('src')).startsWith('blob:'));
 await w.page.locator('#btn-reset').click();assert.equal(await w.page.locator('#compare-before img,#compare-after img').count(),0);
 await w.upload('<!DOCTYPE svg [<!ENTITY x "x">]>'+sample);await w.page.locator('#toast-msg').filter({hasText:'DOCTYPE'}).waitFor();
 await w.upload(sample+' '.repeat(5*1024*1024));await w.page.locator('#toast-msg').filter({hasText:'5MB'}).waitFor();
 assert.deepEqual(w.errors,[]);await w.context.close();
 console.log('SVG: normal optimization/dimensions/slider passed; active SVG inert; DTD/oversize rejected; reset cleared previews');
 const slow=await open(true);await slow.upload(sample);
 await slow.page.locator('#opt-result').filter({hasText:'5秒'}).waitFor({timeout:10000});
 assert.match(await slow.page.locator('#opt-result').textContent(),/5秒/);
 // タイムアウト後もメイン画面は操作できる。
 await slow.page.locator('#btn-reset').click();
 await slow.upload(sample);await slow.page.locator('#btn-reset').click();await slow.page.waitForTimeout(100);
 assert.equal(await slow.page.locator('#compare-before img,#compare-after img').count(),0);
 assert.deepEqual(slow.errors,[]);await slow.context.close();
 console.log('SVG: 5-second timeout and reset while optimizing passed; no stale preview or JS error');
}finally{await browser.close();}
