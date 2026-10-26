import test from 'node:test';
import assert from 'node:assert/strict';
import {newScorecard,stage1Report} from './magi2-daily-stage1.mjs';
const now=new Date('2026-11-06T00:00:00+09:00');
const candidate=(id,patch={})=>({id,pr:'https://github.com/tk33r1/st/pull/15',head:'a'.repeat(40),
  detected_at:'2026-10-23T04:00:00+09:00',classification:'A',grade:'correct',version_ok:true,actions:'success',
  scored_by:'tk33r1',scored_at:'2026-10-23T09:00:00+09:00',...patch});
const ledger=rows=>({schema_version:1,start_date_jst:'2026-10-23',candidates:rows});
test('採点の準備だけでは日付を開始せず、候補0件を合格や移行承認にしない',()=>{
  const empty=stage1Report(newScorecard(),now);
  assert.equal(empty.start_date_jst,null);assert.equal(empty.scoring_pass,false);assert.equal(empty.stage2_authorized,false);
  assert.ok(empty.reasons.includes('not_started'));assert.ok(stage1Report(ledger([]),now).reasons.includes('no_candidates'));
});
test('14日の期間はJSTの開始日00:00から数え、直前は合格にしない',()=>{
  const rows=ledger([candidate('one')]);
  assert.equal(stage1Report(rows,new Date(+now-1)).scoring_pass,false);
  assert.equal(stage1Report(rows,now).scoring_pass,true);
  assert.equal(stage1Report(rows,now).stage2_authorized,false);
});
test('誤検出1/3ちょうどは通り、超過・AからBの直し・版の直しは落ちる',()=>{
  const rows=[candidate('one',{grade:'false_positive'}),candidate('two'),candidate('three')];
  assert.equal(stage1Report(ledger(rows),now).scoring_pass,true);
  assert.ok(stage1Report(ledger(rows.slice(0,2)),now).reasons.includes('false_positive_rate'));
  assert.ok(stage1Report(ledger([candidate('one',{grade:'wrong_category'})]),now).reasons.includes('A_should_be_B'));
  assert.ok(stage1Report(ledger([candidate('one',{version_ok:false})]),now).reasons.includes('version_corrections'));
});
test('未採点・未検証を残し、Actions失敗の理由を集計する',()=>{
  const pending=candidate('one',{grade:null,version_ok:null,actions:'not_run'});
  assert.equal(stage1Report(ledger([pending]),now).pending,1);
  assert.equal(stage1Report(ledger([pending]),now).scoring_pass,false);
  const failure=candidate('one',{actions:'failure',actions_reason:'browser check failed'});
  assert.equal(stage1Report(ledger([failure]),now).actions_failures[0].reason,'browser check failed');
  assert.throws(()=>stage1Report(ledger([candidate('one',{actions:'failure'})]),now),/scorecard_candidate/);
});
test('重複・期間外・未来の採点・不正な日付と対象PRを拒否する',()=>{
  for(const patch of [{detected_at:'2026-11-06T00:00:00+09:00'},{detected_at:'2026-10-22T23:59:59+09:00'},
    {scored_at:'2026-11-07T00:00:00Z'},{pr:'https://github.com/other/repo/pull/15'},{head:'HEAD'}])
    assert.throws(()=>stage1Report(ledger([candidate('one',patch)]),now));
  assert.throws(()=>stage1Report(ledger([candidate('one'),candidate('one')]),now));
  assert.throws(()=>stage1Report({...ledger([]),start_date_jst:'2026-02-30'},now));
});
