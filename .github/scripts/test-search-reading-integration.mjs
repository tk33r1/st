// Pythonが実際の辞書で生成した読みを、同じ生バイト列・ID順でブラウザ部品へ渡す。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), search = require('../../assets/japanese-search.js');
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node test-search-reading-integration.mjs generated-directory');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => JSON.parse(readFileSync(resolve(directory,name),'utf8'));
const siteBytes = readFileSync(resolve(directory,'data/site-keyword.json'));
const site = JSON.parse(siteBytes), readings = load('data/site-readings.json');
const siteEngine = search.prepare(site.pages.map(p => ({id:p.id,...p.search_fields}))).attachReadings(readings,hash(siteBytes));
for (const query of ['DJ','Thought','思索','人類踊狂計画']) assert.ok(siteEngine.search(query).total>0,query);
for (const name of ['tools','game']) {
  const source = readFileSync(resolve('data',name+'.json'));
  const rows = JSON.parse(source).map(r=>({...r,id:(name==='tools'?'tool:':'game:')+r.id}));
  const fieldNames = name==='tools' ? ['title','tags','description','shortDescription','category'] : ['title','description','genre','ai'];
  const config = fieldNames.map(name=>({name,mask:name==='title'?1:['tags','genre'].includes(name)?2:name==='description'||name==='shortDescription'?4:8}));
  const api = search.prepare(rows,config).attachReadings(load(`data/${name}-readings.json`),hash(source));
  assert.equal(api.search('').total,rows.length);
  for (const row of rows) assert.ok(api.search(row.title).rows.some(r=>r.id===row.id),row.title);
}
for (const media of ['nitoridaily','retailtechdaily']) {
  const manifest = load(`job/${media}/search-readings.json`);
  const root = resolve('job',media);
  const head = JSON.parse(readFileSync(resolve(root,'search-index.json')));
  assert.equal(manifest.source_generation,head.generation);
  assert.deepEqual(manifest.files.map(f=>f.year),head.years);
  for (const file of manifest.files) {
    const bytes = readFileSync(resolve(root,file.source));
    assert.equal(hash(bytes),file.source_sha256);
    const readingBytes = readFileSync(resolve(directory,'job',media,file.readings));
    assert.equal(hash(readingBytes),file.readings_sha256);
    const records = JSON.parse(bytes).records.map(r=>({...r,id:`${media}:${r.date}:${r.url.split('#art-')[1]}`}));
    const config = [{name:'title',mask:1},{name:'tags',mask:2},{name:'summary',mask:4},{name:'takeaway',mask:4},{name:'source',mask:8},{name:'category',mask:2}];
    const api = search.prepare(records,config,{legacyFields:['title','summary','takeaway','source','category','tags'],legacyRemoveWhitespace:true})
      .attachReadings(JSON.parse(readingBytes),hash(bytes));
    assert.equal(api.search('').total,records.length);
    for (const row of records) assert.ok(api.search(row.title).rows.some(r=>r.id===row.id),row.title);
  }
}
console.log('Python→browser: site/tools/game/dailyの生バイト列・ID順・全題名・manifestを照合済み');
