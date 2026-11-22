import { env } from "../config/env.js";
import { getSettings } from "../models/Settings.js";

// Telegram is the sole notification channel (Section 11.1) — free, reliable,
// reaches the phone instantly. No email/push needed for a single user.
export async function sendTelegramMessage(
  text: string,
  options?: { parseMode?: "HTML" },
): Promise<void> {
  // The chat ID is user-editable in Settings (stored in the DB), but actual
  // sends previously ignored that and always used the .env value — meaning
  // editing it in the UI silently did nothing. DB value wins when set; .env
  // remains the fallback for the initial/default configuration.
  const settings = await getSettings();
  const chatId = settings.telegramChatId || env.telegramChatId;

  if (!env.telegramBotToken || !chatId) {
    console.warn("Telegram not configured (bot token / chat ID missing) — skipping send:", text);
    return;
  }

  const url = `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}
