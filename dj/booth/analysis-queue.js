// ブース専用。通信を2曲まで並べ、失敗した通信だけ間隔を空けて最大3回試す。
export const ANALYSIS_CONCURRENCY = 2;
export const ANALYSIS_ATTEMPTS = 3;
const RETRY_DELAYS = [2000, 5000];
const FAILURE_MESSAGES = {
  preview_network: 'プレビューの通信に失敗しました', preview_http: 'プレビューを取得できませんでした',
  audio_unsupported: 'このブラウザは音声解析に対応していません', audio_decode: 'プレビューの音声形式を読み取れませんでした',
  save: '推定値の保存に失敗しました', analysis: 'プレビューを解析できませんでした',
};
const BPM_MESSAGES = {
  low_confidence: 'BPMは確信度不足のため非表示です。TAPで測定できます',
  short_audio: 'BPMを推定できません（解析できる音源が短すぎます）',
  no_beats: 'BPMを推定できません（拍を検出できませんでした）',
};

const serverBpm = (s) => Object.prototype.hasOwnProperty.call(s, 'serverBpm') ? s.serverBpm : s.bpm;
const hasKey = (s) => !!(s.camelot || s.songKey);
const missing = (s) => !s.isFree && (serverBpm(s) == null || !hasKey(s));
const sameSong = (s, state) => s.id === state.id && s.previewUrl === state.url;
const transient = (status) => status === 408 || status === 429 || status >= 500;

export function createAnalysisQueue({ getSongs, analyze, save, onChange,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const states = new Map();
  let active = 0, timer;

  const current = (state, songs = getSongs()) => songs.find((s) => sameSong(s, state) && missing(s));
  const getState = (s) => {
    const state = states.get(s.id);
    return state && sameSong(s, state) ? state : undefined;
  };

  async function run(state) {
    active++;
    state.status = 'running';
    state.attempts++;
    state.phase = state.result ? 'save' : 'analyze';
    onChange();
    try {
      if (!state.result) state.result = await analyze(state.url);
      // イベント切替・削除・URL変更・外部サービスの補完が先に済んだ曲は保存しない。
      const song = current(state);
      if (!song) return;
      const r = state.result;
      // 再試行までに外部取得で埋まった欄も除く。新しい値がなければ保存せず理由を表示する。
      const bpm = serverBpm(song) == null ? r.bpm : null;
      const camelot = hasKey(song) ? '' : r.camelot;
      if (bpm || camelot) {
        state.phase = 'save';
        onChange();
        await save(state.id, { bpm, camelot, songKey: camelot ? r.songKey : '' }, state.url);
      }
      state.status = 'done';
    } catch (error) {
      state.error = state.phase === 'save' ? 'save' : (error.code || 'analysis');
      state.httpStatus = error.status;
      const retryable = state.phase === 'save'
        ? (!error.status || transient(error.status))
        : (error.code === 'preview_network' || (error.code === 'preview_http' && transient(error.status)));
      state.status = retryable && state.attempts < ANALYSIS_ATTEMPTS ? 'retry' : 'failed';
      if (state.status === 'retry') state.retryAt = now() + RETRY_DELAYS[state.attempts - 1];
    } finally {
      active--;
      // 保存失敗時の再試行では解析結果を使い回す。低確信度は繰り返し解析しない。
      if (!current(state) && states.get(state.id) === state) states.delete(state.id);
      onChange();
      pump();
    }
  }

  function pump() {
    clearTimer(timer);
    let wakeAt = Infinity;
    const songs = getSongs();
    for (const [id, state] of states) {
      if (state.status !== 'running' && !current(state, songs)) states.delete(id);
    }
    for (const s of songs) {
      if (!missing(s) || !s.previewUrl) continue;
      let state = getState(s);
      if (!state) {
        state = { id: s.id, url: s.previewUrl, status: 'waiting', attempts: 0 };
        states.set(s.id, state);
      }
      if (state.status === 'retry' && state.retryAt > now()) {
        wakeAt = Math.min(wakeAt, state.retryAt);
        continue;
      }
      if (active < ANALYSIS_CONCURRENCY && (state.status === 'waiting' || state.status === 'retry')) void run(state);
    }
    if (wakeAt < Infinity) timer = setTimer(pump, Math.max(0, wakeAt - now()));
  }

  function retry(id) {
    const state = states.get(id);
    if (!state || state.status !== 'failed') return;
    state.status = 'waiting';
    state.attempts = 0;
    pump();
  }

  return { pump, retry, getState };
}

// 手入力・外部取得で埋まった項目には、古い失敗理由を表示しない。
export function analysisNotice(s, state) {
  if (s.isFree || (s.bpm != null && hasKey(s))) return null;
  if (!s.previewUrl) return { text: 'プレビューがないため推定できません' };
  if (!state || state.status === 'waiting') return { text: 'プレビュー解析待ち', busy: true };
  if (state.status === 'running') return { text: state.phase === 'save' ? '推定値を保存中…' : 'プレビューを解析中…', busy: true };
  if (state.status === 'retry' || state.status === 'failed') {
    let text = FAILURE_MESSAGES[state.error];
    if (state.httpStatus) text += '（HTTP ' + state.httpStatus + '）';
    const retry = state.status === 'failed';
    text += retry ? '。自動再試行は停止しました' : '。自動再試行を待っています（' + (state.attempts + 1) + '/' + ANALYSIS_ATTEMPTS + '回目）';
    return { text, retry };
  }
  const reasons = [];
  if (s.bpm == null) reasons.push(BPM_MESSAGES[state.result?.bpmReason] || BPM_MESSAGES.no_beats);
  if (!hasKey(s)) reasons.push('キーを推定できません（音の特徴を検出できませんでした）');
  return { text: reasons.join(' · ') };
}
