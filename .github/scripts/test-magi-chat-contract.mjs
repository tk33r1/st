import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {checkContract, root} from './magi-chat-contract.mjs';

test('公開契約: Worker・Web・PWA・Javaの受信イベントが一致する', () => checkContract());
test('公開契約: 今回のsession取りこぼしを再導入すると公開を拒否する', () => {
  assert.throws(() => checkContract(p => {
    const text = readFileSync(resolve(root, p), 'utf8');
    return p.endsWith('MagiConversationService.java') ? text.replace('session|classification', 'classification') : text;
  }), /不一致/);
});
test('公開契約: 一覧の形式変更で検査を黙って飛ばさない', () => {
  assert.throws(() => checkContract(p => p === 'index.html' ? '' : readFileSync(resolve(root, p), 'utf8')), /見つからない/);
});
