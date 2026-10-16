// 実機の通信失敗を確認。AIへは送らず、送信前に機内モード・WiFi停止を必須にする。
// 必ずアプリを停止してから元の通信設定を戻す。既存の会話データを削除しない。
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const adb=arg('adb'),device=arg('device');assert(adb&&device);
const run=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
const qa=(...args)=>execFileSync(process.execPath,['.github/scripts/qa-magi-android.mjs','--adb='+adb,'--device='+device,...args],{stdio:'pipe',encoding:'utf8'});
const before={airplane:run('shell','settings','get','global','airplane_mode_on'),wifi:run('shell','settings','get','global','wifi_on')};
assert(['0','1'].includes(before.airplane)&&['0','1','2'].includes(before.wifi));
const path='workers/.wrangler/magi2-android-20261017/offline-check.json';
const report={before,network_calls_to_ai:0,complete:false,restored:false};
try{
 run('shell','am','force-stop','st.tk.magi');run('shell','cmd','connectivity','airplane-mode','enable');run('shell','svc','wifi','disable');
 assert.equal(run('shell','settings','get','global','airplane_mode_on'),'1');
 assert.equal(run('shell','settings','get','global','wifi_on'),'0');
 let connectivity='';
 // radio/WiFiの切断は非同期。切断完了を最大5秒待ち、経路が残れば送信せず中断する。
 for(let i=0;i<10;i++){
  connectivity=run('shell','dumpsys','connectivity');
  if(/Active default network:\s*(?:none|null)/i.test(connectivity))break;
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 report.network_state=connectivity.match(/Active default network:[^\r\n]*/i)?.[0]||'unrecognized';
 assert(/Active default network:\s*(?:none|null)/i.test(connectivity),'実機に通信経路が残っている');
 report.no_default_network=true;
 run('shell','am','start','-n','st.tk.magi/.MainActivity');
 qa('--tap=ver 5.1 ▾','--snapshot=offline-versions51');qa('--tap=✕ CLOSE');
 qa('--tap=System & Privacy','--snapshot=offline-privacy51');qa('--tap=✕ CLOSE');
 qa('--tap-class=android.widget.EditText');run('shell','input','text','MAGI%sQA%soffline%s20261017');
 qa('--tap=Send','--snapshot=offline-send51');report.complete=true;
}finally{
 // 復旧後に失敗中のfetchが送られることを避け、端末設定を元に戻してから起動する。
 run('shell','am','force-stop','st.tk.magi');
 run('shell','cmd','connectivity','airplane-mode',before.airplane==='1'?'enable':'disable');
 run('shell','svc','wifi',before.wifi==='0'?'disable':'enable');
 report.after={airplane:run('shell','settings','get','global','airplane_mode_on'),wifi:run('shell','settings','get','global','wifi_on')};
 report.restored=report.after.airplane===before.airplane&&(before.wifi==='0'?report.after.wifi==='0':['1','2'].includes(report.after.wifi));
 writeFileSync(path,JSON.stringify(report,null,2)+'\n');
 run('shell','am','start','-n','st.tk.magi/.MainActivity');
 console.log(JSON.stringify(report));
}
