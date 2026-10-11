// Use: npm run orders   - local DB ke recent orders dikhata hai (status monitoring ke liye)
import { openDb, makeStore } from "../src/db.js";

const store = makeStore(openDb(process.env.DB_PATH ?? "./data/orders.db"));
console.table(
  store.recent(30).map((r) => ({
    inv: r.inv,
    status: r.status,
    stars: r.quantity,
    user: r.username,
    ms_order: r.ms_order_id?.slice(0, 8),
    ms_status: r.ms_status,
    reason: r.reason,
    digi_delivered: r.digi_delivered,
    created: new Date(r.created_at).toISOString(),
  })),
);
