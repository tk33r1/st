// 実API評価は既定で停止。正本の予算を、要求ごとの保守的な費用見積もりと突き合わせる。
// 課金額を取得するAPIではない。予約額は失敗・中断後も消さず、実行をまたいで累計する。
import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const evaluationBudgetPath=fileURLToPath(new URL('../../workers/.wrangler/magi2-dialogue-a2/budget-20261015.json',import.meta.url));
const scope='magi-dialogue-20261015';
// 2026-10-17、本人が追加$2の代表経路案を採用。過去の予約は保持する。
export const evaluationBudgetCaps={openai:1.20,anthropic:1.20,total:2.80};
const caps=evaluationBudgetCaps;
const providers=['openai','anthropic','deepseek','typesafe'];
const cents=value=>Math.ceil(value*1e6); // 比較は百万分の1ドル、端数は切り上げる。
export const evaluationRequestHash=(provider,body)=>createHash('sha256').update(JSON.stringify({provider,body})).digest('hex');

export function paidEvaluationGate(args=process.argv,expectedLedgerPath=evaluationBudgetPath) {
  const argument=args.find(a=>a.startsWith('--budget-ledger='))?.slice('--budget-ledger='.length);
  if(!argument)throw new Error('Paid API evaluation is disabled. Use recorded replay, or provide --budget-ledger with reviewed per-request cost estimates.');
  const path=resolve(argument);
  if(path!==resolve(expectedLedgerPath))throw new Error('Use the shared budget-20261015.json ledger. A different file would reset the cumulative budget.');
  const validate=ledger=>{
    if(ledger.version!==1||ledger.scope!==scope||!ledger.estimates||typeof ledger.estimates!=='object'||Array.isArray(ledger.estimates)
      ||!Array.isArray(ledger.reservations))throw new Error('Invalid evaluation budget ledger.');
    for(const r of ledger.reservations)if(!providers.includes(r.provider)||!Number.isFinite(r.max_usd)||r.max_usd<0)throw new Error('Invalid budget reservation.');
    return ledger;
  };
  validate(JSON.parse(readFileSync(path,'utf8')));
  return {
    reserve(provider,body) {
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
