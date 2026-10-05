// 本番の設定（magi2 のサイト案内・討議の判定・言語の判定）をスモークテストへ渡す。スキーマをPython側へ複製しない。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')), URL, Response, AbortController, setTimeout, clearTimeout });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(strip(read('workers/magi2/languages.js')) + '\n' + strip(read('workers/magi2/personas.js'))
  + '\n' + strip(read('workers/magi2/classification.js'))
  + '\n' + strip(read('workers/magi2/site-search.js'))
  + '\nglobalThis.config = { model: SITE_SEARCH.model, temperature: SITE_SEARCH.temperature, top_p: DEFAULTS.top_p, chat_max_tokens: SITE_SEARCH.chat_max_tokens, formats: SITE_SEARCH.formats,'
  + ' judge: { model: DEFAULTS.models.judge, format: DEBATE.format },'
  + ' magi: { motion: { model: DEFAULTS.models.motion, format: MAGI_MODE.motion_format, prompt: MAGI_MODE.motion_prompt },'
  + ' vote_reader: { model: DEFAULTS.models.vote_reader, format: MAGI_MODE.vote_reader_format, prompt: MAGI_MODE.vote_reader_prompt } },'
  + ' classify: INTENT_CLASSIFY, classify_smoke: ['
  + ' { input: { texts: ["Should I go for ramen tonight?"], seed: "日本語で話したいです。" }, expected: { language: "ja", votable: "yes", intent: "consult" } },'
  + ' { input: { texts: ["Which songs would you recommend for a DJ set?"], hasLanguage: true }, expected: { intent: "music" } },'
  + ' { input: { texts: ["Help me organize the factors to consider for a career change."], seed: "Please reply in English." }, expected: { language: "en", votable: "no", intent: "consult" } },'
  + ' { input: { texts: ["このサイトでPDFを結合するページを探して。"], hasLanguage: true }, expected: { votable: "no", intent: "site" } },'
  + ' { input: { texts: ["転職の判断材料を整理してほしい", "OK"], hasLanguage: true }, expected: { votable: "no", intent: "consult" } },'
  + ' { input: { profile: "dj-request", texts: ["OK"], seed: "Please help me choose music." }, expected: { language: "en" } },'
  + ' { input: { profile: "dj-request", texts: ["OK"], seed: "日本語で曲の相談をしたいです。" }, expected: { language: "ja" } },'
  + ' { input: { profile: "legacy", texts: ["DJを始めたい", "OK"] }, expected: { language: "ja" } },'
  + ' { input: { profile: "legacy", texts: ["I want to start DJing."] }, expected: { language: "en" } }'
  + ' ].map(test => ({ payload: classificationPayload(test.input), expected: test.expected })) };', ctx);
// 会社ごとのパラメーター名・推論時のsampling除外も本番の組立てを使う。
const worker = read('workers/magi2/src/index.js');
const start = worker.indexOf('function requestBody('), end = worker.indexOf('\nasync function callModel(', start);
if (start < 0 || end < 0) throw new Error('requestBody block not found');
vm.runInContext(worker.slice(start, end), ctx);
vm.runInContext(worker.match(/^const withLangNote = .*$/m)[0], ctx);
vm.runInContext(`for (const [name, data] of [
  ['motion', {latest: 'Should I go for ramen tonight?', has_image: false, reference: []}],
  ['vote_reader', {motion: 'Go for ramen tonight', responses: [{codename: 'CASPER-3', text: 'I explicitly reject this proposal because the cost is too high.'}]}]
]) {
  const cfg = config.magi[name];
  cfg.body = requestBody(cfg.model, {stream: false, response_format: cfg.format, messages: [
    {role: 'system', content: name === 'motion' ? withLangNote(cfg.prompt, languageNote({code: 'en'})) : cfg.prompt},
    {role: 'user', content: JSON.stringify(data)}
  ]});
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
    synthesizer: { provider: DEFAULTS.models.synthesizer.provider,
      body: requestBody(DEFAULTS.models.synthesizer, { stream: true,
        messages: [{role: 'system', content: SYNTHESIZER.system_prompt + '\\n' + (SYNTHESIZER.role?.chat || '') + '\\n' + guide.synth},
          ...messages, {role: 'user', content: '討議: PDF Studioで結合できる。検証済みの候補: ' + JSON.stringify(page)}] }) },
  };
  config.site_smoke = [];
  for (const purpose of ['requested', 'auxiliary']) for (const daily of [null, {media: 'nitori', query: '出店'}]) {
    let body;
    const pages = [page, portal, retail];
    const query = daily ? 'ニトリの出店ニュースを探して' : 'PDFを結合するページを探して';
    const expected = { selections: daily ? [] : [page.id], daily };
    await selectSitePages({query, locale: 'ja', purpose, pages, log() {},
      async call(options) {
        body = requestBody(options.cfg, options);
        return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(expected)}}]});
      } });
    config.site_smoke.push({purpose, body, expected, pages: shortlistSitePages(pages, query)});
  }
  // 判断の品質と分け、nullableの両側は指定したJSONを返す疎通で確認する。
  config.site_schema_smoke = [null, {media: 'nitori', query: '出店'}].map(daily => {
    const expected = {selections: [page.id], daily};
    return {expected, body: {...config.site_smoke[0].body,
      messages: [{role: 'user', content: 'Return exactly this JSON: ' + JSON.stringify(expected)}]}};
  });
})()`, ctx);
if (process.argv.includes('--validate-site-smoke')) {
  ctx.smokeValues = JSON.parse(readFileSync(0, 'utf8'));
  vm.runInContext(`
    if (!Array.isArray(smokeValues) || smokeValues.length !== config.site_smoke.length) throw new Error('Site smoke response count mismatch');
    smokeValues.forEach((value, i) => {
      const test = config.site_smoke[i], result = validateSiteChoice(value, test.pages, 'ja', true);
      if (result.results.length !== value.selections.length || (value.daily !== null && !result.daily)) throw new Error('Invalid site smoke response');
    });`, ctx);
  process.stdout.write('OK');
} else process.stdout.write(JSON.stringify(ctx.config));
