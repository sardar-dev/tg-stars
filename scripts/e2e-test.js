// LIVE test: MyStars -> on-chain payment -> Stars delivery (DigiSeller ke bina).
// Apne COMPUTER par chalao, taake wallet seed / API key kisi chat mein na jayein.
//
//   npm run e2e              DRY RUN: wallet balance + live quote + username check. Kuch kharidta NAHI.
//   npm run e2e -- --pay     ASLI order banata hai aur wallet se pay karta hai (5 second ka countdown, Ctrl+C se roko).
//   npm run e2e -- --pay --new   pichla test bhool kar bilkul naya order (sirf jab pichla poora ho chuka ho).
//
// Required env (.env): MYSTARS_API_KEY, WALLET_MNEMONIC, PAYMENT_CURRENCY (ton|usdt_ton),
//                      TEST_USERNAME (jis Telegram account par Stars aane chahiye), MAX_PAY (is se zyada kabhi pay nahi karega)
// Optional: TEST_QUANTITY (50..100, default 50), TONCENTER_ENDPOINT, TONCENTER_KEY
import fs from "node:fs";
import path from "node:path";
import { MyStarsClient, canonicalUsername } from "@mystars-tg/faas-sdk";
import { TonWallet, ToncenterRpc, fulfill, orderIdFromError } from "@mystars-tg/faas-wallet";
import { DEFAULT_USDT_MASTER } from "@mystars-tg/faas-wallet";

const args = new Set(process.argv.slice(2));
const PAY = args.has("--pay");
const FRESH = args.has("--new");
const STATE = path.resolve("./data/e2e-last.json");

const die = (m) => {
  console.error("\n✗ " + m);
  process.exit(1);
};
const need = (n) => {
  const v = process.env[n]?.trim();
  if (!v) die(`Env var ${n} missing - .env file mein daalo (README dekho).`);
  return v;
};

const currency = need("PAYMENT_CURRENCY");
if (!["ton", "usdt_ton"].includes(currency)) die('PAYMENT_CURRENCY "ton" (GRAM) ya "usdt_ton" (USDT) hona chahiye.');
let username;
try {
  username = canonicalUsername(need("TEST_USERNAME"));
} catch (e) {
  die(`TEST_USERNAME galat hai: ${e.message}`);
}
const quantity = Number(process.env.TEST_QUANTITY || 50);
if (!Number.isInteger(quantity) || quantity < 50 || quantity > 100) die("TEST_QUANTITY 50 se 100 ke beech hona chahiye (ye script sirf chhote test ke liye hai).");
const maxPay = Number(need("MAX_PAY"));
if (!(maxPay > 0)) die("MAX_PAY ek positive number hona chahiye (jaise 1.1).");
const words = need("WALLET_MNEMONIC").split(/\s+/).filter(Boolean);
if (words.length < 12) die("WALLET_MNEMONIC mein 24 words (space se alag) hone chahiye.");

const client = MyStarsClient.production(need("MYSTARS_API_KEY"));
const wallet = await TonWallet.fromMnemonic(words);
const rpc = new ToncenterRpc({
  endpoint: process.env.TONCENTER_ENDPOINT?.trim() || "https://toncenter.com/api/v2/jsonRPC",
  ...(process.env.TONCENTER_KEY?.trim() ? { apiKey: process.env.TONCENTER_KEY.trim() } : {}),
});

console.log("== Telegram Stars LIVE test ==");
console.log(`Mode        : ${PAY ? "PAY (asli kharidari)" : "DRY RUN (kuch nahi kharidega)"}`);
console.log(`Recipient   : @${username}   Quantity: ${quantity} Stars   Pay in: ${currency === "ton" ? "GRAM" : "USDT"}`);
console.log(`Wallet addr : ${wallet.address}   <- is par paise bhejo`);

// 1) Balance
let gram, usdt = null;
try {
  gram = Number(await wallet.getBalance(rpc)) / 1e9;
  if (currency === "usdt_ton") usdt = Number(await wallet.getJettonBalance(rpc, DEFAULT_USDT_MASTER)) / 1e6;
} catch (e) {
  die(`Wallet balance nahi mila (TON network/RPC problem): ${e.message}\n  Agar toncenter limit laga raha ho to free TONCENTER_KEY lo.`);
}
console.log(`Balance     : ${gram.toFixed(4)} GRAM${usdt != null ? `, ${usdt.toFixed(4)} USDT` : ""}`);

// 2) Live quote (supplier ka asli price; koi price yahan hardcode nahi)
let quote;
try {
  quote = await client.getPricing({ type: "stars", quantity, payment_currency: currency });
} catch (e) {
  die(`Quote nahi mila: ${e.name}: ${e.message}`);
}
const amount = Number(quote.amount);
console.log(`Live quote  : ${quote.amount} ${currency === "ton" ? "GRAM" : "USDT"} for ${quantity} Stars` + (quote.fee ? `  (fee shamil: ${quote.fee.processing_fee} USDT, ${quote.fee.description})` : ""));
console.log(`              (quote sirf hint hai; order banne par price lock hota hai)`);

// 3) Kya paise kaafi hain? (gas ke numbers ESTIMATES hain, docs mein exact nahi)
const problems = [];
if (amount > maxPay) problems.push(`Quote (${amount}) tumhare MAX_PAY (${maxPay}) se zyada hai - script rok raha hai. MAX_PAY badhao ya chhoti quantity lo.`);
if (currency === "ton") {
  if (gram < amount + 0.05) problems.push(`GRAM kam hai: lagbhag ${(amount + 0.05).toFixed(3)} chahiye (quote + ~0.05 network fee), wallet mein ${gram.toFixed(3)}.`);
} else {
  if (usdt < amount) problems.push(`USDT kam hai: ${amount} chahiye, wallet mein ${usdt.toFixed(3)}.`);
  if (gram < 0.1) problems.push(`USDT bhejne ke liye thoda GRAM bhi chahiye (gas, lagbhag 0.1): wallet mein ${gram.toFixed(3)}.`);
}

// 4) Recipient
let check;
try {
  check = await client.checkRecipient({ type: "stars", recipient: { username } });
} catch (e) {
  die(`Recipient check fail: ${e.name}: ${e.message}`);
}
console.log(`Username    : resolved=${check.resolved} eligible=${check.eligible}${check.recipient_name ? ` name="${check.recipient_name}"` : ""}${check.indeterminate ? "  (check ka fail-open: pakka nahi)" : ""}`);
if (!check.eligible) problems.push(`@${username} par Stars nahi ja sakte (${check.reason ?? "unknown"}${check.telegram_message ? `: ${check.telegram_message}` : ""}).`);

if (problems.length) {
  console.log("\nProblems:");
  problems.forEach((p) => console.log("  ✗ " + p));
}
if (!PAY) {
  console.log(problems.length ? "\nDRY RUN: upar ki problems theek karo, phir dobara chalao." : "\n✓ DRY RUN theek hai. Asli test ke liye:  npm run e2e -- --pay");
  process.exit(problems.length ? 2 : 0);
}
if (problems.length) die("Problems ki wajah se pay nahi kiya.");

// 5) Double-buy se bachao: pichla state check
fs.mkdirSync(path.dirname(STATE), { recursive: true });
let state = null;
try {
  state = JSON.parse(fs.readFileSync(STATE, "utf8"));
} catch {
  /* pehli baar */
}
const same = state && state.username === username && state.quantity === quantity && state.currency === currency;
if (state && !FRESH) {
  if (!same) die("Pichla test alag settings ka tha. Pehle usse poora karo, ya --new lagao (sirf jab pakka ho ke pichla pay nahi hua ya poora ho chuka).");
  if (state.done) die("Ye test pehle hi poora ho chuka hai (dobara kharidne se rok diya). Naya order chahiye to --new lagao.");
  console.log(`\nPichla adhoora test mila: wahi idempotency key dobara use hogi, isliye dobara pay NAHI hoga.`);
}
const key = state && !FRESH && same ? state.key : `e2e-${username}-${quantity}-${Date.now()}`;
fs.writeFileSync(STATE, JSON.stringify({ key, username, quantity, currency, done: false, startedAt: new Date().toISOString() }, null, 2));

console.log(`\nAsli payment shuru: ~${quote.amount} ${currency === "ton" ? "GRAM" : "USDT"} kharch hoga. Rokna ho to 5 second mein Ctrl+C dabao...`);
await new Promise((r) => setTimeout(r, 5000));

try {
  const order = await fulfill(
    client,
    wallet,
    { type: "stars", recipient: { username }, quantity, payment_currency: currency },
    { rpc, idempotencyKey: key, wait: { onUpdate: (o) => console.log(`  status: ${o.status}`) } },
  );
  console.log(`\nFinal status: ${order.status}`);
  if (order.status === "delivered") {
    fs.writeFileSync(STATE, JSON.stringify({ key, username, quantity, currency, done: true, orderId: order.order_id, finishedAt: new Date().toISOString() }, null, 2));
    console.log(`✓ MyStars kehta hai DELIVERED. purchase_tx: ${order.purchase_tx ?? "-"}`);
    console.log(`\nAB KHUD CHECK KARO: @${username} ke Telegram mein ${quantity} Stars gift (shayad anonymous sender) ke roop mein aaye?`);
    console.log("Jab tak Telegram mein Stars na dikhein, test pass mat maano.");
  } else {
    console.log(`✗ Order delivered nahi hua (status=${order.status}, reason=${order.failure_reason ?? "-"}). Order id: ${order.order_id}`);
    process.exitCode = 3;
  }
} catch (e) {
  const id = orderIdFromError(e);
  console.error(`\n✗ Error: ${e.name}: ${e.message}`);
  if (id) console.error(`  Order id: ${id}. Payment ho chuki ho sakti hai. Wahi command dobara chalao (same key -> dobara pay NAHI hoga), ya MyStars bot mein order status dekho.`);
  process.exitCode = 4;
}
