/* 同梱した外部ライブラリに当てる置き換え（fetch-vendor.js が取り込みのたびに当てる）
 *
 * SAFE TOOLS のページは Content-Security-Policy で 'unsafe-eval' を許していない（文字列から
 * コードを作る処理はブラウザが止める）。ところが Emscripten の古い出力（embind）は、関数の
 * 名前付けや呼び出し口を new Function で組み立てるので、そのままでは起動の途中で止まる。
 * そこで該当箇所を、同じ働きのクロージャに置き換える。Emscripten 自身が DYNAMIC_EXECUTION=0
 * のときに使う形と同じで、動きは変わらない。
 *
 * 置き換えは「元の文字列が見つかったら当てる」形なので、何度当てても同じ結果になる。
 * 当てたあとに元の文字列が残っていないこと、同梱の JS 全体に new Function などが残って
 * いないことは fetch-vendor.js --check が確かめる。
 *
 *   start … 置き換える範囲の頭（after があれば、その後ろで最初に出てくるもの）
 *   end   … 置き換える範囲の終わり（この文字列まで含めて置き換える）
 *   after … start を探し始める位置の目印（start が他の場所にも出てくるとき）
 *   replace … 置き換え後の文字列
 */
'use strict';

const NOTE = '/*tk.st: CSP で unsafe-eval を許さないため、文字列から関数を作らず同じ働きのクロージャにした（Emscripten の DYNAMIC_EXECUTION=0 と同じ形）*/';

const PATCHES = {
  // heic2any に同梱の libheif（HEIC を処理する worker のコード。文字列として埋め込まれている）
  'data/vendor/heic2any@0.0.4/heic2any.min.js': [
    { // createNamedFunction（1か所目）
      start: 'function QA(A,e){return A=YA(A),new Function(', end: ')(e)}',
      replace: 'function QA(A,e){' + NOTE + 'return A=YA(A),{[A]:function(){return e.apply(this,arguments)}}[A]}' },
    { // createNamedFunction（2か所目。ライブラリの外側の定義）
      start: 'function QA(A,e){return A=YA(A=A||"function_"+new Date),new Function(', end: ')(e)}',
      replace: 'function QA(A,e){' + NOTE + 'return A=YA(A=A||"function_"+new Date),{[A]:function(){return e.apply(this,arguments)}}[A]}' },
    { // 関数ポインタの呼び出し口（makeDynCaller）
      start: 'A=function(A){for(var e=[],r=1;r<f.length;++r)e.push("a"+r);', end: 'new Function("dynCall","rawFunction",i)(A,n)}(e)',
      replace: 'A=function(A){' + NOTE + 'return function(){for(var e=[n],r=0;r<arguments.length;r++)e.push(arguments[r]);return A.apply(null,e)}}(e)' },
    { // craftInvokerFunction（C++ の関数を JS から呼ぶ口）。このコードは ' で囲んだ文字列の中にあるので、
      // 置き換え後に ' と \ を使わない
      after: 'function xe(A,e,r,i,f){', start: 'var c="void"!==e[0].name,l="",u="";', end: 'He(Function,d).apply(null,k)}',
      replace: 'var c="void"!==e[0].name;' + NOTE + 'return QA(A,function(){' +
        'if(arguments.length!==n-2)HA("function "+A+" called with "+arguments.length+" arguments, expected "+(n-2)+" args!");' +
        'var s=o?[]:null,w;t&&(w=e[1].toWireType(s,this));' +
        'for(var g=[],a=0;a<n-2;++a)g[a]=e[a+2].toWireType(s,arguments[a]);' +
        'var v=i.apply(null,t?[f,w].concat(g):[f].concat(g));' +
        'if(o)CA(s);else for(a=t?1:2;a<e.length;++a){var h=1===a?w:g[a-2];null!==e[a].destructorFunction&&e[a].destructorFunction(h)}' +
        'if(c)return e[0].fromWireType(v)})}' }
  ],
  // QR Atelier の読み取りテストに使う OpenCV WeChat（取得元は vendor/wechat/index.js の冒頭）
  'tools/qr-atelier/vendor/wechat/wasm.js': [
    { // createNamedFunction
      start: 'function tA(A,I){return A=JA(A),new Function(', end: ')(I)}',
      replace: 'function tA(A,I){/*tk.st: CSP で unsafe-eval を許さないため、new Function を使わない形に置き換え（名前付きの関数で本体を呼ぶだけで、働きは元と同じ）*/return A=JA(A),{[A]:function(){return I.apply(this,arguments)}}[A]}' },
    { // craftInvokerFunction（C++ の関数を JS から呼ぶ口）
      after: 'function qA(A,I,g,C,B){', start: 'let R="",y="";', end: 'HI(Function,s).apply(null,Y)}',
      replace: NOTE + 'return tA(A,function(...R){' +
        'R.length!==E-2&&h(`function ${A} called with ${R.length} arguments, expected ${E-2} args!`);' +
        'const U=i?[]:null;let tw;D&&(tw=I[1].toWireType(U,this));' +
        'const aw=[];for(let w=0;w<E-2;++w)aw[w]=I[w+2].toWireType(U,R[w]);' +
        'const rv=D?C(B,tw,...aw):C(B,...aw);' +
        'if(i)aA(U);else for(let w=D?1:2;w<I.length;++w){const P=w===1?tw:aw[w-2];I[w].destructorFunction!==null&&I[w].destructorFunction(P)}' +
        'if(G)return I[0].fromWireType(rv)})}' },
    { // __emval_get_method_caller（JS のメソッドを C++ から呼ぶ口）
      after: 'function kC(A,I){', start: 'let w="";for(var G=0;G<A-1;++G)w+=', end: 'const U=HI(Function,D).apply(null,i);',
      replace: NOTE + 'const U=tA(`methodCaller_${B}`,function(Q,W,X,Z){' +
        'const V=[];let N=0;for(let G=0;G<A-1;++G){V[G]=g[G+1].readValueFromPointer(Z+N);N+=g[G+1].argPackAdvance}' +
        'const rv=Q[W](...V);for(let G=0;G<A-1;++G)g[G+1].deleteObject&&g[G+1].deleteObject(V[G]);' +
        'if(!C.isVoid)return C.toWireType(X,rv)});' }
  ]
};

// 文字列からコードを作る処理の目印。同梱の JS にこれが残っていたら、CSP の下で止まる
const DYNAMIC_CODE = /new Function\s*\(|\(\s*Function\s*,|[^\w.$]eval\s*\(/;

// 置き換えを当てる。元の文字列が無い（当て済み）ものは飛ばす。
// 戻り値は { text, applied（当てた数）, pending（当てられなかった＝形が変わっていた数） }
function applyPatches(text, list) {
  let applied = 0, pending = 0;
  for (const p of list) {
    const from = p.after ? text.indexOf(p.after) : 0;
    if (from < 0) { if (!text.includes(p.replace)) pending++; continue; }
    const i = text.indexOf(p.start, from);
    if (i < 0) { if (!text.includes(p.replace)) pending++; continue; }
    const j = text.indexOf(p.end, i);
    if (j < 0) { pending++; continue; }
    text = text.slice(0, i) + p.replace + text.slice(j + p.end.length);
    applied++;
  }
  return { text, applied, pending };
}

module.exports = { PATCHES, DYNAMIC_CODE, applyPatches };
