import { env } from "../config/env.js";

// Telegram is the sole notification channel (Section 11.1) — free, reliable,
// reaches the phone instantly. No email/push needed for a single user.
export async function sendTelegramMessage(
  text: string,
  options?: { parseMode?: "HTML" },
): Promise<void> {
  if (!env.telegramBotToken || !env.telegramChatId) {
    console.warn("Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — skipping send:", text);
    return;
  }

  const url = `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.telegramChatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}
