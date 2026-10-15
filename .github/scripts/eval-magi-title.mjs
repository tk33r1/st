// タイトルの役割（fetchTitle）だけを実APIで測る。入力は eval-magi-models.mjs の初回の固定入力と同じ33件。
// 題ではなく答えを書いた件を数える（判定は機械的な目安。全件の出力も成果物に残して目で確かめる）。
// --ref=<git commit> で旧版を読む。--repeat=<n> で各入力を n 回呼ぶ。本番DB・生成物は変更しない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url);
const opt=(key,fallback='')=>process.argv.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3)||fallback;
const ref=opt('ref'),label=opt('label',ref?'title-baseline':'title-candidate'),repeat=Number(opt('repeat','2'));
assert.match(label,/^[a-z0-9-]+$/);assert(Number.isInteger(repeat)&&repeat>=1&&repeat<=5);
const current=p=>readFileSync(new URL(p,root),'utf8');
const read=p=>ref?execFileSync('git',['show',ref+':'+p],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}):current(p);
const files=['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js',...(!ref || execFileSync('git',['ls-tree','--name-only',ref,'workers/magi2/research.js'],{cwd:root,encoding:'utf8'}).trim() ? ['research.js'] : []),'src/index.js'];
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const calls=[];
const context=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),bundledContext:JSON.parse(current('data/magi-context.json')),
 Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,AbortSignal,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
 console:{log(){}},
 fetch:async(url,options)=>{const res=await fetch(url,options);calls.push({provider:String(url).includes('anthropic.com')?'anthropic':'openai',status:res.status});return res;}});
vm.runInContext(files.map(p=>strip(read('workers/magi2/'+p))).join('\n').replace('export default {','globalThis.worker = {'),context);
const env={MAGI_ANTHROPIC_API_KEY:process.env.MAGI_ANTHROPIC_API_KEY,MAGI_OPENAI_API_KEY:process.env.MAGI_OPENAI_API_KEY};
assert(env.MAGI_ANTHROPIC_API_KEY,'MAGI_ANTHROPIC_API_KEY is required');

const images=JSON.parse(current('.github/scripts/fixtures/anthropic-images.json'));
const inputs=[
 '仕事の締切が重なり、休むと遅れるのが怖い。優先順位と休み方を一緒に整理して。',
 '友人からの誘いを断るのが苦手で、疲れてしまう。関係を大切にしながら伝える方法を相談したい。',
 '新しい職場で質問するタイミングがわからない。自分で考える時間と人に聞く基準を整理して。',
 '週末に読書とバイクの時間を作りたいが、いつも家事だけで終わる。無理なく両立する工夫を相談したい。',
 '店の売上が伸びない。SNSの投稿と常連向けイベントの利点と弱点を整理して。予算は月2万円、平日は一人です。',
 'DJを始めたばかりで、練習を録音すると失敗ばかり気になる。楽しみと上達のバランスを相談したい。',
 '会議で自分の意見を言う前に話題が変わることが多い。準備と伝え方を相談したい。',
 'I feel guilty taking breaks when deadlines pile up. Help me choose a realistic priority and rest plan.',
 'A friend keeps cancelling at the last minute. How can I discuss it without making assumptions about them?',
 'I want to learn DJing but only have twenty minutes a day. Help me design a small, enjoyable practice routine.',
 ...[0,1,2].map(i=>[{type:'image_url',image_url:{url:'data:'+images[i].media_type+';base64,'+images[i].data}},{type:'text',text:i===2?'Describe the color and shape, and suggest one improvement to make this icon readable.':'画像の色と形を説明して、アイコンとして見やすくする改善案を一つ教えて。'}]),
 '寝る前にスマートフォンを別の部屋に置くべき？','月の予算が2万円なら、常連向けの小さな読書会を試すべき？','Should I reserve Sunday afternoon for rest?',
 '雨が降るなら今日はバイクに乗るのをやめるべき？','締切が明日なら今日中に資料を完成させるべき？','今週末、使っていない本を10冊手放すべき？','帰りが22時を過ぎるなら飲み会を断るべき？','睡眠が6時間未満なら今日は早く帰るべき？','参加者が3人なら会議をオンラインにすべき？',
 'Should I skip riding my bike today if it rains?','Should I finish the report today if the deadline is tomorrow?','Should I donate ten unused books this weekend?','Should I decline dinner if I would get home after 10 pm?','Should a three-person meeting be online?','Should I share a draft today if the deadline is next week?',
 '夕方の落ち着いた雰囲気に合うソウルを3曲提案して。','ファンク中心のセットの序盤に合う曲を3曲、理由も短く教えて。','世代の違う人がいるカフェでかける、親しみやすい曲を3曲相談したい。','ハウスの前に自然につなげられるディスコを3曲提案して。','Suggest three mellow songs for the opening of a small evening DJ set.',
];
const textOf=c=>typeof c==='string'?c:c.filter(p=>p.type==='text').map(p=>p.text).join('');
// 題でなく答えに見える目安: 文の区切り（句読点・疑問符）があるか、日本語で20字超・英語で8語超
const answerLike=(title,input)=>{const ja=/[ぁ-んァ-ン一-龥]/.test(textOf(input));
 return /[。、！？!?]|\.\s|:\s|\*\*/.test(title)||(ja?[...title].length>20:title.split(/\s+/).length>8);};

const results=[];
for(const [i,content] of inputs.entries())for(let n=0;n<repeat;n++){
 calls.length=0;
 const langNote=context.replyLanguageNote([{role:'user',content}]);
 const title=await context.fetchTitle(env,content,langNote,AbortSignal.timeout(45000),()=>{});
 results.push({id:i+1,run:n+1,input:textOf(content),image:typeof content!=='string',title,answer_like:title?answerLike(title,content):null,calls:[...calls]});
 console.log(JSON.stringify({label,id:i+1,run:n+1,ok:!!title,answer_like:results.at(-1).answer_like,calls:calls.map(c=>c.provider+':'+c.status)}));
 if(calls.some(c=>[401,402,403,429].includes(c.status)))throw new Error('Evaluation stopped at upstream authentication, billing, or rate limit');
}
const titled=results.filter(r=>r.title),bad=titled.filter(r=>r.answer_like);
const summary={label,ref:ref||'working-tree',date:new Date().toISOString(),repeat,total:results.length,titled:titled.length,answer_like:bad.length};
const directory=new URL('workers/.wrangler/magi-title/',root);mkdirSync(directory,{recursive:true});
writeFileSync(new URL(label+'.json',directory),JSON.stringify({...summary,results},null,2)+'\n');
console.log('SUMMARY '+JSON.stringify(summary));
