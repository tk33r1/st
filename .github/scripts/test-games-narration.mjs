// TIFFINの短文制限。実APIを使わず、長文を切り詰めて保存しないことを確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../game/masala-tetris-tiffin/index.html',import.meta.url),'utf8');
const start=html.indexOf('const LOCAL_DAILY = ['),end=html.indexOf('/* ===',html.indexOf('const Narrator = {'));
assert(start>0&&end>start);
function narrator(answer){
 const cache=new Map(),elements=new Map();let calls=0;
 const ctx=vm.createContext({WORKER_URL:'https://mock.invalid',Date,
  localStorage:{getItem:k=>cache.get(k)||null,setItem:(k,v)=>cache.set(k,v)},
  document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{remove(){}}});return elements.get(id);}},
  fetch:async()=>{calls++;return {json:async()=>({text:answer})};}});
 vm.runInContext(html.slice(start,end)+'\nglobalThis.narrator= Narrator; globalThis.fallbacks=LOCAL_DAILY;',ctx);
 return {ctx,cache,elements,calls:()=>calls};
}
test('TIFFIN：30字の回答を表示して当日のキャッシュを使う',async()=>{
 const w=narrator('あ'.repeat(30));await w.ctx.narrator.daily();await w.ctx.narrator.daily();
 assert.equal(w.elements.get('daily-order').textContent,'あ'.repeat(30));assert.equal(w.cache.size,1);assert.equal(w.calls(),1);
});
test('TIFFIN：31字以上は切り詰めず既存文へ戻し、保存しない',async()=>{
 const w=narrator('あ'.repeat(31));await w.ctx.narrator.daily();
 assert.ok(w.ctx.fallbacks.includes(w.elements.get('daily-order').textContent));assert.equal(w.cache.size,0);assert.equal(w.calls(),1);
});
test('TIFFIN：Unicodeの補助文字はコードポイントで数える',async()=>{
 const w=narrator('𠮷'.repeat(30));await w.ctx.narrator.daily();
 assert.equal(w.elements.get('daily-order').textContent,'𠮷'.repeat(30));assert.equal(w.cache.size,1);
});
