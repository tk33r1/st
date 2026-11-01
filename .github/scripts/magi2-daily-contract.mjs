// 継続改善の識別子。型を含めて検査する入口と、従来の文字列変換を保つ正規表現を分ける。
// 公開版の「<SHA>-dirty」は別の契約なので、ここでは許可しない。
export const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
export const VERSION_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const isCommitSha = value => typeof value === 'string' && COMMIT_SHA_RE.test(value);
export const isVersionId = value => typeof value === 'string' && VERSION_ID_RE.test(value);
