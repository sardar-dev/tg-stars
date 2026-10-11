import { log } from "./log.js";

// Owner ko Telegram par alert bhejta hai (optional). Token/chat_id env se aate hain.
export function makeNotifier(cfg, fetchImpl = fetch) {
  return async function notify(text) {
    log.warn("ALERT", { text });
    if (!cfg.botToken || !cfg.chatId) return;
    try {
      await fetchImpl(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text: String(text).slice(0, 3500) }),
      });
    } catch (e) {
      log.error("alert send failed", { err: e.message });
    }
  };
}
