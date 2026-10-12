/** Phase 4の固定ソースadapter。生バイト列・ID順・年別manifestを共通UIへ渡す。 */
(function(w){
  'use strict';
  const newest=(a,b)=>b.numericId-a.numericId;
  const listSorts=[{value:'relevance',label:'関連順'},{value:'title',label:'タイトル順',compare:(a,b)=>a.title.localeCompare(b.title,'ja')},
    {value:'newest',label:'新しい順',compare:newest},{value:'oldest',label:'古い順',compare:(a,b)=>a.numericId-b.numericId}];
  const daily={fields:[{name:'title',mask:1},{name:'tags',mask:2},{name:'summary',mask:4},{name:'takeaway',mask:4},{name:'source',mask:8},{name:'category',mask:2}],
    legacy:{legacyFields:['title','summary','takeaway','source','category','tags'],legacyRemoveWhitespace:true},
    sorts:[{value:'relevance',label:'関連順',compare:(a,b)=>(a.date===b.date?0:a.date<b.date?1:-1)||a.article-b.article}]};
  const specs={site:{base:'/data/site-keyword.json',readings:'/data/site-readings.json',
      fields:['title','tags','description','detail'].map((key,i)=>({name:'search_'+key,mask:1<<i})),legacy:{},sorts:[],
      displayFields:{en:{title:'title_en',description:'description_en'}}},
    tools:{base:'/data/tools.json',readings:'/data/tools-readings.json',kind:'tool',filter:'category',compare:newest,sorts:listSorts,
      fields:[{name:'title',mask:1},{name:'tags',mask:2},{name:'description',mask:4},{name:'shortDescription',mask:4},{name:'category',mask:8}],
      legacy:{legacyFields:['title','description','category','tags']}},
    game:{base:'/data/game.json',readings:'/data/game-readings.json',kind:'game',filter:'genre',compare:newest,sorts:listSorts,
      fields:[{name:'title',mask:1},{name:'description',mask:4},{name:'genre',mask:2},{name:'ai',mask:8}],
      legacy:{legacyFields:['title','description','genre','ai']}},
    nitori:{media:'nitoridaily',...daily},retail:{media:'retailtechdaily',...daily}};
  const hex=/^[a-f0-9]{64}$/,dailyHex=/^[a-f0-9]{1,32}$/;
  const fail=code=>{throw new Error(code);};
  const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const string=value=>typeof value==='string' && (value.length<=32768 || Array.from(value).length<=32768)?value:fail('search_base');
  const object=value=>value && typeof value==='object' && !Array.isArray(value);
  let parserSource=null;
  function nativeJSON(bytes) {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  async function parseJSON(bytes,signal) {
    if(bytes.length<256*1024 || typeof Worker!=='function') return {data:nativeJSON(bytes),sourceHash:await sha(bytes)};
    let retained=bytes;
    try {
      // コードだけを一度取得する。解析するデータは同じサイトの固定検索JSON。
      if(!parserSource) parserSource=(async()=>{
        const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),8000);
        try {
          const r=await fetch('/assets/search-json-worker.js?v=20261012_5',{signal:ac.signal,credentials:'omit',referrerPolicy:'no-referrer'});
          if(!r.ok) fail('search_parser');return await r.text();
        } finally {clearTimeout(timer);}
      })();
      const source=await parserSource;if(signal.aborted) fail('search_cancelled');
      return await new Promise((resolve,reject)=>{
        // 同一サイトのURLから直接起動せず、ページのCSPを受け継ぐBlobを使う。
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));let worker,finished=false,result=null,keys=null,sourceHash=null;
        const finish=(error,value)=>{
          if(finished) return;finished=true;signal.removeEventListener('abort',stop);worker?.terminate();URL.revokeObjectURL(url);
          if(error) reject(error);else resolve(value);
        };
        const stop=()=>finish(new Error('search_cancelled'));
        try {
          worker=new Worker(url);
          worker.onerror=event=>{event.preventDefault?.();finish(new Error('search_parser'));};
          worker.onmessage=event=>{
            const m=event.data;
            if(m?.type==='hash' && !sourceHash && hex.test(m.value || '')) {sourceHash=m.value;return;}
            if(m?.type==='value' && sourceHash) {finish(null,{data:m.value,sourceHash});return;}
            if(m?.type==='start' && !keys) {
              keys=new Set(m.keys);result=m.rootArray?[]:Object.assign(Object.create(null),m.header);
              if(!m.rootArray) for(const key of keys) result[key]=[];
            } else if(m?.type==='rows' && keys?.has(m.key) && Array.isArray(m.rows)) {
              const rows=Array.isArray(result)?result:result[m.key];rows.push(...m.rows);
            } else if(m?.type==='postings' && keys?.has(m.key) && Number.isSafeInteger(m.index) && Number.isSafeInteger(m.offset)
              && Array.isArray(m.rows) && m.rows.length>0 && m.rows.length<=512) {
              const rows=Array.isArray(result)?result:result[m.key],target=rows[m.index]?.postings;
              if(m.index!==rows.length-1 || !Array.isArray(target) || target.length!==m.offset) {finish(new Error('search_parser'));return;}
              target.push(...m.rows);
            } else if(m?.type==='done' && keys && sourceHash) finish(null,{data:result,sourceHash});
            else finish(new Error('search_parser'));
          };
          signal.addEventListener('abort',stop,{once:true});
          if(signal.aborted) stop();else {
            // 失敗時用の同じバイト列を保ち、解析側への受け渡しはコピーせず移譲する。
            retained=bytes.slice();worker.postMessage(bytes.buffer,[bytes.buffer]);
          }
        } catch(_) {finish(new Error('search_parser'));}
      });
    } catch(error) {
      if(signal.aborted) throw error;
      // Worker非対応・コード取得失敗でも元の文字検索を使える。再取得はしない。
      return {data:nativeJSON(retained),sourceHash:await sha(retained)};
    }
  }
  function href(value,scope) {
    if(typeof value!=='string' || !/^(?:https:\/\/tk\.st)?\/(?!\/)/.test(value) || /[\\\u0000- \u007f?#]/.test(value)) fail('search_base');
    const path=value.replace(/^https:\/\/tk\.st/,'');let url,decoded;
    try {url=new URL(path,'https://tk.st');decoded=decodeURIComponent(path);}catch(_){fail('search_base');}
    if(url.origin!=='https://tk.st' || url.pathname!==path || /[\\\u0000- \u007f?#]/.test(decoded) || decoded.split('/').some(p=>p==='.'||p==='..')
      || (['tools','game'].includes(scope) && !path.startsWith('/'+scope+'/'))) fail('search_base');
    return path;
  }
  async function json(path,{cache='default',signal}={},maxBytes=12*1024*1024) {
    const ac=new AbortController(),stop=()=>ac.abort(),timer=setTimeout(stop,8000);
    if(signal?.aborted) stop();else signal?.addEventListener('abort',stop,{once:true});
    let reader;
    try {
      const response=await fetch(path,{signal:ac.signal,cache,credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok || !response.body) fail('search_fetch');
      reader=response.body.getReader();const chunks=[];let size=0;
      for(;;){const {value,done}=await reader.read();if(ac.signal.aborted) fail('search_fetch');if(done) break;size+=value.byteLength;if(size>maxBytes) fail('search_size');chunks.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const {data,sourceHash}=await parseJSON(bytes,ac.signal);
      if(ac.signal.aborted) fail('search_fetch');return {data,sourceHash,bytes:size};
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
  }
  function unique(records) {
    if(records.length>10000 || new Set(records.map(r=>r.id)).size!==records.length || new Set(records.map(r=>r.href)).size!==records.length) fail('search_base');
    return records;
  }
  async function mapRecords(records,convert,signal) {
    if(records.length>10000) fail('search_base');const result=[];
    for(let i=0;i<records.length;i++) {
      if(signal?.aborted) fail('search_cancelled');result.push(convert(records[i]));
      if((i & 31)===31) await (w.STJapaneseSearch?.yieldControl?.() || new Promise(resolve=>setTimeout(resolve,0)));
    }
    return unique(result);
  }
  async function listRecords(scope,rows,signal) {
    if(!Array.isArray(rows)) fail('search_base');const spec=specs[scope];
    return mapRecords(rows,r=>{
      if(!object(r) || !((typeof r.id==='string' && r.id) || Number.isSafeInteger(r.id)) || !string(r.title).trim()) fail('search_base');
      const row={...r,id:spec.kind+':'+r.id,numericId:Number(r.id),kind:spec.kind,href:href(r.url,scope),title:r.title,description:string(r.description || '')};
      if(scope==='tools') {
        if(!Array.isArray(r.tags) || r.tags.some(t=>typeof t!=='string')) fail('search_base');
        row.tags=r.tags.map(string);const category=string(r.category || '');row.category=category.slice(0,1).toUpperCase()+category.slice(1);
        row.shortDescription=string(r.shortDescription || '');
      } else {row.genre=string(r.genre || '');row.ai=string(r.ai || '');}
      return row;
    },signal);
  }
  async function siteRecords(index,signal) {
    if(index?.version!==1 || !hex.test(index.rank_generation || '') || !Array.isArray(index.pages)) fail('search_base');
    return mapRecords(index.pages,p=>{
      if(!object(p) || !['tool','game','page','article'].includes(p.kind) || typeof p.id!=='string' || !p.id.startsWith(p.kind+':')
        || !string(p.title).trim() || !object(p.search_fields)) fail('search_base');
      const row={id:p.id,kind:p.kind,href:href(p.url,'site'),title:p.title,title_en:string(p.title_en || ''),
        description:string(p.description),description_en:string(p.description_en || '')};
      for(const key of ['title','tags','description','detail']) {
        if(!Array.isArray(p.search_fields[key])) fail('search_base');row['search_'+key]=p.search_fields[key].map(string);
      }
      return row;
    },signal);
  }
  async function dailyRecords(media,year,index,generation,signal) {
    if(!object(index) || index.media!==media || index.generation!==generation || !Array.isArray(index.records)) fail('reading_version');
    return mapRecords(index.records,r=>{
      const match=/^([1-9]\d{7})\/#art-([1-9]\d*)$/.exec(r?.url || '');
      if(!match || match[1]!==r.date || r.date.slice(0,4)!==year || !Number.isSafeInteger(Number(match[2])) || !string(r.title).trim()
        || !Array.isArray(r.tags) || !['JP','GLOBAL'].includes(r.region)) fail('search_base');
      const iso=r.date.slice(0,4)+'-'+r.date.slice(4,6)+'-'+r.date.slice(6),date=new Date(iso+'T00:00:00Z');
      if(isNaN(date.getTime()) || date.toISOString().slice(0,10)!==iso) fail('search_base');
      return {...r,id:`${media}:${r.date}:${match[2]}`,article:Number(match[2]),kind:'daily',href:`/job/${media}/${r.url}`,title:r.title,tags:r.tags.map(string),
        summary:string(r.summary),takeaway:string(r.takeaway || ''),source:string(r.source || ''),category:string(r.category),description:string(r.summary)};
    },signal);
  }
  async function parallel(items,run) {
    const out=Array(items.length);let next=0;
    await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{for(;;){const i=next++;if(i>=items.length) return;out[i]=await run(items[i],i);}}));
    return out;
  }
  function createAdapter(scope,options={}) {
    if(!Object.hasOwn(specs,scope)) fail('search_scope');const spec=specs[scope];let pending=null;
    const names={category:'カテゴリー',genre:'ジャンル',region:'地域',month:'月'};
    const keys=spec.media?['category','region','month']:spec.filter?[spec.filter]:[];
    const adapter={...options,scope,fields:spec.fields,href:r=>r.href,compare:options.compare || spec.compare,
      displayFields:spec.displayFields,legacy:spec.legacy,
      filters:keys.map(key=>({key,label:names[key],options:[{value:'',label:'すべて'}]})),
      sorts:options.sorts || spec.sorts,
      async loadBase(request) {
        if(request.cache==='no-cache') pending=null;
        if(pending) return pending;
        pending=(async()=>{
          if(!spec.media) {
            const result=await json(spec.base,request,2*1024*1024),records=await (scope==='site'?siteRecords(result.data,request.signal):listRecords(scope,result.data,request.signal));
            return {records,sourceHash:result.sourceHash,generation:scope==='site'?result.data.rank_generation:result.sourceHash,
              filterOptions:spec.filter?{[spec.filter]:[...new Set(records.map(r=>r[spec.filter]))].filter(Boolean).sort()}: {}};
          }
          const root=`/job/${spec.media}/`,head=await json(root+'search-index.json',request,8*1024*1024),years=head.data.years;
          if(!Array.isArray(years) || years.length>100 || years.some((year,i)=>typeof year!=='string' || !/^[1-9]\d{3}$/.test(year) || (i && years[i-1]<=year))
            || head.data.media!==spec.media || !dailyHex.test(head.data.generation || '') || !Array.isArray(head.data.records) || (!years.length && head.data.records.length)) fail('search_base');
          let total=head.bytes;
          const loaded=await parallel(years,async(year,i)=>{
            const source=i===0?'search-index.json':`search-index-${year}.json`,part=i===0?head:await json(root+source,request,8*1024*1024);
            if(i) total+=part.bytes;if(total>8*1024*1024) fail('search_size');
            const records=await dailyRecords(spec.media,year,part.data,head.data.generation,request.signal);
            return {year,source,sourceHash:part.sourceHash,records,recordIds:records.map(r=>r.id)};
          });
          const records=unique(loaded.flatMap(p=>p.records));
          const filterOptions=Object.fromEntries(keys.map(key=>[key,[...new Set(records.map(r=>key==='month'?r.date.slice(0,6):r[key]))].filter(Boolean).sort().reverse()]));
          return {records,sourceHash:head.sourceHash,generation:head.data.generation,parts:loaded.length?loaded:[{sourceHash:head.sourceHash,recordIds:[]}],years,filterOptions};
        })();
        pending.catch(()=>{pending=null;});return pending;
      },
      async loadReadings(base,request) {
        if(!spec.media) return (await json(spec.readings,request,2*1024*1024)).data;
        const root=`/job/${spec.media}/`,manifest=(await json(root+'search-readings.json',request,1024*1024)).data;
        if(manifest?.version!==1 || manifest.normalization_revision!==1 || manifest.media!==spec.media || !hex.test(manifest.generation || '') || !Array.isArray(manifest.files)) fail('reading_contract');
        if(manifest.source_generation!==base.generation || JSON.stringify(manifest.files.map(f=>f.year))!==JSON.stringify(base.years)) fail('reading_version');
        if(!base.years.length) return [{sourceHash:base.sourceHash,recordIds:[],payload:{version:1,normalization_revision:1,source_sha256:base.sourceHash,
          generation:manifest.generation,record_ids:[],terms:[],analyzer:{package:'empty',dictionary:'empty',dictionary_sha256:manifest.generation,aliases_sha256:manifest.generation}}}];
        return parallel(manifest.files,async(file,i)=>{
          const part=base.parts[i];
          if(file.source!==part.source || file.readings!==`search-readings-${part.year}.json` || !hex.test(file.source_sha256 || '') || !hex.test(file.readings_sha256 || '')
            || !Number.isSafeInteger(file.records) || file.records<0) fail('reading_contract');
          if(file.source_sha256!==part.sourceHash || file.records!==part.recordIds.length) fail('reading_version');
          const loaded=await json(root+file.readings,request,12*1024*1024);
          if(loaded.sourceHash!==file.readings_sha256) fail('reading_version');
          return {payload:loaded.data,sourceHash:part.sourceHash,recordIds:part.recordIds};
        });
      }};
    return adapter;
  }
  w.STSearchData={createAdapter};
})(window);
