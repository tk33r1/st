// 実API評価は既定で停止。正本の予算を、要求ごとの保守的な費用見積もりと突き合わせる。
// 課金額を取得するAPIではない。予約額は失敗・中断後も消さず、実行をまたいで累計する。
import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const evaluationBudgetPath=fileURLToPath(new URL('../../workers/.wrangler/magi2-dialogue-a2/budget-20261015.json',import.meta.url));
const scope='magi-dialogue-20261015';
// 2026-10-17、本人が追加$2の代表経路案を採用。過去の予約は保持する。
// 2026-10-20 本人承認: B3代表3件に追加$0.32。既存予約は保持する。
// 2026-10-26 本人承認: 7.03最終APKの本番確認1回に追加上限$0.08。過去の未確定分は未確定のまま保持。
export const evaluationBudgetCaps={openai:1.20,anthropic:1.20,total:3.20};
const caps=evaluationBudgetCaps;
const providers=['openai','anthropic','deepseek','typesafe'];
const cents=value=>Math.ceil(value*1e6); // 比較は百万分の1ドル、端数は切り上げる。
export const evaluationRequestHash=(provider,body)=>createHash('sha256').update(JSON.stringify({provider,body})).digest('hex');

const dailyBudgetRoot=fileURLToPath(new URL('../../workers/.wrangler/magi2-daily/',import.meta.url));
const utcMonth=now=>now.toISOString().slice(0,7); // YYYY-MM
export function dailyEvaluationBudgetPath(now=new Date()) {
  return resolve(dailyBudgetRoot,'budget-'+utcMonth(now).replace('-','')+'.json');
}

// CLIから別の月・別の保存先を指定して枠を増やさない。A2の既存の入口と上限は維持する。
export function evaluationBudgetPolicy(path,now=new Date()) {
  if(resolve(path)===resolve(evaluationBudgetPath))return {scope,caps};
  const month=utcMonth(now);
  if(resolve(path)===dailyEvaluationBudgetPath(now))return {scope:'magi2-daily-'+month.replace('-',''),caps:{total:.50},month};
  throw new Error('Use the shared budget-20261015.json ledger or the current A6 monthly ledger.');
}

// 台帳の指定が無ければ送らない。実APIの評価はどの入口も既定で停止する。
function ledgerArgument(args,message) {
  const argument=args.find(a=>a.startsWith('--budget-ledger='))?.slice('--budget-ledger='.length);
  if(!argument)throw new Error('Paid API evaluation is disabled. '+message);
  return resolve(argument);
}

export function paidEvaluationGate(args=process.argv,expectedLedgerPath=evaluationBudgetPath) {
  const path=ledgerArgument(args,'Use recorded replay, or provide --budget-ledger with reviewed per-request cost estimates.');
  // 既存の評価器はA2だけを使う。第2引数は既存単体テストの一時台帳用。
  if(path!==resolve(expectedLedgerPath))throw new Error('Use the shared budget-20261015.json ledger.');
  return evaluationLedgerGate(path,{scope,caps});
}

// A6用の呼び出しだけが明示的に選ぶ入口。A2や別月の台帳では実行しない。
export function dailyPaidEvaluationGate(args=process.argv,now=new Date()) {
  const path=ledgerArgument(args,'Provide the current A6 monthly ledger.');
  // 月末をまたいでも、保存先と枠の月を同じ時刻で決める。
  if(path!==dailyEvaluationBudgetPath(now))throw new Error('Use the shared current A6 monthly ledger.');
  return evaluationLedgerGate(path,evaluationBudgetPolicy(path,now));
}

// I/Oと予約の検査。入口の保存先判定と分け、外部APIを使わずに両方の台帳を検証する。
export function evaluationLedgerGate(path,policy) {
  const {scope,caps,month}=policy;
  const validate=ledger=>{
    if(ledger.version!==1||ledger.scope!==scope||!ledger.estimates||typeof ledger.estimates!=='object'||Array.isArray(ledger.estimates)
      ||!Array.isArray(ledger.reservations))throw new Error('Invalid evaluation budget ledger.');
    for(const r of ledger.reservations)if(!providers.includes(r.provider)||!Number.isFinite(r.max_usd)||r.max_usd<0
      ||month&&(!/^\d{4}-\d{2}-\d{2}T/.test(r.at||'')||r.at.slice(0,7)!==month))throw new Error('Invalid budget reservation.');
    return ledger;
  };
  validate(JSON.parse(readFileSync(path,'utf8')));
  return {
    reserve(provider,body) {
      if(month&&utcMonth(new Date())!==month)throw new Error('The A6 budget month changed. Open the current monthly ledger.');
      if(!providers.includes(provider)||!body?.model)throw new Error('Unknown paid API request.');
      const request_hash=evaluationRequestHash(provider,body),lock=path+'.lock';
      let handle;
      try {
        // 別の評価器と同時に使う場合も、予約を二重に読み出さない。ロックがあれば送らずに停止する。
        handle=openSync(lock,'wx');
        const ledger=validate(JSON.parse(readFileSync(path,'utf8'))),estimate=ledger.estimates[request_hash];
        if(!estimate||estimate.provider!==provider||estimate.model!==body.model||!Number.isFinite(estimate.max_usd)||estimate.max_usd<0
          ||estimate.max_usd===0&&body.operation!=='models-read'
          ||!/^\d{4}-\d{2}-\d{2}$/.test(estimate.pricing_checked_at||'')||typeof estimate.basis!=='string'||!estimate.basis.trim()) {
          throw new Error('No reviewed cost ceiling for this exact API request.');
        }
        const total=ledger.reservations.reduce((sum,r)=>sum+cents(r.max_usd),0);
        const spent=ledger.reservations.filter(r=>r.provider===provider).reduce((sum,r)=>sum+cents(r.max_usd),0);
        const amount=cents(estimate.max_usd);
        if(total+amount>cents(caps.total)||spent+amount>cents(caps[provider]??caps.total))throw new Error('Evaluation cost ceiling reached. API request was not sent.');
        ledger.reservations.push({at:new Date().toISOString(),provider,model:body.model,request_hash,max_usd:estimate.max_usd});
        writeFileSync(path,JSON.stringify(ledger,null,2)+'\n');
        return {request_hash,max_usd:estimate.max_usd};
      } finally {
        if(handle!==undefined){closeSync(handle);unlinkSync(lock);}
      }
    },
  };
}
