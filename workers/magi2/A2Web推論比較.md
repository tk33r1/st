# A2 Web回答の推論比較（medium採用・未公開）

2026-10-14。最新15件を両テーマで、同じ最終指示・同じWorkerコードからlow/mediumで比較した。実API・ローカルWorker・合成入力。各結果はGit管理外の`worker-fresh-low-final.json`・`worker-fresh-medium-final.json`、集約は`final-web-comparison.json`。

| テーマ | 推論 | 引用付き完了 | 書き始め中央値 | Web呼出しの平均概算 |
| --- | --- | --- | --- | --- |
| ライト | low | 15/15 | 3,971ms | $0.01137 |
| ライト | medium | 15/15 | 5,606ms | $0.01469 |
| ダーク | low | 14/15 | 4,213ms | $0.02152 |
| ダーク | medium | 15/15 | 6,581ms | $0.02241 |

lowのダークの地震情報は、本文後に引用欠落でerrorになった。別会社の本文を混ぜず、失敗として保存した。mediumは両テーマとも全15件が引用付きで完了した。

最新の物理学賞は、最終lowのライトが2025年と回答した一方、mediumは2026年のFrancis Halzenと回答した。[AIPの2026年10月6日の発表](https://www.aip.org/aip/aip-congratulates-2026-nobel-prize-winner-in-physics)と照合するとmediumが一致した。国勢調査と博物館の開館時間は、原典優先の指示を補強した最終low/mediumの両方で改善している。すべての改善を推論強度だけの効果とは扱わない。

mediumでも、ダークのANAの手荷物で機内持込の説明が欠ける例、最新の公式ページを直接確認できない例、確認時刻の前後を取り違える説明が残る。引用があることと回答の正確さを区別し、原典の全件照合が終わるまでは公開合格にしない。

費用は実使用量・検索回数を[OpenAI通常料金](https://developers.openai.com/api/docs/pricing)・[Haiku通常料金とキャッシュ](https://platform.claude.com/docs/en/models/haiku-5-5/overview)・[Web検索料金](https://platform.claude.com/docs/en/about-claude/pricing)（2026-10-14確認）で計算した短い文脈の概算。Web呼出しだけで、Jev・タイトル・サイト案内・通知・請求額は含まない。各回のキャッシュ状態と検索回数にも左右される。

2026-10-14、本人の「はい、問題ありません」を受け、Web回答だけmediumを採用した。通常の事実説明とWebなしの答えはlowを維持する。`RESEARCH.reasoning_effort`を`FACT_ANSWER.reasoning_effort`と分けてある。これは検証計画§0.3の比較後の採用で、本番公開の承認ではない。残る品質確認を続ける。
