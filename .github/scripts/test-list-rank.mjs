// 新scopeの評価器。固定公開候補・合成Jevだけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWorker} from './eval-site-rank.mjs';
import {loadListFixtures,listCandidates,listScores,listReport} from './eval-list-rank.mjs';
import {measureAccuracy} from './eval-daily-rank.mjs';

test('全80問を検査し、category/genreを候補選択より先に適用する',async()=>{
  const magi=loadWorker(),{data,locals}=await loadListFixtures(magi);
  assert.equal(data.queries.length,80);
  for(const q of data.queries) {
    const c=listCandidates(magi,locals[q.scope],q);
    assert.ok(c.ids.length<=20);assert.ok(c.ids.every(id=>id.startsWith(q.scope==='tools'?'tool:':'game:')));
    for(const id of q.answers) assert.ok(c.ids.includes(id),q.id+': '+id);
    assert.equal(Object.keys(c.payload.questions).length,c.ids.length);
    for(const record of Object.values(c.payload.state.candidates)) {
      for(const [key,value] of Object.entries(q.filters)) assert.equal(record[key],value);
      assert.ok(!('url' in record) && !('id' in record));
    }
  }
});

test('実Workerで2回再生し、欠けたnoul・正解なしへの誤表示を精度の失敗にする',async()=>{
  const magi=loadWorker(),{data,locals}=await loadListFixtures(magi),scope='game';
  const qs=data.queries.filter(q=>q.scope===scope && q.set==='final'),threshold=magi.rankScopeConfig(scope).threshold;
  let calls=0;
  const measurements=await measureAccuracy(magi,locals[scope],qs,{runs:2,thresholds:[threshold],key:'fixture-only',candidateProvider:listCandidates,
    liveFetch:async(_url,options)=>{
      const payload=JSON.parse(options.body),q=qs[calls++%qs.length],c=listCandidates(magi,locals[scope],q);
      return new Response(JSON.stringify({model:'synthetic',usage:{input_tokens:1},answers:Object.fromEntries(c.ids.map((id,i)=>[magi.rankId(i),{type:'noul',noul:q.answers.includes(id)?.99:.01}]))}));
    }});
  assert.equal(calls,40);assert.ok(measurements.every(m=>listScores(qs,m.rows,threshold).pass));
  const record={scope,set:'final',queries:qs,measurements,thresholds:[threshold]};
  assert.deepEqual(listReport(record).drift[0].queries,[]);
  const none=qs.find(q=>!q.answers.length),row=measurements[1].rows.find(r=>r.id===none.id);
  row.by_threshold[threshold].ids=['game:1'];row.probs['game:1']=null;
  const score=listScores(qs,measurements[1].rows,threshold);assert.equal(score.shown,1);assert.equal(score.missing,1);assert.equal(score.pass,false);
  assert.deepEqual(listReport(record).drift[0].queries,[none.id]);
});
