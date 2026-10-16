// 保存記録の件数・参照hash・予算を照合するだけ。キー・ネットワーク・実機へは触れない。
// 以前の結果を最新コードの実モデル品質の合格へ読み替えない。
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url),raw=p=>readFileSync(new URL(p,root),'utf8');
const sources=[],sha=s=>createHash('sha256').update(s).digest('hex');
const read=p=>{const text=raw(p);sources.push({path:p,sha256:sha(text)});return JSON.parse(text);};
const unique=rows=>new Set(rows.map(r=>r.id)).size;
const a1=read('workers/.wrangler/magi2-dialogue-a1/worker-current-summary.json');
const a1fixture=read('.github/scripts/fixtures/magi-dialogue-a1-final.json');
const a1coverage={};
for(const [theme,summary] of Object.entries(a1.themes)){
 const rows=summary.batch_files.flatMap(file=>{
  const path='workers/.wrangler/magi2-dialogue-a1/'+file.path;
  assert.equal(sha(raw(path)),file.sha256,'A1参照記録のhash');return read(path).results;
 });
 assert.equal(rows.length,80);assert.equal(unique(rows),80);
 assert.deepEqual([...rows.map(r=>r.id)].sort(),a1fixture.cases.map(c=>c.id).sort());
 assert(rows.every(r=>r.complete&&r.status===200));
 a1coverage[theme]={saved:rows.length,detected:summary.detected,false_positives:summary.false_positives,
  human_review:summary.human_review,worker_hash:summary.worker_hash,latest_model_run:false};
}
const a2class=read('workers/.wrangler/magi2-dialogue-a2/classification-final-2026-10-14T01-44-05-560Z.json');
assert.equal(a2class.results.length,150);assert(a2class.complete);
const a2stable=read('workers/.wrangler/magi2-dialogue-a2/worker-coverage-final.json');
const a2verified=read('workers/.wrangler/magi2-dialogue-a2/worker-verified-source-final.json');
const a3collection=read('workers/.wrangler/magi2-dialogue-a3/collection-result.json');
const a3judge=read('workers/.wrangler/magi2-dialogue-a3/release-judge-result.json');
const a3repair=read('workers/.wrangler/magi2-dialogue-a3/release-v2-judge-result.json');
const a3final=read('.github/scripts/fixtures/magi-dialogue-a3-final-20261017.json');
assert.equal(a3final.cases.length,20);assert.equal(unique(a3final.cases),20);
assert(!a3final.cases.some(c=>a3collection.results.some(r=>r.input===c.input)));
const a3plan=read('workers/.wrangler/magi2-dialogue-a3/collection-full-plan-20261017.json');
assert.equal(a3plan.cases.length,20);
const a5original=read('workers/.wrangler/magi2-dialogue-a5/quality-result.json');
const a5repair=read('workers/.wrangler/magi2-dialogue-a5/quality-repair-result.json');
const a5plan=read('workers/.wrangler/magi2-dialogue-a5/quality-full-plan-20261017.json');
const a5fixture=read('.github/scripts/fixtures/magi-dialogue-a5-full-20261017.json');
assert.equal(a5fixture.cases.length,10);assert.equal(a5fixture.malice_source_ids.length,5);
assert.equal(a5plan.cases.reduce((n,c)=>n+c.questions.length,0),45);
const a5latest=new Map(a5original.results.map(r=>[r.id+':'+r.turn,r]));
for(const r of a5repair.results)a5latest.set(r.id+':'+r.turn,r);
assert.equal(a5latest.size,6);
const games=read('workers/.wrangler/auxiliary-haiku-20261017/games-comparison-result.json');
const gamesPlan=read('workers/.wrangler/auxiliary-haiku-20261017/games-comparison-plan.json');
const kabuki=read('workers/.wrangler/auxiliary-haiku-kabuki-20261017/games-comparison-result.json');
const kabukiFinal=read('workers/.wrangler/auxiliary-haiku-kabuki-20261017-short/games-comparison-result.json');
const kabukiPlan=read('workers/.wrangler/auxiliary-haiku-kabuki-20261017/games-comparison-plan.json');
const kabukiFinalPlan=read('workers/.wrangler/auxiliary-haiku-kabuki-20261017-short/games-comparison-plan.json');
const replay=read('workers/.wrangler/auxiliary-haiku-final-20261017/browser-replay.json');
assert.equal(games.results.length,9);assert(games.complete&&games.results.every(r=>r.completed));
assert.equal(kabuki.results.length,2);assert.equal(kabukiFinal.results.length,2);
assert(kabuki.complete&&kabukiFinal.complete&&kabukiFinal.results.every(r=>r.completed));
assert.equal(replay.results.length,7);assert(replay.results.every(r=>r.ok));
const dj=read('workers/.wrangler/dj-song-card-20261017/result.json');
const djPlan=read('workers/.wrangler/dj-song-card-20261017/plan.json');
assert.equal(dj.results.length,5);assert(dj.complete&&dj.results.every(r=>r.completed));
const android=read('workers/.wrangler/magi2-android-20261017/audit.json');
assert.equal(android.device.app_version,'5.1');assert.equal(android.paid_ai_calls,0);
assert(android.title_hashes_match&&Object.values(android.checks).every(v=>v===true));
const ledger=read('workers/.wrangler/magi2-dialogue-a2/budget-20261015.json');
const reserved={};for(const r of ledger.reservations)reserved[r.provider]=(reserved[r.provider]||0)+Math.ceil(r.max_usd*1e6);
const total=Object.values(reserved).reduce((n,v)=>n+v,0);
assert(total<=800000&&reserved.openai<=400000&&reserved.anthropic<=400000);
for(const r of games.results.concat(kabuki.results,kabukiFinal.results,dj.results))assert.equal(ledger.reservations.filter(x=>x.request_hash===r.request_hash).length,1);
const report={date:new Date().toISOString(),network_calls:0,new_quality_pass:false,
 a1:a1coverage,
 a2:{classification_records:a2class.results.length,stable_saved:a2stable.results.length,verified_source_saved:a2verified.results.length,
  limitation:'番号・記録の存在の照合。全引用の意味の支持と最新コードの新規30回答の合格ではない。'},
 a3:{old_collection:a3collection.results.length,old_judge_unique:unique(a3judge.results.concat(a3repair.results)),
  independent_new_inputs:20,independent_model_runs:0,collection_only_ceiling_usd:a3plan.maximum_usd},
 a4:{owner_copy_approval:'既存承認あり',physical_update_notice:'4.6の通知・ダウンロード・5.1への上書き・履歴継承を実機確認'},
 a5:{old_conversations:2,old_latest_responses:a5latest.size,new_conversations:10,new_followups:20,new_malice_placements:10,
  model_runs_for_new_suite:0,offline_planned_calls:a5plan.requests.length,
  primary_only_estimate_usd:Math.round(a5plan.mock_primary_reservation_usd*1e6)/1e6,
  limitation:'模擬の長い履歴を使った一次経路の概算。切替・再試行・実モデルの意味の評価は含まない。'},
 games:{new_paid_calls:13,reused_haiku_responses_in_final_seven:4,screen_replays:7,
  reserved_usd:Math.round((gamesPlan.total_max_usd+kabukiPlan.total_max_usd+kabukiFinalPlan.total_max_usd)*1e6)/1e6,
  final_agent_review:'修正後の単一7場面は字数・正常終了・指定形式・意味の整合を確認。旧Kabukiの矛盾と中間77字の不合格も保持。全プレイの保証ではない。本番反映未実施。'},
 dj:{new_paid_calls:dj.results.length,reserved_usd:djPlan.maximum_usd,live_search_calls:0,
  decision:'A2の検索品質比較と2026-10-17本人方針により、検索からカード生成までLuna継続。混成は採用しない。',
  limitation:'固定原典のカード生成5件の確認。実検索の品質・全段階25秒の合格ではない。'},
 android:{app_version:android.device.app_version,history_before:android.history_before,history_after:android.history_after,
  title_hashes_match:android.title_hashes_match,checks:android.checks,paid_ai_calls:android.paid_ai_calls,limitations:android.limitations},
 budget:{reserved_usd:Object.fromEntries(Object.entries(reserved).map(([p,v])=>[p,v/1e6])),total_reserved_usd:total/1e6,
  remaining_total_usd:(800000-total)/1e6},sources};
const dir=new URL('workers/.wrangler/magi2-dialogue-full-20261017/',root);mkdirSync(dir,{recursive:true});
writeFileSync(new URL('coverage-audit.json',dir),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,sources:sources.length}));
