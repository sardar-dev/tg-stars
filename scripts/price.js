// Use: npm run price
// Live MyStars quote se aapki selling price (per Star) calculate karta hai.
// Koi supplier price yahan hardcode nahi: sab MyStars API se aata hai. Fees aap env mein dete ho
// (DigiSeller/Plati ki asli fees apne account ke Tariff/Fees page se dekho - main ne invent nahi ki).
//
// Required env:
//   MYSTARS_API_KEY, PAYMENT_CURRENCY (ton|usdt_ton)
//   PLATFORM_FEE_PCT   -> Plati/DigiSeller commission jo aapki sale se kategi (%)
//   PAYOUT_FEE_PCT     -> withdrawal/conversion cost jo aapke paise nikalne par lagta hai (%)
//   MARGIN_PCT         -> profit jo aap cost ke upar chahte ho (%)
// Optional:
//   FIXED_COST_USD     -> har order par fixed kharcha (default 0)
//   GRAM_USD           -> agar PAYMENT_CURRENCY=ton ho to 1 GRAM = kitne USD (apne exchange rate se)
import { MyStarsClient } from "@mystars-tg/faas-sdk";

const need = (n) => {
  const v = process.env[n];
  if (v === undefined || v === "") {
    console.error(`Missing env var ${n}`);
    process.exit(1);
  }
  return v;
};
const num = (n, d) => {
  const v = process.env[n];
  return v === undefined || v === "" ? d : Number(v);
};

const currency = need("PAYMENT_CURRENCY");
const platformFee = Number(need("PLATFORM_FEE_PCT")) / 100;
const payoutFee = Number(need("PAYOUT_FEE_PCT")) / 100;
const margin = Number(need("MARGIN_PCT")) / 100;
const fixedUsd = num("FIXED_COST_USD", 0);

const client = MyStarsClient.production(need("MYSTARS_API_KEY"));
const sizes = [50, 100, 500, 1000, 5000, 25000];
const batch = await client.getPricingBatch({ quantities: sizes, payment_currency: currency });

// USD mein cost
let usdPerUnit;
if (currency === "usdt_ton") usdPerUnit = 1;
else {
  const g = num("GRAM_USD", num("GRAM_USD_FALLBACK", NaN));
  const fromApi = Number(batch.usdt_per_ton);
  usdPerUnit = Number.isFinite(g) ? g : fromApi; // API ka indicative rate (informational)
  console.log(`GRAM->USD rate used: ${usdPerUnit} (${Number.isFinite(g) ? "GRAM_USD env" : "MyStars usdt_per_ton, indicative"})`);
}

const rows = batch.quotes.map((q) => {
  const costUsd = Number(q.amount) * usdPerUnit;
  const perStarCost = costUsd / q.quantity;
  // price jisme: price*(1-platform-payout) - fixed >= cost*(1+margin)
  const price = (costUsd * (1 + margin) + fixedUsd) / (1 - platformFee - payoutFee);
  return {
    stars: q.quantity,
    supplier_cost: `${q.amount} ${q.fee ? "USDT" : "GRAM"}`,
    cost_usd: costUsd.toFixed(4),
    cost_per_star_usd: perStarCost.toFixed(5),
    min_price_usd: price.toFixed(4),
    price_per_star_usd: (price / q.quantity).toFixed(5),
  };
});
console.table(rows);
console.log(`Quote valid_until: ${batch.valid_until} (price market ke saath badalta hai - ye sirf hint hai).`);
console.log("\nDigiSeller variable-price product mein EK hi per-unit price lagti hai (4 decimals tak).");
console.log("Chhoti quantity par per-star cost thodi zyada hoti hai (gas/fixed). Safe price = upar ki table mein se SABSE UNCHI price_per_star_usd");
console.log("(ya us quantity range ko dhyan mein rakho jo aap actually bechoge) + chhota buffer, kyunki rate roz badalta hai.");
console.log("Price ko USD se DigiSeller ki currency (WMZ/WMR etc.) mein convert karna aapka manual step hai.");
