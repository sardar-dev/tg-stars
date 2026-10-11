import { canonicalUsername } from "@mystars-tg/faas-sdk";
import { parseUniqueCode } from "./digiseller.js";
import { log } from "./log.js";

const MIN_QTY = 50;
const MAX_QTY = 1_000_000;
const USERNAME_RE = /^[a-z0-9_]{1,32}$/;
const MIN = 60 * 1000;

const MS_OK = new Set(["delivered"]);
const MS_FAIL = new Set(["failed", "reversed", "expired", "cancelled"]);

// Ek serial queue: wallet se payments ek-ek karke hon (seqno clash/double spend se bachao).
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function createEngine({ store, digi, ms, payer, notify, cfg, now = () => Date.now() }) {
  const payLock = makeMutex();
  const keyFor = (row) => `digi-${row.inv}-${row.attempt}`;

  // ---------- 1. DigiSeller redirect se entry ----------
  // Return: { row, work } - work ek Promise hai (server usse await nahi karta, tests karte hain)
  async function ingest(uniqueCode) {
    const existing = store.byCode(uniqueCode);
    if (existing) return { row: existing, work: null }; // refresh/dobara click: dobara kuch nahi hota

    const raw = await digi.verifyUniqueCode(uniqueCode);
    const p = parseUniqueCode(raw, cfg.digiseller.usernameOptionId);
    if (p.error) {
      log.warn("unique code verify failed", { err: p.error });
      return { row: null, error: "invalid_code" };
    }
    const dup = store.byInv(p.inv);
    if (dup) return { row: dup, work: null };

    // Validation: yahan galti ka matlab hai buyer pehle hi pay kar chuka hai -> needs_review (refund/fix manual).
    // canonicalUsername galat input par exception deta hai; buyer ne pay kar diya hota hai,
    // isliye order ko record karna zaroori hai (needs_review), crash nahi.
    let username = "";
    try {
      username = p.username ? canonicalUsername(p.username) : "";
    } catch {
      username = "";
    }
    let status = "queued";
    let reason = null;
    if (!p.quantity || p.quantity < MIN_QTY || p.quantity > MAX_QTY) {
      status = "needs_review";
      reason = `bad_quantity:${p.quantity}`;
    } else if (!USERNAME_RE.test(username)) {
      status = "needs_review";
      reason = "bad_username_format";
    }
    const row = store.insert({
      inv: p.inv,
      unique_code: uniqueCode,
      product_id: p.productId == null ? null : String(p.productId),
      quantity: p.quantity ?? null,
      username: username || null,
      lang: p.lang,
      status,
      reason,
    });
    if (status === "needs_review") {
      await notify(`Order inv=${p.inv} needs review (${reason}). Buyer already paid on DigiSeller.`);
      return { row, work: null };
    }
    return { row, work: process(p.inv) };
  }

  // ---------- 2. Order process karna ----------
  async function process(inv) {
    // 'queued' -> 'processing' atomically. Do requests ek saath aayein to sirf ek jeetegi.
    if (!store.transition(inv, "queued", "processing")) return;
    let row = store.byInv(inv);
    try {
      // Risk limits
      if (row.quantity > cfg.limits.maxStarsAuto) {
        store.transition(inv, "processing", "needs_review", { reason: `over_auto_limit:${row.quantity}` });
        return notify(`Order inv=${inv}: ${row.quantity} Stars exceeds MAX_STARS_AUTO (${cfg.limits.maxStarsAuto}). Approve manually.`);
      }
      const dayTotal = store.starsSince(now() - 24 * 60 * MIN);
      if (dayTotal > cfg.limits.maxStarsPerDay) {
        store.transition(inv, "processing", "needs_review", { reason: `daily_limit:${dayTotal}` });
        return notify(`Order inv=${inv}: daily Stars limit exceeded (${dayTotal}). Review.`);
      }

      // Recipient check (payment se pehle). indeterminate = "pata nahi", order create khud dobara check karta hai.
      let check;
      try {
        check = await ms.checkRecipient(row.username);
      } catch (e) {
        return requeue(inv, `recipient_check_error:${e.name}`);
      }
      if (!check.eligible) {
        store.transition(inv, "processing", "needs_review", { reason: `recipient_ineligible:${check.reason ?? ""}` });
        return notify(`Order inv=${inv}: @${row.username} cannot receive Stars (${check.reason ?? "unknown"}). Buyer paid -> fix username or refund in DigiSeller.`);
      }

      // MyStars order (idempotent: same key = same order, crash ke baad bhi)
      let order;
      try {
        order = await ms.createOrder({ username: row.username, quantity: row.quantity, key: keyFor(row) });
      } catch (e) {
        if (e.name === "RecipientIneligibleError") {
          store.transition(inv, "processing", "needs_review", { reason: "recipient_ineligible" });
          return notify(`Order inv=${inv}: @${row.username} ineligible at order time. Fix username / refund.`);
        }
        return requeue(inv, `create_order_error:${e.name}`);
      }
      store.patch(inv, {
        ms_order_id: order.order_id,
        ms_status: order.status,
        pay_amount: order.payment?.amount ?? null,
        pay_asset: order.payment?.asset ?? null,
      });

      if (order.status !== "awaiting_payment") {
        // Replay: order pehle hi aage badh chuka hai (shayad pehle pay ho chuka). Dobara PAY NAHI karte.
        store.transition(inv, "processing", "paid_waiting");
        return;
      }

      // Payment se PEHLE state save: crash ho to restart par hum dobara pay nahi karenge.
      store.transition(inv, "processing", "paying");
      try {
        await payLock(() => payer.pay(order));
        store.transition(inv, "paying", "paid_waiting");
        log.info("order paid on-chain", { inv, ms_order_id: order.order_id });
      } catch (e) {
        if (e.name === "InsufficientBalanceError") {
          // Paise nahi gaye: MyStars order cancel karke baad mein dobara try.
          try { await ms.cancelOrder(order.order_id); } catch { /* expire ho jayega */ }
          store.transition(inv, "paying", "queued", {
            attempt: row.attempt + 1,
            next_try_at: now() + 2 * MIN,
            ms_order_id: null,
            reason: "insufficient_wallet_balance",
          });
          return notify(`Wallet balance low: order inv=${inv} is waiting. Top up the wallet!`);
        }
        // Koi aur error: payment broadcast ho chuki ho sakti hai -> khud retry NAHI (double-spend ka khatra)
        store.transition(inv, "paying", "needs_review", { reason: `pay_error:${e.name}` });
        return notify(`Order inv=${inv} ms_order=${order.order_id}: payment step errored (${e.message}). Check wallet + MyStars order BEFORE retrying.`);
      }
    } catch (e) {
      log.error("process crashed", { inv, err: e.message });
      store.transition(inv, ["processing"], "needs_review", { reason: `engine_error:${e.name}` });
      await notify(`Order inv=${inv}: unexpected error ${e.message}`);
    }
  }

  function requeue(inv, reason) {
    store.transition(inv, "processing", "queued", { next_try_at: now() + MIN, reason });
    log.warn("order requeued", { inv, reason });
  }

  // ---------- 3. MyStars status apply (webhook ya polling) ----------
  async function applyStatus(row, msStatus, extra = {}) {
    if (!["paid_waiting", "paying"].includes(row.status)) return;
    if (MS_OK.has(msStatus)) {
      if (store.transition(row.inv, ["paid_waiting", "paying"], "delivered", { ms_status: msStatus, purchase_tx: extra.purchase_tx ?? null })) {
        log.info("stars delivered", { inv: row.inv });
        try {
          const r = await digi.markDelivered(row.unique_code);
          store.patch(row.inv, { digi_delivered: r?.skipped ? 0 : 1 });
        } catch (e) {
          log.error("digiseller markDelivered failed", { inv: row.inv, err: e.message });
          await notify(`Order inv=${row.inv} delivered, but marking it delivered in DigiSeller failed: ${e.message}`);
        }
      }
    } else if (MS_FAIL.has(msStatus)) {
      if (store.transition(row.inv, ["paid_waiting", "paying"], "failed", { ms_status: msStatus, reason: extra.failure_reason ?? msStatus })) {
        await notify(`Order inv=${row.inv} FAILED at MyStars (${msStatus}/${extra.failure_reason ?? "-"}). Check funds returned (reversal_tx=${extra.reversal_tx ?? "-"}) and refund buyer in DigiSeller.`);
      }
    } else {
      store.patch(row.inv, { ms_status: msStatus });
      if (msStatus === "held") await notify(`Order inv=${row.inv} is HELD at MyStars (${extra.failure_reason ?? "-"}).`);
    }
  }

  async function onWebhook(event) {
    const row = store.byMsOrder(event.order_id);
    if (!row) return { ignored: true };
    await applyStatus(row, event.status, event);
    return { ok: true };
  }

  // ---------- 4. Periodic sweeper ----------
  async function sweep() {
    const t = now();
    for (const row of store.listByStatus(["queued"])) {
      if ((row.next_try_at ?? 0) <= t) await process(row.inv);
    }
    for (const row of store.listByStatus(["processing"])) {
      // Process beech mein mar gaya (restart): MyStars order idempotent hai, safe requeue.
      if (t - row.status_since > 10 * MIN) requeue(row.inv, "stuck_processing");
    }
    for (let row of store.listByStatus(["paying", "paid_waiting"])) {
      if (!row.ms_order_id) continue;
      try {
        const o = await ms.getOrder(row.ms_order_id);
        if (row.status === "paying") {
          if (o.status !== "awaiting_payment") {
            store.transition(row.inv, "paying", "paid_waiting");
            row = store.byInv(row.inv);
          } else if (t - row.status_since > 10 * MIN) {
            store.transition(row.inv, "paying", "needs_review", { reason: "paying_unconfirmed" });
            await notify(`Order inv=${row.inv}: payment state unclear after restart (ms_order=${row.ms_order_id}). Check wallet tx before doing anything.`);
            continue;
          } else continue;
        }
        await applyStatus(row, o.status, o);
        if (row.status === "paid_waiting" && t - row.status_since > 45 * MIN && !["delivered", ...MS_FAIL].includes(o.status)) {
          store.patch(row.inv, { reason: "slow" });
        }
      } catch (e) {
        log.warn("sweep poll error", { inv: row.inv, err: e.name });
      }
    }
  }

  return { ingest, process, sweep, onWebhook, applyStatus };
}
