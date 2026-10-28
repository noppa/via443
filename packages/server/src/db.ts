/** A SQL parameter. Booleans are not supported by D1; use 0/1. */
export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export const sql = (strings: TemplateStringsArray, ...params: SqlValue[]): Statement => ({
  sql: strings.join('?'),
  params,
});

/**
 * The few database operations the server needs, implemented over D1 on
 * Cloudflare and node:sqlite on Node. Queries are plain SQLite SQL.
 */
export interface Db {
  all<T>(statement: Statement): Promise<T[]>;
  first<T>(statement: Statement): Promise<T | null>;
  run(statement: Statement): Promise<{ changes: number }>;
  /** Runs statements atomically: all of them or none. */
  batch(statements: Statement[]): Promise<void>;
}

/** The subset of Cloudflare's D1Database binding used here. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

export function d1Db(d1: D1Like): Db {
  const bind = (s: Statement) => d1.prepare(s.sql).bind(...s.params);
  return {
    async all<T>(s: Statement) {
      return (await bind(s).all<T>()).results;
    },
    first: <T>(s: Statement) => bind(s).first<T>(),
    async run(s) {
      return { changes: (await bind(s).run()).meta.changes };
    },
    async batch(statements) {
      if (statements.length > 0) await d1.batch(statements.map(bind));
    },
  };
}
