import { MyStarsClient } from "@mystars-tg/faas-sdk";
import { TonWallet, ToncenterRpc, OrderPayer, DEFAULT_USDT_MASTER } from "@mystars-tg/faas-wallet";

// Verified against: https://mystars.tg/openapi.json (v2.0.0), SDK READMEs (unpkg).
// - payment_currency is REQUIRED ("ton" = GRAM, "usdt_ton" = USDT).
// - POST /v1/orders needs an Idempotency-Key; same key + same body = same order.
// - There is NO prepaid balance: each order is paid by its own on-chain transfer.

export function makeMyStars(cfg, publicBaseUrl) {
  const client = MyStarsClient.production(cfg.mystars.apiKey);
  const currency = cfg.payment.currency;
  const callback_url = cfg.mystars.webhookSecret && publicBaseUrl ? `${publicBaseUrl}/webhooks/mystars` : undefined;

  return {
    client,
    checkRecipient: (username) => client.checkRecipient({ type: "stars", recipient: { username } }),
    createOrder: ({ username, quantity, key }) =>
      client.createOrder(
        { type: "stars", recipient: { username }, quantity, payment_currency: currency, ...(callback_url ? { callback_url } : {}) },
        { idempotencyKey: key },
      ),
    getOrder: (id) => client.getOrder(id),
    cancelOrder: (id) => client.cancelOrder(id),
  };
}

// Real payer: apne wallet se on-chain payment bhejta hai.
export async function makePayer(cfg) {
  const words = cfg.payment.walletMnemonic.split(/\s+/).filter(Boolean);
  if (words.length < 12) throw new Error("WALLET_MNEMONIC missing/short (expected 24 words)");
  const wallet = await TonWallet.fromMnemonic(words);
  const rpc = new ToncenterRpc({
    endpoint: cfg.payment.toncenterEndpoint,
    ...(cfg.payment.toncenterKey ? { apiKey: cfg.payment.toncenterKey } : {}),
  });
  const payer = new OrderPayer(wallet);
  return {
    address: wallet.address,
    pay: (order) => payer.payOrder(order, { rpc }),
    async balances() {
      const gram = Number(await wallet.getBalance(rpc)) / 1e9;
      const usdt = cfg.payment.currency === "usdt_ton" ? Number(await wallet.getJettonBalance(rpc, DEFAULT_USDT_MASTER)) / 1e6 : null;
      return { gram, usdt };
    },
  };
}
