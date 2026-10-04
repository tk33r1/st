import { INTENT_CLASSIFY, REPLY_LANGUAGE } from './personas.js';

// 本番・実装前確認で同じ材料と問いを組み立てる。
export function classifySlice(text, limit) {
  const out = String(text || '').slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

export function classificationPayload({ profile = 'chat', texts = [], seed, hasLanguage = false }) {
  const cfg = INTENT_CLASSIFY;
  const latest = texts.at(-1) || '';
  let state, names;
  if (profile === 'legacy') {
    const p = cfg.profiles.legacy;
    const recent = texts.filter(t => t.trim()).slice(-p.messages).map(t => classifySlice(t, p.message_max_chars));
    if (!recent.length) return null;
    state = { earlier_messages: recent.slice(0, -1), latest_message: recent.at(-1) };
    names = p.questions;
  } else {
    const languageSeed = classifySlice(seed ?? texts.find(t => t.trim()) ?? '', cfg.language_seed_max_chars);
    if (profile === 'dj-request') {
      state = { language_seed: languageSeed };
      names = !hasLanguage && languageSeed.trim() ? cfg.profiles[profile].questions : [];
    } else {
      state = {
        latest_message: classifySlice(latest, cfg.latest_max_chars),
        earlier_messages: texts.slice(0, -1).filter(t => t.trim()).slice(-cfg.earlier_messages).map(t => classifySlice(t, cfg.earlier_max_chars)),
        ...(!hasLanguage && languageSeed.trim() ? { language_seed: languageSeed } : {}),
      };
      names = cfg.profiles.chat.questions.filter(name => name === 'language'
        ? !hasLanguage && !!languageSeed.trim() : !!latest.trim());
    }
  }
  if (!names.length) return null;
  return { model: cfg.model.model, state, questions: Object.fromEntries(names.map(name => [name, cfg.questions[name]])) };
}

const languageControl = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export function cleanReplyLanguage(value) {
  if (!value || value.version !== 1 || typeof value.code !== 'string' || !Object.hasOwn(INTENT_CLASSIFY.languages, value.code)) return null;
  if (value.code === 'other') {
    if (value.source !== 'sample' || typeof value.sample !== 'string' || !value.sample.trim()
      || value.sample.length > REPLY_LANGUAGE.sample_chars || languageControl.test(value.sample) || /[<>]/.test(value.sample)) return null;
    return { version: 1, code: 'other', source: 'sample', sample: value.sample };
  }
  if (!['jev', 'rule', 'ui'].includes(value.source) || value.sample !== undefined
    || (value.source === 'ui' && !['ja', 'en'].includes(value.code))) return null;
  return { version: 1, code: value.code, source: value.source };
}

export function fixedLanguage(seed, ui = 'ja') {
  const text = String(seed || '').trim();
  const letters = [...text].filter(ch => /\p{L}/u.test(ch) && !/[\p{Script=Common}\p{Script=Inherited}]/u.test(ch));
  if (letters.some(ch => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch))
    && letters.every(ch => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch))) return { version: 1, code: 'ja', source: 'rule' };
  if ((text.match(/[A-Za-z]+/g) || []).length >= 3 || letters.filter(ch => ch.codePointAt(0) > 127).length >= 2) {
    const sample = classifySlice(text.replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, ''), REPLY_LANGUAGE.sample_chars);
    const state = cleanReplyLanguage({ version: 1, code: 'other', source: 'sample', sample });
    if (state) return state;
  }
  return { version: 1, code: ui === 'en' ? 'en' : 'ja', source: 'ui' };
}

export function languageNote(value) {
  return value.code === 'ja' ? REPLY_LANGUAGE.ja : value.code === 'other'
    ? REPLY_LANGUAGE.note(value.sample) : REPLY_LANGUAGE.named(INTENT_CLASSIFY.languages[value.code].name);
}

export function acceptedChoice(name, answer) {
  return answer && typeof answer.choice === 'string' && Object.hasOwn(INTENT_CLASSIFY.questions[name].criteria, answer.choice)
    && typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    && answer.confidence >= INTENT_CLASSIFY.min_confidence[name] && answer.confidence <= 1 ? answer.choice : null;
}

export async function classifyQuery(env, input, signal, log) {
  const { profile, texts, seed, replyLanguage, uiLanguage, fallback } = input;
  const payload = classificationPayload({ profile, texts, seed, hasLanguage: !!replyLanguage });
  let answers = {};
  const started = Date.now();
  if (payload && env[INTENT_CLASSIFY.key] && !signal.aborted) {
    try {
      const res = await fetch(INTENT_CLASSIFY.endpoint, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env[INTENT_CLASSIFY.key] },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (env.onUpstreamError) await env.onUpstreamError('typesafe', res.clone());
        await res.body?.cancel();
        log('classify', profile, 'HTTP', res.status);
      } else answers = (await res.json()).answers || {};
    } catch (err) { log('classify', profile, 'failed', err.name); }
  }
  const choices = {};
  for (const name of Object.keys(payload?.questions || {})) {
    choices[name] = acceptedChoice(name, answers[name]);
    log('classify', profile, name, choices[name] || 'fallback',
      typeof answers[name]?.confidence === 'number' && Number.isFinite(answers[name].confidence) ? answers[name].confidence : null,
      Date.now() - started);
  }
  if (profile === 'legacy') {
    const code = choices.language;
    return { langNote: code && code !== 'other' ? languageNote({ code }) : fallback };
  }
  const code = choices.language;
  const language = replyLanguage || (code && code !== 'other' ? { version: 1, code, source: 'jev' } : fixedLanguage(seed, uiLanguage));
  const dj = profile === 'dj-request';
  const noText = !(texts.at(-1) || '').trim();
  return {
    langNote: languageNote(language),
    classification: { version: 1, intent: dj ? 'music' : noText ? 'consult' : choices.intent || 'consult',
      site_pages: dj ? 'no' : choices.site_pages || 'uncertain', votable: dj || noText ? 'no' : choices.votable || 'uncertain',
      magi_candidate: false, reply_language: language },
  };
}
