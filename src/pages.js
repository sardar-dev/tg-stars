// Buyer ko dikhne wale pages (EN + RU, DigiSeller se aane wali `lang` ke hisaab se).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const T = {
  en: {
    title: "Telegram Stars order",
    processing: "Your payment is confirmed. We are sending your Stars now — this usually takes 1–3 minutes. This page refreshes automatically.",
    delivered: (q, u) => `Done! ${q} Telegram Stars were delivered to @${u}.`,
    failed: (s) => `We could not complete the delivery automatically. ${s}`,
    review: (s) => `Your payment is received, but this order needs a quick manual check. ${s}`,
    invalid: "This link is not valid. Please use the link from your Digiseller purchase page.",
    order: "Order",
    product: "Product",
    recipient: "Recipient",
    qty: "Quantity",
  },
  ru: {
    title: "Заказ Telegram Stars",
    processing: "Оплата подтверждена. Отправляем Stars — обычно это занимает 1–3 минуты. Страница обновляется автоматически.",
    delivered: (q, u) => `Готово! ${q} Telegram Stars отправлены на @${u}.`,
    failed: (s) => `Не удалось выполнить доставку автоматически. ${s}`,
    review: (s) => `Оплата получена, но заказ требует быстрой ручной проверки. ${s}`,
    invalid: "Ссылка недействительна. Используйте ссылку со страницы покупки Digiseller.",
    order: "Заказ",
    product: "Товар",
    recipient: "Получатель",
    qty: "Количество",
  },
};

function page(lang, body, refresh) {
  const t = lang === "ru" ? T.ru : T.en;
  return `<!doctype html><html lang="${lang === "ru" ? "ru" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="6">' : ""}
<title>${esc(t.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;line-height:1.5}
.box{border:1px solid #ccc;border-radius:12px;padding:20px}.ok{border-color:#2a9d4a}.bad{border-color:#c0392b}small{color:#666}</style>
</head><body><h2>${esc(t.title)}</h2>${body}</body></html>`;
}

// Order number = DigiSeller invoice (inv); buyer ko wahi dikhta hai jo uski purchase page par hota hai.
function details(row, t) {
  const who = row.username ? `@${esc(row.username)}` : "—";
  const qty = row.quantity ? esc(row.quantity) : "—";
  return `<p><small>${t.order} #${esc(row.inv)}<br>${t.product}: Telegram Stars<br>${t.recipient}: ${who}<br>${t.qty}: ${qty}</small></p>`;
}

export function renderOrder(row, supportText) {
  const lang = String(row?.lang ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
  const t = lang === "ru" ? T.ru : T.en;
  const ref = details(row, t);
  switch (row.status) {
    case "delivered":
      return page(lang, `<div class="box ok"><p>${esc(t.delivered(row.quantity, row.username))}</p>${ref}</div>`, false);
    case "failed":
      return page(lang, `<div class="box bad"><p>${esc(t.failed(supportText))}</p>${ref}</div>`, false);
    case "needs_review":
      return page(lang, `<div class="box bad"><p>${esc(t.review(supportText))}</p>${ref}</div>`, false);
    default:
      return page(lang, `<div class="box"><p>${esc(t.processing)}</p>${ref}</div>`, true);
  }
}

export function renderInvalid() {
  return page("en", `<div class="box bad"><p>${esc(T.en.invalid)}</p><p>${esc(T.ru.invalid)}</p></div>`, false);
}
