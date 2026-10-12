// CDPのプロセス一覧に対応するWindowsのprivate commitと、主フレームのJS heapを測る。
// WorkerのheapはRuntime.getHeapUsageに含まれず、プロセス集計にのみ含まれる。
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
export async function browserMemoryProbe(browser,pageSession) {
  const browserSession=await browser.newBrowserCDPSession();
  const child=process.platform==='win32'?spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('.github/scripts/search-browser-memory.ps1')],
    {windowsHide:true,stdio:['pipe','pipe','pipe']}):null;
  const pending=[];let queue=Promise.resolve();
  const fail=()=>{for(const item of pending.splice(0)) {clearTimeout(item.timer);item.reject(new Error('memory_probe'));}};
  if(child) {
    child.on('error',fail);child.on('exit',fail);
    createInterface({input:child.stdout}).on('line',line=>{
      const item=pending.shift();if(!item)return;clearTimeout(item.timer);
      try {const value=JSON.parse(line);if(value.error)throw new Error(value.error);item.resolve(value.rows);}
      catch(error){item.reject(error);}
    });
  }
  function processRows(info) {
    if(!child) return Promise.resolve(null);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();fail();},5000);pending.push({resolve,reject,timer});
      child.stdin.write(JSON.stringify(info.map(p=>({id:p.id,type:p.type})))+'\n');
    });
  }
  return {
    capture(phase) {
      const next=queue.then(async()=>{
        const heap=await pageSession.send('Runtime.getHeapUsage');
        const {processInfo}=await browserSession.send('SystemInfo.getProcessInfo');
        const rows=await processRows(processInfo);
        const totals=rows?rows.reduce((totals,row)=>{
          const total=totals[row.type] ||= {processes:0,privateBytes:0,workingSetBytes:0};
          total.processes++;total.privateBytes+=row.privateBytes;total.workingSetBytes+=row.workingSetBytes;return totals;
        },{}):null;
        return {phase,at:new Date().toISOString(),heap,processes:totals};
      });queue=next.catch(()=>{});return next;
    },
    async close(){await queue;child?.stdin.end();child?.kill();await browserSession.detach();}
  };
}
