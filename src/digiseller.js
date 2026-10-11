import crypto from "node:crypto";

// Verified (official docs, my.digiseller.com/inside/api_general.asp):
//  - POST https://api.digiseller.com/api/apilogin  {seller_id, timestamp, sign}
//    sign = SHA256(api_key + timestamp), response has `token`
//  - GET  https://api.digiseller.com/api/purchases/unique-code/{code}?token=...
//    response has retval (0 = ok), retdesc, inv, lang ...
// NOT verified (docs page truncated for me): exact names of the other fields
// (quantity, buyer options). parseUniqueCode() below is tolerant and the
// `probe` script prints the real response so we can lock the names down.

const BASE = "https://api.digiseller.com";

export function makeDigiseller(cfg, fetchImpl = fetch) {
  let token = null;
  let tokenAt = 0;

  async function login() {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHash("sha256").update(cfg.apiKey + timestamp).digest("hex");
    const res = await fetchImpl(`${BASE}/api/apilogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ seller_id: cfg.sellerId, timestamp, sign }),
    });
    const j = await res.json();
    if (!j.token) throw new Error(`DigiSeller login failed (retval=${j.retval}, desc=${j.desc ?? j.retdesc ?? ""})`);
    token = j.token;
    tokenAt = Date.now();
    return token;
  }

  async function getToken(force = false) {
    // Token ki expiry docs mein alag field mein hoti hai; 401 aane par dobara login karte hain.
    if (!force && token && Date.now() - tokenAt < 60 * 60 * 1000) return token;
    return login();
  }

  async function call(urlBuilder, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await getToken(attempt > 0);
      const res = await fetchImpl(urlBuilder(t), { ...init, headers: { Accept: "application/json", ...(init.headers || {}) } });
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`DigiSeller returned non-JSON (HTTP ${res.status})`);
      }
      return { status: res.status, json };
    }
    throw new Error("DigiSeller auth failed twice");
  }

  return {
    async verifyUniqueCode(code) {
      const { json } = await call((t) => `${BASE}/api/purchases/unique-code/${encodeURIComponent(code)}?token=${encodeURIComponent(t)}`);
      return json;
    },

    // Best effort. Sirf tab chalta hai jab DIGISELLER_DELIVER_URL_TEMPLATE set ho
    // (docs section "Change the status of the unique code to goods delivered").
    async markDelivered(code) {
      if (!cfg.deliverUrlTemplate) return { skipped: true };
      const { json } = await call(
        (t) => cfg.deliverUrlTemplate.replace("{code}", encodeURIComponent(code)).replace("{token}", encodeURIComponent(t)),
        { method: cfg.deliverMethod },
      );
      return json;
    },
  };
}

// DigiSeller response -> {inv, quantity, username, lang, productId} ya {error}
export function parseUniqueCode(j, usernameOptionId = "") {
  if (!j || Number(j.retval) !== 0) return { error: `retval=${j?.retval} ${j?.retdesc ?? ""}`.trim() };
  const inv = Number(j.inv);
  if (!Number.isInteger(inv) || inv <= 0) return { error: "no inv in response" };

  // ASSUMPTION: quantity field name. Pehle jo mile wo lo; probe script se confirm karna hai.
  const qCandidates = [j.cnt_goods, j.unit_cnt, j.cnt, j.quantity, j.count];
  const quantity = qCandidates.map(Number).find((n) => Number.isInteger(n) && n > 0);

  // ASSUMPTION: buyer options array ka shape [{id, name, value}] (ya value ek object)
  const opts = Array.isArray(j.options) ? j.options : [];
  const val = (o) => (o && typeof o.value === "object" && o.value ? o.value.text ?? o.value.name ?? "" : o?.value ?? o?.user_data ?? "");
  let opt = usernameOptionId ? opts.find((o) => String(o.id) === String(usernameOptionId)) : undefined;
  if (!opt) opt = opts.find((o) => /telegram|username|@/i.test(String(o.name ?? "")));
  if (!opt && opts.length === 1) opt = opts[0];
  const username = opt ? String(val(opt)).trim() : "";

  return {
    inv,
    quantity,
    username,
    lang: j.lang ?? null,
    productId: j.id_goods ?? j.product_id ?? null,
  };
}
