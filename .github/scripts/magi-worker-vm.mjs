// magi2 の本番コードを、外部 API・キーなしで vm に読み込む（検証・smoke 用）。
// src/index.js の import をたどってモジュールを依存順に丸ごと読み、関数の配置やコメントには頼らない。
// JSON の import は同じ名前の値として渡す。
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const IMPORT_RE = /^import\s+(?:(\w+)\s+from\s+|[\s\S]*?\sfrom\s+)'(\.{1,2}\/[^']+)';\r?$/gm;
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '')
  .replace(/^export default \{/m, 'globalThis.worker = {');

// Workers にある組み込みだけを渡し、通信は既定で止める。sandbox で足す・差し替える。
// 読み込んだ関数は ctx から名前で引く（トップレベルの const は vm.runInContext の中から参照する）。
export function loadMagiWorker(sandbox = {}) {
  const ctx = vm.createContext({ URL, TextEncoder, TextDecoder, Request, Response, Headers, ReadableStream, AbortController, AbortSignal,
    crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, console,
    fetch() { throw new Error('magi-worker-vm: network is disabled'); }, ...sandbox });
  const done = new Set(), order = [];
  const visit = path => {
    if (done.has(path)) return;
    done.add(path);
    const source = readFileSync(path, 'utf8');
    for (const [, name, spec] of source.matchAll(IMPORT_RE)) {
      const target = join(dirname(path), spec);
      if (target.endsWith('.json')) { if (!Object.hasOwn(ctx, name)) ctx[name] = JSON.parse(readFileSync(target, 'utf8')); }
      else visit(target);
    }
    order.push([path, source]);
  };
  visit(join(root, 'workers/magi2/src/index.js'));
  for (const [path, source] of order) vm.runInContext(strip(source), ctx, { filename: relative(root, path) });
  return ctx;
}
