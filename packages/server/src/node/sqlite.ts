import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db, Statement } from '../db.ts';

/** The migrations folder shared with `wrangler d1 migrations apply`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

export function sqliteDb(db: DatabaseSync): Db {
  const prepare = (s: Statement) => db.prepare(s.sql);
  const params = (s: Statement) => s.params as SQLInputValue[];
  return {
    async all<T>(s: Statement) {
      return prepare(s).all(...params(s)) as T[];
    },
    async first<T>(s: Statement) {
      return (prepare(s).get(...params(s)) as T | undefined) ?? null;
    },
    async run(s) {
      return { changes: Number(prepare(s).run(...params(s)).changes) };
    },
    async batch(statements) {
      transaction(db, () => {
        for (const s of statements) prepare(s).run(...params(s));
      });
    },
  };
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Applies pending `NNNN_name.sql` migrations in order, each in its own
 * transaction. Bookkeeping uses the same `d1_migrations` table as wrangler,
 * so one folder of migrations serves both Cloudflare and Node.
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((row) => row.name),
  );
  const pending = readdirSync(dir)
    .filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name) && !applied.has(name))
    .sort();
  for (const name of pending) {
    const body = readFileSync(join(dir, name), 'utf8');
    transaction(db, () => {
      db.exec(body);
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    });
  }
  return pending;
}
