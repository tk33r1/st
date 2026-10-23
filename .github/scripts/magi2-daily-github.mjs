// GitHubへの操作はmain側のジョブだけから呼ぶ。PR本文・結果表をコマンドとして扱わない。
import {createHash} from 'node:crypto';
export const dailyRepository='tk33r1/st';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export function githubClient(token,{fetcher=fetch,repository=dailyRepository}={}) {
  if(repository!==dailyRepository)throw new Error('unexpected_repository');
  if(!token)throw new Error('github_token_missing');
  const request=async(path,{method='GET',body}={})=>{
    if(!path.startsWith('/')||path.includes('://'))throw new Error('github_path');
    const response=await fetcher('https://api.github.com/repos/'+repository+path,{method,
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('github_'+response.status+'_'+method+'_'+path.split('?')[0]);
    return response.status===204?null:response.json();
  };
  const pages=async (path,{stop}={})=>{
    const values=[];
    for(let page=1;page<=100;page++) {
      const rows=await request(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);
      if(!Array.isArray(rows))throw new Error('github_page_shape');
      for(const row of rows){if(stop?.(row))return values;values.push(row);}
      if(rows.length<100)return values;
    }
    throw new Error('github_pagination_limit');
  };
  return {request,pages};
}
export function eligibleDailyPR(pr,{actor='tk33r1',label='magi2-daily-A'}={}) {
  const labelled=name=>pr.labels?.some(row=>row.name===name);
  return pr.base?.repo?.full_name===dailyRepository&&pr.base.ref==='main'&&pr.head?.repo?.full_name===dailyRepository
    &&pr.user?.login===actor&&(label==='magi2-daily-B'||/^automation\/magi2-daily-\d{8}$/.test(pr.head.ref))
    &&labelled(label)&&(label!=='magi2-daily-A'||!labelled('magi2-daily-B'));
}
export function dailyIssueNumber(value) {
  if(!/^[1-9]\d*$/.test(String(value||'')))throw new Error('MAGI2_DAILY_ISSUE is required');
  return Number(value);
}
export async function commentOnce(client,issue,key,text) {
  const marker='<!-- magi2-daily:event:'+digest(key)+' -->';
  const comments=await client.pages('/issues/'+issue+'/comments');
  if(comments.some(c=>c.user?.login==='github-actions[bot]'&&c.body?.includes(marker)))return false;
  await client.request('/issues/'+issue+'/comments',{method:'POST',body:{body:marker+'\n'+text}});return true;
}
export async function stateComment(client,number,value) {
  const marker='<!-- magi2-daily:state -->',body=marker+'\n```json\n'+JSON.stringify(value,null,2)+'\n```';
  const comments=await client.pages('/issues/'+number+'/comments');
  const previous=comments.find(c=>c.user?.login==='github-actions[bot]'&&c.body?.startsWith(marker));
  if(previous?.body===body)return false;
  await client.request(previous?'/issues/comments/'+previous.id:'/issues/'+number+'/comments',
    {method:previous?'PATCH':'POST',body:{body}});return true;
}
export async function notifyDaily(text,key,{env=process.env,fetcher=fetch}={}) {
  if(!env.RESEND_API_KEY||!env.ALERT_TO||!env.ALERT_FROM)throw new Error('daily_mail_not_configured');
  const response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,
    'Content-Type':'application/json','Idempotency-Key':'magi2-daily-'+digest(key)},
    body:JSON.stringify({from:env.ALERT_FROM,to:[env.ALERT_TO],subject:'MAGI 継続改善の確認',text}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('daily_mail_'+response.status);
}
