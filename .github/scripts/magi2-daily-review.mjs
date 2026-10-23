// 交互レビューの状態を元の依頼・正式な実行記録から再計算する。状態コメント自体は入力にしない。
// routeとrecordsは信頼するサービスの取得結果専用。PR本文の自己申告を渡してはいけない。
const columns=['finding_id','status','evidence'];
const states=new Set(['fixed','withdrawn','open']);
const id=value=>typeof value==='string'&&/^[\w:-]{1,200}$/.test(value);
const time=value=>typeof value==='string'?Date.parse(value):NaN;
const sol=value=>typeof value==='string'&&/^gpt-\d+(?:\.\d+)?-sol$/.test(value);
const day=86400000;

export function findingTable(text) {
  if(typeof text!=='string'||text.length>65536)return null;
  const lines=text.split(/\r?\n/),headers=[];
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
  for(const [i,line] of lines.entries())if(cells(line).join()===columns.join())headers.push(i);
  if(headers.length!==1)return null;
  const start=headers[0],separator=cells(lines[start+1]||'');
  if(separator.length!==3||!separator.every(s=>/^:?-{3,}:?$/.test(s)))return null;
  const rows=[];
  for(let i=start+2;i<lines.length&&lines[i].trim().startsWith('|');i++) {
    const values=cells(lines[i]);if(values.length!==3)return null;
    rows.push(Object.fromEntries(columns.map((key,i)=>[key,values[i]])));
  }
  if(rows.some(r=>!id(r.finding_id)||!states.has(r.status)||!r.evidence)||new Set(rows.map(r=>r.finding_id)).size!==rows.length)return null;
  return rows;
}

export function claudeModelEvidence(evidence,head,actor) {
  return evidence.some(row=>row.actor===actor&&row.head===head&&row.model_alias==='opus'&&row.effort==='high'
    &&Number.isFinite(time(row.created_at)));
}

export function reviewState({head,base,route=null,requests=[],results=[],records=[],claude=[],now=new Date()}={}) {
  const nowMs=+now,known=new Map(),accepted=new Set(),seen=new Map();
  const output=(next,reason,extra={})=>({next,reason,rounds:accepted.size,remaining:Math.max(0,3-accepted.size),
    unresolved:[...known.values()].filter(f=>f.priority<=1&&f.status==='open').map(f=>f.finding_id),...extra});
  // 3ラウンドを使い切ったら本人、残っていれば Claude が直して再依頼する。
  const retry=reason=>output(accepted.size>=3?'human':'claude',reason);
  // 設定だけで実経路の合格を代用しない。点検・レビューの登録と実試行が必要。
  const configured=route?.configured===true&&route.live_trial_passed===true&&route.name&&route.result_actor&&route.routine_actor;
  const ordered=[...requests].sort((a,b)=>time(a.created_at)-time(b.created_at));
  for(const request of ordered) {
    if(!id(request.id)||!Number.isFinite(time(request.created_at)))return output('unconfigured','invalid_request');
    if(seen.has(request.id)) {
      if(JSON.stringify(seen.get(request.id))!==JSON.stringify(request))return output('unconfigured','conflicting_request');
      continue;
    }
    seen.set(request.id,request);
    if(request.run_id!=null&&!id(request.run_id))return output('unconfigured','invalid_execution');
    if(request.run_id) {
      if(accepted.has(request.run_id))return output('unconfigured','duplicate_execution');
      accepted.add(request.run_id);
    }
  }
  if(!configured)return output('unconfigured','route_not_configured');
  if(accepted.size>3)return output('human','round_limit');
  const unique=[...seen.values()];let round=0,latest=null,latestValid=false,invalidTable=false,latestFailed=false;
  for(const request of unique) {
    latest=request;
    if(request.run_id)round++;
    if(request.actor!==route.routine_actor||!sol(request.selection?.model)||request.selection?.effort!=='high'
      ||request.selection?.source!==route.name||!Number.isFinite(time(request.selection?.selected_at))
      ||time(request.selection.selected_at)>time(request.created_at))return output('unconfigured','selection_unverified');
    if(request.run_id&&request.round!==round)return output('unconfigured','round_sequence');
    latestValid=false;invalidTable=false;latestFailed=false;
    const failed=!!request.run_id&&records.some(r=>r.request_id===request.id&&r.run_id===request.run_id&&r.head===request.head
      &&r.source===route.name&&r.state==='failed');
    const matches=results.filter(r=>request.run_id&&r.request_id===request.id&&r.run_id===request.run_id&&r.head===request.head
      &&r.actor===route.result_actor&&r.state==='completed');
    const result=matches.at(-1);
    if(!result) {
      if(failed){latestFailed=true;continue;}
      if(nowMs-time(request.created_at)>=day)return output('human','response_timeout',{request_id:request.id});
      if(request!==unique.at(-1))return output('unconfigured','overlapping_requests');
      continue;
    }
    const record=records.find(r=>r.id===result.record_id&&r.run_id===request.run_id&&r.request_id===request.id&&r.head===request.head
      &&r.source===route.name&&r.state==='completed');
    if(!record) {
      if(failed){latestFailed=true;continue;}
      if(nowMs-time(request.created_at)>=day)return output('human','record_timeout');
      if(request!==unique.at(-1))return output('unconfigured','unverified_prior_record');
      continue;
    }
    if(record.model!==request.selection.model||record.effort!=='high') {
      if(failed){latestFailed=true;continue;}
      return output('unconfigured','model_record_mismatch');
    }
    if(!Number.isFinite(time(result.completed_at))||time(result.completed_at)<time(request.created_at))return output('unconfigured','completion_time');
    if(time(result.completed_at)-time(request.created_at)>=day)return output('human','response_timeout');
    if(!Array.isArray(result.findings))return output('unconfigured','findings_shape');
    const newIds=new Set();
    for(const finding of result.findings) {
      if(!id(finding.finding_id)||!finding.finding_id.startsWith(request.id+':')||known.has(finding.finding_id)
        ||newIds.has(finding.finding_id)||!Number.isInteger(finding.priority)||finding.priority<0||finding.priority>3)return output('unconfigured','finding_identity');
      newIds.add(finding.finding_id);known.set(finding.finding_id,{...finding,status:'open'});
    }
    const rows=findingTable(result.table);
    if(!rows||rows.length!==known.size||rows.some(r=>!known.has(r.finding_id)||newIds.has(r.finding_id)&&r.status!=='open'))invalidTable=true;
    else {
      for(const row of rows)known.set(row.finding_id,{...known.get(row.finding_id),status:row.status});
      latestValid=true;
    }
  }
  if(!latest)return output('claude','review_required');
  if(latest.head!==head||latest.base!==base)return output(accepted.size>=3?'human':'claude',accepted.size>=3?'round_limit':'head_changed');
  if(!latestValid) {
    if(latestFailed)return retry('request_failed');
    if(invalidTable)return retry('invalid_table');
    return output('chatgpt','awaiting_result',{request_id:latest.id,deadline:new Date(time(latest.created_at)+day).toISOString()});
  }
  if([...known.values()].some(f=>f.priority<=1&&f.status==='open'))return retry('open_findings');
  if(!claudeModelEvidence(claude,head,route.routine_actor))return output('claude','claude_settings_missing');
  return output('ready','completed',{claude_model_evidence:'self_report',independent_claude_model_proof:false});
}

export function inspectionWindow({now=new Date(),pauses=[],completions=[],verifyMain=()=>false}={}) {
  const end=+now,normal=end-25*3600000,remaining=[];
  for(const pause of pauses) {
    if(!id(pause.id)||!Number.isFinite(time(pause.started_at))||time(pause.started_at)>end)throw new Error('invalid_pause');
    const consumed=completions.some(c=>c.success===true&&Array.isArray(c.pause_ids)&&c.pause_ids.includes(pause.id)
      &&Number.isFinite(time(c.from))&&Number.isFinite(time(c.to))&&time(c.from)<=time(pause.started_at)-25*3600000
      &&time(c.to)>=time(pause.started_at)&&time(c.to)<=end&&verifyMain(c.main,c.to));
    if(!consumed)remaining.push(pause);
  }
  return {from:new Date(Math.min(normal,...remaining.map(p=>time(p.started_at)-25*3600000))).toISOString(),
    to:new Date(end).toISOString(),pause_ids:[...new Set(remaining.map(p=>p.id))]};
}

export function mayMerge({stage,halt,openA=0,validation=false,head,base,currentHead,currentBase,open=false,
  labelled=false,eligible=false,claudeSettings=false,review,reviewOff=false}={}) {
  const reasons=[];
  if(String(stage)!=='2')reasons.push('stage');
  if(halt!==false)reasons.push('halt');if(openA!==1)reasons.push('duplicate_or_missing_A');
  if(open!==true||labelled!==true||eligible!==true)reasons.push('pr_state');
  if(validation!==true)reasons.push('validation');
  if(claudeSettings!==true)reasons.push('claude_settings');
  if(!head||!base||head!==currentHead||base!==currentBase)reasons.push('snapshot_changed');
  if(reviewOff!==true&&review?.next!=='ready')reasons.push('review');
  return {allowed:!reasons.length,reasons,review_bypassed:reviewOff===true};
}
