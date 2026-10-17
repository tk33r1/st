// 採用された追加$2案の入力・期待・本番の会社別上限を固定する。通信・キーの読み取りなし。
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir=new URL('../../workers/.wrangler/magi2-compact-20261017/',import.meta.url);mkdirSync(dir,{recursive:true});
const file=new URL('plan.json',dir),registry=JSON.parse(readFileSync(new URL('../../config/ai-models.json',import.meta.url)));
const models=Object.fromEntries(Object.entries(registry).map(([p,v])=>[p,Object.values(v)[0].id]));
if(existsSync(file)){const plan=JSON.parse(readFileSync(file));assert.deepEqual(plan.models,models);console.log(JSON.stringify({mode:'existing-plan',id:plan.id,cases:plan.cases.length,paid_calls:0}));process.exit(0);}
const id='compact-20261017-'+randomBytes(6).toString('hex'),mark=kind=>'MAGI-QA-'+id+'-'+kind;
const native=[
 {id:'normal',text:'I want to spend 30 minutes reading at home this weekend. I am not choosing between alternatives. Suggest one small first step using a book I already own. No web research is needed. '+mark('normal'),images:0,
  expected:'通常の相談として最終回答まで完了。不要な確認質問やWeb検索なし。既に持つ本で30分の最初の一歩を提案。',caps_micro:{openai:140000,anthropic:150000,deepseek:130000,typesafe:4000}},
 {id:'vote',text:'Should I spend 30 minutes reading my own book at home this weekend instead of watching a video I already have? I prefer a quiet screen-free break and have no other commitments. '+mark('vote'),images:0,
  expected:'MAGIの議題・票・決議が表示され、統合の説明が決議と矛盾せず完了。確認質問なし。',caps_micro:{openai:140000,anthropic:150000,deepseek:130000,typesafe:4000}},
 {id:'image',text:'Look at the attached synthetic picture. For a quiet craft session at home, suggest one way to combine these two shapes. Do not research products or services. '+mark('image'),images:1,
  expected:'合成画像の赤い円と青い四角を取り違えず、2つの図形を組み合わせる案を最後まで答える。画像の外の物を断定しない。',caps_micro:{openai:200000,anthropic:210000,deepseek:240000,typesafe:4000}},
].map(c=>({...c,kind:'chat',history_messages:0}));
const themes=[{id:'pdf',locale:'ja',expected:'/tools/pdf-studio/',questions:['PDFを結合したい。サイトのツールを案内してください。','それの使い方を教えてください。','画像にすることもできますか。']},
 {id:'qr',locale:'en',expected:'/tools/qr-palette/',questions:['Show me the tool on this site for creating a QR code.','How do I use that tool?','Can I change its colors and then save it?']}];
const site=themes.flatMap(t=>t.questions.map((q,i)=>({id:t.id+'-'+(i+1),kind:'site',theme:t.id,locale:t.locale,text:q+' '+mark(t.id+'-'+(i+1)),
 history_messages:i*2,images:0,expected:t.expected,caps_micro:{openai:30000,anthropic:22000,deepseek:0,typesafe:3000}})));
const plan={version:1,id,day:new Date().toISOString().slice(0,10),expires_at:new Date(Date.now()+6*3600000).toISOString(),
 approved:'2026-10-17 本人「おススメ案で実施」。追加$2、累計総額$2.80。通常/MAGI/合成画像各1、PDF/QR各3往復、保存討議2件の比較。',
 models,cases:[...native,...site]};
const byProvider={};for(const c of plan.cases)for(const [p,v]of Object.entries(c.caps_micro))byProvider[p]=(byProvider[p]||0)+v/1e6;
const total=Object.values(byProvider).reduce((a,b)=>a+b,0);assert(total<2); // A3判定比較の枠を残す。
writeFileSync(file,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
copyFileSync(new URL('../../workers/.wrangler/magi2-apk52-20261017/magi-qa52-synthetic.png',import.meta.url),new URL('magi-qa-compact.png',dir));
writeFileSync(new URL('review.md',dir),'# 代表経路の有料確認\n\n'+plan.approved+'\n\n合成入力と公開人格カード・ページ情報だけを使用。画像は320×240の赤い円・青い四角。OpenAI/Anthropic/DeepSeek/TypeSafeへ役割ごとに送る。検索はガードで拒否し、予期しない経路は失敗として残す。\n\n'+plan.cases.map(c=>'## '+c.id+'\n\n'+c.text+'\n\n期待：'+c.expected+'\n').join('\n')+'\n本番9要求の事前予約：'+JSON.stringify(byProvider)+'、計$'+total.toFixed(6)+'。判定比較は別途最大$0.10。\n');
console.log(JSON.stringify({mode:'plan',id,cases:plan.cases.length,maximum_usd:byProvider,total_usd:total,plan_hash:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),paid_calls:0}));
