// 段階1の本人採点のローカル集計。GitHubへ書かず、段階を変更しない。
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const day=86400000;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const timestamp=value=>typeof value==='string'&&date(value.slice(0,10))&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
export const newScorecard=()=>({schema_version:1,start_date_jst:null,candidates:[]});

export function stage1Report(ledger,now=new Date()) {
  if(!ledger||ledger.schema_version!==1||!Array.isArray(ledger.candidates)
    ||ledger.start_date_jst!==null&&!date(ledger.start_date_jst)||!Number.isFinite(+now))throw new Error('scorecard_shape');
  const start=ledger.start_date_jst===null?null:Date.parse(ledger.start_date_jst+'T00:00:00+09:00');
  const seen=new Set(),rows=ledger.candidates;
  for(const row of rows) {
    if(!row||typeof row.id!=='string'||!/^[\w:-]{1,100}$/.test(row.id)||seen.has(row.id)
      ||!/^https:\/\/github\.com\/tk33r1\/st\/pull\/[1-9]\d*$/.test(row.pr||'')||!/^[a-f0-9]{40}$/.test(row.head||'')
      ||!['A','B'].includes(row.classification)||!timestamp(row.detected_at)
      ||start===null||Date.parse(row.detected_at)<start||Date.parse(row.detected_at)>=start+14*day||Date.parse(row.detected_at)>+now
      ||![null,'correct','wrong_category','false_positive'].includes(row.grade)
      ||![null,true,false].includes(row.version_ok)||!['success','failure','not_run'].includes(row.actions)
      ||row.actions==='failure'&&(typeof row.actions_reason!=='string'||!row.actions_reason.trim()))throw new Error('scorecard_candidate');
    if(row.grade!==null&&(!/^[\w-]{1,100}$/.test(row.scored_by||'')||!timestamp(row.scored_at)
      ||Date.parse(row.scored_at)<Date.parse(row.detected_at)||Date.parse(row.scored_at)>+now))throw new Error('scorecard_judgement');
    seen.add(row.id);
  }
  const pending=rows.filter(r=>r.grade===null||r.version_ok===null).length;
  const wrongA=rows.filter(r=>r.classification==='A'&&r.grade==='wrong_category').length;
  const falsePositives=rows.filter(r=>r.grade==='false_positive').length;
  const versionCorrections=rows.filter(r=>r.version_ok===false).length;
  const periodEnded=start!==null&&+now>=start+14*day;
  const actionsFailures=rows.filter(r=>r.classification==='A'&&r.actions==='failure').map(r=>({id:r.id,pr:r.pr,reason:r.actions_reason}));
  const reasons=[];
  if(start===null)reasons.push('not_started');else if(!periodEnded)reasons.push('period_incomplete');
  if(!rows.length)reasons.push('no_candidates');
  if(pending)reasons.push('pending_judgements');if(wrongA)reasons.push('A_should_be_B');
  if(falsePositives*3>rows.length)reasons.push('false_positive_rate');
  if(versionCorrections)reasons.push('version_corrections');
  if(rows.some(r=>r.classification==='A'&&r.actions==='not_run'))reasons.push('A_validation_not_run');
  return {start_date_jst:ledger.start_date_jst,
    end_exclusive:start===null?null:new Date(start+14*day).toISOString(),period_ended:periodEnded,
    candidates:rows.length,pending,wrong_A:wrongA,false_positives:falsePositives,version_corrections:versionCorrections,
    actions_failures:actionsFailures,scoring_pass:!reasons.length,reasons,
    stage2_authorized:false,review_trial:'not_verified',deployment_trial:'not_verified',
    limitation:'本人が入力した採点の集計だけ。投稿元・実レビュー・実公開の確認や段階変更の承認ではない。'};
}

function main(args) {
  if(args.length===2&&args[0]==='--init') {
    writeFileSync(args[1],JSON.stringify(newScorecard(),null,2)+'\n',{flag:'wx',mode:0o600});return;
  }
  if(args.length===2&&args[0]==='--report') {
    console.log(JSON.stringify(stage1Report(JSON.parse(readFileSync(args[1],'utf8'))),null,2));return;
  }
  throw new Error('Use --init <new local file> or --report <scorecard.json>');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
