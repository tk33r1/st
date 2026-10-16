// ゲーム・DJの候補設定を本番ソースから読む。APIを呼ばず、週次smokeと有料評価で共用する。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
export const stripAuxImports=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export (?=(?:async )?function|const)/g,'');
export function auxiliaryContext() {
  const ctx=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),URL});
  for(const p of ['workers/shared/anthropic.js','workers/games/anthropic.js','workers/dj-request/song-info-anthropic.js','workers/dj-request/src/index.js'])
    vm.runInContext(stripAuxImports(read(p)).replace('export default {','globalThis.worker = {'),ctx);
  return ctx;
}
export function auxiliaryConfig() {
  const ctx=auxiliaryContext();
  const song={title:'Billie Jean',artist:'Michael Jackson',releaseYear:1982};
  const evidence={excerpts:[{url:'https://example.com/song',text:'The song was released in 1982.'}],sources:[{title:'Synthetic source',url:'https://example.com/song'}]};
  const data=vm.runInContext('({schema:SONG_INFO_SCHEMA,game:gameAnthropicBody("Return only READY.",[{role:"user",content:"Say READY."}],200)})',ctx);
  const provider=(p,name)=>new RegExp('^'+name+' = "(openai|anthropic)"','m').exec(read(p))?.[1]||'openai';
  return JSON.parse(JSON.stringify({...data,song,search:ctx.songSearchBody(song),card:ctx.songCardBody(song,evidence,data.schema),
    providers:{games:provider('workers/games/wrangler.toml','GAME_AI_PROVIDER'),song:provider('workers/dj-request/wrangler.toml','SONG_INFO_AI_PROVIDER')}}));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const cfg=auxiliaryConfig();
  if(process.argv.includes('--card-body')){
    const ctx=auxiliaryContext(),searched=JSON.parse(readFileSync(0,'utf8'));
    console.log(JSON.stringify(ctx.songCardBody(cfg.song,ctx.songSearchEvidence(searched),cfg.schema)));
  }else if(process.argv.includes('--validate-card')){
    const ctx=auxiliaryContext(),{searched,card}=JSON.parse(readFileSync(0,'utf8'));
    const result=ctx.buildSongCard(ctx.songCardOutput(ctx.songSearchEvidence(searched),card));
    if(!result.identified || !result.originalYear || result.dropped)throw new Error('Song card did not pass the source checks');
    console.log(JSON.stringify(result));
  }else console.log(JSON.stringify(cfg));
}
