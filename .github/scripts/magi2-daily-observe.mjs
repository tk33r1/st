// 件数だけを取り出す週次の確認。DBはSELECTのみ、公開カタログはGETのみ。
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {githubClient,dailyIssueNumber,commentOnce,eligibleDailyPR} from './magi2-daily-github.mjs';

const kinds=['global','search:global','research:global'];
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))
  &&new Date(value).toISOString().slice(0,10)===value;
export function observationPeriod(now=new Date()) {
  const until=new Date(now.toISOString().slice(0,10)+'T00:00:00Z');
  return {from:new Date(+until-7*86400000).toISOString().slice(0,10),until:until.toISOString().slice(0,10)};
}
export function observationSQL(period=observationPeriod()) {
  if(!validDay(period.from)||!validDay(period.until)||period.from>=period.until)throw new Error('observation_period');
  return "SELECT day, ip AS kind, count FROM rate_limit WHERE ip IN ('global','search:global','research:global')"
    +" AND day >= '"+period.from+"' AND day < '"+period.until+"' ORDER BY day, kind;\n"
    +"SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM reactions WHERE created_at >= '"+period.from+"T00:00:00'"
    +" AND created_at < '"+period.until+"T00:00:00' GROUP BY substr(created_at,1,10) ORDER BY day;";
}
export function cleanObservation(value,period=observationPeriod()) {
  if(!Array.isArray(value)||value.length!==2||!value.every(v=>v.success===true&&Array.isArray(v.results)))throw new Error('observation_shape');
  const counts=new Map(),reactions=new Map();
  for(const [i,result] of value.entries())for(const row of result.results) {
    const allowed=i===0?['count','day','kind']:['count','day'];
    if(Object.keys(row).sort().join()!==allowed.sort().join()||!validDay(row.day)||row.day<period.from||row.day>=period.until
      ||!Number.isSafeInteger(row.count)||row.count<0||i===0&&!kinds.includes(row.kind))throw new Error('observation_private_or_invalid_row');
    const target=i===0?counts:reactions,key=i===0?row.day+':'+row.kind:row.day;
    if(target.has(key))throw new Error('observation_duplicate');target.set(key,row.count);
  }
  const days=[];
  for(let ms=Date.parse(period.from);ms<Date.parse(period.until);ms+=86400000) {
    const day=new Date(ms).toISOString().slice(0,10);
    days.push({day,...Object.fromEntries(kinds.map(k=>[k,counts.get(day+':'+k)||0])),reactions:reactions.get(day)||0});
  }
  return {period,days};
}
export async function catalogObservation(fetcher=fetch) {
  const start=Date.now();
  try {
    const response=await fetcher('https://workers.tk.st/magi2/models',{headers:{Origin:'https://tk.st'},signal:AbortSignal.timeout(10000)});
    const data=response.ok?await response.json():null;
    const described=row=>row&&['desc','context','theme'].every(field=>['ja','en'].every(lang=>typeof row[field]?.[lang]==='string'));
    return {ok:response.ok&&['MELCHIOR-1','BALTHASAR-2','CASPER-3'].every(k=>described(data?.personas?.[k]))
      &&!!described(data?.synthesizer)&&['ja','en'].every(k=>Array.isArray(data?.privacy?.[k])&&data.privacy[k].length>0),
      status:response.status,elapsed_ms:Date.now()-start};
  } catch{return {ok:false,status:null,elapsed_ms:Date.now()-start};}
}
export async function weeklyPRs(client,period=observationPeriod()) {
  // updated降順なので、期間開始より古くなった最初の行で打ち切れる。
  return client.pages('/pulls?state=all&sort=updated&direction=desc',{
    stop:pr=>typeof pr.updated_at==='string'&&pr.updated_at<period.from+'T00:00:00Z',
  });
}
export function observationText(report,catalog,prs=[],version=null,{actor='tk33r1'}={}) {
  const start=report.period.from,end=report.period.until;
  const inWeek=value=>typeof value==='string'&&value.slice(0,10)>=start&&value.slice(0,10)<end;
  const a=prs.filter(p=>eligibleDailyPR(p,{actor})&&inWeek(p.merged_at)).length;
  const b=prs.filter(p=>eligibleDailyPR(p,{actor,label:'magi2-daily-B'})&&inWeek(p.created_at)).length;
  return '週次まとめ（UTC '+start+' 以上、'+end+' 未満）\n\n'
    +'公開カタログ: '+(catalog.ok?'正常':'要確認')+'（HTTP '+(catalog.status??'応答なし')+'）\n'
    +'区分Aのマージ '+a+'件、区分Bの新規PR '+b+'件。現在の履歴の版: '+(version||'未確認')+'。\n\n'
    +'| 日付（UTC） | 通常チャット | サイト案内 | Web検索 | リアクション |\n| --- | ---: | ---: | ---: | ---: |\n'
    +report.days.map(r=>'| '+[r.day,r.global,r['search:global'],r['research:global'],r.reactions].join(' | ')+' |').join('\n')
    +'\n\n件数は既存カウンターの値です。実際の課金額や回答品質を表しません。IP・本文・検索語は取得していません。';
}
async function main(args) {
  const period=observationPeriod();
  if(args.includes('--sql')){console.log(observationSQL(period));return;}
  const index=args.indexOf('--rows');if(index<0)throw new Error('--rows is required');
  const report=cleanObservation(JSON.parse(readFileSync(args[index+1],'utf8')),period);
  const catalog=await catalogObservation();
  const client=githubClient(process.env.GITHUB_TOKEN,{repository:process.env.GITHUB_REPOSITORY});
  const prs=await weeklyPRs(client,period);
  const version=JSON.parse(readFileSync('data/magi-versions.json','utf8')).versions[0].version;
  const text=observationText(report,catalog,prs,version,{actor:process.env.MAGI2_DAILY_ACTOR||'tk33r1'});
  await commentOnce(client,dailyIssueNumber(process.env.MAGI2_DAILY_ISSUE),['weekly',period.from],text);
  console.log(JSON.stringify({period,catalog,reported:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
