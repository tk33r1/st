import { BIDI_CONTROL_CHARS, MAGI_MODE, PERSONAS } from './personas.js';

// 改行・タブは許し（後で空白にする）、それ以外の制御文字と双方向制御文字を拒む
const bidiOrControl = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f${BIDI_CONTROL_CHARS}]`);
export function cleanMotion(text) {
  if (typeof text !== 'string' || bidiOrControl.test(text)) return null;
  const clean = text.trim().replace(/[\r\n\t]+/g, ' ');
  return clean && clean.length <= MAGI_MODE.motion_max_chars ? clean : null;
}

const voteAtStart = new RegExp('^[\\s*`]*' + MAGI_MODE.vote_tag.source, MAGI_MODE.vote_tag.flags.replace('g', ''));
const voteDisplay = new RegExp('(?:\\*+|`+)?' + MAGI_MODE.vote_tag.source + '(?:\\*+|`+)?', MAGI_MODE.vote_tag.flags);
export function parseVote(raw) {
  const tags = [...raw.matchAll(new RegExp(MAGI_MODE.vote_tag.source, MAGI_MODE.vote_tag.flags))];
  const values = tags.map(m => m[1].trim().toUpperCase());
  const invalid = values.some(v => !['APPROVE', 'REJECT'].includes(v)) || new Set(values).size > 1;
  const first = raw.split(/\r?\n/).find(l => l.trim()) || '';
  const atStart = voteAtStart.test(first);
  const vote = !invalid && tags.length && atStart ? values[0].toLowerCase() : null;
  const text = raw.replace(voteDisplay, '').trim();
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
  return value && value.votable !== false ? `〔MAGI モードの採決。議題: ${value.motion}／決議: ${{ approve: '承認', reject: '否決', hold: '保留' }[value.result]}（賛成${value.tally.approve}・反対${value.tally.reject}・票なし${value.tally.none}）〕\n` : '';
}
