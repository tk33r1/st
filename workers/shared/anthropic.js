// Worker間で共有するMessages APIの受信。呼び出し側の期限で、ヘッダー・本文の両方を止める。
export async function postAnthropicJSON(key, body, signal) {
  if (!key) throw new Error('Anthropic API key is not configured');
  let reader, onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { reader?.cancel().catch(() => {}); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once:true});
  });
  const load = async () => {
    signal.throwIfAborted();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', signal, headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify(body),
    });
    if (signal.aborted) { res.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      const error = new Error('Anthropic HTTP '+res.status); error.status = res.status; throw error;
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8',{fatal:true}); let text='', bytes=0;
    try {
      for (;;) {
        const {done,value}=await reader.read(); signal.throwIfAborted(); if(done)break;
        bytes+=value.byteLength; if(bytes>262144)throw new Error('Anthropic response too large');
        text+=decoder.decode(value,{stream:true});
      }
      return JSON.parse(text+decoder.decode());
    } finally { reader.cancel().catch(() => {}); }
  };
  try { return await Promise.race([load(),aborted]); }
  finally { signal.removeEventListener('abort',onAbort); }
}

export function anthropicText(data, allowPartial = false) {
  if (!data || !(data.stop_reason==='end_turn' || allowPartial && data.stop_reason==='max_tokens')) throw new Error('Anthropic response did not complete');
  const text=(data.content || []).filter(b=>b.type==='text').map(b=>b.text || '').join('').trim();
  if (!text) throw new Error('Anthropic response is empty');
  return text;
}
