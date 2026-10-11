// Saari settings environment variables se aati hain. Koi secret code mein hardcode nahi hota.
// Local: .env file (git mein NAHI jati). Railway: "Variables" tab.

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}
function opt(name, fallback = "") {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function int(name, fallback) {
  const v = opt(name, String(fallback));
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Env var ${name} must be a non-negative integer`);
  return n;
}

export function loadConfig() {
  const paymentCurrency = need("PAYMENT_CURRENCY"); // "ton" (GRAM) ya "usdt_ton" (USDT) - koi default nahi
  if (!["ton", "usdt_ton"].includes(paymentCurrency)) {
    throw new Error('PAYMENT_CURRENCY must be "ton" or "usdt_ton"');
  }
  return {
    port: int("PORT", 3000),
    publicBaseUrl: opt("PUBLIC_BASE_URL").replace(/\/+$/, ""), // https://your-app.up.railway.app
    dbPath: opt("DB_PATH", "./data/orders.db"),

    digiseller: {
      sellerId: Number(need("DIGISELLER_SELLER_ID")),
      apiKey: need("DIGISELLER_API_KEY"),
      // Option (parameter) jisme buyer Telegram username likhta hai. Probe script se ID milti hai.
      usernameOptionId: opt("DIGISELLER_USERNAME_OPTION_ID"),
      // "Mark delivered" ka URL - official docs section #deliveruniquecode se confirm karke bharo.
      // Khali ho to ye step skip hota hai. {code} aur {token} placeholders.
      deliverUrlTemplate: opt("DIGISELLER_DELIVER_URL_TEMPLATE"),
      deliverMethod: opt("DIGISELLER_DELIVER_METHOD", "POST"),
    },

    mystars: {
      apiKey: need("MYSTARS_API_KEY"),
      webhookSecret: opt("MYSTARS_WEBHOOK_SECRET"), // optional: bina iske polling hi chalegi
    },

    payment: {
      currency: paymentCurrency,
      walletMnemonic: opt("WALLET_MNEMONIC"), // 24 words, space separated. Sirf server env mein.
      toncenterEndpoint: opt("TONCENTER_ENDPOINT", "https://toncenter.com/api/v2/jsonRPC"),
      toncenterKey: opt("TONCENTER_KEY"),
      lowGram: Number(opt("LOW_BALANCE_GRAM", "0")),
      lowUsdt: Number(opt("LOW_BALANCE_USDT", "0")),
    },

    limits: {
      // Isse bade orders khud-ba-khud pay NAHI hote; "needs_review" mein jate hain.
      maxStarsAuto: int("MAX_STARS_AUTO", 500),
      maxStarsPerDay: int("MAX_STARS_PER_DAY", 5000),
    },

    notify: {
      botToken: opt("ALERT_BOT_TOKEN"),
      chatId: opt("ALERT_CHAT_ID"),
    },

    supportText: opt("SUPPORT_TEXT", "Please contact the seller via the Digiseller chat."),
    sweepIntervalMs: int("SWEEP_INTERVAL_SECONDS", 30) * 1000,
  };
}
