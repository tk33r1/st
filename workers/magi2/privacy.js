// 一時会話と利用者設定の契約。本文・設定値をエラーに含めない。
import { PERSONALIZATION, TEXT_CONTROL_RE, LINE_CONTROL_RE } from './personas.js';

const invalid = () => {
  const error = new Error('invalid_privacy_request');
  error.envelope = { stage: 'bad_request', code: 'invalid_privacy_request', message: '会話モードまたはパーソナライズ設定が不正です', retryable: false };
  throw error;
};
export function privacyFeatures(env) {
  return { privacy_contract: 1, temporary_chat: env.TEMPORARY_CHAT_ENABLED !== 'false',
    personalization: env.PERSONALIZATION_ENABLED !== 'false', temporary_speech: env.TEMPORARY_CHAT_ENABLED !== 'false' };
}
export function chatPrivacy(body) {
  const declared = ['privacy_contract', 'conversation_mode', 'personalization'].some(key => Object.hasOwn(body, key));
  if (declared && (body.privacy_contract !== 1 || !['normal', 'temporary'].includes(body.conversation_mode))) invalid();
  const mode = declared ? body.conversation_mode : 'normal';
  let personalization = null;
  if (mode === 'normal' && body.personalization != null) {
    const p = body.personalization;
    if (typeof p !== 'object' || Array.isArray(p) || typeof p.enabled !== 'boolean') invalid();
    if (p.enabled) {
      const name = p.preferred_name === undefined ? '' : p.preferred_name;
      const instructions = p.custom_instructions === undefined ? '' : p.custom_instructions;
      if (typeof name !== 'string' || typeof instructions !== 'string' || TEXT_CONTROL_RE.test(name) || LINE_CONTROL_RE.test(instructions)
        || Array.from(name.trim()).length > PERSONALIZATION.name_max_chars || Array.from(instructions).length > PERSONALIZATION.instructions_max_chars) invalid();
      if (name.trim() || instructions.trim()) personalization = { preferred_name: name.trim(), custom_instructions: instructions.trim() };
    }
  }
  return { privacyContract: declared, conversationMode: mode, personalization };
}
export function personalizationNote(settings) {
  return settings ? '\n\n' + PERSONALIZATION.prompt + '\n' + JSON.stringify(settings) : '';
}
