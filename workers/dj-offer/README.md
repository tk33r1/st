# tk-st-dj-offer — 出演オファーフォームの受け口

`dj/index.html` の OFFER セクションのフォームを受け取り、内容をメールに載せて転送する
Worker。ルートは `tk.st/dj/api/offer/*`、実装は `src/index.js` の1ファイル。

```
POST /dj/api/offer/send
  { name, org, email, contact, event, date, venue, gear, message, website, token }
  → 200 { ok: true }  /  4xx・5xx { error: "画面に出す日本語" }
```

## 設計のメモ

- **D1 は持たない**。届いた内容はメールに載せるだけで Worker 側には何も残さない。
  オファーは件数が知れているうえ控えは受信箱に残るので、DB を足すと運用対象が増える
  だけになる。
- **宛先と差出人はリポジトリに書かない**。`OFFER_TO` / `OFFER_FROM` は secret で渡す。
  このリポジトリは公開で、`contact/index.html` も同じ理由でアドレスを平文にしていない。
- **スパム対策は Turnstile とハニーポットの二段**。Turnstile はサーバー側で `siteverify`
  を通すまで信用しない。ハニーポット（`website` 欄）が埋まっていたら、弾いたと気付かせ
  ないよう成功と同じ応答を返して黙って捨てる。
- **レート制限は isolate のメモリだけの best-effort**（同一 IP から10分で3件）。
  Cloudflare は isolate をいくつも立てるので抜けられるが、本命は Turnstile で、
  これはその先の保険。ここのために D1 も KV も足さない。
- **検証の順番は「入力 → レート制限 → Turnstile」**。書き間違いのやり直しで送信枠と
  Turnstile のトークン（使い捨て）を潰さないため。入力で弾いた分はメールも外部リクエスト
  も発生しないので、数え漏らしても損はない。
- **`Reply-To` に送信者のアドレスを載せる**。`From` に載せると SPF/DKIM で落ちるので、
  `From` は必ず認証済みドメインのアドレスにする。受信したメールにそのまま返信すれば
  相手へ届く。

## 初期設定

### 1. Resend

1. <https://resend.com> にサインアップ（無料枠は月3,000通）。
2. **Domains** で `tk.st` を追加し、表示される DNS レコード（MX / TXT / DKIM）を
   Cloudflare の DNS に登録する。tk.st は Cloudflare にあるので数分で `Verified` になる。
3. **API Keys** で送信専用のキーを作る（`re_` で始まる文字列。作成時にしか表示されない）。

### 2. Turnstile

`dj/index.html` は既存のサイトキー `0x4AAAAAACwi9fjjeeh8ujIK`（`contact/` と同じもの）を
使う。Cloudflare ダッシュボードの **Turnstile** で同じウィジェットの **Secret Key** を
控え、許可ドメインに `tk.st` が入っていることを確認する。

### 3. secret の登録

wrangler は `workers/wrangler` にしか入っていないので、そこから `--config` で指す。
`workers/dj-offer` で `npx` すると毎回ダウンロードが走る。

```bash
cd workers/wrangler
npx wrangler secret put RESEND_API_KEY        --config ../dj-offer/wrangler.toml
npx wrangler secret put TURNSTILE_SECRET_KEY  --config ../dj-offer/wrangler.toml
npx wrangler secret put OFFER_TO              --config ../dj-offer/wrangler.toml
npx wrangler secret put OFFER_FROM            --config ../dj-offer/wrangler.toml
```

| secret | 値 |
| --- | --- |
| `RESEND_API_KEY` | `re_` で始まるキー。Sending access・tk.st 限定で発行したもの |
| `TURNSTILE_SECRET_KEY` | サイトキー `0x4AAAAAACwi9fjjeeh8ujIK` と対の Secret Key |
| `OFFER_TO` | `dj@tk.st`（Cloudflare Email Routing で Gmail へ転送される） |
| `OFFER_FROM` | `人類踊狂計画 <dj@tk.st>` |

送信元と受信先を同じ `dj@tk.st` にしてある。通知の差出人と、こちらが返信するときの
差出人（Gmail の send-as）が揃うので、依頼者から見た連絡先が一本化される。Resend が
tk.st で DKIM 署名し、転送しても署名は壊れないので Gmail 側の判定も問題ない。

副作用として Gmail の一覧では差出人が「me」と表示される。フィルタは差出人ではなく
件名で作ること（件名には必ず `[DJ オファー]` が付く）。

`OFFER_FROM` のドメインは Resend で Verified になっているものにする。表示名を付ける
場合は `名前 <address@tk.st>` の形式で書く。

### 4. デプロイ

secret は Worker が存在しないと登録できないので、デプロイが先。secret は即時反映される
ため、登録後の再デプロイは要らない。

```bash
cd workers/wrangler
npx wrangler deploy --config ../dj-offer/wrangler.toml
npx wrangler secret list --config ../dj-offer/wrangler.toml   # 4つ揃ったか（値は出ない）
```

secret が1つでも欠けていると、フォームは 500 を返して「DM からご連絡ください」と表示する
（送信者には設定の事情を見せない）。

## 確認

`npx wrangler tail` でログを見ながらフォームを送る。Resend が拒否した場合は
`resend failed <status> <本文>` が出るので、たいていはドメイン未認証か `OFFER_FROM` の
ドメイン違いのどちらか。

ページ側の JS は Turnstile を**フォームが視界に入ってから**読み込む（`dj/index.html` の
`// 8. Offer Form`）。オファーを送る人はごく一部なので、全訪問者に外部スクリプトを
踏ませない。開発中にウィジェットが出ないときは、まずここまでスクロールしているか見る。
