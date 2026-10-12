// 公開2の実通信。固定の本番URLから説明とwwwを確認し、入力や会話は送らない。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {chromium} from 'playwright';
const reportPath=resolve('workers/.wrangler/magi2-app46-eval/production-app.json');
const report={pass:false,checked:new Date().toISOString(),www:[],screens:[],limitations:'Chromiumのみ。Android実機・WebView・ランチャーは未確認。'};
const origin='https://tk.st',api='https://workers.tk.st';
const git=(...args)=>execFileSync('git',args);
let browser;
try {
  const res=await fetch(api+'/magi2/models',{headers:{Origin:origin},cache:'no-store'});assert.equal(res.status,200);
  const models=await res.json();assert.deepEqual(Object.values(models.personas).map(p=>p.provider).sort(),['deepseek','google','openai']);
  for(const p of [...Object.values(models.personas),models.synthesizer])assert.equal(p.provider_label,{openai:'OpenAI',deepseek:'DeepSeek',google:'Google'}[p.provider]);
  for(const lang of ['ja','en'])assert.equal(models.privacy[lang].length,14);
  for(const file of git('ls-files','magi-app/www/').toString().trim().split('\n')) {
    const remote=await fetch(origin+'/'+file,{cache:'no-store'});assert.equal(remote.status,200);
    const bytes=Buffer.from(await remote.arrayBuffer());assert.deepEqual(bytes,git('show','HEAD:'+file),'配布www: '+file);
    report.www.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  browser=await chromium.launch({headless:true});
  for(const [name,path,lang,scheme,failed] of [
    ['top-en','/','en','light',false],['top-ja','/','ja','light',false],
    ['PWA-light','/magi-app/www/','en','light',false],['PWA-dark','/magi-app/www/','en','dark',false],
    ['top-offline-description','/','en','light',true],['PWA-offline-description','/magi-app/www/','en','light',true]
  ]) {
    const ctx=await browser.newContext({locale:'ja-JP',viewport:{width:path==='/'?1280:390,height:900},colorScheme:scheme,serviceWorkers:'block'});
    const page=await ctx.newPage(),github=[],errors=[];
    await ctx.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    page.on('pageerror',e=>errors.push(e.message));
    await ctx.route('**/*',route=>{
      const url=new URL(route.request().url());if(url.hostname==='api.github.com')github.push(url.href);
      if(url.origin===origin&&!url.pathname.startsWith('/cdn-cgi/'))return route.continue();
      if(url.origin===api&&url.pathname==='/magi2/models')return failed?route.abort():route.continue();
      return route.abort();
    });
    try {
      await page.goto(origin+path,{waitUntil:'domcontentloaded'});await page.locator('.magi-ver').waitFor();
      assert.match(await page.locator('.magi-ver').textContent(),/ver 4\.6\b/);
      if(path==='/'&&lang==='ja')await page.evaluate(()=>setLanguage('ja'));
      if(path!=='/'){
        assert.equal(await page.locator('html').getAttribute('data-theme'),scheme);
        await page.emulateMedia({colorScheme:scheme==='light'?'dark':'light'});
        await page.waitForFunction(t=>document.documentElement.getAttribute('data-theme')===t,scheme==='light'?'dark':'light');
        await page.locator('#btn-theme').click();const manual=await page.locator('html').getAttribute('data-theme');
        await page.emulateMedia({colorScheme:scheme});await page.waitForTimeout(100);assert.equal(await page.locator('html').getAttribute('data-theme'),manual);
      }
      await page.locator('#btn-info-agent').click();const list=page.locator('.agent-privacy-list');
      if(failed){await list.getByText(/Could not load/).waitFor();assert.doesNotMatch(await list.textContent(),/OpenAI|DeepSeek|Google|Gemini/);}
      else{await list.getByText(models.privacy[lang][0].text,{exact:true}).waitFor();assert.deepEqual(await list.locator('li').allTextContents(),models.privacy[lang].map(p=>p.text));}
      assert.equal(await list.locator('strong').count(),0);assert.deepEqual(github,[]);assert.deepEqual(errors,[]);
      report.screens.push({name,pass:true,paragraphs:await list.locator('li').count(),githubRequests:github.length});console.log(name+' OK');
    }finally{await ctx.close();}
  }
  report.pass=true;
} catch(error){report.error=error.message;throw error;}
finally{mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');await browser?.close();}
