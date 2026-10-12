// 共通照合の契約。DOM・ネットワーク・本番Jevを使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const search = require('../../assets/japanese-search.js');
const fixture = JSON.parse(readFileSync(new URL('../site-search/phase4/reading-contract.json', import.meta.url)));
const source = '1'.repeat(64), copy = v => structuredClone(v);
const readings = () => ({ version: 1, normalization_revision: 1, source_sha256: source, generation: '2'.repeat(64),
  analyzer: { package: 'fixture', dictionary: 'fixture', dictionary_sha256: '3'.repeat(64), aliases_sha256: '4'.repeat(64) },
  record_ids: fixture.records.map(r => r.id), terms: copy(fixture.readings).map(t => ({...t, surface: search.normalize(t.surface)}))
    .sort((a, b) => a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0) });
const engine = () => search.prepare(copy(fixture.records)).attachReadings(readings(), source);

test('年別の読みは個々のhashとID順を検査し、全文集合へ原子的に採用する', () => {
  const payload=readings(), ids=payload.record_ids;
  const sets=[ids.slice(0,2),ids.slice(2)].map((recordIds,part)=>{
    const offset=part?2:0;
    return {recordIds,sourceHash:source,payload:{...copy(payload),record_ids:recordIds,terms:payload.terms
      .map(t=>({...t,postings:t.postings.filter(([i])=>i>=offset && i<offset+recordIds.length).map(([i,m])=>[i-offset,m])})).filter(t=>t.postings.length)}};
  });
  const api=search.prepare(copy(fixture.records)).attachReadingSets(sets);
  assert.equal(api.search('kaden').rows[0].id,'fixture:1');assert.equal(api.search('nyuusu').rows[0].id,'fixture:3');
  assert.throws(()=>api.attachReadingSets([sets[0]]));
  const mixed=copy(sets);mixed[1].payload.source_sha256='5'.repeat(64);assert.throws(()=>api.attachReadingSets(mixed));
  assert.equal(api.search('nyuusu').rows[0].id,'fixture:3','採用失敗で検査済みの読みを壊さない');
});

test('必須の全途中入力・表記差・長音・促音が固定した語へ届く', () => {
  const api = engine();
  for (const { query, includes } of fixture.required) assert.ok(api.search(query).rows.some(r => r.id === includes), query);
  assert.equal(api.search('でん').total, 0);
  assert.equal(api.search('pizzza').total, 0);
});

test('語境界の複数語AND・filters・題名とタグの読みを共通に照合する', () => {
  const api = engine();
  assert.deepEqual(api.search('nitori shuunou').rows.map(r => r.id), ['fixture:1']);
  assert.equal(api.search('nitori news').total, 0);
  assert.equal(api.search('kaden', {category: '話題'}).total, 0);
  assert.equal(api.search('kaden', {category: '商品', month: '202610'}).total, 1);
  assert.equal(api.search('kaden', {month: '202609'}).total, 0);
  assert.equal(api.search('beta alpha').total, 1);
});

test('漢字の既知語・全半角・結合濁点とASCII偶然一致の順位', () => {
  const api = engine();
  assert.equal(search.normalize('ｶﾞ'), search.normalize('か\u3099'));
  assert.equal(api.search('ＫＡＤＥＮ').rows[0].id, 'fixture:1');
  assert.equal(api.search('n').rows[0].id, 'fixture:1');
  assert.ok(api.search('n').rows.some(r => r.id === 'fixture:2'));
  assert.equal(api.search('家電').rows[0].id, 'fixture:1');
  assert.equal(api.search('架空固有名詞').total, 0);
});

test('n/nn/n\'と拗音の別表記を扱い、入力値を変更しない', () => {
  for (const [input, kana] of [['shi','し'], ['si','し'], ['chi','ち'], ['ti','ち'], ['tsu','つ'], ['tu','つ'], ['fu','ふ'], ['hu','ふ'], ['nya','にゃ'], ['nn','ん'], ["n'",'ん'], ['onna','おんな']]) assert.ok(search.prefixes(input).includes(kana), input);
  const original = 'にｔ'; engine().search(original); assert.equal(original, 'にｔ');
});

test('版・順序・schema・範囲・重複・bitの不正を拒否する', () => {
  const changes = [p => p.version++, p => p.normalization_revision++, p => p.record_ids.reverse(),
    p => p.record_ids.pop(), p => p.terms.reverse(), p => p.terms.push(copy(p.terms[0])),
    p => p.terms[0].postings.push(copy(p.terms[0].postings[0])), p => p.terms[0].postings[0][0] = 999,
    p => p.terms[0].postings[0][1] = 16, p => p.generation = 'not-a-hash', p => p.analyzer.dictionary_sha256 = 'bad'];
  for (const change of changes) { const p = readings(); change(p); assert.throws(() => engine().attachReadings(p, source), /reading_contract/); }
  assert.throws(() => engine().attachReadings(readings(), '0'.repeat(64)), /reading_version/);
});

test('読み不採用・切り離しでも旧文字一致は残り、壊れた読みを途中採用しない', () => {
  const api = engine(), literal = api.search('家電').rows.map(r => r.id);
  const bad = readings(); bad.terms[0].postings[0][0] = 999;
  assert.throws(() => api.attachReadings(bad, source));
  assert.equal(api.search('kaden').total, 1);
  api.detachReadings();
  assert.deepEqual(api.search('家電').rows.map(r => r.id), literal);
  assert.equal(api.search('kaden').total, 0);
  const legacy = search.prepare([{id:'legacy',title:'abcd',description:'EF'}], undefined, {legacyRemoveWhitespace:true, legacyJoin:''});
  assert.equal(legacy.search('ab cd').total, 1);
  assert.equal(legacy.search('cd ef').total, 1);
  assert.equal(legacy.search('cd ef', {category:'missing'}).total, 0);
});

test('1文字でも101件目・最後の候補と総件数を切り捨てない', () => {
  const records = Array.from({length:250}, (_, i) => ({id:`many:${i}`,title:`候補${i}`}));
  const api = search.prepare(records);
  const p = readings(); p.record_ids = records.map(r=>r.id);
  p.terms = [{surface:'にとり',reading:'にとり',postings:records.map((_,i)=>[i,1])}];
  api.attachReadings(p, source);
  const result = api.search('n');
  assert.equal(result.total, 250);
  assert.equal(result.rows[100].id, 'many:100');
  assert.equal(result.rows[249].id, 'many:249');
});

test('複数語の題名完全一致が別フィールドのANDより上に来る', () => {
  const api = search.prepare([{id:'split',title:'alpha',description:'beta'}, {id:'exact',title:'alpha beta'}]);
  const found = api.search('alpha beta');
  assert.equal(found.rows[0].id,'exact');
  assert.equal(found.rows[0].score,700);
});

test('分割した準備・読みの中止は未検証の状態を公開せず、最後まで進めれば同期版と一致する',()=>{
  const records=Array.from({length:250},(_,i)=>({id:'yield:'+i,title:'収納'+i}));
  const task=search.prepareTask(records);let step=task.next(),pauses=0;
  while(!step.done) {pauses++;step=task.next();}
  assert.ok(pauses>=3);const api=step.value;
  const p=readings();p.record_ids=records.map(r=>r.id);p.terms=[{surface:'収納',reading:'しゅうのう',postings:records.map((_,i)=>[i,1])}];
  p.terms[0].surface=search.normalize(p.terms[0].surface);
  const sets=[{payload:p,recordIds:p.record_ids,sourceHash:source}];
  assert.equal(api.search('shuu').total,0,'採用前の検索をキャッシュする');
  const pending=api.attachReadingSetsTask(sets);assert.equal(pending.next().done,false);pending.return();
  assert.equal(api.search('shuu').total,0);assert.equal(api.search('収納').total,250);
  const adopt=api.attachReadingSetsTask(sets);do {step=adopt.next();} while(!step.done);
  const expected=search.prepare(records).attachReadingSets(sets).search('shuu');
  assert.deepEqual(api.search('shuu'),expected,'採用後は以前の0件キャッシュを破棄する');
  api.detachReadings();assert.equal(api.search('shuu').total,0);
});

test('語のキャッシュと事前順序はfilter・sortを跨いでも従来の比較順と一致する',()=>{
  const records=[{id:'a',title:'alpha',category:'A',date:'20261001'},
    {id:'b',title:'alpha beta',category:'B',date:'20261003'},
    {id:'c',title:'beta',description:'alpha',category:'A',date:'20261002'}];
  let sort='relevance';
  const compare=(a,b)=>sort==='oldest'?(a.date<b.date?-1:1):(a.date>b.date?-1:1);
  const options={compare,sortByRelevance:()=>sort==='relevance'};
  const normal=search.prepare(records,undefined,options),cached=search.prepare(records,undefined,{...options,orderKey:()=>sort});
  for(const next of ['relevance','oldest','newest','relevance']) {
    sort=next;
    for(const query of ['alpha','beta','alpha beta','']) for(const filters of [{},{category:'A'},{category:'B'}]) {
      assert.deepEqual(cached.search(query,filters),normal.search(query,filters),next+'/'+query+'/'+JSON.stringify(filters));
    }
  }
});

test('20の偶然一致・数字・記号・未知語で、読みの過剰一致と文字検索の後退を分ける',()=>{
  const records=[{id:'storage',title:'収納'},{id:'english',title:'Beta Alpha',description:'browser privacy XML'},
    {id:'literal',title:'C++ primer',description:'price $42 foo!'},{id:'unknown',title:'𠮷野𠀋𠮟',description:'unresolved'}];
  const api=search.prepare(records),p=readings();p.record_ids=records.map(r=>r.id);
  p.terms=[{surface:'収納',reading:'しゅうのう',postings:[[0,1]]}];api.attachReadings(p,source);
  const probes=[['42',['literal']],['4',['literal']],['+',['literal']],['$',['literal']],['foo!',['literal']],
    ['𠮷野𠀋𠮟',['unknown']],['𠮟',['unknown']],['kaden',[]],['shunou',[]],['syuunou',['storage']],
    ['n',['unknown']],['x',['english']],['pizzza',[]],['alpha beta',['english']],
    ['999',[]],['・・・',[]],['/',[]],['<script>',[]],['[',[]],['sunou',[]]];
  assert.equal(probes.length,20);
  for(const [query,ids] of probes) assert.deepEqual(api.search(query).rows.map(r=>r.id),ids,query);
  api.detachReadings();assert.equal(api.search('𠮷野𠀋𠮟').rows[0].id,'unknown');
});
