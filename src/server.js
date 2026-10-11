import express from "express";
import { constructEvent } from "@mystars-tg/faas-sdk";
import { loadConfig } from "./config.js";
import { openDb, makeStore } from "./db.js";
import { makeDigiseller } from "./digiseller.js";
import { makeMyStars, makePayer } from "./mystars.js";
import { makeNotifier } from "./notify.js";
import { createEngine } from "./engine.js";
import { renderOrder, renderInvalid } from "./pages.js";
import { pickUniqueCode } from "./params.js";
import { log } from "./log.js";

const cfg = loadConfig();
if (!cfg.payment.walletMnemonic) throw new Error("WALLET_MNEMONIC is required to run the server (use a dedicated hot wallet with a small balance)");

const store = makeStore(openDb(cfg.dbPath));
const digi = makeDigiseller(cfg.digiseller);
const ms = makeMyStars(cfg, cfg.publicBaseUrl);
const payer = await makePayer(cfg);
const notify = makeNotifier(cfg.notify);
const engine = createEngine({ store, digi, ms, payer, notify, cfg });

log.info("wallet ready - fund this address", { address: payer.address, currency: cfg.payment.currency });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ---- Webhook: raw body zaroori hai (signature raw bytes par hota hai) ----
app.post("/webhooks/mystars", express.raw({ type: "*/*", limit: "100kb" }), async (req, res) => {
  if (!cfg.mystars.webhookSecret) return res.status(404).end();
  try {
    const event = await constructEvent(req.body, req.get("x-faas-signature"), cfg.mystars.webhookSecret);
    await engine.onWebhook(event);
    res.status(200).json({ ok: true });
  } catch (e) {
    if (e.name === "WebhookSignatureError") return res.status(401).json({ error: "bad signature" });
    log.error("webhook error", { err: e.message });
    res.status(500).json({ error: "internal" }); // 5xx par MyStars retry karega
  }
});

// ---- Simple per-IP rate limit (DigiSeller API ko hammer hone se bachane ke liye) ----
const hits = new Map();
function limited(ip, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

// ---- DigiSeller redirect: yahi URL DigiSeller mein daalna hai ----
// GET /delivery?uniquecode=XXXXXXXXXXXXXXXX
app.get("/delivery", async (req, res) => {
  const code = pickUniqueCode(req.query); // uniquecode do baar aaye (pehla khali) tab bhi theek
  if (!code) return res.status(400).type("html").send(renderInvalid());
  if (limited(req.ip)) return res.status(429).type("text").send("Too many requests, retry in a minute.");
  try {
    const { row, error } = await engine.ingest(code);
    if (!row) return res.status(404).type("html").send(renderInvalid());
    res.set("Cache-Control", "no-store").type("html").send(renderOrder(row, cfg.supportText));
  } catch (e) {
    log.error("delivery error", { err: e.message });
    res.status(503).type("text").send("Temporary error. Please reload this page in a minute — your order is safe.");
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Background: sweeper + balance monitor ----
let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try { await engine.sweep(); } catch (e) { log.error("sweep failed", { err: e.message }); } finally { sweeping = false; }
}, cfg.sweepIntervalMs).unref();

let lowAlertAt = 0;
setInterval(async () => {
  try {
    const b = await payer.balances();
    const lowG = cfg.payment.lowGram > 0 && b.gram < cfg.payment.lowGram;
    const lowU = b.usdt != null && cfg.payment.lowUsdt > 0 && b.usdt < cfg.payment.lowUsdt;
    if ((lowG || lowU) && Date.now() - lowAlertAt > 3 * 60 * 60 * 1000) {
      lowAlertAt = Date.now();
      await notify(`Wallet balance low: GRAM=${b.gram.toFixed(3)}${b.usdt != null ? ` USDT=${b.usdt.toFixed(2)}` : ""}. Top up: ${payer.address}`);
    }
  } catch (e) {
    log.warn("balance check failed", { err: e.message });
  }
}, 5 * 60_000).unref();

app.listen(cfg.port, () => log.info("server listening", { port: cfg.port }));
