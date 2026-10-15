// A3実装前の確認資料。保存済みの合成討議だけを読み、通信・キーの読み込みは行わない。
// 実行: node .github/scripts/prepare-magi-a3-review.mjs --prepare
// 本文と本人の採点はGit管理外に置く。既存の採点ファイルは上書きしない。
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const names = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'];
const sources = [
  'workers/.wrangler/magi2-dialogue-a1/worker-light-2026-10-13T12-42-35-613Z.json',
  'workers/.wrangler/magi47-quality/candidate.json',
];

export function extractDebate(row) {
  assert(row.complete === true || row.completed === true, '完了した記録が必要');
  const opinions = names.map(codename => {
    const events = row.events.filter(e => (e.event || e.name) === 'persona'
      && e.data?.codename === codename && [1, 2].includes(e.data.round));
    assert.equal(events.length, 2, '各人格の第1回・第2回が必要');
    const views = [1, 2].map(round => {
      const e = events.find(e => e.data.round === round);
      assert(e && !e.data.absent && typeof e.data.text === 'string' && e.data.text.trim(), '欠席・空の意見は除外');
      // 統合の結論や旧判定、第3回以降は本人の期待値を付ける資料に出さない。
      return { round, text: e.data.text };
    });
    return { codename, name: events[0].data.name, views };
  });
  return opinions;
}

export function buildReview(a1, quality, fixture, provenance) {
  assert.equal(a1.input_hash, hash(fixture.text), 'A1の原質問が測定時と一致しない');
  const inputs = new Map(JSON.parse(fixture.text).cases.map(c => [c.id, c]));
  const ordinary = a1.results.filter(r => r.group === 'ordinary');
  const consult = quality.results.filter(r => r.kind === 'consult' && r.theme === 'light' && /^c(?:[1-9]|10)$/.test(r.id));
  assert.equal(ordinary.length, 20, 'A1の通常入力20件が必要');
  assert.equal(consult.length, 10, '先行評価の独立した相談10件が必要');
  const rows = [...ordinary.map(row => {
    const input = inputs.get(row.id);
    assert(input?.group === 'ordinary' && input.expected === 'none', '合成の通常入力だけを使う');
    return { row, input: input.text, source: 0, report: a1 };
  }), ...consult.map(row => ({ row, input: row.input, source: 1, report: quality }))];
  assert(rows.every(r => typeof r.input === 'string' && r.input.trim()), '質問本文が必要');
  assert.equal(new Set(rows.map(r => r.input)).size, 30, '質問の重複');
  return {
    version: 1, split: 'tune-proposal', created_at: new Date().toISOString(),
    status: 'awaiting_owner_labels_and_replay_scope',
    reviewed_by: null, reviewed_at: null,
    limitations: [
      '保存済みの旧版の合成評価を再利用する案。現行Workerによる新規収集ではない。',
      '相談のほか一般説明・挨拶・曲案内を含む。A3の調整用として使う範囲は本人未確認。',
      'A3の期待値は未記入。元のA1の無害判定をA3の正解に流用していない。',
      '判定用20件は未作成。別の機会に作成し、調整完了までAPIへ送らない。',
      'Haiku 5.5 mediumの判定・質問生成、旧Lunaとの比較、指示とJSONスキーマの確定、実API評価は未実施。',
    ],
    sources: provenance,
    cases: rows.map(({ row, input, source, report }, i) => ({
      id: `tune-${String(i + 1).padStart(2, '0')}`, input,
      input_hash: hash(input), source_index: source, source_id: row.id,
      captured_at: report.date, worker_hash: report.worker_hash || report.fingerprint,
      round: 2, max_rounds: 5, earlier_messages: [], context: '',
      debate: extractDebate(row),
      expected: { next_step: null, targets: [] }, reviewed_by: null, reviewed_at: null,
    })),
  };
}

export function reviewMarkdown(review) {
  const proposed = review.cases.some(c => c.expected?.next_step);
  const label = c => {
    const step = c.expected?.next_step;
    if (step === 'answer') return 'そのまま答える';
    if (step === 'ask_user') return '利用者に聞き返す';
    if (step === 'ask_personas') return `人格に追加で聞く（${c.expected.targets.join('・')}）`;
    return '未記入';
  };
  const cell = s => String(s || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [
    `# A3 調整用の期待値${proposed ? '案（本人確認待ち）' : 'を付ける資料（保存済み記録の再利用案）'}`, '',
    '30件の第2回までの討議です。現行Workerの新規収集ではありません。一般説明・挨拶・曲案内も含むため、調整に使う範囲を先に確認します。', '',
    proposed
      ? '本人の依頼により、エージェントが期待値と理由を仮入力しました。まず下の一覧を見て、違和感のある件だけ番号と修正内容を教えてください。各番号の先に元の相談と3人格の討議があります。本人の確認者・日時は未記入です。'
      : '各件に、本人として期待する次の動きを付けてください。', '',
    '判断するのは「この討議の後、MAGIに次に何をしてほしいか」です。元の統合回答・Lunaの判定・A3の結果は表示していません。', '',
    '- A / answer: この材料で答える。価値観が割れただけなら本人が決める。',
    '- P / ask_personas: 人格に聞けば、理由・具体性・判断が良くなる論点が残る。対象はM（熱狂者）・B（人間主義者）・C（戦略家）。複数ならMBなど。',
    '- U / ask_user: 利用者しか知らない情報が欠け、答えの方向が大きく変わる。人格の推測では埋められない。', '',
    '記入例: `tune-01 A` / `tune-02 P BC` / `tune-03 U`。必要なら除外したい件も指定してください。', '',
    proposed ? '候補と理由はエージェントの案で、本人の採用済みの正解ではありません。' : 'これは期待値の未記入資料です。',
    '判定役は両テーマ共通のHaiku 5.5・mediumで、次の動きと質問を1回のJSONで作る方針です。指示・JSONスキーマの確定や品質合格を示しません。本文はGit管理外に保持します。', '',
    ...(proposed ? [
      '## 確認用一覧', '',
      ...['answer', 'ask_personas', 'ask_user'].map(step => `${{answer:'そのまま答える',ask_personas:'人格に追加で聞く',ask_user:'利用者に聞き返す'}[step]}: ${review.cases.filter(c => c.expected?.next_step === step).length}件`), '',
      '人格への追加質問を期待する例が0件なら、この資料だけではその判定の検出・対象人格の選択を評価できません。件数合わせで期待値を変えず、追加例の不足として残します。', '',
      '| 番号 | 相談の要点 | 次の動きの案 | 理由 |',
      '| --- | --- | --- | --- |',
      ...review.cases.map(c => `| [${c.id}](#${c.id}) | ${cell(c.proposal?.summary || c.input)} | ${cell(label(c))} | ${cell(c.proposal?.reason)} |`), '',
    ] : []),
    ...review.cases.flatMap(c => [
      `## ${c.id}`, '', `取得日: ${c.captured_at} / 元のID: ${c.source_id}`, '',
      ...(c.expected?.next_step ? [
        `**次の動きの案: ${label(c)}**`, '',
        `理由: ${c.proposal?.reason || '未記入'}`, '',
        ...(c.proposal?.review_note ? [`確認のポイント: ${c.proposal.review_note}`, ''] : []),
        ...(c.proposal?.next_action ? [`次の返答の例: ${c.proposal.next_action}`, ''] : []),
        '状態: エージェント仮入力・本人確認待ち', '',
      ] : []),
      '### 利用者の質問', '', c.input, '',
      ...c.debate.flatMap(p => [`### ${p.codename}（${p.name}）`, '',
        ...p.views.flatMap(v => [`第${v.round}回: ${v.text}`, ''])]),
      `期待値: ${c.expected?.next_step ? `${c.expected.next_step}${c.expected.targets.length ? ' / ' + c.expected.targets.join(', ') : ''}（仮入力）` : '（未記入）'}`, '',
    ]),
  ].join('\n');
}

function main() {
  assert.deepEqual(process.argv.slice(2), ['--prepare'], 'use --prepare (通信は行わない)');
  const dir = resolve(root, 'workers/.wrangler/magi2-dialogue-a3');
  const output = resolve(dir, 'tune-review.json'), markdown = resolve(dir, 'tune-review.md');
  assert(!existsSync(output) && !existsSync(markdown), '本人の採点を保護するため既存ファイルは上書きしない');
  const texts = sources.map(p => readFileSync(resolve(root, p), 'utf8'));
  const fixturePath = '.github/scripts/fixtures/magi-dialogue-a1-final.json';
  const fixture = { text: readFileSync(resolve(root, fixturePath), 'utf8') };
  const provenance = sources.map((path, i) => ({ path, sha256: hash(texts[i]) }));
  const review = buildReview(...texts.map(JSON.parse), fixture, provenance);
  review.input_fixture = { path: fixturePath, sha256: hash(fixture.text) };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(review, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(markdown, reviewMarkdown(review), { flag: 'wx' });
  console.log(JSON.stringify({ cases: review.cases.length, status: review.status, output, markdown, paid_api_calls: 0 }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
