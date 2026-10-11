// Offline tests: asli DigiSeller / MyStars / wallet ki jagah fakes. Ye logic ko test karte hain,
// asli services ko NAHI. (Real end-to-end test README ke "Test plan" mein hai.)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { constructEvent } from "@mystars-tg/faas-sdk";
import { openDb, makeStore } from "../src/db.js";
import { createEngine } from "../src/engine.js";
import { parseUniqueCode } from "../src/digiseller.js";

const CODE = "ABCDEFGH12345678";
const baseCfg = () => ({
  digiseller: { usernameOptionId: "" },
  limits: { maxStarsAuto: 500, maxStarsPerDay: 5000 },
});

function setup({ digiResponse, msOverrides = {}, payOverride, cfgOverride = {} } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const store = makeStore(openDb(":memory:"), clock.now);
  const calls = { pay: 0, create: [], cancel: [], delivered: [], notify: [] };
  const digi = {
    verifyUniqueCode: async () =>
      digiResponse ?? { retval: 0, inv: 777, cnt_goods: 100, lang: "ru-RU", options: [{ id: 5, name: "Telegram username", value: "@Durov" }] },
    markDelivered: async (c) => (calls.delivered.push(c), { retval: 0 }),
  };
  let orderSeq = 0;
  const orders = new Map();
  const ms = {
    checkRecipient: async () => ({ eligible: true, resolved: true }),
    createOrder: async ({ username, quantity, key }) => {
      calls.create.push({ username, quantity, key });
      if (!orders.has(key)) {
        orders.set(key, { order_id: `ord-${++orderSeq}`, status: "awaiting_payment", payment: { amount: "5.0", asset: "USDT" } });
      }
      return orders.get(key);
    },
    getOrder: async (id) => [...orders.values()].find((o) => o.order_id === id),
    cancelOrder: async (id) => (calls.cancel.push(id), { status: "cancelled" }),
    ...msOverrides,
  };
  const payer = {
    pay: payOverride ?? (async (order) => {
      calls.pay++;
      order.status = "paid"; // MyStars on-chain payment dekh leta hai
    }),
  };
  const notify = async (m) => calls.notify.push(m);
  const cfg = { ...baseCfg(), ...cfgOverride };
  const engine = createEngine({ store, digi, ms, payer, notify, cfg, now: clock.now });
  return { engine, store, calls, orders, clock, ms };
}

test("happy path: ingest -> pay -> delivered -> DigiSeller marked", async () => {
  const { engine, store, calls, orders } = setup();
  const { row, work } = await engine.ingest(CODE);
  assert.equal(row.username, "durov");
  await work;
  assert.equal(calls.pay, 1);
  assert.equal(store.byInv(777).status, "paid_waiting");
  assert.equal(calls.create[0].key, "digi-777-1");
  [...orders.values()][0].status = "delivered";
  await engine.sweep();
  assert.equal(store.byInv(777).status, "delivered");
  assert.deepEqual(calls.delivered, [CODE]);
});

test("duplicate: same code twice / concurrently pays exactly once", async () => {
  const { engine, calls } = setup();
  const [a, b] = await Promise.all([engine.ingest(CODE), engine.ingest(CODE)]);
  await a.work;
  await b.work;
  await engine.ingest(CODE); // refresh
  assert.equal(calls.pay, 1);
  assert.equal(calls.create.length, 1);
});

test("different code, same invoice does not create second order", async () => {
  const { engine, calls } = setup();
  const r = await engine.ingest(CODE);
  await r.work;
  const r2 = await engine.ingest("ZZZZZZZZ99999999");
  await r2.work;
  assert.equal(calls.pay, 1);
});

test("bad username format -> needs_review, never pays", async () => {
  const { engine, calls, store } = setup({
    digiResponse: { retval: 0, inv: 1, cnt_goods: 100, options: [{ id: 1, name: "Telegram username", value: "bad name!!" }] },
  });
  const { row } = await engine.ingest(CODE);
  assert.equal(row.status, "needs_review");
  assert.equal(calls.pay, 0);
  assert.equal(calls.notify.length, 1);
  assert.equal(store.byInv(1).reason, "bad_username_format");
});

test("quantity out of range -> needs_review", async () => {
  const { engine, calls } = setup({ digiResponse: { retval: 0, inv: 2, cnt_goods: 10, options: [{ id: 1, name: "username", value: "durov" }] } });
  const { row } = await engine.ingest(CODE);
  assert.equal(row.status, "needs_review");
  assert.equal(calls.pay, 0);
});

test("over MAX_STARS_AUTO -> needs_review, no payment", async () => {
  const { engine, calls, store } = setup({ digiResponse: { retval: 0, inv: 3, cnt_goods: 800, options: [{ id: 1, name: "username", value: "durov" }] } });
  const { work } = await engine.ingest(CODE);
  await work;
  assert.equal(store.byInv(3).status, "needs_review");
  assert.match(store.byInv(3).reason, /over_auto_limit/);
  assert.equal(calls.pay, 0);
});

test("ineligible recipient -> needs_review, no order, no payment", async () => {
  const { engine, calls, store } = setup({ msOverrides: { checkRecipient: async () => ({ eligible: false, reason: "not_found" }) } });
  const { work } = await engine.ingest(CODE);
  await work;
  assert.equal(store.byInv(777).status, "needs_review");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.pay, 0);
});

test("insufficient wallet balance: cancel, requeue with new idempotency key, pay after top-up", async () => {
  let fail = true;
  let paid = 0;
  const { engine, store, calls, clock } = setup({
    payOverride: async (order) => {
      if (fail) {
        const e = new Error("low");
        e.name = "InsufficientBalanceError";
        throw e;
      }
      paid++;
      order.status = "paid";
    },
  });
  const { work } = await engine.ingest(CODE);
  await work;
  assert.equal(store.byInv(777).status, "queued");
  assert.equal(store.byInv(777).attempt, 2);
  assert.equal(calls.cancel.length, 1);
  fail = false;
  clock.advance(3 * 60 * 1000);
  await engine.sweep();
  assert.equal(paid, 1);
  assert.equal(calls.create[1].key, "digi-777-2");
  assert.equal(store.byInv(777).status, "paid_waiting");
});

test("unknown payment error -> needs_review and sweeper NEVER re-pays", async () => {
  let attempts = 0;
  const { engine, store, clock } = setup({
    payOverride: async () => {
      attempts++;
      throw new Error("rpc timeout");
    },
  });
  const { work } = await engine.ingest(CODE);
  await work;
  assert.equal(store.byInv(777).status, "needs_review");
  clock.advance(60 * 60 * 1000);
  await engine.sweep();
  await engine.sweep();
  assert.equal(attempts, 1);
});

test("crash while paying: after restart sweeper does not pay again", async () => {
  const { engine, store, calls, clock, orders } = setup();
  const { work } = await engine.ingest(CODE);
  await work;
  // Crash simulate: status wapas 'paying' aur MyStars order abhi 'awaiting_payment' dikha raha hai
  store.transition(777, "paid_waiting", "paying");
  [...orders.values()][0].status = "awaiting_payment";
  clock.advance(11 * 60 * 1000);
  await engine.sweep();
  assert.equal(store.byInv(777).status, "needs_review");
  assert.equal(calls.pay, 1); // sirf pehli baar
});

test("replayed already-paid MyStars order is not paid again", async () => {
  const { engine, calls, store } = setup({
    msOverrides: {
      createOrder: async () => ({ order_id: "ord-x", status: "paid", payment: null }),
      getOrder: async () => ({ order_id: "ord-x", status: "fulfilling" }),
    },
  });
  const { work } = await engine.ingest(CODE);
  await work;
  assert.equal(calls.pay, 0);
  assert.equal(store.byInv(777).status, "paid_waiting");
});

test("MyStars failed/reversed -> failed + alert (refund is manual)", async () => {
  const { engine, store, calls, orders } = setup();
  const { work } = await engine.ingest(CODE);
  await work;
  [...orders.values()][0].status = "reversed";
  await engine.sweep();
  assert.equal(store.byInv(777).status, "failed");
  assert.ok(calls.notify.some((m) => /FAILED/.test(m)));
});

test("webhook delivered event updates order; unknown order ignored", async () => {
  const { engine, store, calls } = setup();
  const { row, work } = await engine.ingest(CODE);
  await work;
  const msId = store.byInv(777).ms_order_id;
  assert.deepEqual(await engine.onWebhook({ order_id: "nope", status: "delivered" }), { ignored: true });
  await engine.onWebhook({ order_id: msId, status: "delivered", purchase_tx: "tx1" });
  assert.equal(store.byInv(777).status, "delivered");
  assert.equal(store.byInv(777).purchase_tx, "tx1");
  assert.equal(calls.delivered.length, 1);
  // Dobara aaya webhook (at-least-once) kuch double nahi karta
  await engine.onWebhook({ order_id: msId, status: "delivered", purchase_tx: "tx1" });
  assert.equal(calls.delivered.length, 1);
  assert.ok(row);
});

test("webhook signature: valid accepted, tampered/missing rejected, rotation list accepted", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ order_id: "11111111-1111-1111-1111-111111111111", status: "delivered", failure_reason: null });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const ev = await constructEvent(body, sig, secret);
  assert.equal(ev.status, "delivered");
  await assert.rejects(() => constructEvent(body + " ", sig, secret));
  await assert.rejects(() => constructEvent(body, "deadbeef", secret));
  await assert.rejects(() => constructEvent(body, undefined, secret));
  const ev2 = await constructEvent(body, `deadbeef,${sig}`, secret);
  assert.equal(ev2.order_id, "11111111-1111-1111-1111-111111111111");
});

test("parseUniqueCode: ok, bad retval, option by id, missing username", () => {
  const ok = parseUniqueCode({ retval: 0, inv: 9, cnt_goods: 50, lang: "en-US", options: [{ id: 3, name: "x", value: "@abc_def" }, { id: 4, name: "y", value: "zzz" }] }, "3");
  assert.equal(ok.username, "@abc_def");
  assert.equal(ok.quantity, 50);
  assert.ok(parseUniqueCode({ retval: 1, retdesc: "nope" }).error);
  assert.equal(parseUniqueCode({ retval: 0, inv: 9, cnt_goods: 50, options: [] }).username, "");
});
