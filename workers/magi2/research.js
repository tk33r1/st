// Web検索のストリーム解析、公開出典の本文・アイコン取得、照合の入出力の組立て。AI呼び出しと照合の制御は入口側で行う。
import { RESEARCH, SOURCE_ICON } from './personas.js';
import { classifySlice, exactKeys } from './classification.js';
import { searchDeadline, searchFailure } from './site-search.js';

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

// 出典は公開ホストのみ。リダイレクトも各段で検査し、認証・Cookie・APIキーを付けずに読む。
export function researchSourceUrl(value) {
  try {
    const u = new URL(value), host = u.hostname.toLowerCase().replace(/\.+$/, '');
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      && (!u.port || ['80', '443'].includes(u.port)) && host.includes('.')
      && !host.includes(':') && !/^\d+(?:\.\d+){3}$/.test(host)
      && !/(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host) ? u.href : null;
  } catch { return null; }
}

// 相対URLの解決と公開URLの検査。回数上限と拒否後の扱いは取得側で決める。
function researchSourceTarget(value, base) {
  return value && URL.canParse(value, base) ? researchSourceUrl(new URL(value, base).href) : null;
}

// HTML のタグ・コメントを外し、文字参照を戻す
function decodeSourceHtml(raw) {
  return raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
        const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : +n;
        return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
      }).replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, n => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[n]));
}

export function researchSourceBlocks(raw, html) {
  if (html) {
    raw = raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    // 本文の区画はすべて読み、記事の見出し（公開日・更新日を置くことが多い）を残す。区画が無いページは周りの部品を外して全体を読む。
    // 区画の本文がごく短いページ（天気予報の表が区画の外にある tenki.jp など。2026-10-24）も全体を読む
    const sections = [...raw.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => m[2]).filter(t => t.trim());
    const picked = sections.length ? decodeSourceHtml(sections.join(' ').replace(/<nav\b[^>]*>[\s\S]*?<\/nav\s*>/gi, ' ')) : '';
    const size = s => s.replace(/\s+/g, '').length;
    if (size(picked) >= RESEARCH.verify.section_min_chars) raw = picked;
    else {
      // 区画の外にも本文がある（全体が区画の倍を超える）ときだけ全体を読む。短い記事は区画の見出し（更新日など）を残す
      const all = decodeSourceHtml(raw.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '));
      raw = size(all) > size(picked) * 2 ? all : picked;
    }
  }
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const boundary = end => end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
  const kept = classifySlice(text, RESEARCH.verify.source_chars), blocks = [];
  for (let at = 0; at < kept.length;) {
    const end = boundary(Math.min(kept.length, at + RESEARCH.verify.block_chars));
    blocks.push({id: blocks.length, text: kept.slice(at, end)}); at = end;
  }
  return {blocks, truncated: kept.length < text.length};
}

// エラー用readLimitedは途中の本文を返すため、根拠の取得では完了と打切りを別に扱う。
async function readResearchSourceBody(res, signal, html, charset) {
  if (!res.body) return {raw:'',truncated:false};
  const reader = res.body.getReader(), chunks = [];
  let size = 0, onStop;
  const decode = truncated => {
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) {bytes.set(chunk,at);at += chunk.length;}
    const head = html ? new TextDecoder().decode(bytes.subarray(0,2048)) : '';
    const declared = charset || head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'/>]+)/i)?.[1] || 'utf-8';
    if (!/^(?:utf-8|utf8|us-ascii|shift_jis|shift-jis|sjis|windows-31j|euc-jp|iso-2022-jp)$/i.test(declared)) throw new Error('unsupported_source_encoding');
    return {raw:new TextDecoder(declared,{fatal:true}).decode(bytes,{stream:truncated}),truncated};
  };
  const stopped = new Promise((_,reject) => {
    onStop = () => reject(searchFailure('cancelled'));
    if (signal.aborted) onStop(); else signal.addEventListener('abort',onStop,{once:true});
  });
  try {
    while (size < RESEARCH.verify.source_bytes) {
      const {done,value} = await Promise.race([reader.read(),stopped]);
      if (done) return decode(false);
      const kept = value.subarray(0,RESEARCH.verify.source_bytes - size); size += kept.byteLength;
      chunks.push(kept);
    }
    return decode(true);
  } finally {
    signal.removeEventListener('abort',onStop); reader.cancel().catch(() => {});
    try {reader.releaseLock();} catch {}
  }
}

export async function readResearchSource(item, signal) {
  const unread = allowed => ({...item, allowed, readable:false, blocks:[]});
  if (!researchSourceUrl(item.url)) return unread(false);
  try {
    return await searchDeadline(RESEARCH.verify.source_ms, async stop => {
      let url = item.url;
      for (let redirects = 0; ; redirects++) {
        if (stop.aborted) throw searchFailure('cancelled');
        // 名乗り（User-Agent）の無い取得を断るサイト（tenki.jp など）があるので、MAGI の取得だと正直に名乗る
        const res = await fetch(url, {redirect:'manual', signal:stop, headers:{Accept:'text/html, text/plain, application/json', 'User-Agent':RESEARCH.user_agent}});
        if ([301,302,303,307,308].includes(res.status)) {
          res.body?.cancel().catch(() => {});
          const next = res.headers.get('location');
          const target = researchSourceTarget(next, url);
          if (redirects >= 3 || !target) return unread(false);
          url = target; continue;
        }
        const type = res.headers.get('content-type') || '';
        const charset = type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
        // 403・404なども、PDFや時間切れと同じく取得を試みた未読の出典として残し、照合で未確認にする。
        if (!res.ok || !/(?:text\/html|text\/plain|application\/json)/i.test(type)) {
          res.body?.cancel().catch(() => {});
          return unread(true);
        }
        const {raw,truncated} = await readResearchSourceBody(res,stop,/text\/html/i.test(type),charset);
        if (stop.aborted) throw searchFailure('cancelled');
        const content = researchSourceBlocks(raw, /text\/html/i.test(type));
        return {...item, allowed:true, readable:content.blocks.length > 0, ...content, html:/text\/html/i.test(type),
          textChars:content.blocks.reduce((n, b) => n + b.text.length, 0),
          truncated:content.truncated || truncated, icons:sourceIconHrefs(/text\/html/i.test(type) ? raw : '', url)};
      }
    }, signal);
  } catch (e) {
    if (signal.aborted) throw searchFailure('cancelled');
    return unread(true);
  }
}

// --- 出典のアイコン（読み上げ設計§4.4）。画面から外部へ取りに行かせず、Worker が出典と同じホストから取って data: URL で渡す ---
// 候補は HTML の <link rel="icon">（SVG を除く）を書かれた順に、無ければ /favicon.ico。最後に apple-touch-icon（PNG のことが多く、
// 大きな .ico から1枚も取り出せないサイトの控え。宣言した大きさの小さいもの）。URL の検査は出典の本文と同じ
function sourceIconHrefs(html, pageUrl) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&').trim() : '';
  };
  const head = html.split(/<\/head\s*>/i)[0];
  const hrefs = [], touch = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/), href = attr(tag, 'href'), type = attr(tag, 'type').toLowerCase();
    if (!href || type.includes('svg') || /\.svgz?(?:[?#]|$)/i.test(href)) continue;
    if (rel.includes('icon')) { const abs = researchSourceTarget(href, pageUrl); if (abs && !hrefs.includes(abs)) hrefs.push(abs); }
    else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
      const abs = researchSourceTarget(href, pageUrl), size = Number((attr(tag, 'sizes').match(/^(\d+)x\d+/i) || [])[1]) || 180;
      if (abs) touch.push({ abs, size });
    }
  }
  const root = URL.canParse(pageUrl) ? new URL('/favicon.ico', pageUrl).href : null;
  const small = touch.sort((a, b) => a.size - b.size).find(t => !hrefs.includes(t.abs))?.abs;
  // 最後の /favicon.ico は、宣言したアイコンがどれも大きいサイト（NHK など）でも、その中の小さな1枚で付けるため
  const first = hrefs.length ? hrefs.slice(0, SOURCE_ICON.max_candidates - (small ? 2 : 1)) : [root];
  return [...new Set([...first, small, root].filter(Boolean))];
}
// 中身の先頭のバイトで種類を決める（Content-Type は信じない）。PNG・ICO・JPEG・GIF・WebP 以外は付けない
function sourceIconType(b) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
// 画面へ渡す1枚に収める。.ico は上限以内のファイルでも、収まる画像のうち 32px に近いもの（16px の表示を高精細な画面でも
// 粗くしない。同じ近さなら大きい方、同じ大きさなら色数の多い方）だけを選び（履歴に入る大きさを抑える）、PNG ならそのまま、
// BMP なら1枚だけの .ico に詰め直す。目次が崩れていて取り出せない .ico も、上限以内ならブラウザは描けるのでそのまま渡す。
// bytes は .ico なら先頭だけのこともある（範囲の外の画像は飛ばす）。ほかの種類は上限を超えたら付けない
function sourceIconFit(bytes) {
  const type = sourceIconType(bytes);
  if (!type) return null;
  const whole = bytes.length <= SOURCE_ICON.max_bytes ? { type, bytes } : null;
  if (type !== 'image/x-icon' || bytes.length < 6) return whole;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best = null;
  for (let i = 0, count = view.getUint16(4, true); i < count && 22 + 16 * i <= bytes.length; i++) {
    const at = 6 + 16 * i, width = bytes[at] || 256, size = view.getUint32(at + 8, true), offset = view.getUint32(at + 12, true);
    if (!size || offset < 6 + 16 * count || offset + size > bytes.length) continue;
    const png = sourceIconType(bytes.subarray(offset, offset + 8)) === 'image/png';
    if ((png ? size : 22 + size) > SOURCE_ICON.max_bytes) continue;
    const score = Math.abs(width - 32), depth = png ? 32 : view.getUint16(at + 6, true);
    if (!best || score < best.score || score === best.score && (width > best.width || width === best.width && depth > best.depth)) best = { score, width, depth, at, size, offset, png };
  }
  if (!best) return whole;
  const image = bytes.subarray(best.offset, best.offset + best.size);
  if (best.png) return { type: 'image/png', bytes: image };
  const out = new Uint8Array(22 + best.size);
  out.set([0, 0, 1, 0, 1, 0]); out.set(bytes.subarray(best.at, best.at + 12), 6);
  new DataView(out.buffer).setUint32(18, 22, true); out.set(image, 22);
  return { type: 'image/x-icon', bytes: out };
}
async function fetchSourceIcon(hrefs, signal) {
  try {
    return await searchDeadline(SOURCE_ICON.ms, async stop => {
      for (const first of hrefs) {
        let url = first;
        for (let redirects = 0; url; redirects++) {
          const res = await fetch(url, { redirect: 'manual', signal: stop, headers: { Accept: 'image/*', 'User-Agent': RESEARCH.user_agent } });
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            res.body?.cancel().catch(() => {});
            const next = res.headers.get('location');
            url = redirects < SOURCE_ICON.max_redirects ? researchSourceTarget(next, url) : null;
            continue;
          }
          if (!res.ok || !res.body) { res.body?.cancel().catch(() => {}); break; }
          const reader = res.body.getReader(), chunks = [];
          let size = 0;
          try {
            while (size <= SOURCE_ICON.fetch_bytes) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value); size += value.byteLength;
            }
          } finally { reader.cancel().catch(() => {}); }
          if (!size) break;
          // 上限を超えたファイルも先頭だけを渡す。大きな .ico（256px まで入れた 100KB 前後のもの）は目次と小さな画像が先頭にあり、
          // 範囲の外の画像は sourceIconFit が飛ばす。.ico 以外は画面へ渡す上限より大きいので付かない
          const length = Math.min(size, SOURCE_ICON.fetch_bytes), bytes = new Uint8Array(length); let at = 0;
          for (const c of chunks) { if (at >= length) break; const part = c.subarray(0, length - at); bytes.set(part, at); at += part.byteLength; }
          const icon = sourceIconFit(bytes);
          if (icon) return `data:${icon.type};base64,${btoa(String.fromCharCode(...icon.bytes))}`;
          break;
        }
      }
      return null;
    }, signal);
  } catch { return null; }
}
// 出典ごとにアイコンを取り始め、呼んだ時点で取れている分だけを返す関数を返す（照合の完了を待たせない）
export function startSourceIcons(evidence, signal) {
  const got = new Map(), byHost = new Map();
  for (const e of evidence) {
    if (!e.icons?.length) continue;
    const host = new URL(e.url).hostname;
    if (!byHost.has(host)) byHost.set(host, fetchSourceIcon(e.icons, signal));
    byHost.get(host).then(icon => { if (icon) got.set(e.url, icon); });
  }
  return url => got.get(url);
}

// --- Web回答の指示・照合の組立てと照合結果の検査。本番と保存済み出典の評価（.github/scripts）で同じものを使う ---
// 照合の応答が契約に合わないときは、入口の stageError と同じ封筒で返す（このファイルは入口を import しない）。
const verificationInvalid = () => Object.assign(new Error('Web回答の根拠を確認できませんでした'), {envelope:{stage:'upstream',
  code:'research_verification_invalid', message:'Web回答の根拠を確認できませんでした', retryable:true}});

const placeName = place => [place.city, place.region !== place.city ? place.region : null, place.country].filter(Boolean).join(', ');
function researchPlaceNote(place) {
  if (!place) return '';
  if (place.source !== 'device') return RESEARCH.place_prompt + placeName(place) + '。' + RESEARCH.place_rules + '\n';
  return RESEARCH.device_place_prompt + JSON.stringify({ place: placeName(place) || null, coordinates: place.coordinates })
    + '。' + RESEARCH.place_rules + '\n';
}
export function researchPlaceLabel(place, lang) {
  if (place.source !== 'device') return (RESEARCH.place_label[lang] || RESEARCH.place_label.en).replace('{place}', placeName(place));
  return (RESEARCH.device_place_label[lang] || RESEARCH.device_place_label.en)
    .replace('{place}', placeName(place) || (lang === 'ja' ? '現在地' : 'current location')).replace('{accuracy}', place.coordinates.accuracy);
}

// 検索と照合で、同じ「日本の現在日付」を使う。
function researchLocalDate(verifiedNow) {
  const localParts = new Intl.DateTimeFormat('en', { timeZone: RESEARCH.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(verifiedNow);
  const localPart = type => localParts.find(p => p.type === type).value;
  return `${localPart('year')}-${localPart('month')}-${localPart('day')} (${localPart('weekday')})`;
}

// 日付・項目・出典の指示は実経路と週次smokeで同じ形から作る。
export function researchMessages(messages, verifiedNow, place = null) {
  const localDate = researchLocalDate(verifiedNow);
  const firstUser = messages.findIndex(m => m.role !== 'system');
  return [...messages.slice(0, firstUser),
    { role: 'system', content: `${RESEARCH.prompt}\nこちらの確認日時: ${verifiedNow.toISOString()}（UTC）。日本の現在日付: ${localDate}（${RESEARCH.location.timezone}）。「今日」「現在」の対象日をUTCの日付や検索記事の日付で置き換えない。\n${researchPlaceNote(place)}${RESEARCH.answer_rules}` }, ...messages.slice(firstUser)];
}

function researchVerificationFormat(evidence) {
  return {type:'json_schema', json_schema:{name:'research_verified_reply', strict:true, schema:{type:'object', additionalProperties:false,
    properties:{parts:{type:'array', items:{type:'object', additionalProperties:false, properties:{label:{type:'string'}, text:{type:'string'},
      status:{type:'string', enum:['verified','unverified']}, citations:{type:'array', items:{type:'object', additionalProperties:false,
        properties:{n:{type:'integer', enum:evidence.map(e => e.n)}, blocks:{type:'array', items:{type:'integer'}}}, required:['n','blocks']}}},
      required:['label','text','status','citations']}}, place_used:{type:'boolean'}}, required:['parts','place_used']}}};
}

// place_used は、場所の指定が無い質問に推定所在地を使ったか（使ったら画面に前提を出す）。保存済みの評価の値（parts だけ）も読む
export function verifiedResearchResult(value, evidence, replyLanguage) {
  const fail = () => {throw verificationInvalid();};
  if (!(exactKeys(value,['parts']) || exactKeys(value,['parts','place_used']) && typeof value.place_used === 'boolean')
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > RESEARCH.verify.max_parts) fail();
  let text = ''; const items = [], marks = [], numbers = new Map(), unverified = [];
  let anyUnverified = false;
  // 1行を足し、その末尾に引用の印を付ける。出典は回答全体で連番にする
  const line = (body, citations, verified) => {
    text += (text ? '\n\n' : '') + '- ' + body;
    const used = new Set();
    for (const c of citations) {
      const source = evidence.find(e => e.n === c?.n);
      if (!exactKeys(c,['n','blocks']) || !Number.isInteger(c.n) || !source?.allowed || !researchSourceUrl(source.url)
        || !Array.isArray(c.blocks) || c.blocks.length > 20
        || c.blocks.some(id => !Number.isInteger(id) || id < 0 || !source.blocks.some(b => b.id === id))
        || verified && (!source.readable || !c.blocks.length)) fail();
      if (used.has(c.n)) continue; used.add(c.n);
      if (!numbers.has(c.n)) {numbers.set(c.n,items.length + 1);items.push({n:items.length + 1,title:source.title,url:source.url});}
      marks.push({at:text.length, n:numbers.get(c.n)});
    }
  };
  for (const p of value.parts) {
    if (!exactKeys(p,['label','text','status','citations']) || !['verified','unverified'].includes(p.status)
      || typeof p.label !== 'string' || !p.label.trim() || p.label.length > RESEARCH.verify.label_chars
      || typeof p.text !== 'string' || !p.text.trim() || p.text.length > RESEARCH.verify.text_chars
      || !Array.isArray(p.citations) || p.status === 'verified' && !p.citations.length || p.citations.length > RESEARCH.sources_max) fail();
    if (p.status === 'verified') line(p.label.trim() + ': ' + p.text.trim(), p.citations, true);
    else { anyUnverified = true; unverified.push(...p.citations); }
  }
  // 未確認の項目は、モデルが書いた本文も項目名も表示しない（項目名に候補値を書かれても残らないように）。
  // 末尾の1行の固定文にまとめ、確かめた出典の印だけを付ける
  if (anyUnverified)
    line(RESEARCH.unverified_note[replyLanguage?.code] || RESEARCH.unverified_note.en, unverified, false);
  return {text, sources:{items,marks}, placeUsed:value.place_used === true};
}

// callModelへ渡す設定・会話・出力形式。本番と保存済み出典の評価で同じものを使う。
// 照合にはカード・検索の指示・画像を送り直さない。前の会話は、質問が何を指すかを読むための文字だけを渡す。
export function researchVerificationRequest(cfg,messages,verifiedNow,result,evidence,replyLanguage,place = null) {
  const text = content => typeof content === 'string' ? content : (content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const turns = messages.filter(m => m.role !== 'system'), latest = turns.findLastIndex(m => m.role === 'user');
  const conversation = turns.slice(0, latest).map(m => ({role:m.role, text:text(m.content)})).filter(m => m.text.trim());
  const input = [{role:'system', content:RESEARCH.verify_prompt + '\nEstablished reply language: ' + (replyLanguage?.code || 'en')
      + `\nChecked at: ${verifiedNow.toISOString()} (UTC). Current date in Japan: ${researchLocalDate(verifiedNow)} (${RESEARCH.location.timezone}).`},
    {role:'user', content:JSON.stringify({conversation,question:text(turns[latest]?.content),draft:result.text,evidence,
      estimated_place:place ? placeName(place) : null,
      ...(place?.source === 'device' ? { device_coordinates: place.coordinates } : {})})}];
  return {cfg:{...cfg,max_tokens:RESEARCH.verify.max_tokens}, messages:input, response_format:researchVerificationFormat(evidence)};
}
