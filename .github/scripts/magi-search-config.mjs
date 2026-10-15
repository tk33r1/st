// 本番の設定（magi2 のサイト案内・討議の判定・言語の判定）をスモークテストへ渡す。スキーマをPython側へ複製しない。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {researchReader} from './magi-a2-research-stream.mjs';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')), URL, Response, AbortController, setTimeout, clearTimeout });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(strip(read('workers/magi2/languages.js')) + '\n' + strip(read('workers/magi2/personas.js'))
  + '\n' + strip(read('workers/magi2/classification.js'))
  + '\n' + strip(read('workers/magi2/site-search.js'))
  + '\nglobalThis.config = { model: SITE_SEARCH.model, temperature: SITE_SEARCH.temperature, top_p: DEFAULTS.top_p, chat_max_tokens: SITE_SEARCH.chat_max_tokens, formats: SITE_SEARCH.formats,'
  + ' judge: { model: DEFAULTS.models.judge, format: DEBATE.format },'
  + ' magi: { motion: { model: DEFAULTS.models.motion, format: MAGI_MODE.motion_format, prompt: MAGI_MODE.motion_prompt } },'
  + ' classify: INTENT_CLASSIFY, classify_smoke: ['
  + ' { input: { texts: ["Should I go for ramen tonight?"], seed: "日本語で話したいです。" }, expected: { language: "ja", votable: "yes", intent: "consult" } },'
  + ' { input: { texts: ["Which songs would you recommend for a DJ set?"], hasLanguage: true }, expected: { intent: "music" } },'
  + ' { input: { texts: ["Help me organize the factors to consider for a career change."], seed: "Please reply in English." }, expected: { language: "en", votable: "no", intent: "consult" } },'
  + ' { input: { texts: ["このサイトでPDFを結合するページを探して。"], hasLanguage: true }, expected: { votable: "no", intent: "site" } },'
  + ' { input: { texts: ["転職の判断材料を整理してほしい", "OK"], hasLanguage: true }, expected: { votable: "no", intent: "consult" } },'
  + ' { input: { profile: "dj-request", texts: ["OK"], seed: "Please help me choose music." }, expected: { language: "en" } },'
  + ' { input: { profile: "dj-request", texts: ["OK"], seed: "日本語で曲の相談をしたいです。" }, expected: { language: "ja" } },'
  + ' { input: { profile: "legacy", texts: ["DJを始めたい", "OK"] }, expected: { language: "ja" } },'
  + ' { input: { profile: "legacy", texts: ["I want to start DJing."] }, expected: { language: "en" } },'
  + ' { input: { factMode: true, texts: ["楽譜の4分の4拍子はどういう意味？"], seed: "日本語でお願いします。" }, expected: { language: "ja", intent: "research", fresh: "no" } },'
  + ' { input: { factMode: true, hasLanguage: true, texts: ["今日の東京の天気を確認して。"] }, expected: { intent: "research", fresh: "yes" } },'
  + ' { input: { factMode: true, hasLanguage: true, texts: ["作業用に聴く曲を3曲すすめて。"] }, expected: { intent: "music", fresh: "no" } }'
  + ' ].map(test => { const payload = classificationPayload(test.input); return { payload, expected: { ...(payload.questions.malice ? { malice: "none" } : {}), ...test.expected } }; }) };', ctx);
// 会社ごとのパラメーター名・推論時のsampling除外も本番の組立てを使う。
const worker = read('workers/magi2/src/index.js');
const start = worker.indexOf('function requestBody('), end = worker.indexOf('\nasync function callModel(', start);
if (start < 0 || end < 0) throw new Error('requestBody block not found');
vm.runInContext(worker.slice(start, end), ctx);
vm.runInContext(worker.slice(worker.indexOf('function researchMessages('),worker.indexOf('// pause_turnで送り返す')),ctx);
vm.runInContext(worker.slice(worker.indexOf('function researchSourceUrl('),worker.indexOf('async function verifyResearchAnswer(')),ctx);
vm.runInContext('function stageError(_kind, code) {return new Error(code);}',ctx);
vm.runInContext(worker.match(/^const withLangNote = .*$/m)[0], ctx);
// 議題化の答え直し（callAuxModel）は同じ中身を aux_fallback へ、上限は元の役割の値で送る。
vm.runInContext(`{
  const cfg = config.magi.motion;
  const messages = [
    {role: 'system', content: withLangNote(cfg.prompt, languageNote({code: 'en'}))},
    {role: 'user', content: JSON.stringify({latest: 'Should I go for ramen tonight?', has_image: false, reference: []})}
  ];
  cfg.body = requestBody(cfg.model, {stream: false, response_format: cfg.format, messages});
  const fallback = {...DEFAULTS.models.aux_fallback, max_tokens: cfg.model.max_tokens};
  config.magi.motion_fallback = {model: fallback, body: requestBody(fallback, {stream: false, response_format: cfg.format, messages})};
}`, ctx);
ctx.smokeIndex = JSON.parse(read('data/site-search.json'));
await vm.runInContext(`(async function () {
  const allPages = makeSitePages(smokeIndex);
  const page = allPages.find(p => p.url === '/tools/pdf-studio/');
  const portal = allPages.find(p => p.url === '/job/nitoridaily/');
  const retail = allPages.find(p => p.url === '/job/retailtechdaily/');
  if (!page || !portal || !retail) throw new Error('Site smoke candidate missing');
  const guide = siteGuide('/', [page]);
  const temperature = Math.max(DEFAULTS.temperature, ...Object.values(PERSONA_TEMPERATURE));
  const messages = [{role: 'user', content: 'PDFを結合するページを案内して。説明は短く。'}];
  config.discussion = {
    personas: PERSONAS.map(p => ({ codename: p.codename, provider: DEFAULTS.models.persona[p.codename].provider,
      body: requestBody(DEFAULTS.models.persona[p.codename], { stream: false, temperature,
        messages: [{role: 'system', content: p.system_prompt + '\\n' + (p.role?.chat || '') + '\\n' + guide.persona},
          ...messages, {role: 'user', content: '検証済みの候補: ' + JSON.stringify(page)}] }) })),
    // ライトとダークの統合は同じプロンプトで、呼び出し先だけが違う
    ...Object.fromEntries(['synthesizer', 'synthesizer_dark'].map(name => [name, { provider: DEFAULTS.models[name].provider,
      body: requestBody(DEFAULTS.models[name], { stream: true,
        messages: [{role: 'system', content: SYNTHESIZER.system_prompt + '\\n' + (SYNTHESIZER.role?.chat || '') + '\\n' + guide.synth},
          ...messages, {role: 'user', content: '討議: PDF Studioで結合できる。検証済みの候補: ' + JSON.stringify(page)}] }) }])),
    // 悪意への短い返し（replyToMalice）は、同じ統合のモデルを推論なしでストリーミングする
    malice_reply: ['synthesizer', 'synthesizer_dark'].map(name => ({ provider: DEFAULTS.models[name].provider,
      body: requestBody({ ...DEFAULTS.models[name], reasoning_effort: 'none' }, { stream: true,
        messages: [{role: 'system', content: withLangNote(MALICE_REPLY.system_prompt + '\\n\\n' + MALICE_REPLY.output_rules, languageNote({code: 'ja'}))},
          {role: 'user', content: MALICE_REPLY.directions.identity}] }) })),
  };
  config.site_smoke = [];
  for (const purpose of ['requested', 'auxiliary']) {
    let body;
    const pages = [page, portal, retail];
    const query = 'PDFを結合するページを探して';
    const expected = { selections: [page.id] };
    await selectSitePages({query, locale: 'ja', purpose, pages, log() {},
      async call(options) {
        body = requestBody(options.cfg, options);
        return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(expected)}}]});
      } });
    config.site_smoke.push({purpose, body, expected, pages: shortlistSitePages(pages, query)});
  }
  // 判断の品質と分け、選択が空と1件の両側は指定したJSONを返す疎通で確認する。
  config.site_schema_smoke = [[page.id], []].map(selections => {
    const expected = {selections};
    return {expected, body: {...config.site_smoke[0].body,
      messages: [{role: 'user', content: 'Return exactly this JSON: ' + JSON.stringify(expected)}]}};
  });
})()`, ctx);
vm.runInContext(`{
  const base=[{role:'system',content:SYNTHESIZER.system_prompt+'\\n'+SYNTHESIZER.voice_rules+'\\n'+FACT_ANSWER.prompt},
    {role:'user',content:'楽譜の4分の4拍子はどういう意味？'}];
  config.fact_smoke=['synthesizer','synthesizer_dark'].map(name=>{
    const cfg={...DEFAULTS.models[name],reasoning_effort:FACT_ANSWER.reasoning_effort};
    return {provider:cfg.provider,body:requestBody(cfg,{messages:base,stream:true})};
  });
  config.research_smoke=['synthesizer','synthesizer_dark'].map(name=>{
    const cfg={...DEFAULTS.models[name],reasoning_effort:RESEARCH.reasoning_effort};
    const messages=researchMessages([{role:'system',content:RESEARCH.system_prompt},
      {role:'user',content:'Web検索で、Python 3.0の公開日を公式の公開ページで確認して。短く出典付きで答えて。'}],new Date());
    return {provider:cfg.provider,endpoint:cfg.provider==='openai'?RESEARCH.openai_endpoint:PROVIDERS[cfg.provider].endpoint,
      body:researchRequestBody(cfg,messages)};
  });
  const evidence=[{n:1,title:'Synthetic source',url:'https://example.com/',allowed:true,readable:true,
    blocks:[{id:0,text:'The exhibition opened on July 11 and ended on October 12.'}],truncated:false}];
  config.verify_smoke=['synthesizer','synthesizer_dark'].map(name=>{
    const cfg={...DEFAULTS.models[name],reasoning_effort:RESEARCH.reasoning_effort,max_tokens:RESEARCH.verify.max_tokens};
    const messages=[{role:'system',content:RESEARCH.verify_prompt+'\\nEstablished reply language: en'},
      {role:'user',content:JSON.stringify({question:'Which exhibition is currently active on October 15?',
        draft:'No exhibition is active and the next one starts on October 31.',evidence})}];
    return {provider:cfg.provider,evidence,body:requestBody(cfg,{messages,stream:false,response_format:researchVerificationFormat(evidence)})};
  });
}`,ctx);
if (process.argv.includes('--validate-site-smoke')) {
  ctx.smokeValues = JSON.parse(readFileSync(0, 'utf8'));
  vm.runInContext(`
    if (!Array.isArray(smokeValues) || smokeValues.length !== config.site_smoke.length) throw new Error('Site smoke response count mismatch');
    smokeValues.forEach((value, i) => {
      const test = config.site_smoke[i], result = validateSiteChoice(value, test.pages, 'ja', true);
      if (result.results.length !== value.selections.length) throw new Error('Invalid site smoke response');
    });`, ctx);
  process.stdout.write('OK');
} else if(process.argv.includes('--validate-research-smoke')) {
  const provider=process.argv.at(-1),raw=readFileSync(0,'utf8');
  const reader=researchReader(provider);
  for(const frame of raw.replaceAll('\r','').split('\n\n')) {
    const data=frame.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
    if(data && data!=='[DONE]')reader.push(JSON.parse(data));
  }
  reader.finish();
  process.stdout.write('OK');
} else if(process.argv.includes('--validate-verifier-smoke')) {
  ctx.smokeProvider=process.argv.at(-1);ctx.smokeReply=JSON.parse(readFileSync(0,'utf8'));
  vm.runInContext(`{
    const sample=config.verify_smoke.find(v=>v.provider===smokeProvider);
    if(!sample)throw new Error('Unknown verifier provider');
    const data=smokeReply;
    const reason=smokeProvider==='anthropic'?data.stop_reason:data.choices?.[0]?.finish_reason;
    const text=smokeProvider==='anthropic'?data.content?.filter(b=>b.type==='text').map(b=>b.text).join(''):data.choices?.[0]?.message?.content;
    if(reason!==(smokeProvider==='anthropic'?'end_turn':'stop')||typeof text!=='string')throw new Error('Incomplete verifier smoke');
    const value=JSON.parse(text);verifiedResearchResult(value,sample.evidence);
    if(value.parts.length!==1||value.parts[0].status!=='unverified')throw new Error('Unsupported current status');
  }`,ctx);
  process.stdout.write('OK');
} else process.stdout.write(JSON.stringify(ctx.config));
