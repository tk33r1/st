// A6の公開後確認。呼び出し側が渡した通信・版取得だけを使い、生成成功経路へは送らない。
// このモジュールのimportや単体の実行では、本番へ通信しない。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {cleanVersionHistory,versionOrder,VERSION_HISTORY_LIMITS} from '../../workers/magi2/version-history.js';
import {catalogObservation} from './magi2-daily-observe.mjs';
import {limitedJSON} from './magi2-daily-http.mjs';

const legacyValid=vm.runInNewContext(readFileSync(new URL('./fixtures/magi-versions-apk59.js',import.meta.url),'utf8')+'\nvalidAgentVersions;');
const origin='https://tk.st',api='https://workers.tk.st';
export function publicationRequests() {
  const headers={Origin:origin,'Content-Type':'application/json'};
  const post=(name,url,body,status,code,custom={})=>({name,url,options:{method:'POST',headers:{...headers,...custom},body},status,code});
  return [
    {name:'versions',url:api+'/magi2/versions?format=2',options:{method:'GET',headers:{Origin:origin}},status:200},
    {name:'legacy_versions',url:api+'/magi2/versions',options:{method:'GET',headers:{Origin:origin}},status:200},
    post('origin_rejected',api+'/magi2/chat','{}',401,'unauthorized',{Origin:'https://example.invalid'}),
    post('json_rejected',api+'/magi2/chat','{',400,'invalid_json'),
    post('old_404_rejected',api+'/magi2/site-search',JSON.stringify({query:'PDF',locale:'ja'}),409,'site_search_update_required'),
    // DEFAULTSを変えるPRはAで扱わない。1,001文字は現在の公開契約の上限超。
    post('length_rejected',api+'/magi2/chat',JSON.stringify({messages:[{role:'user',content:'x'.repeat(1001)}]}),400,'text_too_long'),
    // siteのgenerationは公開索引のSHA-256。全0は仕込み用の不一致値。
    post('old_generation_rejected',origin+'/search/api/rank',JSON.stringify({mode:'rank',scope:'site',query:'PDF',locale:'ja',
      search_contract:1,generation:'0'.repeat(64)}),200,'index_updating'),
  ];
}

export async function verifyDailyPublication({fetcher,readDeployment,expected}={}) {
  if(typeof fetcher!=='function'||typeof readDeployment!=='function'||!expected||typeof expected.id!=='string'||!expected.id
    ||!/^[a-f0-9]{40}$/.test(expected.sha||'')||versionOrder(expected.version)===null)throw new Error('publication_inputs');
  const cases=[],version=async name=>{
    try {
      const current=await readDeployment();
      const ok=current?.id===expected.id&&current?.message===expected.sha;
      cases.push({name,ok});return ok;
    } catch{cases.push({name,ok:false});return false;}
  };
  if(!await version('deployment_before'))return {ok:false,cases};
  const catalog=await catalogObservation((url,options)=>fetcher(url,{...options,redirect:'error'}));
  cases.push({name:'catalog',ok:catalog.ok,status:catalog.status});
  for(const probe of publicationRequests()) {
    try {
      const response=await fetcher(probe.url,{...probe.options,redirect:'error',signal:AbortSignal.timeout(10000)});
      const data=await limitedJSON(response,VERSION_HISTORY_LIMITS.max_bytes);let ok=response.status===probe.status;
      if(probe.name==='versions')ok=ok&&!!cleanVersionHistory(data)&&data.versions.some(row=>row.version===expected.version);
      else if(probe.name==='legacy_versions')ok=ok&&!!legacyValid(data)&&data.versions.every(row=>row.version==='earlier'||/^\d{1,2}\.\d$/.test(row.version));
      else if(probe.name==='old_generation_rejected')ok=ok&&data.status==='failed'&&data.complete===false
        &&data.reason===probe.code&&Array.isArray(data.results)&&data.results.length===0;
      else ok=ok&&data.error?.code===probe.code;
      cases.push({name:probe.name,ok,status:response.status});
    } catch{cases.push({name:probe.name,ok:false,status:null});}
  }
  await version('deployment_after');
  return {ok:cases.every(row=>row.ok),cases,
    limitation:'生成モデルの回答品質・実チャット経路・実機は対象外。通信アダプターと本番版の取得の接続は別途必要。'};
}
