// 保存した実機の単色アイコン確認と端末設定の復元を検算する。端末・APIには接続しない。
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir=new URL('../../workers/.wrangler/magi2-android-20261017/',import.meta.url);
const files=[],sha=s=>createHash('sha256').update(s).digest('hex');
const read=p=>{const data=readFileSync(new URL(p,dir));files.push({path:p,sha256:sha(data)});return data.toString('utf8');};
const nodes=p=>[...read(p+'.xml').matchAll(/<node ([^>]+)>?/g)].map(m=>Object.fromEntries(
 [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]])));
const switches=p=>nodes(p).filter(n=>n.class==='android.widget.Switch').map(n=>n.checked);
assert.deepEqual(switches('color-palette'),['false','false']);
assert.deepEqual(switches('color-icons-enabled'),['true','true']);
assert.deepEqual(switches('palette-restored-values'),['false','false']);
const opened=nodes('monochrome-opened-native');
assert(opened.some(n=>n.package==='st.tk.magi'));
assert(opened.some(n=>n.text==='ver 5.1 ▾'));
assert.equal(read('color-app-icon-final.txt').trim(),'0');
assert(read('default-home-final.txt').includes('ginlemon.flowerfree/ginlemon.flower.HomeScreen'));
const final=nodes('additional-final51');assert(final.some(n=>n.text==='ver 5.1 ▾'));
assert(!final.some(n=>n['content-desc']==='Remove attachment'));
assert(!final.some(n=>n.text?.includes('MAGI QA offline')));
const image=readFileSync(new URL('magi-oneui-icons.png',dir));files.push({path:'magi-oneui-icons.png',sha256:sha(image)});
const report={date:new Date().toISOString(),paid_ai_calls_from_android:0,
 checks:{original_palette_and_icons_off:true,temporary_themed_icons_on:true,native51_opened_from_icon:true,
  palette_and_icons_restored_off:true,default_smart_launcher_preserved:true,final_native51_without_attachment_or_test_draft:true},
 visual_review:{by:'agent',scope:'One UIの検索結果を画像で確認。左の正式アプリはパレット色の背景と単色の2/3/1と枠線。右のブラウザショートカットとは区別。正式アプリを起動して5.1を確認した。'},
 limitation:'Smart Launcher全体のアイコン描画や、すべてのランチャーでの表示を保証した確認ではない。',evidence_files:files};
writeFileSync(new URL('monochrome-audit.json',dir),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,evidence_files:files.length}));
