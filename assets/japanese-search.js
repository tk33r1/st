/* Phase 4の純粋な文字・読み照合。DOM・通信・入力欄の書き換えを持たない。 */
(function (root) {
  'use strict';
  const REVISION = 1;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const normalize = value => String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(CONTROL, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const chars = value => Array.from(value).length;
  const hashPattern = /^[a-f0-9]{64}$/;
  const masks = { title: 1, tags: 2, description: 4, detail: 8 };
  // 対応ブラウザでは4msのタイマー待ちを避ける。低い優先度で再開し、入力と通常のタイマーを先に通す。
  const yieldControl = () => typeof root.scheduler?.postTask==='function'?root.scheduler.postTask(()=>{}, {priority:'background'}):new Promise(resolve=>setTimeout(resolve,0));
  const roman = Object.create(null);
  for (const [consonant, syllables] of Object.entries({
    '': 'あいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ',
    t: 'たちつてと', d: 'だぢづでど', n: 'なにぬねの', h: 'はひふへほ', b: 'ばびぶべぼ',
    p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ', v: ['ゔぁ', 'ゔぃ', 'ゔ', 'ゔぇ', 'ゔぉ']
  })) Array.from(syllables).forEach((kana, i) => { roman[consonant + 'aiueo'[i]] = kana; });
  Object.assign(roman, { ya: 'や', yu: 'ゆ', yo: 'よ', wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を',
    shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', she: 'しぇ', che: 'ちぇ', je: 'じぇ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', ti: 'ち', tu: 'つ', si: 'し', hu: 'ふ',
    tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ', thi: 'てぃ', thu: 'てゅ', dhi: 'でぃ',
    dho: 'でょ', kwa: 'くぁ', gwa: 'ぐぁ', '-': 'ー' });
  for (const [prefix, base] of Object.entries({ ky: 'き', gy: 'ぎ', sy: 'し', sh: 'し', zy: 'じ', j: 'じ',
    jy: 'じ', ty: 'ち', ch: 'ち', cy: 'ち', dy: 'ぢ', ny: 'に', hy: 'ひ', by: 'び', py: 'ぴ', my: 'み', ry: 'り' })) {
    for (const [vowel, small] of Object.entries({ a: 'ゃ', u: 'ゅ', o: 'ょ' })) roman[prefix + vowel] = base + small;
  }
  for (const prefix of ['x', 'l']) {
    for (const [key, kana] of Object.entries({ a: 'ぁ', i: 'ぃ', u: 'ぅ', e: 'ぇ', o: 'ぉ', ya: 'ゃ', yu: 'ゅ', yo: 'ょ', tu: 'っ', tsu: 'っ', wa: 'ゎ', ka: 'ゕ', ke: 'ゖ' })) roman[prefix + key] = kana;
  }
  const romanKeys = Object.keys(roman).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  function prefixes(value) {
    const input = normalize(value);
    if (!input || chars(input) > 200) return [];
    let kana = '', offset = 0;
    while (offset < input.length) {
      const rest = input.slice(offset), c = rest[0];
      if (/[ぁ-ゖー]/.test(c)) { kana += c; offset++; continue; }
      if (rest === 'n') return [...new Set([kana + 'ん', ...'なにぬねの'.split('').map(k => kana + k)])];
      if (rest.startsWith("n'")) { kana += 'ん'; offset += 2; continue; }
      if (rest.startsWith('nn')) {
        // onna は おんな。末尾nnや、後ろが子音なら2打鍵でん。
        kana += 'ん'; offset += /[aiueoy]/.test(rest[2] || '') ? 1 : 2; continue;
      }
      if (c === 'n' && rest.length > 1 && /[bcdfghjklmpqrstvwxz]/.test(rest[1])) { kana += 'ん'; offset++; continue; }
      if (rest.length > 1 && c === rest[1] && /[bcdfghjklmpqrstvwxyz]/.test(c)) { kana += 'っ'; offset++; continue; }
      const key = romanKeys.find(k => rest.startsWith(k));
      if (key) { kana += roman[key]; offset += key.length; continue; }
      const pending = romanKeys.filter(k => k.startsWith(rest));
      return pending.length ? [...new Set(pending.map(k => kana + roman[k]))] : [];
    }
    return [kana];
  }

  const vowels = { あ: 'あ', い: 'い', う: 'う', え: 'え', お: 'お', ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', ゃ: 'あ', ゅ: 'う', ょ: 'お', ゎ: 'あ' };
  for (const [key, kana] of Object.entries(roman)) if (kana.length === 1 && /[aiueo]$/.test(key)) vowels[kana] = 'あいうえお'['aiueo'.indexOf(key.slice(-1))];
  function longForms(reading) {
    let repeated = '', conventional = '', vowel = '';
    for (const c of reading) {
      if (c === 'ー' && vowel) { repeated += vowel; conventional += vowel === 'お' ? 'う' : vowel === 'え' ? 'い' : vowel; }
      else { repeated += c; conventional += c; vowel = vowels[c] || ''; }
    }
    return [...new Set([reading, repeated, conventional])];
  }

  function lowerBound(rows, prefix) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (rows[middle].reading < prefix) lo = middle + 1; else hi = middle; }
    return lo;
  }

  function* validateReadingTask(payload, ids, sourceHash) {
    if (!hashPattern.test(sourceHash || '') || payload?.source_sha256 !== sourceHash) throw new Error('reading_version');
    if (payload.version !== 1 || payload.normalization_revision !== REVISION || !hashPattern.test(payload.generation || '')
      || !payload.analyzer || typeof payload.analyzer.package !== 'string' || typeof payload.analyzer.dictionary !== 'string'
      || !hashPattern.test(payload.analyzer.dictionary_sha256 || '') || !hashPattern.test(payload.analyzer.aliases_sha256 || '')
      || !Array.isArray(payload.record_ids) || payload.record_ids.length !== ids.length
      || payload.record_ids.some((id, i) => id !== ids[i]) || !Array.isArray(payload.terms) || payload.terms.length > 250000) throw new Error('reading_contract');
    let previous = '', count = 0, termCount = 0;
    const keys = new Set();
    for (const t of payload.terms) {
      if (!t || typeof t.surface !== 'string' || !t.surface || (t.surface.length > 32768 && chars(t.surface) > 32768)
        || typeof t.reading !== 'string' || !/^[ぁ-ゖー]+$/.test(t.reading) || t.reading.length > 32768
        || normalize(t.surface) !== t.surface || t.reading < previous || !Array.isArray(t.postings) || !t.postings.length) throw new Error('reading_contract');
      const key = JSON.stringify([t.surface, t.reading]);
      if (keys.has(key)) throw new Error('reading_contract');
      keys.add(key); previous = t.reading;
      let last = -1;
      for (const pair of t.postings) {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] <= last || pair[0] >= ids.length
          || !Number.isSafeInteger(pair[1]) || pair[1] < 1 || pair[1] > 15 || ++count > 2000000) throw new Error('reading_contract');
        last = pair[0]; if((count & 1023)===0) yield;
      }
      if((++termCount & 15)===0) yield;
    }
    return payload;
  }

  function finish(task) { let step; do { step=task.next(); } while(!step.done);return step.value; }
  function validateReadings(payload,ids,sourceHash) { return finish(validateReadingTask(payload,ids,sourceHash)); }
  function* sortTask(items,compare) {
    // 大きなsortも小さな塊とマージに分け、非同期の呼び出し側へ処理を返す。
    let runs=[];
    for(let i=0;i<items.length;i+=512) {runs.push(items.slice(i,i+512).sort(compare));yield;}
    while(runs.length>1) {
      const next=[];
      for(let k=0;k<runs.length;k+=2) {
        if(!runs[k+1]) {next.push(runs[k]);continue;}
        const a=runs[k],b=runs[k+1],out=[];let i=0,j=0;
        while(i<a.length || j<b.length) {
          out.push(j===b.length || (i<a.length && compare(a[i],b[j])<=0)?a[i++]:b[j++]);
          if((out.length & 1023)===0) yield;
        }
        next.push(out);
      }
      runs=next;
    }
    return runs[0] || [];
  }
  function prepare(records,fields,options) {return finish(prepareTask(records,fields,options));}
  function* prepareTask(records, fieldConfig, options = {}) {
    if (!Array.isArray(records) || records.length > 10000) throw new Error('search_records');
    const fields = fieldConfig || Object.keys(masks).map(name => ({ name, mask: masks[name] }));
    if (!Array.isArray(fields) || fields.some(f => !f || typeof f.name !== 'string' || ![1, 2, 4, 8].includes(f.mask))) throw new Error('search_fields');
    const ids = new Set();
    const rows=[];
    for(let order=0;order<records.length;order++) {
      const record=records[order];
      if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id)) throw new Error('search_ids');
      ids.add(record.id);
      const texts = fields.flatMap(f => {
        const value = record[f.name] == null ? '' : record[f.name];
        return (Array.isArray(value) ? value : [value]).map(text => {
          if (typeof text !== 'string' || (text.length > 32768 && chars(text) > 32768)) throw new Error('search_field');
          return { text: normalize(text), mask: f.mask };
        });
      });
      let legacy = texts.map(t => t.text).join(' ');
      if (options.legacyFields) legacy = options.legacyFields.map(name => {
        const value = record[name]; return normalize(Array.isArray(value) ? value.join(' ') : value);
      }).join(options.legacyJoin == null ? ' ' : options.legacyJoin);
      if (options.legacyRemoveWhitespace) legacy = legacy.replace(/\s+/g, '');
      rows.push({ record, order, texts, legacy });
      if((order & 63)===63) yield;
    }
    let vocabulary = [], bySurface = new Map();
    const termScores=new Map();
    let ordered = null, orderingKey;
    const maskScore = (mask, asciiSingle) => (mask & 3) ? 400 : asciiSingle ? 50 : 100;
    const api = {
      recordIds: rows.map(r => r.record.id),
      attachReadings(payload, sourceHash) {
        return api.attachReadingSets([{payload, sourceHash, recordIds: api.recordIds}]);
      },
      // 日刊の年別ファイルは各生バイト列とID順を検査してから、共通の語彙へ束ねる。
      attachReadingSets(sets) {return finish(api.attachReadingSetsTask(sets));},
      *attachReadingSetsTask(sets) {
        if (!Array.isArray(sets) || !sets.length) throw new Error('reading_contract');
        const positions = new Map(api.recordIds.map((id, index) => [id, index])), seen = new Set(), terms = [];
        for (const set of sets) {
          if (!set || !Array.isArray(set.recordIds)) throw new Error('reading_contract');
          yield* validateReadingTask(set.payload, set.recordIds, set.sourceHash);
          const remap = set.recordIds.map(id => {
            if (!positions.has(id) || seen.has(id)) throw new Error('reading_contract');
            seen.add(id); return positions.get(id);
          });
          let count=0;
          for (const t of set.payload.terms) {
            const postings=[];
            for(const [index,mask] of t.postings) {postings.push([remap[index],mask]);if((++count & 1023)===0) yield;}
            terms.push({...t,postings});if((++count & 127)===0) yield;
          }
        }
        if (seen.size !== positions.size) throw new Error('reading_contract');
        let next = [];const surfaces = new Map();let count=0;
        for (const t of terms) {
          for (const reading of longForms(t.reading)) next.push({ reading, postings: t.postings });
          if (!surfaces.has(t.surface)) surfaces.set(t.surface, new Set());
          surfaces.get(t.surface).add(t.reading);if((++count & 127)===0) yield;
        }
        next=yield* sortTask(next,(a,b)=>a.reading<b.reading?-1:a.reading>b.reading?1:0);
        const merged = [];
        for (let i = 0; i < next.length;) {
          const reading = next[i].reading, positions = new Map();
          while (i < next.length && next[i].reading === reading) {
            for (const [index, mask] of next[i++].postings) {positions.set(index,(positions.get(index) || 0)|mask);if((++count & 1023)===0) yield;}
          }
          const ordered = yield* sortTask([...positions],(a,b)=>a[0]-b[0]);
          const packed = new Uint32Array(ordered.length);
          for(let position=0;position<ordered.length;position++) {const [index,mask]=ordered[position];packed[position]=index*16+mask;if((++count & 1023)===0) yield;}
          merged.push({reading, postings: packed});if((++count & 127)===0) yield;
        }
        vocabulary = merged; bySurface = surfaces;termScores.clear();
        return api;
      },
      detachReadings() { vocabulary = []; bySurface = new Map();termScores.clear(); },
      search(value, filters = {}) {
        const query = normalize(value).trim();
        if (chars(query) > 200) throw new Error('search_query');
        const terms = query.split(/\s+/).filter(Boolean);
        const matches = terms.map(term => {
          if(termScores.has(term)) return termScores.get(term);
          const found = new Uint16Array(rows.length), ps = [...prefixes(term), ...Array.from(bySurface.get(term) || []).flatMap(longForms)];
          const unique = [...new Set(ps)];
          // 「き」があれば「きゃ」等の範囲をもう一度走査しない。件数は省略しない。
          for (const prefix of unique.filter(p => !unique.some(other => other !== p && p.startsWith(other)))) {
            for (let i = lowerBound(vocabulary, prefix); i < vocabulary.length && vocabulary[i].reading.startsWith(prefix); i++) {
              const postings=vocabulary[i].postings;
              for(let p=0;p<postings.length;p++) {
                const packed=postings[p];
                const index = packed >>> 4, score = (packed & 3) ? 300 : 100;
                if (score > found[index]) found[index] = score;
              }
            }
          }
          const asciiSingle = /^[a-z0-9]$/.test(term);
          for(let index=0;index<rows.length;index++) {
            let best=found[index];
            for (const f of rows[index].texts) {
              // 既に得た読み・題名の点数を超えないフィールドは、全文を再走査しない。
              const ceiling=(f.mask & 1)?700:maskScore(f.mask,asciiSingle);
              if(best>=ceiling || !f.text.includes(term)) continue;
              const score=(f.mask & 1)?(f.text===term?700:f.text.startsWith(term)?600:500):ceiling;
              if(score>best) best=score;
              if(best===700) break;
            }
            found[index]=best;
          }
          // filter・sort・②の到着による同じ語の再照合を避ける。読みの採用／破棄で必ず捨てる。
          if(termScores.size>=32) termScores.delete(termScores.keys().next().value);
          termScores.set(term,found);return found;
        });
        let legacyQuery = options.legacyRemoveWhitespace ? query.replace(/\s+/g, '') : query;
        const filterEntries = Object.entries(filters).filter(([, value]) => !!value);
        const relevance=options.sortByRelevance?.()!==false;
        // UIの同点順は条件と独立。sortの値が変わるまで、一度確定した順を使う。
        if(options.orderKey && (!ordered || orderingKey!==options.orderKey())) {
          orderingKey=options.orderKey();ordered=rows.slice().sort((a,b)=>(options.compare?.(a.record,b.record) || 0) || a.order-b.order);
        }
        const result = [], buckets = !options.compare || (options.orderKey && relevance)?new Map():null;
        const candidates=options.orderKey?ordered:rows;
        for(let position=0;position<candidates.length;position++) {
          const row=candidates[position];
          const index=row.order;
          if (filterEntries.length && !filterEntries.every(([key, val]) => (key === 'month' ? String(row.record.date || '').slice(0, 6) : row.record[key]) === val)) continue;
          let common = true, score = matches.length ? 700 : 0;
          for (const m of matches) {
            if (!m[index]) { common = false; break; }
            score = Math.min(score, m[index]);
          }
          const legacy = !common && !!query && row.legacy.includes(legacyQuery);
          if (!common && !legacy) continue;
          if (!common) score = 100;
          if (terms.length > 1) for (const f of row.texts) if ((f.mask & 1) && f.text.includes(query)) {
            score = Math.max(score, f.text === query ? 700 : f.text.startsWith(query) ? 600 : 500);
          }
          const item = { record: row.record, id: row.record.id, score, order: row.order, match: common ? 'common' : 'legacy' };
          if (buckets) {
            if (!buckets.has(score)) buckets.set(score, []);
            buckets.get(score).push(item);
          } else result.push(item);
        }
        if (buckets) {
          // 点数は少数の離散値。元の順のまま束ねれば全件を比較ソートしなくてよい。
          for (const score of [...buckets.keys()].sort((a, b) => b - a)) result.push(...buckets.get(score));
        } else if(!options.orderKey) result.sort((a, b) => (relevance?b.score-a.score:0)
          || options.compare(a.record,b.record) || b.score-a.score || a.order-b.order);
        return { rows: result, total: result.length };
      }
    };
    return api;
  }

  const api = { normalizationRevision: REVISION, normalize, prefixes, validateReadings, prepare, prepareTask, yieldControl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.STJapaneseSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
