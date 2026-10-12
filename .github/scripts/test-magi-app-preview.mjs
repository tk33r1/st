// 公開2の実画面検査。API/Releaseは固定応答で、端末の設定と保存禁止も再現する。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, extname, sep} from 'node:path';
import {chromium} from 'playwright';
const root=resolve(process.argv[2]||'.'),out=resolve('workers/.wrangler/magi2-app46-eval');mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{
  let path=new URL(req.url,'http://localhost').pathname;if(path.endsWith('/'))path+='index.html';
  const file=resolve(root,'.'+path);if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});const results=[];
const model={provider:'future',provider_label:'Future Co <literal>',model:'test model',desc:{en:'description',ja:'説明'},context:{en:'context',ja:'素材'},theme:{en:'theme',ja:'テーマ'}};
const paragraphs=[{text:'Shared text <strong>literal</strong>'},{text:'Site guidance',requires:['site_pages']},{text:'Web search hidden',requires:['fact_mode']},{text:'Unknown hidden',requires:['future']},{text:'Partial hidden',requires:['site_pages','future']}];
const models={personas:{'MELCHIOR-1':model},synthesizer:model,themes:{light:model,dark:{...model,provider_label:'Dark Co'}},privacy:{en:paragraphs,ja:paragraphs}};
async function scenario(name,path,{native=false,scheme='light',api='ok',stored={},language='en',blocked=false}={}){
  const ctx=await browser.newContext({viewport:{width:path==='/'?1280:390,height:900},locale:language,colorScheme:scheme,serviceWorkers:'block'});
  const page=await ctx.newPage(),errors=[],releases=[],modelCalls=[];let modelMode=api,release='v4.7';
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({native,stored,blocked})=>{
    if(native)window.Capacitor={isNativePlatform:()=>true};
    localStorage.setItem('magi_theme','dark');localStorage.setItem('st-analytics','off');
    Object.entries(stored).forEach(([k,v])=>localStorage.setItem(k,v));
    if(blocked){Storage.prototype.getItem=()=>{throw new Error('blocked');};Storage.prototype.setItem=()=>{throw new Error('blocked');};Storage.prototype.removeItem=()=>{throw new Error('blocked');};}
  },{native,stored,blocked});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.host==='api.github.com'){releases.push(url.href);await route.fulfill({json:{tag_name:release}});return;}
    if(url.pathname==='/magi2/models'){modelCalls.push(url.href);if(modelMode==='failure'){await route.fulfill({status:503,json:{}});return;}
      await route.fulfill({json:modelMode==='legacy'?{personas:{'MELCHIOR-1':{...model,provider_label:undefined}},synthesizer:{...model,provider_label:undefined}}:models});return;}
    if(url.origin!==origin){await route.fulfill({status:200,body:''});return;}await route.continue();
  });
  try{
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});await page.locator('.magi-ver').waitFor();
    assert.match(await page.locator('.magi-ver').textContent(),/ver 4\.6/);
    if(path!=='/'){
      assert.equal(await page.locator('html').getAttribute('data-theme'),scheme);
      if(!blocked)assert.equal(await page.evaluate(()=>localStorage.getItem('magi_theme')),null);
      await page.emulateMedia({colorScheme:scheme==='light'?'dark':'light'});await page.waitForTimeout(50);
      assert.equal(await page.locator('html').getAttribute('data-theme'),scheme==='light'?'dark':'light');
      await page.locator('#btn-theme').click();const chosen=await page.locator('html').getAttribute('data-theme');
      await page.emulateMedia({colorScheme:scheme});assert.equal(await page.locator('html').getAttribute('data-theme'),chosen);
    }else assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await page.locator('#btn-info-agent').click();const list=page.locator('.agent-privacy-list');await list.waitFor();
    if(api==='ok'){
      await list.getByText('Shared text <strong>literal</strong>',{exact:true}).waitFor();
      assert.equal(await list.locator('strong').count(),0);assert.ok((await list.textContent()).includes('Site guidance'));assert.ok(!(await list.textContent()).includes('hidden'));
      assert.equal(modelCalls.length,1);await page.locator('.agent-panel-close').click();await page.locator('#btn-info-agent').click();await page.waitForTimeout(50);assert.equal(modelCalls.length,1);
    }else{
      await page.waitForTimeout(100);const text=await list.textContent();assert.match(text,/Could not load|取得できません/);assert.doesNotMatch(text,/OpenAI|DeepSeek|Google|Gemini|Future Co/);
      if(api==='failure'){await page.locator('.agent-panel-close').click();modelMode='ok';await page.locator('#btn-info-agent').click();await list.getByText('Shared text <strong>literal</strong>',{exact:true}).waitFor();assert.equal(modelCalls.length,2);}
    }
    await page.locator('.agent-panel-close').click();
    await page.locator('.magi-node[data-codename="Shinya Takeda"]').click();const desc=page.locator('.magi-desc');await desc.waitFor();await page.waitForTimeout(100);
    if(api!=='legacy'){assert.match(await desc.textContent(),/Future Co <literal>/);assert.match(await desc.textContent(),/Dark Co/);assert.equal(await desc.locator('literal').count(),0);}
    if(native){await page.locator('#app-update').waitFor({state:'visible'});assert.equal(releases.length,1);assert.match(await page.locator('#app-update').innerText(),/4\.7/);assert.equal(await page.locator('#app-update a').getAttribute('href'),'https://tk.st/magi-app/android/');assert.equal(await page.locator('#app-update a').getAttribute('target'),'_blank');
      await page.screenshot({path:resolve(out,name+'.png')});await page.locator('#app-update button').click();await page.reload();await page.locator('.magi-ver').waitFor();await page.waitForTimeout(100);assert.equal(releases.length,blocked?2:1);
      if(!blocked){assert.equal(await page.locator('#app-update').isVisible(),false);await page.evaluate(()=>localStorage.setItem('magi_update_checked','1'));release='v4.8';await page.reload();await page.locator('#app-update').waitFor({state:'visible'});assert.match(await page.locator('#app-update').innerText(),/4\.8/);}
    }else assert.equal(releases.length,0);
    assert.deepEqual(errors,[]);results.push({name,pass:true,modelCalls:modelCalls.length,releaseCalls:releases.length});console.log(name+' OK');
  }finally{await ctx.close();}
}
try{
  for(const [path,label]of[['/','top'],['/magi-app/www/','PWA']])for(const api of ['ok','failure','legacy'])await scenario(label+'-'+api,path,{api});
  await scenario('PWA-dark','/magi-app/www/',{scheme:'dark'});
  await scenario('native-ja','/magi-app/www/',{native:true,language:'ja-JP'});
  await scenario('native-en','/magi-app/www/',{native:true});
  await scenario('native-storage-blocked','/magi-app/www/',{native:true,blocked:true});
}finally{writeFileSync(resolve(out,'preview.json'),JSON.stringify(results,null,2)+'\n');await browser.close();await new Promise(r=>server.close(r));}
