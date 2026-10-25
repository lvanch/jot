// A small stand-in for Cloudflare D1 over node:sqlite, for tests and local runs without wrangler.
// Covers the subset jot-api uses: prepare/bind/first/all/run and batch.

import { DatabaseSync } from 'node:sqlite';

// Each call yields to the event loop first, like a real round trip, so concurrent requests interleave.
const tick = () => new Promise((resolve) => setImmediate(resolve));

function checkParams(params) {
  for (const p of params) {
    if (p === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
    if (typeof p === 'boolean') throw new TypeError('D1 shim: bind booleans as 0/1');
  }
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    checkParams(params);
    return new Statement(this.db, this.sql, params);
  }

  compiled() {
    return this.db.prepare(this.sql);
  }

  async first(column) {
    await tick();
    const row = this.compiled().get(...this.params);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async all() {
    await tick();
    const results = this.compiled().all(...this.params).map((r) => ({ ...r }));
    return { success: true, results, meta: {} };
  }

  async run() {
    await tick();
    const info = this.compiled().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class D1 {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    await tick();
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => {
        const info = s.compiled().run(...s.params);
        return { success: true, results: [], meta: { changes: Number(info.changes) } };
      });
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
