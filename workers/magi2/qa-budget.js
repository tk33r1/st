// 本人承認の合成入力だけに付ける一時的な本番確認用ガード。未設定・通常入力では何もしない。
// 実行前に手元の共通台帳へ会社別の枠を予約し、その内側をD1の原子的な加算で守る。
const encoder = new TextEncoder();
const qaError = reason => new Error('qa_budget_' + reason);
const rates = { openai: [.125, .50], anthropic: [.125, .50], deepseek: [.30, 1.20], typesafe: [.042, 0] };

function imageDimensions(url) {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url || '');
  if (!match || match[2].length > 40000) throw qaError('image');
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (match[1] === 'png' && bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i++] !== 255) break;
      const marker = bytes[i++];
      if (marker === 255) { i--; continue; }
      if ([0xd8, 0xd9].includes(marker)) continue;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) return [view.getUint16(i + 5), view.getUint16(i + 3)];
      i += length;
    }
  }
  throw qaError('image_dimensions');
}

export function qaRequestCost(provider, body, plan, sample) {
  if (!rates[provider] || body.model !== plan.models[provider] || body.tools) throw qaError('unplanned_upstream');
  let images = 0;
  const text = JSON.stringify(body, (_key, value) => {
    if (value?.type === 'image_url') { images++; return { type: 'image_url', image_url: { url: '[image]' } }; }
    if (value?.type === 'image' && value.source?.type === 'base64') { images++; return { type: 'image', source: { type: 'base64', data: '[image]' } }; }
    return value;
  });
  const bytes = encoder.encode(text).byteLength;
  const input = bytes * 2 + 2048 + images * 32768;
  const output = provider === 'typesafe' ? 0 : body.max_tokens || body.max_completion_tokens || body.max_output_tokens;
  if (bytes > 40000 || images > sample.images || input >= 100000 || provider === 'typesafe' && input > 64000
    || !Number.isInteger(output) || output < 0 || output > 8192 || provider !== 'typesafe' && !output) throw qaError('request_size');
  return { micro: Math.ceil((input * rates[provider][0] + output * rates[provider][1]) * 1.1), input, output, images };
}

export async function qaBudgetEnv(env, { kind, text, images = [], historyMessages }) {
  if (!env.MAGI_QA_PLAN || !text.includes('MAGI-QA-')) return env;
  let plan;
  try { plan = JSON.parse(env.MAGI_QA_PLAN); } catch { throw qaError('invalid_plan'); }
  const sample = plan.cases?.find(c => c.kind === kind && c.text === text);
  if (!sample) throw qaError('unplanned_case');
  const expires = Date.parse(plan.expires_at);
  if (plan.version !== 1 || !/^[a-z0-9-]{12,80}$/.test(plan.id) || !/^\d{4}-\d{2}-\d{2}$/.test(plan.day)
    || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 86400000
    || !/^[a-z0-9-]{1,40}$/.test(sample.id) || !env.DB || images.length !== sample.images
    || historyMessages !== sample.history_messages || ![0, 1].includes(sample.images)
    || !Object.keys(rates).every(p => typeof plan.models?.[p] === 'string' && Number.isSafeInteger(sample.caps_micro?.[p])
      && sample.caps_micro[p] >= 0 && sample.caps_micro[p] <= 1000000)) throw qaError('invalid_plan');
  for (const url of images) {
    const [w, h] = imageDimensions(url);
    if (w < 1 || h < 1 || w > 512 || h > 512) throw qaError('image_dimensions');
  }
  const key = 'qa:' + plan.id + ':' + sample.id;
  const claim = await env.DB.prepare('INSERT INTO rate_limit (ip,day,count) VALUES (?1,?2,0) ON CONFLICT(ip,day) DO NOTHING RETURNING count')
    .bind(key + ':claim', plan.day).first();
  if (!claim) throw qaError('already_claimed');
  return Object.assign(Object.create(env), { qaReserve: async (provider, body) => {
    try {
      const cost = qaRequestCost(provider, body, plan, sample), cap = sample.caps_micro[provider];
      if (cost.micro > cap) throw qaError('ceiling');
      const row = await env.DB.prepare('INSERT INTO rate_limit (ip,day,count) VALUES (?1,?2,?3) ON CONFLICT(ip,day) DO UPDATE SET count=count+excluded.count WHERE count+excluded.count<=?4 RETURNING count')
        .bind(key + ':' + provider, plan.day, cost.micro, cap).first();
      if (!row) throw qaError('ceiling');
    } catch (error) {
      // 部分回答で終わっても予算拒否を見落とさない。本文・画像・実IPは保存しない。
      await env.DB.prepare('INSERT INTO rate_limit (ip,day,count) VALUES (?1,?2,1) ON CONFLICT(ip,day) DO UPDATE SET count=count+1 RETURNING count')
        .bind(key + ':blocked', plan.day).first();
      throw error;
    }
  } });
}
