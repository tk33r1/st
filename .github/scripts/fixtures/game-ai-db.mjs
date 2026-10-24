// 実際のSQLiteと本番の移行SQLを使う、外部通信のないD1のfixture。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function gameAiDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../workers/games/migrations/0001_ai_rate_limits.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    close: () => sqlite.close(),
    prepare(sql) {
      return { bind(...values) {
        return {
          first: async () => sqlite.prepare(sql).get(...values) || null,
          all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
          run: async () => sqlite.prepare(sql).run(...values),
        };
      } };
    },
  };
}
