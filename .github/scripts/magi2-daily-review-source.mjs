// 正式なレビューサービスが決まるまでは未設定。PR本文・コメントのJSONや環境変数を代用しない。
// 接続時は信頼するmainのこのアダプターで依頼・正式な実行記録・完了結果を取得する。
export async function readReviewEvidence() {
  return {route:null,requests:[],results:[],records:[],claude:[]};
}
