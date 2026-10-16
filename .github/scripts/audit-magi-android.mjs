// 実機の保存記録だけを照合する。端末・APIには触れず、会話タイトルはhashだけを記録する。
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir=new URL('../../workers/.wrangler/magi2-android-20261017/',import.meta.url);
const read=p=>readFileSync(new URL(p,dir),'utf8'),json=p=>JSON.parse(read(p));
const sha=s=>createHash('sha256').update(s).digest('hex');
const nodes=p=>[...read(p+'.xml').matchAll(/<node ([^>]+)>?/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]])));
const history=p=>{
 let list=nodes(p);const close=list.findIndex(n=>n.text==='✕ CLOSE'&&n.clickable==='true');assert(close>=0);list=list.slice(close+1);
 return list.filter(n=>n.text==='Delete chat'&&n.clickable==='true').map(d=>{
  const y=+d.bounds.match(/\d+/g)[1];
  return sha(JSON.stringify(list.filter(n=>n.text&&n.text!=='Delete chat'&&Math.abs(+n.bounds.match(/\d+/g)[1]-y)<30).map(n=>n.text)));
 });
};
const before=history('history-before51');assert.equal(before.length,5);
assert.deepEqual(history('history-after51'),before);assert.deepEqual(history('history-final51'),before);
assert(read('initial46.xml').includes('新しいバージョン（5.1）があります'));
for(const p of ['update-dismissed46','update-dismissed46-restart','launch51'])assert(!read(p+'.xml').includes('新しいバージョン'));
const actual=readFileSync(new URL('downloaded-on-device51.apk',dir));
assert.equal(sha(actual),'951b18ffb0f4173c78bdeb36437dfd324e4d7dc461e2785096ad6905a9f4c9d0');
const pixels=json('theme-pixels.json');
for(const k of ['theme-auto-light51','theme-manual-light51'])assert(pixels[k].every(c=>c>=230));
for(const k of ['theme-auto-dark51','theme-restart-dark51'])assert(pixels[k].every(c=>c<=20));
const flags=['factual questions and site guidance are answered directly','When clarification is needed','After that short reply, this conversation ends.'];
for(const flag of flags){assert(!read('privacy46.xml').includes(flag));assert(read('privacy51.xml').includes(flag));}
const versions=nodes('versions51');assert.equal(versions.filter(n=>/^ver \d+\.\d+$/.test(n.text)).length,26);
const bottom=nodes('versions-bottom51').find(n=>n.text==='Earlier releases');assert(bottom);
const box=bottom.bounds.match(/\d+/g).map(Number);assert(box[3]>box[1]);
const offline=json('offline-check.json');assert(offline.complete&&offline.restored&&offline.no_default_network);
assert(read('offline-privacy51.xml').includes('Could not load the latest description of the recipients.'));
assert(read('offline-send51.xml').includes('network_error'));
assert(nodes('offline-send51').some(n=>n['content-desc']==='Send'&&n.enabled==='true'));
assert(nodes('image-preview51').some(n=>n['content-desc']==='Remove attachment'));
assert(!nodes('image-removed51').some(n=>n['content-desc']==='Remove attachment'));
assert(!read('final51.xml').includes('MAGI QA offline'));
const meta=json('device-meta.json');assert.equal(meta.app_version,'5.1');assert.equal(meta.version_code,51);
assert.equal(meta.airplane,'0');assert(meta.wifi_enabled&&meta.default_network!=='none');
const report={date:new Date().toISOString(),device:meta,paid_ai_calls:0,history_before:5,history_after:5,title_hashes_match:true,
 checks:{release_download_hash:true,notification_shown_in46:true,dismissed_version_stays_hidden:true,upgrade51:true,
  themes_auto_and_manual_and_restart:true,privacy_capability_gating:true,release_history27_entries_and_scroll_to_end:true,
  offline_privacy_fallback:true,offline_send_error_and_controls_recovered:true,synthetic_attachment_preview_and_remove:true,network_settings_restored:true},
 limitations:['通常相談・MAGI・画像を本番AIで完了する確認は未実施。添付画像は送信していない。',
  '24時間の経過・iPhone・Androidの単色アイコンは未確認。',
  'オフラインの更新履歴は既存HTTPキャッシュが表示された。履歴取得失敗の文言を実機で再現したとは扱わない。'],
 evidence_files:['initial46.xml','privacy46.xml','history-before51.xml','history-after51.xml','history-final51.xml',
  'theme-pixels.json','privacy51.xml','versions51.xml','versions-bottom51.xml','offline-check.json','offline-privacy51.xml','offline-send51.xml',
  'image-preview51.xml','image-removed51.xml','final51.xml'].map(path=>({path,sha256:sha(read(path))}))};
writeFileSync(new URL('audit.json',dir),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,evidence_files:report.evidence_files.length}));
