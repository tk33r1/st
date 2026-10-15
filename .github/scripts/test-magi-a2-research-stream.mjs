// 実測で見つかった引用の前後関係・URLなしの天気データと、失敗境界を確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import {researchReader, ResearchStreamError} from './magi-a2-research-stream.mjs';
const result = (content = [{type: 'web_search_result', url: 'https://example.com/'}]) =>
  ({type: 'content_block_start', index: 0, content_block: {type: 'web_search_tool_result', content}});
const start = index => ({type: 'content_block_start', index, content_block: {type: 'text', text: ''}});
const delta = (index, text) => ({type: 'content_block_delta', index, delta: {type: 'text_delta', text}});
const cite = (index, href = 'https://example.com/') => ({type: 'content_block_delta', index,
  delta: {type: 'citations_delta', citation: {type: 'web_search_result_location', url: href, title: 'source'}}});
const endBlock = index => ({type: 'content_block_stop', index});
const end = reader => {reader.push({type: 'message_delta', delta: {stop_reason: 'end_turn'}}); reader.push({type: 'message_stop'});};
const openResult = sources => ({type: 'response.output_item.done', item: {type: 'web_search_call', status: 'completed', action: {sources}}});
const openText = text => ({type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text});
const openCite = (start_index, end_index, href = 'https://example.com/') => ({type: 'response.output_text.annotation.added', output_index: 1, content_index: 0,
  annotation: {type: 'url_citation', start_index, end_index, url: href, title: 'source'}});

test('Anthropicの引用が本文前に届いても、ブロック末尾へ番号を置く', () => {
  const r = researchReader('anthropic');
  r.push(result()); r.push(start(1)); r.push(cite(1)); r.push(delta(1, '事実😀')); r.push(endBlock(1)); end(r);
  assert.deepEqual(r.finish().sources.marks, [{at: 4, n: 1}]);
});
test('検索前の前置きと引用を落とし、成功後の本文の位置へ写す', () => {
  let emitted = '';
  const r = researchReader('anthropic', text => emitted += text);
  r.push(start(1)); r.push(delta(1, '検索します。')); r.push(cite(1)); r.push(endBlock(1));
  r.push(result()); r.push(start(2)); r.push(cite(2)); r.push(delta(2, '答え')); r.push(endBlock(2)); end(r);
  assert.equal(emitted, '答え'); assert.deepEqual(r.finish().sources.marks, [{at: 2, n: 1}]);
});
test('HTTP200のエラー・空結果・URLなしの天気は本文前の失敗', () => {
  for (const content of [[], {type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded'}]) {
    let emitted = '';
    const r = researchReader('anthropic', t => emitted += t);
    r.push(result(content)); r.push(start(1)); r.push(delta(1, '根拠なしの答え')); end(r);
    assert.equal(emitted, ''); assert.throws(() => r.finish(), e => e.code === 'no_url_search_result' && e.beforeText);
  }
  let emitted = '';
  const r = researchReader('openai', t => emitted += t);
  r.push(openResult([{type: 'api', name: 'oai-weather'}])); r.push(openText('天気の値'));
  r.push({type: 'response.completed', response: {status: 'completed', output: []}});
  assert.equal(emitted, ''); assert.throws(() => r.finish(), e => e.beforeText && e.code === 'no_url_search_result');
});

test('課金障害はエラーの種類だけ保持し、メッセージや応答本文を保持しない',()=>{
  for(const event of [
    {type:'response.failed',response:{error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'private text'}}},
    {type:'error',code:'credit_balance_exhausted',message:'private text'},
  ]){
    const reader=researchReader('openai');
    assert.throws(()=>reader.push(event),e=>e.code==='stream_error'&&e.beforeText
      &&e.upstreamError.code==='credit_balance_exhausted'&&!Object.hasOwn(e.upstreamError,'message'));
  }
});
test('検索の失敗の後の成功と、成功の後の検索エラーを許す', () => {
  const r = researchReader('anthropic');
  r.push(result({type: 'web_search_tool_result_error', error_code: 'unavailable'}));
  r.push({...result(), index: 1}); r.push(start(2)); r.push(delta(2, '答え')); r.push(cite(2)); r.push(endBlock(2));
  r.push({...result({type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded'}), index: 3}); end(r);
  assert.equal(r.finish().text, '答え');
});
test('OpenAIの検索前に捨てた分を引用位置から除く', () => {
  const r = researchReader('openai');
  r.push(openText('前置き')); r.push(openResult([{url: 'https://example.com/'}])); r.push(openText('答え😀'));
  r.push(openCite(3, 7)); r.push({type: 'response.completed', response: {status: 'completed', output: []}});
  assert.equal(r.finish().text, '答え😀'); assert.deepEqual(r.finish().sources.marks, [{at: 4, n: 1}]);
});
test('差分に無いOpenAIの引用を完了応答から取る', () => {
  const r = researchReader('openai');
  r.push(openResult([{url: 'https://example.com/'}])); r.push(openText('答え'));
  r.push({type: 'response.completed', response: {status: 'completed', output: [{type: 'web_search_call'},
    {type: 'message', content: [{annotations: [openCite(0, 2).annotation]}]}]}});
  assert.deepEqual(r.finish().sources.marks, [{at: 2, n: 1}]);
});
test('実SSEで空だった出典題名にはURLを使う', () => {
  const r = researchReader('openai'); r.push(openResult([{url: 'https://example.com/'}])); r.push(openText('本文'));
  const citation = openCite(0, 2); citation.annotation.title = ''; r.push(citation);
  r.push({type: 'response.completed', response: {status: 'completed', output: []}});
  assert.equal(r.finish().sources.items[0].title, 'https://example.com/');
});
test('出典を重複除去し最大5件にし、危険なURLと範囲外の位置を落とす', () => {
  const r = researchReader('openai');
  r.push(openResult([{url: 'https://example.com/'}])); r.push(openText('答え'));
  for (let i = 0; i < 7; i++) r.push(openCite(0, 2, 'https://example.com/' + i));
  r.push(openCite(0, 2, 'https://example.com/0')); r.push(openCite(0, 2, 'javascript:alert(1)'));
  r.push(openCite(0, 99, 'https://example.com/bad'));
  r.push({type: 'response.completed', response: {status: 'completed', output: []}});
  assert.equal(r.finish().sources.items.length, 5); assert.equal(r.finish().sources.marks.length, 5);
});
test('本文後の失敗・引用欠落では答え直し可能としない', () => {
  const r = researchReader('openai');
  r.push(openResult([{url: 'https://example.com/'}])); r.push(openText('途中の本文'));
  assert.throws(() => r.push({type: 'response.failed'}), e => e instanceof ResearchStreamError && !e.beforeText);
  const other = researchReader('openai');
  other.push(openResult([{url: 'https://example.com/'}])); other.push(openText('本文'));
  other.push({type: 'response.completed', response: {status: 'completed', output: []}});
  assert.throws(() => other.finish(), e => e.code === 'no_citations' && !e.beforeText);
});
test('pause_turnを正常完了にせず、継続が必要な停止理由として区別する', () => {
  const r = researchReader('anthropic'); r.push(result());
  r.push({type: 'message_delta', delta: {stop_reason: 'pause_turn'}}); r.push({type: 'message_stop'});
  assert.throws(() => r.finish(), e => e.code === 'pause_turn' && e.beforeText);
});

const fetched = (index, url, source = {type:'text', data:'根拠の本文😀'}) => ({type:'content_block_start', index,
  content_block:{type:'web_fetch_tool_result', content:{type:'web_fetch_result', url,
    content:{type:'document', title:'直接取得したページ', source}}}});
const docCite = (index, document_index = 0, extra = {}) => ({type:'content_block_delta', index,
  delta:{type:'citations_delta', citation:{type:'char_location', document_index, start_char_index:0, end_char_index:4, ...extra}}});

test('直接取得した文書の引用は取得URLへ結び、引用側のURL・題名を使わない', () => {
  const r=researchReader('anthropic');
  r.push(fetched(0,'https://official.example/'));r.push(start(1));
  r.push(docCite(1,0,{url:'https://wrong.example/',document_title:'偽の題名'}));
  r.push(delta(1,'確認した事実😀'));r.push(endBlock(1));end(r);
  const value=r.finish();
  assert.equal(value.sources.items[0].url,'https://official.example/');
  assert.equal(value.sources.items[0].title,'直接取得したページ');
  assert.deepEqual(value.sources.marks,[{at:value.text.length,n:1}]);
});

test('検索・取得の引用を重複除去し、pause_turn後も取得文書の番号を維持する', () => {
  const r=researchReader('anthropic');
  r.push(fetched(0,'https://example.com/'));r.push(start(1));r.push(delta(1,'初回'));r.push(cite(1));r.push(endBlock(1));
  r.push({type:'message_delta',delta:{stop_reason:'pause_turn'}});r.push({type:'message_stop'});r.beginTurn();
  r.push(fetched(0,'https://second.example/'));r.push(start(1));r.push(docCite(1,0));r.push(delta(1,'続き'));r.push(endBlock(1));
  r.push(start(2));r.push(docCite(2,1));r.push(delta(2,'別文書'));r.push(endBlock(2));end(r);
  const value=r.finish();assert.equal(value.sources.items.length,2);
  assert.deepEqual(value.sources.marks,[{at:2,n:1},{at:4,n:1},{at:7,n:2}]);
});

test('危険な取得URL・空本文・未知の文書番号・不正な引用範囲を根拠にしない', () => {
  const r=researchReader('anthropic');
  r.push(fetched(0,'javascript:alert(1)'));r.push(fetched(1,'https://empty.example/',{type:'text',data:''}));
  r.push(fetched(2,'https://safe.example/'));r.push(start(3));r.push(delta(3,'本文'));
  for(const [doc,extra] of [[0,{}],[1,{}],[-1,{}],[3,{}],[2,{end_char_index:99}],[2,{start_char_index:4,end_char_index:2}],
    [2,{start_char_index:.5}],[2,{type:'page_location',start_page_number:0,end_page_number:1}]])r.push(docCite(3,doc,extra));
  r.push(docCite(3,2));r.push(endBlock(3));end(r);
  assert.deepEqual(r.finish().sources.items.map(x=>x.url),['https://safe.example/']);
  const failed=researchReader('anthropic');failed.push(fetched(0,'https://empty.example/',{type:'text',data:''}));end(failed);
  assert.throws(()=>failed.finish(),e=>e.code==='no_url_search_result'&&e.beforeText);
});

test('PDFのページ引用と文書ブロック引用も取得済みURLへ結び、取得エラーを文書に数えない', () => {
  const r=researchReader('anthropic');
  r.push({type:'content_block_start',index:0,content_block:{type:'web_fetch_tool_result',content:{type:'web_fetch_tool_result_error',error_code:'max_uses_exceeded'}}});
  r.push(fetched(1,'https://official.example/report.pdf',{type:'base64',data:'JVBERg=='}));
  r.push(start(2));r.push(docCite(2,0,{type:'page_location',start_page_number:1,end_page_number:2}));r.push(delta(2,'PDF'));r.push(endBlock(2));
  r.push(start(3));r.push(docCite(3,0,{type:'content_block_location',start_block_index:0,end_block_index:1}));r.push(delta(3,'補足'));r.push(endBlock(3));end(r);
  assert.deepEqual(r.finish().sources.marks,[{at:3,n:1},{at:5,n:1}]);
});
