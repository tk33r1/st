import test from 'node:test';
import assert from 'node:assert/strict';
import {COMMIT_SHA_RE,VERSION_ID_RE,isCommitSha,isVersionId} from './magi2-daily-contract.mjs';

test('コミットSHAは小文字40桁、版IDは大文字小文字を問わないUUIDを受け付ける',()=>{
  const sha='a'.repeat(40),id='ABCDEF12-1234-5678-ABCD-123456789ABC';
  assert.equal(isCommitSha(sha),true);assert.equal(isCommitSha(sha),true);
  for(const value of [sha.slice(1),sha+'a',sha.toUpperCase(),sha+'-dirty','HEAD',null,undefined,{},[sha]])
    assert.equal(isCommitSha(value),false);
  assert.equal(isVersionId(id),true);assert.equal(isVersionId(id.toLowerCase()),true);
  for(const value of ['',id.slice(1),id.replace('-',''),id.replace('A','G'),null,{},[id]])assert.equal(isVersionId(value),false);
});

test('型も検査する入口と、従来から文字列変換する入口の違いを保つ',()=>{
  const sha=['a'.repeat(40)],id=['ABCDEF12-1234-5678-ABCD-123456789ABC'];
  assert.equal(COMMIT_SHA_RE.test(sha),true);assert.equal(isCommitSha(sha),false);
  assert.equal(VERSION_ID_RE.test(id),true);assert.equal(isVersionId(id),false);
});
