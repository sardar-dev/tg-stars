import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Status lifecycle:
// queued -> processing -> paying -> paid_waiting -> delivered
//                      \-> failed | needs_review
// (queued bhi wapas aa sakta hai agar wallet mein balance kam ho)

export function openDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      inv            INTEGER PRIMARY KEY,      -- DigiSeller invoice number (duplicate protection)
      unique_code    TEXT UNIQUE NOT NULL,
      product_id     TEXT,
      quantity       INTEGER,
      username       TEXT,
      lang           TEXT,
      status         TEXT NOT NULL,
      attempt        INTEGER NOT NULL DEFAULT 1,
      next_try_at    INTEGER,
      ms_order_id    TEXT,
      ms_status      TEXT,
      pay_amount     TEXT,
      pay_asset      TEXT,
      payment_tx     TEXT,
      purchase_tx    TEXT,
      reason         TEXT,
      digi_delivered INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      status_since   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_ms ON orders(ms_order_id);
  `);
  return db;
}

export function makeStore(db, now = () => Date.now()) {
  const byInv = db.prepare("SELECT * FROM orders WHERE inv = ?");
  const byCode = db.prepare("SELECT * FROM orders WHERE unique_code = ?");
  const byMs = db.prepare("SELECT * FROM orders WHERE ms_order_id = ?");
  const insert = db.prepare(`
    INSERT INTO orders (inv, unique_code, product_id, quantity, username, lang, status, reason, created_at, updated_at, status_since)
    VALUES (@inv, @unique_code, @product_id, @quantity, @username, @lang, @status, @reason, @t, @t, @t)`);

  return {
    byInv: (inv) => byInv.get(inv),
    byCode: (c) => byCode.get(c),
    byMsOrder: (id) => byMs.get(id),
    insert(row) {
      const t = now();
      insert.run({ product_id: null, lang: null, reason: null, ...row, t });
      return byInv.get(row.inv);
    },
    // Sirf tab badlo jab status abhi 'from' ho. Ye concurrency/duplicate se bachata hai.
    transition(inv, from, to, fields = {}) {
      const t = now();
      const keys = Object.keys(fields);
      const sets = ["status = @to", "updated_at = @t", "status_since = @t", ...keys.map((k) => `${k} = @${k}`)];
      const froms = Array.isArray(from) ? from : [from];
      const marks = froms.map((_, i) => `@f${i}`).join(",");
      const params = { inv, to, t, ...fields };
      froms.forEach((f, i) => (params[`f${i}`] = f));
      const info = db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE inv = @inv AND status IN (${marks})`).run(params);
      return info.changes === 1;
    },
    // Status badle bina fields update (jaise ms_order_id save karna)
    patch(inv, fields) {
      const keys = Object.keys(fields);
      const sets = ["updated_at = @t", ...keys.map((k) => `${k} = @${k}`)];
      db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE inv = @inv`).run({ inv, t: now(), ...fields });
    },
    listByStatus(statuses) {
      const marks = statuses.map(() => "?").join(",");
      return db.prepare(`SELECT * FROM orders WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses);
    },
    recent(n = 30) {
      return db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(n);
    },
    starsSince(sinceMs) {
      const r = db
        .prepare("SELECT COALESCE(SUM(quantity),0) AS s FROM orders WHERE created_at >= ? AND status NOT IN ('failed')")
        .get(sinceMs);
      return r.s;
    },
  };
}
