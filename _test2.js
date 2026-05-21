const fs=require('fs'), vm=require('vm');
const html=fs.readFileSync('index.html','utf8');
let code=''; (html.match(/<script>([\s\S]*?)<\/script>/g)||[]).forEach(s=>{ if(s.includes('WORKER_URL')) code+=s.replace(/<\/?script>/g,''); });
code += '\nglobal.Game=Game;';
const noop=()=>{};
function fakeCtx(){ return new Proxy({}, {get:()=>(()=>{})}); }
const elStore={};
function fakeEl(){ return {style:{cssText:''}, classList:{add:noop,remove:noop,contains:()=>false}, addEventListener:noop, querySelectorAll:()=>[], getContext:()=>fakeCtx(), width:0,height:0, innerHTML:'', innerText:'', value:'匿名', dataset:{}, offsetWidth:0, appendChild:noop, animate:()=>({}), remove:noop }; }
const document={ getElementById:id=>elStore[id]||(elStore[id]=fakeEl()), querySelector:()=>fakeEl(), querySelectorAll:()=>[], addEventListener:noop, createElement:()=>fakeEl() };
const localStorage={_d:{},getItem(k){return this._d[k]||null;},setItem(k,v){this._d[k]=v;}};
const window={AudioContext:function(){return {createGain:()=>({gain:{},connect:noop}),createOscillator:()=>({frequency:{setValueAtTime:noop,exponentialRampToValueAtTime:noop},connect:noop,start:noop,stop:noop}),createBiquadFilter:()=>({frequency:{setValueAtTime:noop,exponentialRampToValueAtTime:noop},Q:{},connect:noop}),currentTime:0,destination:{}};}};
const ctxObj={document,localStorage,requestAnimationFrame:()=>1,cancelAnimationFrame:noop,performance:{now:()=>0},window,setTimeout:noop,clearInterval:noop,setInterval:()=>0,console,Math,JSON,Array,Object,Date};
ctxObj.global=ctxObj; vm.createContext(ctxObj); vm.runInContext(code,ctxObj);
const Game=ctxObj.Game;
const R=20,C=10;

Game.reset(); Game.arena=Array.from({length:R},()=>new Array(C).fill(0));
for(let y=R-3;y<R;y++)for(let x=0;x<C;x++)Game.arena[y][x]=1;
Game.score=0;Game.ren=0;Game.lines=0;Game.pot=[];Game.pendingGarbage=0;Game.rolesCompleted=0;
Game.clearLines();
console.log('統合 3ライン消去: lines='+Game.lines+' score='+Game.score+' roles='+Game.rolesCompleted+' pot='+JSON.stringify(Game.pot)+' garbage='+Game.pendingGarbage);
console.log((Game.lines===3&&Game.rolesCompleted===1&&Game.pot.length===0&&Game.score>0?'OK ':'FAIL ')+'役発動でスコア倍率&鍋リセット');

Game.reset(); Game.arena=Array.from({length:R},()=>new Array(C).fill(0));
for(let x=0;x<C;x++)Game.arena[R-1][x]=2;
Game.lines=0;Game.pot=[];Game.rolesCompleted=0;
Game.clearLines();
console.log((Game.rolesCompleted===0&&Game.pot.length===C?'OK ':'FAIL ')+'役なし時: roles='+Game.rolesCompleted+' pot='+Game.pot.length);
