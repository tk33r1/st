// 応答のバイト数を制限し、途中で失敗してもストリームを解放する。
export async function limitedJSON(response,maxBytes) {
  if(!response.body)throw new Error('response_missing');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let text='',bytes=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;if(bytes>maxBytes)throw new Error('response_too_large');
      text+=decoder.decode(value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
