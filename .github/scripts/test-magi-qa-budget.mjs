import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {qaBudgetEnv,qaRequestCost} from '../../workers/magi2/qa-budget.js';
const models={openai:'test-openai',anthropic:'test-anthropic',deepseek:'test-deepseek',typesafe:'test-typesafe'};
const body={model:models.openai,messages:[{role:'user',content:'synthetic'}],max_completion_tokens:100};
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE rate_limit(ip TEXT,day TEXT,count INTEGER,PRIMARY KEY(ip,day))');
  const plan={version:1,id:'qa-test-20261017',day:'2026-10-17',expires_at:new Date(Date.now()+3600000).toISOString(),models,
    cases:[{id:'normal',kind:'chat',text:'MAGI-QA-test synthetic',images:0,history_messages:0,caps_micro:{openai:1000,anthropic:1000,deepseek:1000,typesafe:1000}}]};
  const env={MAGI_QA_PLAN:JSON.stringify(plan),DB:{prepare(sql){return {bind(...args){return {async first(){return db.prepare(sql).get(...args)||null;}};}};}}};
  const request={kind:'chat',text:plan.cases[0].text,images:[],historyMessages:0};
  return {db,plan,env,request,close:()=>db.close(),update(){env.MAGI_QA_PLAN=JSON.stringify(plan);}};
}
test('未設定・普通の発言はenvをそのまま返し、DBへ触れない',async()=>{
  const env={};assert.equal(await qaBudgetEnv(env,{text:'ordinary'}),env);
  env.MAGI_QA_PLAN='invalid';assert.equal(await qaBudgetEnv(env,{text:'ordinary'}),env);
});
test('評価入力の誤記・期限切れ・予期しない履歴は送信前に拒否する',async()=>{
  const f=fixture();try{
    await assert.rejects(qaBudgetEnv(f.env,{...f.request,text:'MAGI-QA-wrong'}),/unplanned_case/);
    await assert.rejects(qaBudgetEnv(f.env,{...f.request,historyMessages:1}),/invalid_plan/);
    f.plan.expires_at=new Date(Date.now()-1).toISOString();f.update();await assert.rejects(qaBudgetEnv(f.env,f.request),/invalid_plan/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rate_limit').get().n,0);
  }finally{f.close();}
});
test('同じ合成ケースを並行して2回送れない',async()=>{
  const f=fixture();try{const r=await Promise.allSettled([qaBudgetEnv(f.env,f.request),qaBudgetEnv(f.env,f.request)]);
    assert.equal(r.filter(r=>r.status==='fulfilled').length,1);assert.equal(r.filter(r=>r.status==='rejected').length,1);
  }finally{f.close();}
});
test('会社別の事前加算は並行呼出しでも上限を超えず、拒否を記録する',async()=>{
  const f=fixture();try{
    const cost=qaRequestCost('openai',body,f.plan,f.plan.cases[0]);f.plan.cases[0].caps_micro.openai=cost.micro*2;f.update();
    const env=await qaBudgetEnv(f.env,f.request);const r=await Promise.allSettled(Array.from({length:3},()=>env.qaReserve('openai',body)));
    assert.equal(r.filter(x=>x.status==='fulfilled').length,2);assert.equal(r.filter(x=>x.status==='rejected').length,1);
    assert.equal(f.db.prepare("SELECT count FROM rate_limit WHERE ip LIKE '%:openai'").get().count,cost.micro*2);
    assert.equal(f.db.prepare("SELECT count FROM rate_limit WHERE ip LIKE '%:blocked'").get().count,1);
  }finally{f.close();}
});
test('検索・モデル変更・未計画画像・過大本文を課金前に拒否する',()=>{
  const f=fixture();try{const c=f.plan.cases[0];
    for(const b of [{...body,tools:[{}]},{...body,model:'other'},{...body,messages:[{role:'user',content:'x'.repeat(40000)}]},
      {...body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]}]}])
      assert.throws(()=>qaRequestCost('openai',b,f.plan,c),/qa_budget_/);
  }finally{f.close();}
});
test('画像は512px以下のPNG/JPEGだけで、画像分のtoken枠も足す',async()=>{
  const f=fixture();try{
    const b=new Uint8Array(24),v=new DataView(b.buffer);v.setUint32(0,0x89504e47);v.setUint32(4,0x0d0a1a0a);v.setUint32(16,320);v.setUint32(20,240);
    const image='data:image/png;base64,'+Buffer.from(b).toString('base64');f.plan.cases[0].images=1;f.update();
    await qaBudgetEnv(f.env,{...f.request,images:[image]});
    const sample=f.plan.cases[0],cost=qaRequestCost('openai',{...body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:image}}]}]},f.plan,sample);
    assert.equal(cost.images,1);assert(cost.input>=32768);
    v.setUint32(16,513);await assert.rejects(qaBudgetEnv(f.env,{...f.request,images:['data:image/png;base64,'+Buffer.from(b).toString('base64')]}),/image_dimensions/);
  }finally{f.close();}
});
