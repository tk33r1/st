// 共通UIの入力イベント→6候補DOM/layoutと、準備中の主スレッドの応答を測る。
// paintや実機IMEを含んだ値とはしない。結果を失敗込みで保存する。
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {browserMemoryProbe} from './search-browser-memory.mjs';
const input=process.argv[2],output=resolve(process.argv[3] || input || '.');
const adapterMode=process.argv.includes('--adapter');
const profileMode=process.argv.includes('--profile');
const memoryMode=process.argv.includes('--memory');
const selectedCase=process.argv.find(arg=>arg.startsWith('--case='))?.split('=')[1];
const cases=['1000-shared','1000-distinct','10000-shared','10000-distinct'];
if(selectedCase && !cases.includes(selectedCase)) throw new Error('Unknown case');
const maxRecords=Number(process.argv.find(arg=>arg.startsWith('--records='))?.split('=')[1] || 10000);
if(!Number.isSafeInteger(maxRecords) || maxRecords<1 || maxRecords>10000) throw new Error('records must be 1..10000');
if(!adapterMode && maxRecords!==10000)throw new Error('records option applies only to the actual adapter');
if(!input) throw new Error('Usage: measure-search-ui.mjs fixture-directory [report-directory]');
mkdirSync(output,{recursive:true});
const files=['assets/japanese-search.js','assets/site-search.js','assets/search-ui.js','assets/search-data.js','assets/search-ui.css','assets/search-json-worker.js'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={started:new Date().toISOString(),adapterMode,maxRecords,profileMode,memoryMode,cpuThrottle:4,viewport:{width:1280,height:800},
  formalMeasurement:!profileMode && !memoryMode,script_sha256:sha(readFileSync(new URL(import.meta.url))),
  includes:'共通UI input→6候補のDOM/layout。paint・実機IMEは含まない',files:Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))])),cases:[]};
const browser=await chromium.launch({headless:true});report.browser=browser.version();
const activeProbes=new Set();
try {
  for(const name of selectedCase?[selectedCase]:cases) {
    const raw=readFileSync(resolve(input,name+'.json')),page=await browser.newPage({viewport:report.viewport});
    const fixture=JSON.parse(raw),payload=structuredClone(fixture.readings);
    // adapterの8MiB契約を保つ追加測定。各レコードの本文・検索フィールドは削らない。
    fixture.records=fixture.records.slice(0,maxRecords);
    payload.record_ids=payload.record_ids.slice(0,maxRecords);
    payload.terms=payload.terms.map(term=>({...term,postings:term.postings.filter(p=>p[0]<maxRecords)})).filter(term=>term.postings.length);
    const base=JSON.stringify({media:'nitoridaily',generation:'abcd',years:['2026'],records:fixture.records.map((r,i)=>{
      const {id,...record}=r;return {...record,date:'20261011',url:'20261011/#art-'+(i+1)};
    })});
    payload.source_sha256=sha(base);payload.record_ids=fixture.records.map((_,i)=>'nitoridaily:20261011:'+(i+1));
    payload.generation=sha(JSON.stringify({source_sha256:payload.source_sha256,analyzer:payload.analyzer,normalization_revision:1})+'\n');
    const readings=JSON.stringify(payload),manifest=JSON.stringify({version:1,media:'nitoridaily',source_generation:'abcd',
      normalization_revision:1,generation:'b'.repeat(64),files:[{year:'2026',source:'search-index.json',readings:'search-readings-2026.json',
        source_sha256:sha(base),readings_sha256:sha(readings),records:fixture.records.length}]});
    const session=await page.context().newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:4});
    const sources={'/fixture.json':raw,'/job/nitoridaily/search-index.json':base,'/job/nitoridaily/search-readings.json':manifest,
      '/job/nitoridaily/search-readings-2026.json':readings,'/assets/search-json-worker.js':readFileSync(files[5])};
    await page.route('https://search.fixture/**',route=>{
      const path=new URL(route.request().url()).pathname,body=sources[path];
      return route.fulfill(body===undefined?{contentType:'text/html',body:'<!doctype html><html lang="ja"><body><main><div id="search"></div></main></body></html>'}:
        {contentType:path.endsWith('.js')?'application/javascript':'application/json',body});
    });
    await page.goto('https://search.fixture/');
    await page.addStyleTag({path:resolve(files[4])});for(const file of files.slice(0,4)) await page.addScriptTag({path:resolve(file)});
    const memory=[];let memoryProbe,memoryTimer,memoryStopped=false,memoryPending=Promise.resolve();
    if(memoryMode) {
      memoryProbe=await browserMemoryProbe(browser,session);
      activeProbes.add(memoryProbe);
      const capture=async phase=>{memory.push(await memoryProbe.capture(phase));};
      await capture('before_mount');await page.exposeFunction('phase4MemoryMark',async phase=>{
        await capture(phase);
        if(phase==='ready'){await session.send('HeapProfiler.collectGarbage');await capture('ready_after_gc');}
      });
      const tick=()=>{memoryPending=capture('during').then(()=>{if(!memoryStopped)memoryTimer=setTimeout(tick,200);},error=>{memoryStopped=true;memory.push({error:error.message});});};tick();
    }
    if(profileMode) {
      await page.evaluate(()=>{
        window.phase4Spans=[];
        const mark=(name,start)=>{const ms=performance.now()-start;if(ms>10)phase4Spans.push({name,start,ms});};
        const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args)=>{const start=performance.now(),value=digest(...args);mark('digest copy',start);return value;};
        const NativeWorker=Worker;window.Worker=class extends NativeWorker {
          constructor(...args){const start=performance.now();super(...args);mark('Worker init',start);this.addEventListener('error',e=>phase4Spans.push({name:'Worker error',message:e.message,start:performance.now()}));}
          postMessage(...args){const start=performance.now();super.postMessage(...args);mark('Worker post',start);}
        };
        const parse=JSON.parse;JSON.parse=(...args)=>{const start=performance.now(),value=parse(...args);mark('native JSON parse',start);return value;};
        const prepare=STJapaneseSearch.prepareTask;STJapaneseSearch.prepareTask=(...args)=>{
          const task=prepare(...args);return {return:()=>task.return(),next(){const start=performance.now(),step=task.next();mark('base step',start);
            if(step.done){const e=step.value,search=e.search,attach=e.attachReadingSetsTask;
              e.search=(...args)=>{const start=performance.now(),value=search(...args);mark('search '+args[0],start);return value;};
              e.attachReadingSetsTask=(...args)=>{const task=attach(...args);return {return:()=>task.return(),next(){const start=performance.now(),step=task.next();mark('reading step',start);return step;}};};
            }return step;}};
        };
      });
      await session.send('Profiler.enable');await session.send('Profiler.start');
    }
    const measured=await page.evaluate(async adapterMode=>{
      const longTasks=[],observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({start:e.startTime,ms:e.duration}))));
      observer.observe({type:'longtask'});
      const ticks=[];let last=performance.now();const timer=setInterval(()=>{const now=performance.now();ticks.push(now-last);last=now;},20);
      const start=performance.now();
      let data;
      let lastCondition='';
      const fake={scope:'nitori',fields:[{name:'title',mask:1},{name:'tags',mask:2},{name:'summary',mask:4},
        {name:'takeaway',mask:4},{name:'source',mask:8},{name:'category',mask:2}],legacy:{legacyFields:['title','summary','takeaway','source','category','tags'],legacyRemoveWhitespace:true},
        compare:(a,b)=>(a.date===b.date?0:a.date<b.date?1:-1)||a.article-b.article,href:r=>r.href,
        onConditions:c=>{lastCondition=c.query;},loadBase:async()=>{
          data=await (await fetch('/fixture.json')).json();
          const records=data.records.map((r,i)=>({...r,article:i+1,description:r.summary,href:'/job/nitoridaily/20261011/#art-'+(i+1)}));
          return {records,sourceHash:data.source_sha256,generation:'abcd'};
        },loadReadings:async()=>data.readings};
      const adapter=adapterMode?STSearchData.createAdapter('nitori',{onConditions:c=>{lastCondition=c.query;}}):fake;
      const ui=STSearchUI.mount(document.getElementById('search'),adapter);
      const field=document.querySelector('.st-search-input');field.focus();
      // 準備の途中でも入力イベントを処理し、最後の条件で描く。
      const early=setInterval(()=>{field.value=field.value==='収納'?'家電':'収納';field.dispatchEvent(new Event('input',{bubbles:true}));},60);
      await ui.ready;clearInterval(early);clearInterval(timer);const prepareMs=performance.now()-start;
      if(window.phase4MemoryMark)await phase4MemoryMark('ready');
      const preparedInput=field.value,conditionPreserved=lastCondition==='' && field.value===preparedInput;
      await new Promise(resolve=>requestAnimationFrame(resolve));observer.disconnect();
      const queries=['n','ｋ','にｔ','かでｎ','ニトリ','家電','収納','shuunou','が','か\u3099','new','nitori 収納','セルフレジ','ぴぴ','架空xyz無該当','家電 価格','コーヒー','ni','ka','にと'];
      const run=async()=>{
        const times=[],details=[];
        for(let i=0;i<100;i++) {
          const query=queries[i%queries.length],began=performance.now();field.value=query;field.dispatchEvent(new Event('input',{bubbles:true}));
          void document.querySelector('.st-search-suggestions').offsetHeight;
          const elapsed=performance.now()-began;times.push(elapsed);
          details.push({query,ms:elapsed,candidates:document.querySelectorAll('.st-search-suggestions a').length,total:ui.state.total});
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        const first=times.slice(0,20).sort((a,b)=>a-b);times.sort((a,b)=>a-b);
        // 契約は固定20入力×5のp95。最初の20入力も診断として別記し、隠さない。
        return {first20p95:first[18],first20Pass:first[18]<=50,p50:times[49],p95:times[94],max:times[99],pass:times[94]<=50,samples:details};
      };
      const runs=[await run(),await run(),await run()];const state=ui.state;
      if(window.phase4MemoryMark)await phase4MemoryMark('before_destroy');ui.destroy();
      return {prepareMs,conditionPreserved,state,scheduling:typeof scheduler?.postTask==='function'?'background':'timer',
        heartbeat:{samples:ticks.length,maxGapMs:Math.max(0,...ticks)},prepareLongTasks:longTasks,runs};
    },adapterMode);
    if(memoryMode) {
      memoryStopped=true;clearTimeout(memoryTimer);await memoryPending;
      memory.push(await memoryProbe.capture('after_destroy'));
      await session.send('HeapProfiler.collectGarbage');memory.push(await memoryProbe.capture('after_gc'));
      await memoryProbe.close();activeProbes.delete(memoryProbe);measured.memory=memory;
    }
    if(profileMode) {const {profile}=await session.send('Profiler.stop');writeFileSync(resolve(output,name+'.cpuprofile'),JSON.stringify(profile));measured.spans=await page.evaluate(()=>phase4Spans);}
    report.cases.push({name,records:fixture.records.length,fixtureHash:sha(raw),...(adapterMode?{baseHash:sha(base),readingHash:sha(readings),baseBytes:Buffer.byteLength(base),readingBytes:Buffer.byteLength(readings)}:{}),...measured});
    console.log(JSON.stringify({name,prepareMs:measured.prepareMs,heartbeat:measured.heartbeat,longTasks:measured.prepareLongTasks,
      conditionPreserved:measured.conditionPreserved,runs:measured.runs.map(({samples,...stats})=>stats)}));
    writeFileSync(resolve(output,'ui-measurements.json'),JSON.stringify(report,null,2)+'\n');await page.close();
  }
} finally {for(const probe of activeProbes)await probe.close();await browser.close();}
report.pass=report.cases.every(c=>c.runs.every(r=>r.pass) && c.conditionPreserved && c.state.readings==='ready' && !c.memory?.some(sample=>sample.error));
writeFileSync(resolve(output,'ui-measurements.json'),JSON.stringify(report,null,2)+'\n');
if(!report.pass) process.exitCode=1;
