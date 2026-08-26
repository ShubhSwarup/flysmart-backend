import { Router } from "express";
import { Settings, getSettings } from "../models/Settings.js";
import { sendTelegramMessage } from "../integrations/telegram.js";
import { env } from "../config/env.js";
import { PROVIDER_QUOTAS } from "../config/quotas.js";

export const settingsRouter = Router();

settingsRouter.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

settingsRouter.patch("/", async (req, res) => {
  try {
    // A plain $set on "quietHours" replaces the whole subdocument, which
    // would silently drop start/end/timezone fields not included in this
    // particular patch (the frontend updates start and end independently).
    // Merge onto the current value instead of trusting the caller to send
    // the full nested object every time.
    const current = await getSettings();
    const patch: Record<string, unknown> = { ...req.body };
    if (req.body.quietHours) {
      patch.quietHours = { ...current.quietHours, ...req.body.quietHours };
    }
    const settings = await Settings.findByIdAndUpdate("global", patch, {
      new: true,
      upsert: true,
      runValidators: true,
    });
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Sends a real Telegram message through the actual configured bot/chat ID —
// previously this was faked entirely on the frontend (a setTimeout that
// always "succeeded"), which meant a broken chat ID looked identical to a
// working one until a real notification silently failed to arrive.
settingsRouter.post("/test-message", async (_req, res) => {
  const settings = await getSettings();
  if (!settings.telegramChatId && !env.telegramChatId) {
    return res.status(400).json({ error: "No Telegram chat ID configured." });
  }
  try {
    await sendTelegramMessage(
      "✅ This is a test message from FlySmart — your Telegram notifications are working.",
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

settingsRouter.get("/api-usage", async (_req, res) => {
  const settings = await getSettings();
  const month = new Date().toISOString().slice(0, 7);
  const usage = Object.entries(PROVIDER_QUOTAS).map(([provider, meta]) => {
    const entry = settings.apiUsage?.get(provider);
    const used = entry && entry.month === month ? entry.count : 0;
    return { provider, used, quota: meta.quota, unit: meta.unit };
  });
  res.json(usage);
});
