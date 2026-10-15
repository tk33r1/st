// 両社のWeb検索SSEを本文・出典・引用位置へ読む。通信・上限は呼出側が制御する。
const researchUrl = value => {
  if (typeof value !== 'string') return null;
  try {const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : null;} catch {return null;}
};

export const ResearchStreamError = class extends Error {
  constructor(code, beforeText, upstreamError = null) {
    super(code); this.name = 'ResearchStreamError'; this.code = code; this.beforeText = beforeText;
    this.upstreamError = upstreamError;
  }
}

export function researchReader(provider, onText, maxSources) {
  if (!Number.isInteger(maxSources) || maxSources < 1) throw new TypeError('invalid source limit');
  if (!['openai', 'anthropic'].includes(provider)) throw new TypeError('unknown provider');
  let text = '', success = false, ended = false, stop = null;
  const parts = new Map(), blocks = new Map(), documents = [], items = [], marks = [], sourceNumbers = new Map();
  const fail = (code, upstreamError) => {throw new ResearchStreamError(code, !text.length, upstreamError);};
  const source = citation => {
    const href = researchUrl(citation?.url);
    if (!href) return null;
    if (sourceNumbers.has(href)) return sourceNumbers.get(href);
    if (items.length === maxSources) return null;
    const n = items.length + 1;
    sourceNumbers.set(href, n);
    items.push({n, title: typeof citation.title === 'string' && citation.title.trim() ? citation.title : href, url: href});
    return n;
  };
  const mark = (citation, at) => {
    if (!Number.isInteger(at) || at < 0 || at > text.length) return;
    const n = source(citation);
    if (n && !marks.some(m => m.n === n && m.at === at)) marks.push({at, n});
  };
  const append = delta => {if (success && delta) {text += delta; onText(delta);}};
  const part = e => {
    const key = `${e.output_index}:${e.content_index}`;
    if (!parts.has(key)) parts.set(key, {rawLength: 0, spans: []});
    return parts.get(key);
  };
  const annotation = (p, citation) => {
    if (citation?.type !== 'url_citation' || !Number.isInteger(citation.start_index) || !Number.isInteger(citation.end_index)
      || citation.start_index < 0 || citation.end_index < citation.start_index || citation.end_index > p.rawLength) return;
    const s = p.spans.find(s => citation.end_index > s.rawStart && citation.end_index <= s.rawEnd);
    if (s) mark(citation, s.sentStart + citation.end_index - s.rawStart);
  };
  const documentSource = citation => {
    if (!['char_location', 'page_location', 'content_block_location'].includes(citation?.type)
      || !Number.isInteger(citation.document_index)) return null;
    const doc = documents[citation.document_index];
    if (!doc) return null;
    const [start, end, min] = citation.type === 'char_location' ? [citation.start_char_index, citation.end_char_index, 0]
      : citation.type === 'page_location' ? [citation.start_page_number, citation.end_page_number, 1]
      : [citation.start_block_index, citation.end_block_index, 0];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end <= start
      || (citation.type === 'char_location' && (!doc.chars || end > doc.chars))) return null;
    return doc;
  };
  return {
    get paused() { return ended && stop === 'pause_turn'; },
    beginTurn() { blocks.clear(); ended = false; stop = null; },
    push(e) {
      if (!e || typeof e !== 'object') fail('invalid_stream');
      if (e.type === 'error' || e.error || ['response.failed', 'response.incomplete'].includes(e.type)) {
        // 本文・推論・ユーザーの入力を通知へ持ち出さず、課金障害の判定に必要な種類だけ保持する。
        const error = e.error || e.response?.error || e;
        const detail = Object.fromEntries(['code','type'].filter(k => typeof error[k] === 'string').map(k => [k,error[k].slice(0,100)]));
        fail('stream_error', detail);
      }
      if (provider === 'openai') {
        if (e.type === 'response.output_item.done' && e.item?.type === 'web_search_call'
          && e.item.status === 'completed' && e.item.action?.sources?.some(s => researchUrl(s.url))) success = true;
        if (e.type === 'response.output_text.delta') {
          const p = part(e), delta = typeof e.delta === 'string' ? e.delta : '';
          if (success && delta) p.spans.push({rawStart: p.rawLength, rawEnd: p.rawLength + delta.length, sentStart: text.length});
          p.rawLength += delta.length;
          append(delta);
        }
        if (e.type === 'response.output_text.annotation.added') annotation(part(e), e.annotation);
        if (e.type === 'response.completed') {
          ended = true; stop = e.response?.status;
          // 引用が差分のイベントに無い場合だけでも、終端のannotationsを同じ位置へ写せる。
          for (const [output_index, item] of (e.response?.output || []).entries()) if (item.type === 'message') {
            for (const [content_index, content] of (item.content || []).entries()) {
              const p = parts.get(`${output_index}:${content_index}`);
              if (p) for (const c of content.annotations || []) annotation(p, c);
            }
          }
        }
      } else {
        if (e.type === 'content_block_start') {
          const b = e.content_block;
          if (!b || blocks.has(e.index)) fail('invalid_block');
          blocks.set(e.index, {type: b.type, citations: b.citations || [], sent: false});
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)
            && b.content.some(c => c.type === 'web_search_result' && researchUrl(c.url))) success = true;
          if (b.type === 'web_fetch_tool_result' && b.content?.type === 'web_fetch_result'
            && b.content.content?.type === 'document') {
            const result = b.content, doc = result.content, href = researchUrl(result.url);
            const valid = href && ['text', 'base64'].includes(doc.source?.type)
              && typeof doc.source.data === 'string' && doc.source.data.length > 0;
            // 不正URLのdocumentも番号を占める。後続の引用を別ページへずらさない。
            documents.push(valid ? {url: href, title: doc.title, chars: doc.source.type === 'text' ? doc.source.data.length : null} : null);
            if (valid) success = true;
          }
          if (b.type === 'text' && typeof b.text === 'string' && b.text && success) {
            blocks.get(e.index).sent = true; append(b.text);
          }
        }
        if (e.type === 'content_block_delta') {
          const b = blocks.get(e.index);
          if (!b) fail('invalid_block');
          if (e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
            if (success && e.delta.text) b.sent = true;
            append(e.delta.text);
          }
          if (e.delta?.type === 'citations_delta' && e.delta.citation) b.citations.push(e.delta.citation);
        }
        if (e.type === 'content_block_stop') {
          const b = blocks.get(e.index);
          if (b?.type === 'text' && b.sent) for (const c of b.citations) {
            if (c.type === 'web_search_result_location') mark(c, text.length);
            else { const doc = documentSource(c); if (doc) mark(doc, text.length); }
          }
        }
        if (e.type === 'message_delta') stop = e.delta?.stop_reason;
        if (e.type === 'message_stop') ended = true;
      }
    },
    finish() {
      if (!success) fail('no_url_search_result');
      if (!ended || stop !== (provider === 'openai' ? 'completed' : 'end_turn')) fail(stop === 'pause_turn' ? 'pause_turn' : 'incomplete');
      if (!text.trim()) fail('empty_answer');
      if (!marks.length) fail('no_citations');
      return {text, sources: {items, marks: marks.sort((a, b) => a.at - b.at || a.n - b.n)}};
    },
  };
}
