// 交互レビューの正式な経路（2026-10-27本人決定）: 本人の自宅PCが定時にcodex execを動かし、専用GitHub Appの名前で結果を投稿する。
// 投稿元の名前（App）だけを信頼の根拠にする。PR本文・状態コメント・Claudeが転載したJSON・環境変数のreadyは使わない。
// 依頼とClaudeのモデルの自己申告は点検の作成者、受理・選定・結果はAppのコメントから読む。時刻はGitHubの記録を使う。
export const reviewRouteName='codex-exec-home';
const marker=/^<!-- magi2-review:(request|claude|selection|accept|result) (\{.{2,8000}\}) -->\r?\n?/;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const id=value=>typeof value==='string'&&/^[\w:-]{1,200}$/.test(value);

// 先頭行の目印だけを読む。JSONが壊れていれば無かったものとして扱う（判定側で未受理・期限切れになる）。
export function parseReviewComment(comment) {
  const match=typeof comment?.body==='string'&&comment.body.match(marker);
  if(!match)return null;
  let data;try{data=JSON.parse(match[2]);}catch{return null;}
  if(!data||typeof data!=='object'||Array.isArray(data)||data.v!==1)return null;
  return {kind:match[1],data,actor:comment.user?.login,created_at:comment.created_at,
    edited:!!comment.updated_at&&comment.updated_at!==comment.created_at,body:comment.body,url:comment.html_url};
}

export function reviewEvidenceFromComments({comments=[],issueComments=[],app,trialPassed=false,routineActor='tk33r1'}={}) {
  const resultActor=app?app+'[bot]':null;
  const route=app?{configured:true,live_trial_passed:trialPassed===true,name:reviewRouteName,result_actor:resultActor,routine_actor:routineActor}:null;
  if(!route)return {route:null,requests:[],results:[],records:[],claude:[]};
  const parsed=comments.map(parseReviewComment).filter(Boolean);
  const from=(kind,actor)=>parsed.filter(row=>row.kind===kind&&row.actor===actor);
  // 選定は固定Issueに置き、依頼より前の最新のものだけを依頼に結び付ける（後から選び直して古い依頼を通さない）。
  const selections=issueComments.map(parseReviewComment).filter(row=>row&&row.kind==='selection'&&row.actor===resultActor
    &&row.data.source===reviewRouteName&&typeof row.data.model==='string'&&row.data.effort==='high')
    .sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  const accepts=from('accept',resultActor).filter(row=>id(row.data.request_id)&&id(row.data.run_id)&&sha(row.data.head));
  const requests=[];
  for(const row of from('request',routineActor)) {
    const d=row.data;
    // 受理後に書き換えられた依頼は数えない。判定側が不正な依頼として止める。
    if(row.edited||!id(d.id)||!sha(d.head)||!sha(d.base)||!Number.isInteger(d.round)){requests.push({id:'invalid',created_at:'invalid'});continue;}
    const selection=selections.filter(s=>Date.parse(s.created_at)<=Date.parse(row.created_at)).at(-1);
    const accept=accepts.find(a=>a.data.request_id===d.id&&a.data.head===d.head);
    requests.push({id:d.id,round:d.round,head:d.head,base:d.base,actor:row.actor,created_at:row.created_at,
      run_id:accept?.data.run_id??null,
      selection:selection?{model:selection.data.model,effort:selection.data.effort,source:selection.data.source,selected_at:selection.created_at}:null});
  }
  const results=[],records=[];
  for(const row of from('result',resultActor)) {
    const d=row.data,r=d.record||{};
    if(!id(d.request_id)||!id(d.run_id)||!sha(d.head)||!['completed','failed'].includes(d.state)||!id(r.id))continue;
    records.push({id:r.id,request_id:d.request_id,run_id:d.run_id,head:d.head,source:reviewRouteName,state:d.state,model:r.model,effort:r.effort});
    if(d.state==='completed')results.push({request_id:d.request_id,run_id:d.run_id,head:d.head,actor:row.actor,state:d.state,
      completed_at:row.created_at,record_id:r.id,findings:Array.isArray(d.findings)?d.findings:null,table:row.body});
  }
  const claude=from('claude',routineActor).filter(row=>!row.edited&&sha(row.data.head)).map(row=>({actor:row.actor,head:row.data.head,
    model_alias:row.data.model_alias,effort:row.data.effort,actual_model:row.data.actual_model??null,created_at:row.created_at}));
  return {route,requests,results,records,claude};
}

// Appの名前と実地試験の合格は、管理者だけが変えられるリポジトリ変数（workflowのvarsから渡す）で決める。
export async function readReviewEvidence({client,number,env=process.env}={}) {
  const app=env.MAGI2_DAILY_REVIEW_APP||'',issue=env.MAGI2_DAILY_ISSUE||'',actor=env.MAGI2_DAILY_ACTOR||'tk33r1';
  if(!/^[a-z0-9][a-z0-9-]{0,38}$/.test(app))return reviewEvidenceFromComments({});
  const comments=await client.pages('/issues/'+number+'/comments');
  const issueComments=/^[1-9]\d*$/.test(issue)?await client.pages('/issues/'+issue+'/comments'):[];
  return reviewEvidenceFromComments({comments,issueComments,app,routineActor:actor,trialPassed:env.MAGI2_DAILY_REVIEW_TRIAL==='passed'});
}
