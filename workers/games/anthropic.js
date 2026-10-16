import aiModels from '../../config/ai-models.json';
import {postAnthropicJSON,anthropicText} from '../shared/anthropic.js';

export function gameAnthropicBody(system, messages, maxTokens) {
  const input=messages.map(m=>({role:m.role,content:m.content}));
  // Haikuは末尾assistantの続きを直接生成しない。旧入口の続行要求をuserの指示に変える。
  if (input.at(-1)?.role==='assistant') input.push({role:'user',content:'Continue the preceding assistant response.'});
  return {model:aiModels.anthropic.haiku.id,max_tokens:Math.max(1,Math.min(Math.floor(Number(maxTokens)||200),800)),
    thinking:{type:'disabled'},...(system ? {system} : {}),messages:input,stream:false};
}

export async function callGameAnthropic(env, {system,messages,maxTokens}) {
  if (!env.GAME_ANTHROPIC_API_KEY) return {ok:false,status:503,error:'unavailable'};
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000);
  try {
    const data=await postAnthropicJSON(env.GAME_ANTHROPIC_API_KEY,gameAnthropicBody(system,messages,maxTokens),ac.signal);
    return {ok:true,status:200,text:anthropicText(data,true)};
  } catch (error) { return {ok:false,status:error.status||502,error:'upstream'}; }
  finally { clearTimeout(timer); }
}
