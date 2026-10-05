import { BIDI_CONTROL_CHARS, MAGI_MODE, PERSONAS } from './personas.js';

// \u6539\u884c\u30fb\u30bf\u30d6\u306f\u8a31\u3057\uff08\u5f8c\u3067\u7a7a\u767d\u306b\u3059\u308b\uff09\u3001\u305d\u308c\u4ee5\u5916\u306e\u5236\u5fa1\u6587\u5b57\u3068\u53cc\u65b9\u5411\u5236\u5fa1\u6587\u5b57\u3092\u62d2\u3080
const bidiOrControl = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f${BIDI_CONTROL_CHARS}]`);
export function cleanMotion(text) {
  if (typeof text !== 'string' || bidiOrControl.test(text)) return null;
  const clean = text.trim().replace(/[\r\n\t]+/g, ' ');
  return clean && clean.length <= MAGI_MODE.motion_max_chars ? clean : null;
}

export function parseVote(raw) {
  const tags = [...raw.matchAll(new RegExp(MAGI_MODE.vote_tag.source, MAGI_MODE.vote_tag.flags))];
  const values = tags.map(m => m[1].trim().toUpperCase());
  const invalid = values.some(v => !['APPROVE', 'REJECT'].includes(v)) || new Set(values).size > 1;
  const first = raw.split(/\r?\n/).find(l => l.trim()) || '';
  const atStart = /^[\s*`]*\[VOTE:[^\]\r\n]*\]/i.test(first);
  const vote = !invalid && tags.length && atStart ? values[0].toLowerCase() : null;
  const text = raw.replace(/(?:\*+|`+)?\[VOTE:[^\]\r\n]*\](?:\*+|`+)?/gi, '').trim();
  return { text, vote, vote_state: vote || invalid ? 'final' : 'pending', raw };
}

const tallyResult = t => t.approve >= MAGI_MODE.quorum ? 'approve' : t.reject >= MAGI_MODE.quorum ? 'reject' : 'hold';

export function magiTally(records, rounds) {
  const votes = {}, tally = { approve: 0, reject: 0, none: 0 };
  for (const p of PERSONAS) {
    const views = records[p.codename] || [];
    const last = views.at(-1);
    const valid = views.findLast(v => v.vote === 'approve' || v.vote === 'reject');
    const vote = valid?.vote || null;
    const state = last?.vote ? 'voted' : valid ? 'carried' : views.some(v => !v.absent) ? 'unreadable' : 'absent';
    votes[p.codename] = { vote, round: valid?.round || null, state,
      ...(state === 'carried' ? { issue: last.absent ? 'no_response' : 'unreadable' } : {}) };
    tally[vote || 'none']++;
  }
  return { result: tallyResult(tally), tally, rounds, votes };
}

export function cleanMagiHistory(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.votable === false) {
    const reason = value.reason === undefined ? 'not_votable' : value.reason;
    return value.motion === '' && ['not_votable', 'failed'].includes(reason) ? { motion: '', votable: false, reason } : null;
  }
  const motion = cleanMotion(value.motion), t = value.tally;
  if (!motion || !t || !['approve', 'reject', 'hold'].includes(value.result)
    || !['approve', 'reject', 'none'].every(k => Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 3)
    || t.approve + t.reject + t.none !== 3
    || value.result !== tallyResult(t)) return null;
  return { motion, result: value.result, tally: { approve: t.approve, reject: t.reject, none: t.none } };
}

export function magiHistoryNote(value) {
  return value && value.votable !== false ? `〔MAGI モードの採決。議題: ${value.motion}／決議: ${value.result}（賛成${value.tally.approve}・反対${value.tally.reject}・票なし${value.tally.none}）〕\n` : '';
}
