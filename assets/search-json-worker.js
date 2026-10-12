/* 大きな公開検索JSONのhashと解析。DOM・通信・日本語辞書を持たない。Blob Workerでだけ起動する。 */
'use strict';
onmessage=async event=>{
  try {
    // 整形前のバイト列を照合する。大きなdigestのコピーも主スレッドへ置かない。
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',event.data)),v=>v.toString(16).padStart(2,'0')).join('');
    postMessage({type:'hash',value:hash});
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(event.data));
    const arrays=[],header=Object.create(null),rootArray=Array.isArray(data);
    if(rootArray) arrays.push(['',data]);
    else if(data && typeof data==='object') {
      for(const [key,value] of Object.entries(data)) {
        if(Array.isArray(value)) arrays.push([key,value]);else header[key]=value;
      }
    } else {postMessage({type:'value',value:data});return;}
    postMessage({type:'start',rootArray,header,keys:arrays.map(([key])=>key)});
    for(const [key,values] of arrays) {
      let batch=[],size=0;
      const flush=()=>{if(batch.length)postMessage({type:'rows',key,rows:batch});batch=[];size=0;};
      for(let index=0;index<values.length;index++) {
        const value=values[index];
        // 全記事に対応する1語のpostingsも小分けにする。1行だけ大きいと受信側のcloneが主スレッドを止める。
        if(value && !Array.isArray(value) && Array.isArray(value.postings) && value.postings.length>512) {
          flush();postMessage({type:'rows',key,rows:[{...value,postings:[]}]});
          for(let offset=0;offset<value.postings.length;offset+=512)
            postMessage({type:'postings',key,index,offset,rows:value.postings.slice(offset,offset+512)});
          continue;
        }
        const length=JSON.stringify(value).length;
        if(batch.length && (size+length>16384 || batch.length>=64)) flush();
        batch.push(value);size+=length;
      }
      flush();
    }
    postMessage({type:'done'});
  } catch(_) {postMessage({type:'error'});}
};
