# サイト内検索 Phase 4 実装計画書

実装済み（2026-10-12）。正本はコード。404・日刊2誌・tools/gameを共通ロジック・UIへ接続して本番公開した。Linux・Pages・本番Jev・URL／計測・停止／復帰の結果と制約は[公開評価](site-search-phase4-release-evaluation.md)。OSのIMEと実機読み上げは未検証。本書は公開時点で凍結し、以後の運用はコードと公開評価を参照する。

要件は[PRD](site-search-phase4-prd.md)、契約は[設計書](site-search-phase4-design.md)、合否は[検証計画書](site-search-phase4-verification.md)。Phase 0〜3と区別して`P4-Txx`を使う。

## 1. 進め方

- 今回の会話で指定された範囲を4資料へ反映する。辞書の版・測定環境・既存の契約などの実装上の判断は、コードと検証可能な記録で固定する。
- 表示と検索範囲はPRD8章のD01〜D07で確定済み。同じ選択を再確認せず、fixtureへ反映する。tools/gameの②と4画面の共通ロジック・UIを含める。
- まず固定fixtureでデータ量と読みを測り、その後に索引生成・共通照合・各画面の接続へ進む。例示2語だけで方式を決めない。
- レビューできる差分に分け、生成器と、それを必要とする画面の公開単位を揃える。作業IDごとのコミット数は固定しない。
- 資料作成の依頼に、実装・push・本番公開を含めない。以後の実装・公開は本人の指示に沿って進める。既に与えられた指示を同じ操作のために再確認する規則は設けない。
- 既存のPhase 3の評価セット・本文・語の補完器を変えない。今回の①と新scopeの②は別fixtureに置き、既存②の回帰と新scopeのJev評価を分ける。

## 2. 作業と完了条件

| ID | 作業 | 依存 | 完了条件 | 検証 |
| --- | --- | --- | --- | --- |
| P4-T01 | PRD・設計書・実装計画書・検証計画書 | 現行コードと今回の依頼 | 現状、変更範囲、全ページと全文検索の違い、4資料の対応が明記される | P4-V00 |
| P4-T02 | 解析器・辞書・容量・精度の事前試験 | T01 | 正確な依存版・ハッシュ・ライセンス・Python対応を固定。現行と10,000件のfixture、容量・追加ビルド時間、読みの欠けを記録。PRDの目標が成立する構成を確認 | V03・V04・V17・V18 |
| P4-T03 | 共通の読み生成と補正の契約 | T02 | B/C分割・フィールド・内容語・多読・未知語・重複の方針を実装。解析前はかなの表記を維持し、抽出後に照合用のかなを統一。補正には根拠。出力が再現可能 | V03・V04・V09 |
| P4-T04 | 全サイト・一覧の文字／読み索引と出荷ビルド | T03 | 404のブラウザ用基礎索引とrank_generation、tools/gameの個別読みを同じ生成器で作り、最終出荷検査より前へ組み込む。Worker用索引を保持し、公開候補の写像・ID・hash・固定依存・失敗時の未公開を確認。ツリーの埋め込みはT08で追加 | V01・V05・V09・V10・V19 |
| P4-T05 | 日刊の年別読み索引とmanifest | T03 | 2誌×全年度、空の年、年度追加、混在を扱う。履歴保存・既存生成の前に辞書処理を足さず、出荷ビルドで作る。Worker用索引を保持 | V05・V09・V10・V16 |
| P4-T06 | ブラウザの共通照合・検索UI | T03・T04のfixture・T15 | 共通AND・旧文字一致の互換照合・語の読み前方一致・途中子音・順位・件数が通る。search-ui.js/CSSで①②の状態・IME・サジェスト・描画・中止・追加表示を実装。新UIはcreateRankClient/readRankResponseを使い、旧rank/readResponseの描画・状態・計測を新UIの追加読込なしで維持。設計書4.4の自動復帰1回をindex_updatingにも適用し、専用の再試行操作を追加しない | V03〜V08・V10・V16・V17・V23 |
| P4-T07 | 404の①②を共通UIへ接続 | T04・T06・T16 | DJ・Thought・通常ページ・号ページの題名等を検索できる。個別の検索制御を共通部品へ移し、③だけを追加操作にする。URL・縮退・①②の重複・100件ずつの追加表示を確認。3一覧は縮退用へ | V01・V02・V03・V05・V06・V08・V10・V15・V23 |
| P4-T08 | 404のツリー生成とナビゲーション | T04、T01の構造 | 最終出荷検査より前に出荷HTMLへリンク付きツリーを埋め込む。同階層の共通CSS、第一階層の全表示、親リンクと開閉の分離、日英・JS無効・到着区画の展開を確認 | V11〜V14・V18・V19 |
| P4-T09 | 日刊の①②を共通UIへ接続 | T05・T06・T16 | 媒体adapterに全年度取得・filtersを宣言し、個別の検索制御・描画を撤去。①②の連携・自動復帰・追加表示・IME・焦点・件数を確認。テンプレートに共通JS/CSSを追加 | V03・V05〜V08・V10・V15・V23 |
| P4-T10 | tools/gameの①②を共通UIへ接続 | T04・T06・T16 | 正本と個別読みを照合し、全サイト索引をブラウザで取得しない。新scopeのJev、category/genre、共通結果、sort、受け渡し、通常カタログの接続を確認。同一サイトの入口を使い、検索の送信説明を更新。CSP・個別ツールの非送信・解析停止を保持 | V05・V08・V10・V15・V16・V21・V23・V24 |
| P4-T11 | 固定fixtureの全体検証と実機IME | T07〜T10・T17 | 未見セットの読み・順位と大規模速度が合格。4画面の共通UI・ロジックと新scopeの②を検証。実機IME・読み上げ・ツリーを確認 | V00〜V18・V21〜V24 |
| P4-T12 | 公開資料・参照・全号再生成と出荷確認 | T11 | AGENTS・Worker運用・JEV・AI_MODELSの予定箇所を更新。最新botを取り込んで共通JS/CSSの参照を統一、全号の内容・dateModifiedを維持。出荷ビルドと旧／新Worker契約が合格 | V16・V19・V21・V24 |
| P4-T13 | Worker・静的UIの公開と実通信・復帰確認 | T12、本人の公開指示 | 新入口と新scopeの停止・認可を確認してWorkerを先に公開。評価合格scopeを有効化し、共通UIを公開。本番版・404・2誌・2一覧・解析と検索通信を最小要求で確認。scope停止・Pages復帰の経路がある | V15・V20〜V24 |
| P4-T14 | Phase 4完了記録 | T13 | 静的／Worker公開版・時刻・件数・依存・hash・容量・速度・Jev評価・スクリーンショット・未実施の限界を固定 | V20・V22 |
| P4-T15 | 共通検索UI・scope・通信契約を固定 | T01 | 設計書3.4・4.5・4.6のadapter・状態・DOM・新入口・旧契約互換をfixture化。旧404／日刊HTML＋新JS、Worker旧版／ブラウザ新版と逆方向、更新共有・間隔制限・未解消時の回数／Jevゼロを固定。送信契機・filters・並べ替え・公開対象・説明を固定 | V10・V16・V21・V23・V24 |
| P4-T16 | Workerのtools/game scopeと共通入口 | T15・T04・T05のfixture | 固定routeと新入口を既存②へ接続。scope/filtersの先行適用、snapshot・候補・キャッシュ・共有上限・停止・評価専用アクセスを実装。新入口ではgeneration照合を回数・Jevより前に行い、設計書4.5の共有更新・1要求1回・間隔制限・未解消時index_updatingを実装。旧入口の契約を維持し、scope違い・不正要求・未解消の版ずれがAIと回数を使わない | V10・V16・V21・V24 |
| P4-T17 | 新scopeのJev評価とsmoke | T16・T10 | APIを見る前にtune/finalの正解を固定し、候補到達・精度・無回答・filters・揺れ・時間・費用を評価。新scopeの設定とrevision、評価記録、ai_models.pyの本番同形smokeを揃える | V22 |

T04/T05は同じ読み生成を使う。T08は④のような新しい検索機能ではなく、404の既存ナビゲーションの置き換え。T07と到着区画の表示を合わせて確認する。

追加IDのT15〜T17は末尾に置くが、実行順はT01→T15、T02〜T05のfixture→T06/T16→T07〜T10→T17→T11〜T14。番号順に実行せず、依存関係に従う。

## 3. 予定するファイル

| 種類 | ファイル |
| --- | --- |
| 今回作る資料 | `assets/site-search-phase4-{prd,design,plan,verification}.md` |
| Python共通処理・出荷生成 | `.github/scripts/japanese_search.py`・`search-reading-index.py`・`search-tree.py` |
| 固定依存・読み補正 | `.github/scripts/search-reading-requirements.txt`・`config/search-readings.json` |
| 共通ブラウザ処理 | `assets/japanese-search.js`・`assets/search-ui.js`・`assets/search-ui.css`・`assets/search-data.js`、既存`assets/site-search.js`・`assets/search-analytics.js`の必要な接続 |
| Workerと公開設定 | `workers/magi2/search-scope.js`・`site-rank.js`・`src/index.js`・`personas.js`・`wrangler.toml` |
| 画面 | `404.html`・`job/assets/daily-ui.js`・`tools/index.html`・`game/index.html` |
| テンプレートと公開ビルド | `.github/scripts/daily_engine.py`・`build.sh`、対象の検証workflow |
| 検証 | Pythonの生成契約、Nodeの共通照合／UI契約、旧／新Workerと画面の回帰、`.github/site-search/phase4/`の新scope fixture、Jev評価、`ai_models.py`のsmoke |
| 運用 | `AGENTS.md`・Worker README・`.github/JEV.md`・`.github/AI_MODELS.md`、新scopeの評価記録、完成後の`assets/site-search-phase4-completion.md` |
| 出荷時だけ生成するもの | 読み・基礎データは[設計書2.3](site-search-phase4-design.md)の配置表。ほかに`_site/404.html`の子ページツリー |

ファイル名は実装時に整理できるが、4資料の参照と生成物の契約を同時に揃える。非公開のPython依存・補正の正本を公開ディレクトリへ移さない。

## 4. 公開単位

| 単位 | 内容 | 条件 |
| --- | --- | --- |
| 資料作成時 | 4資料 | 2026-10-11に作成。その後の本人の指示で実装を開始。mainへのpushは未実施 |
| 実装時 | 生成器・固定依存・共通JS/CSS・4画面の①②・404ツリー・Workerの新入口とscope・全参照・運用資料 | T11/T12の検証を終え、互換Workerを先に公開。評価済みscopeの有効化と静的UIを揃える |
| 復帰時 | scope停止と以前のPagesの静的公開版 | 新scopeだけを停止でき、開いた新画面は①へ縮退。旧契約を維持したWorkerとPagesの復帰を確認 |

Workerの再デプロイを今回に含める。新入口と`tools`・`game`を実装し、初回は新scopeを公開利用の許可から外す。新入口でも`SITE_RANK_EVAL_SCOPES`と評価用キーの制限を適用して、評価専用要求だけを通す。合格後に許可を`site,nitori,retail,tools,game`へ広げ、新UIを公開する。既存scopeと旧入口は維持し、新UIを先に公開して未対応Workerへ送らない。

障害時はtools/gameだけを`SITE_RANK_SCOPES`から外してWorkerを先に出し、①を維持する。必要なら以前のPagesへ戻す。新UIが開いたタブのため、新入口を即座に削除する巻き戻しは避け、disabledと旧入口を返せる互換版を残す。ルート変更・Worker版・設定・評価専用キーの片付けを公開記録へ残す。

共通JS/CSSを更新したら `?v=YYYYMMDD_n` を上げ、全読み込みページ・テンプレート・既存号を同じpushに含める。変更しない共通ファイルの版を機械的に上げない。root `index.html`の外部参照は増やさない。

古いquery付きのJS URLも新しいファイルを返しうるため、同時pushだけで旧HTMLとの互換性を保証しない。`site-search.js`の旧rank/readResponseを互換APIとして残し、新UIは別APIへ接続する。旧404・日刊のHTMLと関連する旧JSをfixtureへ固定し、新しいsite-search.jsだけを差し替えた回帰をT06/T12の公開条件に含める。新UI用JS/CSSを与えなくても旧画面の②・状態・重複除去・中止・計測が動くことを確認する。

## 5. 再生成・並行更新

1. 作業状態を確認し、最新の `origin/main` と日刊botの更新を取り込む。既存の他作業を巻き込まない。
2. 号の再生成は `daily_engine.py` と各媒体の `--rebuild` を使う。生成物は手編集しない。
3. 前後を比較し、共通JS/CSS参照と検索領域の置き換え以外の本文・履歴・記事ID・RSS・日刊基礎索引・generation・dateModifiedが変わっていないことを確認する。検索領域のDOM・文言・プライバシー説明の変更は今回の意図した差分として記録する。
4. 再生成だけのHTMLのコミットに `Date-Sync: skip` を付ける。404や一覧の実質的な更新は必要なら別コミットにし、実質変更のdateModified同期まで止めない。
5. 共通JS/CSSと参照HTMLを同じpushで出す。サイトへ出すコミットには `[skip ci]` を付けない。
6. 新しい号が途中で増えたら差分を取り込み、その号の参照も揃えてから公開する。履歴JSONを古い版で上書きしない。

## 6. 検証と公開記録

fixture・実機・回帰・公開証跡の正本は[検証計画書3〜7章](site-search-phase4-verification.md)。共通の生成・照合契約は同じfixtureで検証し、各画面では接続・固有の文字照合・filters・並べ替え・操作を確認する。画面ごとに同じ読み変換テストを複製しない。R/T/VのIDは要件と作業の対応として保持する。

## 7. 進捗（2026-10-12）

| 作業 | 状態 | 記録 |
| --- | --- | --- |
| P4-T01 | 完了 | 4資料を実装済みとして凍結。正本はコード |
| P4-T02 | 自動検証完了 | 固定依存・60語・10k・8MiB・Windows／Linuxの時間とRAMを記録。Pages実ビルド成功。初回入力と準備中停止、Pages RAM取得不可を明記 |
| P4-T03 | 実装・検証完了 | B/C・生バイトhash・ID順・未知語・全件保持。補正は空、読みfinal29/30 |
| P4-T04・T05 | 公開済み | 678ファイル、サイト96ページ、日刊411記事の出荷生成とmanifest照合 |
| P4-T06 | 実装・自動検証完了 | 共通照合・UI・5scope・100入力p95・小画面・焦点・通知・Chromium IME・復帰1回。OSのIME／読み上げは未検証 |
| P4-T07・T09・T10 | 公開済み | 404・2誌・tools/gameの①②、各画面の条件と一覧を保持。本番実検索5scopeが合格 |
| P4-T08 | 公開済み | 96ページのリンク付きツリー、JS無効の開閉・遷移を確認。実機読み上げ未検証 |
| P4-T15・T16 | 公開済み | 新入口・5scope・世代先行照合・共有取得・上限・評価認可。旧入口3scopeの本番互換も確認 |
| P4-T11 | 自動検証完了・実機未検証 | 読み・正式入力p95・準備／メモリ・CDP IME・画面を確認。初回入力と準備停止の制約を記録 |
| P4-T17 | 公開評価済み | 固定80問×2回＋smoke、本番final40問・5画面。tools0.4/rev1、game0.5/rev2。原作の1問に続編が混ざる限界を記録 |
| P4-T12 | 完了 | 最新mainと20261012号を統合、61号の参照を生成器で更新。後続botの日付同期を保持 |
| P4-T13・T14 | 公開・自動確認完了 | Linux／Pages／Worker／本番URL・実検索、scope停止と①、Pages旧版→新版の復帰、評価キー片付け、公開評価を記録。実機IME／読み上げは別途 |


実装の経緯は[実装記録](../.github/site-search/phase4/implementation-progress.md)。最終の版・検証結果・再現手順・未確認範囲は[公開評価](site-search-phase4-release-evaluation.md)。
