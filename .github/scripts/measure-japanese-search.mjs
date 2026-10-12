// 取得・準備と入力→6候補のDOM更新を別々に測る。新UI・実機IMEの測定ではない。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node measure-japanese-search.mjs fixture-directory');
const browser = await chromium.launch({headless:true});
const report = {browser:browser.version(),cpuThrottle:4,viewport:{width:1280,height:800},cases:[]};
try {
  const page = await browser.newPage({viewport:report.viewport});
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate',{rate:4});
  await page.setContent('<main><ul id="results"></ul><p id="count"></p></main>');
  await page.addScriptTag({path:resolve('assets/japanese-search.js')});
  for (const name of ['1000-shared','1000-distinct','10000-shared','10000-distinct']) {
    const data = JSON.parse(readFileSync(resolve(directory,name+'.json'),'utf8'));
    const result = await page.evaluate(data => {
      const start = performance.now();
      const api = STJapaneseSearch.prepare(data.records,[{name:'title',mask:1},{name:'tags',mask:2},{name:'summary',mask:4},
        {name:'takeaway',mask:4},{name:'source',mask:8},{name:'category',mask:2}],{legacyFields:['title','summary','takeaway','source','category','tags'],legacyRemoveWhitespace:true})
        .attachReadings(data.readings,data.source_sha256);
      const prepareMs = performance.now()-start;
      const queries = ['n','ｋ','にｔ','かでｎ','ニトリ','家電','収納','shuunou','が','か\u3099','new','nitori 収納','セルフレジ','ぴぴ','架空xyz無該当','家電 価格','コーヒー','ni','ka','にと'];
      const run = () => {
        const times = [];
        for (let i=0;i<100;i++) {
          const began = performance.now();
          const found = api.search(queries[i%queries.length]);
          const fragment = document.createDocumentFragment();
          found.rows.slice(0,6).forEach(row => { const li=document.createElement('li'); li.textContent=row.record.title; fragment.appendChild(li); });
          document.getElementById('results').replaceChildren(fragment);
          document.getElementById('count').textContent=String(found.total);
          // レイアウトまでを計測し、paint時間は含めたと表明しない。
          void document.getElementById('results').offsetHeight;
          times.push(performance.now()-began);
        }
        times.sort((a,b)=>a-b);
        return {p50:times[49],p95:times[94],max:times[99]};
      };
      run();
      return {prepareMs,runs:[run(),run(),run()]};
    }, data);
    const readingBytes=Buffer.from(JSON.stringify(data.readings)+'\n');
    report.cases.push({name,...result,readingBrotliBytes:brotliCompressSync(readingBytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length});
    console.log(JSON.stringify(report.cases.at(-1)));
  }
} finally {await browser.close();}
writeFileSync(resolve(directory,'browser-measurements.json'),JSON.stringify(report,null,2)+'\n');
