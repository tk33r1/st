import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewState,findingTable,mayMerge,inspectionWindow} from './magi2-daily-review.mjs';
const now=new Date('2026-10-23T04:00:00Z'),head='head1',base='base1';
const route={configured:true,live_trial_passed:true,name:'synthetic-service',result_actor:'synthetic-reviewer',routine_actor:'synthetic-claude'};
const header='| finding_id | status | evidence |\n| --- | --- | --- |';
const table=rows=>header+rows.map(([id,status,evidence])=>'\n| '+id+' | '+status+' | '+evidence+' |').join('');
const request=(round=1,h=head)=>({id:'request'+round,round,head:h,base,run_id:'run'+round,actor:route.routine_actor,
  created_at:'2026-10-23T01:00:00Z',selection:{model:'gpt-6.1-sol',effort:'high',selected_at:'2026-10-23T00:59:00Z',source:route.name}});
const result=(req,findings=[],rows=[])=>({id:'result'+req.round,request_id:req.id,run_id:req.run_id,head:req.head,
  actor:route.result_actor,state:'completed',completed_at:'2026-10-23T01:30:00Z',record_id:'record'+req.round,findings,table:table(rows)});
const record=(req)=>({id:'record'+req.round,request_id:req.id,run_id:req.run_id,head:req.head,source:route.name,state:'completed',model:req.selection.model,effort:'high'});
const evidence=h=>({actor:route.routine_actor,head:h,model_alias:'opus',effort:'high',actual_model:null,created_at:'2026-10-23T02:00:00Z'});
function fixture(reqs=[request()],rs=[result(reqs[0])],extra={}) {
  return {head,base,route,now,requests:reqs,results:rs,records:reqs.map(record),claude:[evidence(head)],...extra};
}
test('未決は未決のまま、模擬のreadyや自己申告でレビュー完了にならない',()=>{
  assert.equal(reviewState(fixture(undefined,undefined,{route:null,next:'ready'})).next,'unconfigured');
  assert.equal(reviewState(fixture(undefined,undefined,{route:{...route,live_trial_passed:false}})).next,'unconfigured');
  assert.equal(reviewState(fixture(undefined,undefined,{records:[]})).next,'chatgpt');
  assert.equal(reviewState(fixture(undefined,undefined,{claude:[]})).next,'claude');
  assert.equal(reviewState(fixture()).next,'ready');assert.equal(reviewState(fixture()).independent_claude_model_proof,false);
});
test('次の選定は新しいSolを扱い、実行途中の新版で依頼済みの選定を失効させない',()=>{
  const q=request();q.selection.model='gpt-6.2-sol';
  const state=reviewState(fixture([q],[result(q)]));assert.equal(state.next,'ready');
  assert.equal(reviewState(fixture(undefined,undefined,{route:{...route,latest_model:'gpt-6.2-sol'}})).next,'ready');
  q.selection.model='gpt-6-astra';assert.equal(reviewState(fixture([q],[result(q)])).reason,'selection_unverified');
  const wrong=evidence(head);wrong.effort='medium';assert.equal(reviewState(fixture(undefined,undefined,{claude:[wrong]})).reason,'claude_settings_missing');
});
test('P1→修正→再レビューの表でだけ解消し、修正の自己申告では解除しない',()=>{
  const q1=request(),r1=result(q1,[{finding_id:'request1:F1',priority:1}],[['request1:F1','open','file.js:10']]);
  assert.equal(reviewState(fixture([q1],[r1])).next,'claude');
  const q2=request(2,'head2');
  assert.equal(reviewState(fixture([q1,q2],[r1],{head:'head2',claude:[evidence('head2')]})).next,'chatgpt');
  const r2=result(q2,[],[['request1:F1','fixed','head2 file.js:10 / regression passed']]);
  assert.equal(reviewState(fixture([q1,q2],[r1,r2],{head:'head2',claude:[evidence('head2')]})).next,'ready');
});
test('同じSHAの反論も1ラウンドで、withdrawnの根拠を必要とする',()=>{
  const q1=request(),q2=request(2),r1=result(q1,[{finding_id:'request1:F1',priority:0}],[['request1:F1','open','file.js']]);
  const r2=result(q2,[],[['request1:F1','withdrawn','同じheadのコードと反論を照合']]);
  const state=reviewState(fixture([q1,q2],[r1,r2]));assert.equal(state.next,'ready');assert.equal(state.rounds,2);
});
test('結果表の欠落・重複・不正status・空の根拠で以前のP1を失わない',()=>{
  const q1=request(),q2=request(2),r1=result(q1,[{finding_id:'request1:F1',priority:1}],[['request1:F1','open','file.js']]);
  for(const invalid of ['指摘なし',header,table([['request1:F1','done','proof']]),table([['request1:F1','fixed','']]),
    table([['request1:F1','fixed','one'],['request1:F1','withdrawn','two']])]) {
    const r2={...result(q2),table:invalid},state=reviewState(fixture([q1,q2],[r1,r2]));
    assert.equal(state.next,'claude');assert.deepEqual(state.unresolved,['request1:F1']);
  }
});
test('新しいP0/P1は一覧と表がそろいopenでなければ未解消のまま',()=>{
  const q=request(),r=result(q,[{finding_id:'request1:F1',priority:1}],[]);
  const state=reviewState(fixture([q],[r]));assert.equal(state.reason,'invalid_table');assert.deepEqual(state.unresolved,['request1:F1']);
  r.table=table([['request1:F1','fixed','最初からfixed']]);assert.equal(reviewState(fixture([q],[r])).next,'claude');
  assert.equal(findingTable(header).length,0);assert.equal(findingTable('finding_id,status,evidence'),null);
});
test('正式な投稿元・実行ID・head・モデルを照合し、転載や古いheadでは通さない',()=>{
  const q=request(),r=result(q);
  for(const bad of [{...r,actor:route.routine_actor},{...r,run_id:'other'},{...r,head:'old'}])assert.equal(reviewState(fixture([q],[bad])).next,'chatgpt');
  for(const patch of [{model:'gpt-6-sol'},{effort:'medium'}])assert.equal(reviewState(fixture([q],[r],{records:[{...record(q),...patch}]})).next,'unconfigured');
  assert.equal(reviewState(fixture([q],[r],{head:'new'})).next,'claude');
  const next=reviewState(fixture([q,q],[r]));assert.equal(next.rounds,1);assert.equal(next.next,'ready');
});
test('依頼から24時間で期限切れ、完了してClaudeを待つ時間には期限を掛けない',()=>{
  const q=request(),r=result(q),later=new Date('2026-10-25T04:00:00Z');
  assert.equal(reviewState(fixture([q],[],{now:later})).reason,'response_timeout');
  assert.equal(reviewState(fixture([q],[r],{now:later})).next,'ready');
  q.run_id=null;assert.equal(reviewState(fixture([q],[],{now:later,records:[]})).next,'human');
});

test('R2: 実行IDのない結果・正式記録では完了せず、未受理の期限とラウンドを保つ',()=>{
  for(const run_id of [null,undefined]) {
    const q={...request(),run_id},r=result(q),records=[record(q),{...record(q),state:'failed'}];
    const state=reviewState(fixture([q],[r],{records}));
    assert.equal(state.next,'chatgpt');assert.equal(state.rounds,0);
    assert.equal(reviewState(fixture([q],[r],{records,now:new Date('2026-10-25T04:00:00Z')})).reason,'response_timeout');
    assert.equal(reviewState(fixture([q,request(2)],[r])).reason,'overlapping_requests');
  }
  for(const run_id of ['',42,{},' ']) {
    const q={...request(),run_id},state=reviewState(fixture([q],[result(q)]));
    assert.equal(state.next,'unconfigured');assert.equal(state.reason,'invalid_execution');assert.equal(state.rounds,0);
  }
});
test('3ラウンド目での全件解消はready、未解決・形式不正・新head・4件目はhuman',()=>{
  const qs=[request(1),request(2),request(3)],rs=qs.map(q=>result(q));
  assert.equal(reviewState(fixture(qs,rs)).next,'ready');
  assert.equal(reviewState(fixture(qs,rs,{head:'new'})).next,'human');
  rs[2].table='指摘なし';assert.equal(reviewState(fixture(qs,rs)).next,'human');
  const q4=request(4);assert.equal(reviewState(fixture([...qs,q4],[...rs,result(q4)])).next,'human');
});
test('古い正式記録が無ければ後の空の結果で通さず、復旧後も使用済みラウンドを残す',()=>{
  const q1=request(),q2=request(2),r1=result(q1),r2=result(q2);
  assert.equal(reviewState(fixture([q1,q2],[r1,r2],{records:[record(q2)]})).reason,'unverified_prior_record');
  const wrong={...record(q1),effort:'medium'};
  const broken=reviewState(fixture([q1,q2],[r1,r2],{records:[wrong,record(q2)]}));
  assert.equal(broken.next,'unconfigured');assert.equal(broken.rounds,2);
  const failed={...record(q1),state:'failed'};
  const recovered=reviewState(fixture([q1,q2],[r1,r2],{records:[wrong,failed,record(q2)]}));
  assert.equal(recovered.next,'ready');assert.equal(recovered.rounds,2);
});
test('停止・段階1・検証失敗・head/base変更・重複Aのどれでもマージしない',()=>{
  const input={stage:2,halt:false,openA:1,validation:true,head,base,currentHead:head,currentBase:base,open:true,labelled:true,eligible:true,
    claudeSettings:true,review:{next:'ready'}};
  assert.equal(mayMerge(input).allowed,true);
  for(const patch of [{stage:1},{halt:true},{openA:2},{validation:false},{currentHead:'old'},{currentBase:'new'},{claudeSettings:false},
    {review:{next:'unconfigured'}},{open:false},{labelled:false},{eligible:false},{validation:'failure'},{halt:undefined}])assert.equal(mayMerge({...input,...patch}).allowed,false);
  assert.equal(mayMerge({...input,review:null,reviewOff:true}).review_bypassed,true);
  assert.equal(mayMerge({...input,stage:1,review:null,reviewOff:true}).allowed,false);
  assert.equal(mayMerge({...input,review:null,reviewOff:'false'}).allowed,false);
});
test('休止1日・連続2日を49/73時間に延長し、閉じたPRや途中失敗でも起点を残す',()=>{
  const pauses=[{id:'pause1',started_at:'2026-10-22T04:00:00Z'},{id:'pause2',started_at:'2026-10-21T04:00:00Z'}];
  assert.equal(inspectionWindow({now,pauses:pauses.slice(0,1)}).from,'2026-10-21T03:00:00.000Z');
  const oldest=inspectionWindow({now,pauses});assert.equal(oldest.from,'2026-10-20T03:00:00.000Z');
  const completion={pause_ids:pauses.map(p=>p.id),from:oldest.from,to:now.toISOString(),main:'checked',success:false};
  assert.equal(inspectionWindow({now,pauses,completions:[completion],verifyMain:()=>true}).from,oldest.from);
  completion.success=true;
  assert.equal(inspectionWindow({now,pauses,completions:[completion]}).from,oldest.from);
  assert.equal(inspectionWindow({now,pauses,completions:[completion],verifyMain:()=>true}).pause_ids.length,0);
});
