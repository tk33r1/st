
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": "https://tk.st/tools/qr-atelier/#webapp",
        "name": "QR Atelier - おしゃれなQRコード作成ツール",
        "description": "セルやマーカーの形、グラデーション、中央ロゴ、フレーム文字まで自由にデザインできるQRコード作成ツール。ブラウザ内で完結し、短縮URLを挟まないので広告も有効期限もありません。",
        "url": "https://tk.st/tools/qr-atelier/",
        "inLanguage": "ja",
        "publisher": {
          "@type": "Person",
          "@id": "https://tk.st/#shitake"
        },
        "applicationCategory": "DesignApplication",
        "operatingSystem": "Any",
        "offers": {
          "@type": "Offer",
          "price": 0,
          "priceCurrency": "JPY"
        },
        "browserRequirements": "Requires JavaScript",
        "featureList": "29種類のデザインテンプレート, 17種類のセル形状（連結セル含む）, 9種類のマーカー枠と16種類の目, グラデーション・多色モザイク対応, 中央ロゴ（SNSアイコン・画像・文字）, 枠線8種類とラベルのフレーム, URL/SNS/テキスト/カレンダー/メール/電話/SMS/Wi-Fi/連絡先/位置情報, PNG・SVG・JPEG・WebP書き出し, 読み取りテスト, サーバーへの送信なし"
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Shinya Takeda",
            "item": "https://tk.st/"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "SAFE TOOLS",
            "item": "https://tk.st/tools/"
          },
          {
            "@type": "ListItem",
            "position": 3,
            "name": "QR Atelier",
            "item": "https://tk.st/tools/qr-atelier/"
          }
        ]
      },
      {
        "@type": "FAQPage",
        "@id": "https://tk.st/tools/qr-atelier/#faq",
        "isPartOf": {
          "@id": "https://tk.st/tools/qr-atelier/#webapp"
        },
        "mainEntity": [
          {
            "@type": "Question",
            "name": "作ったQRコードは無料で商用利用できますか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "できます。料金も登録も要らず、透かしも入りません。チラシ・名刺・商品パッケージなどにそのまま使えます。"
            }
          },
          {
            "@type": "Question",
            "name": "あとからURLが変わったり広告が表示されたりしませんか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "しません。短縮URLや中継サーバーを挟まず、入力したURLをそのままQRコードに埋め込みます。サービスが終了しても、印刷済みのQRコードは動き続けます。"
            }
          },
          {
            "@type": "Question",
            "name": "入力した内容やロゴ画像はサーバーに送られますか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "送られません。QRコードの生成もロゴの合成も画像の書き出しも、すべてブラウザの中だけで行われます。"
            }
          },
          {
            "@type": "Question",
            "name": "中央にロゴを置いても読み取れますか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "誤り訂正レベルHであれば、面積のおよそ17%までが安全圏です。それを超えると注意を出し、26%を超えると警告します。本ツールはロゴの面積とコントラストを常に監視し、さらに生成したQRコードを性格の違う最大4種類のデコーダ（jsQR・ZXing・OpenCV WeChat・端末内蔵の読み取り機能）で実際に読み返して、何個が読めたかを表示します。すべてブラウザ内で動き、画像が外に出ることはありません。"
            }
          },
          {
            "@type": "Question",
            "name": "背景を透明にしたQRコードは作れますか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "作れます。背景の色を「透明」にすると、PNG・WebP・SVGは透過のまま書き出せます。JPEGは透過を持てない形式なので白で塗りつぶされます。"
            }
          },
          {
            "@type": "Question",
            "name": "印刷用のベクターデータは書き出せますか？",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "SVGで書き出せます。IllustratorやInDesignで開けば、拡大しても輪郭がぼけません。PNG・JPEG・WebPは最大4096pxまで指定できます。"
            }
          }
        ]
      }
    ]
  }
  