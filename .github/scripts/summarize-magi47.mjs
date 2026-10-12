// 固定入力の比較集計と、本人が新旧を伏せて読むローカル画面を作る。本文をGitへ保存しない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const dir=resolve('workers/.wrangler/magi47-quality');
const read=name=>JSON.parse(readFileSync(resolve(dir,name+'.json'),'utf8'));
const baseline=read('baseline'),candidate=read('candidate'),materials=read('materials');
assert.equal(baseline.cards_hash,candidate.cards_hash,'Same fixed cards');
const quantile=(values,p)=>{const s=values.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.ceil(s.length*p)-1]:null;};
const stats=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;return{count:n,median:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null,p90:quantile(values,.9),max:quantile(values,1)};};
const chars=text=>Array.from(text||'').length;
const persona=(r,id='BALTHASAR-2')=>r.calls.filter(c=>c.persona===id);
const analysis=report=>{
 const consultations=report.results.filter(r=>r.kind==='consult'&&r.theme==='dark'),dark=report.results.filter(r=>r.theme==='dark');
 const balthasar=report.results.flatMap(r=>persona(r)),firstTwo=report.results.filter(r=>r.kind==='magi').flatMap(r=>persona(r).slice(0,2));
 return {cases:report.results.length,complete:report.completed,failures:report.results.filter(r=>!r.completed).map(r=>r.id+'-'+r.theme),
  balthasar:{calls:balthasar.length,missing:balthasar.filter(c=>!c.raw?.trim()).length,refusals:balthasar.filter(c=>c.finish==='refusal'||c.finish==='content_filter').length,chars:stats(balthasar.map(c=>chars(c.raw))),ms:stats(balthasar.map(c=>c.elapsed_ms))},
  votes:Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(id=>{const samples=report.results.filter(r=>r.kind==='magi').flatMap(r=>persona(r,id).slice(0,2));return [id,{samples:samples.length,valid:samples.filter(c=>['approve','reject'].includes(c.vote)).length}];})),
  integration:{first_text_ms:stats(dark.flatMap(r=>r.calls.filter(c=>c.stream).map(c=>c.first_text_ms))),consultation_first_text_ms:stats(consultations.map(r=>r.events.find(e=>e.event==='integrated')?.ms)),chars:stats(dark.map(r=>chars(r.answer))),fallbacks:dark.filter(r=>r.calls.filter(c=>c.stream).length>1).map(r=>r.id),persona_name_flags:dark.filter(r=>/MELCHIOR|BALTHASAR|CASPER|Enthusiast|Humanist|Strategist/.test(r.answer)).map(r=>r.id)},
  missing_titles:report.results.filter(r=>!r.events.some(e=>e.event==='title')).map(r=>r.id+'-'+r.theme),missing_suggestions:report.results.filter(r=>!r.events.some(e=>e.event==='suggest')).map(r=>r.id+'-'+r.theme),
  manual_quality:'not reviewed',first_two_balthasar:stats(firstTwo.map(c=>chars(c.raw)))};
};
const summary={date:new Date().toISOString(),baseline:analysis(baseline),candidate:analysis(candidate),cards:materials.cards.map(c=>({codename:c.codename,variants:c.variants.map(v=>({side:v.side,chars:v.chars,elapsed_ms:v.elapsed_ms}))})),X:{status:materials.x_status,images:materials.images.length,contexts:materials.contexts.length}};
summary.integration_median_delta_ms=summary.candidate.integration.consultation_first_text_ms.median-summary.baseline.integration.consultation_first_text_ms.median;
writeFileSync(resolve(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
const reviews=[];
const pair=(id,group,input,oldText,newText,source='')=>{const swapped=Boolean(createHash('sha256').update(id).digest()[0]%2);reviews.push({id,group,input,source,a:swapped?newText:oldText,b:swapped?oldText:newText,candidate:swapped?'a':'b'});};
for(const c of candidate.results.filter(r=>r.kind==='consult'&&r.theme==='dark')){
 const old=baseline.results.find(r=>r.id===c.id&&r.theme==='dark');if(!old)continue;
 pair('humanist-'+c.id,'人間主義者',c.input,persona(old)[0]?.raw,persona(c)[0]?.raw);
 pair('integration-'+c.id,'統合の回答',c.input,old.answer,c.answer);
 for(const name of ['title','suggest'])pair(name+'-'+c.id,name==='title'?'会話のタイトル':'次の質問の予測',c.input,old.events.find(e=>e.event===name)?.data.text,c.events.find(e=>e.event===name)?.data.text);
}
for(const c of candidate.effort||[])pair('effort-'+c.id,'lowとmedium',candidate.results.find(r=>r.id===c.id)?.input,c.low,c.medium);
for(const c of materials.cards)pair('card-'+c.codename,'人格カード',c.codename,c.variants.find(v=>v.side==='baseline')?.text,c.variants.find(v=>v.side==='candidate-1')?.text,c.source);
for(const c of materials.images)pair('image-'+c.id,'X画像の説明',c.input,c.baseline.join('\n'),c.candidate.join('\n'));
for(const c of materials.contexts)pair('context-'+c.id,'返信・引用の要約',c.input,c.baseline,c.candidate,c.parent);
const data=JSON.stringify({reviews,summary,images:materials.images,cardRepeats:materials.cards.map(c=>({codename:c.codename,variants:c.variants.filter(v=>v.side.startsWith('candidate'))}))}).replace(/</g,'\\u003c');
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MAGI 4.7 回答比較</title>
<style>body{font:16px/1.7 system-ui,sans-serif;color:#17242c;background:#f4f6f7;margin:0}main{max-width:1100px;margin:auto;padding:24px}header{padding:12px 0 24px}h1{font-size:26px}button,select{font:inherit;padding:10px;border:1px solid #aeb9c0;border-radius:6px;background:white}button{cursor:pointer}nav{display:flex;gap:12px;flex-wrap:wrap;position:sticky;top:0;background:#f4f6f7;padding:12px 0;z-index:1}.item{background:white;padding:22px;border-radius:10px;margin:18px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.answer{white-space:pre-wrap;padding:16px;background:#f4f6f7;border-radius:6px;overflow-wrap:anywhere}.ratings{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px}label{cursor:pointer}details{margin:16px 0}pre{white-space:pre-wrap}small{color:#53656f}img{max-width:100%;max-height:320px}.reveal{font-weight:bold;color:#1b5f62}@media(max-width:650px){.pair{grid-template-columns:1fr}main{padding:12px}}</style>
<main><header><h1>MAGI 4.7 回答比較</h1><p>新旧を伏せて並べた回答です。良いと思う方を選んでください。同じ程度なら「同等」、両方に問題があれば「両方に問題」を選べます。</p><p>人間主義者・統合・タイトル・予測は、12件から読む10件を選べます（最初の10件を選択済み）。カードとXは、素材にない事実・誤った説明・他人の文の書き写しがあれば「事実等に問題」を付けてください。</p><small>選択はこのブラウザだけに保存します。公開サイトや外部APIには送信しません。本人による確認はまだ完了していません。</small></header>
<nav><select id="group"></select><button id="export">評価結果を保存</button><button id="reveal">新旧を表示</button><span id="progress"></span></nav><div id="items"></div><details><summary>同じ素材で作ったカード2回分</summary><div id="repeats"></div></details></main>
<script>const data=${data};const state=JSON.parse(localStorage.getItem('magi47-review')||'{}');let revealed=false;const groups=[...new Set(data.reviews.map(r=>r.group))];
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};const store=()=>{localStorage.setItem('magi47-review',JSON.stringify(state));progress()};
const selected=r=>state[r.id]?.selected??(!/-(c11|c12)$/.test(r.id));function progress(){const rows=data.reviews.filter(selected);document.querySelector('#progress').textContent=rows.filter(r=>state[r.id]?.rating).length+' / '+rows.length+'件を評価';}
function render(){const container=document.querySelector('#items');container.replaceChildren();for(const r of data.reviews.filter(r=>r.group===document.querySelector('#group').value)){const box=el('section');box.className='item';const title=el('h2',r.input||r.id);box.append(title);
const take=el('label','この入力を評価する '),check=el('input');check.type='checkbox';check.checked=selected(r);check.onchange=()=>{state[r.id]={...state[r.id],selected:check.checked};store()};take.append(check);box.append(take);
const pair=el('div');pair.className='pair';for(const [side,text]of [['a',r.a],['b',r.b]]){const col=el('div');col.append(el('h3',side.toUpperCase()));const answer=el('div',text||'（生成されませんでした）');answer.className='answer';col.append(answer);if(revealed){const mark=el('p',side===r.candidate?(r.group==='lowとmedium'?'medium':'新構成'):(r.group==='lowとmedium'?'low':'旧構成'));mark.className='reveal';col.append(mark)}pair.append(col)}box.append(pair);
if(r.source){const details=el('details');details.append(el('summary','素材を確認'),el('pre',r.source));box.append(details)}if(r.group==='X画像の説明'){for(const u of data.images.find(x=>'image-'+x.id===r.id)?.urls||[]){const img=el('img');img.src=u;img.alt='比較対象の本人の公開X画像';box.append(img)}}
const ratings=el('div');ratings.className='ratings';for(const [value,label]of [['a','Aがよい'],['b','Bがよい'],['equal','同等'],['both-bad','両方に問題']]){const lab=el('label',label+' '),radio=el('input');radio.type='radio';radio.name=r.id;radio.value=value;radio.checked=state[r.id]?.rating===value;radio.onchange=()=>{state[r.id]={...state[r.id],rating:value};store()};lab.append(radio);ratings.append(lab)}box.append(ratings);const facts=el('label','事実等に問題がある '),bad=el('input');bad.type='checkbox';bad.checked=state[r.id]?.facts===true;bad.onchange=()=>{state[r.id]={...state[r.id],facts:bad.checked};store()};facts.append(bad);box.append(facts);container.append(box)}progress()}
for(const g of groups){const o=el('option',g);document.querySelector('#group').append(o)}document.querySelector('#group').onchange=render;document.querySelector('#reveal').onclick=()=>{revealed=!revealed;render()};document.querySelector('#export').onclick=()=>{const rows=data.reviews.filter(selected).map(r=>({id:r.id,group:r.group,candidate:r.candidate,...state[r.id]}));const a=el('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({date:new Date().toISOString(),results:rows},null,2)],{type:'application/json'}));a.download='magi47-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};for(const c of data.cardRepeats){const s=el('section');s.append(el('h2',c.codename));for(const v of c.variants)s.append(el('pre',v.text));document.querySelector('#repeats').append(s)}render();</script></html>`;
writeFileSync(resolve(dir,'review.html'),html);console.log(JSON.stringify(summary));
