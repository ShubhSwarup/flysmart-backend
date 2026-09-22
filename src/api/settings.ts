import { Router } from "express";
import { Settings, getSettings } from "../models/Settings.js";
import { sendTelegramMessage } from "../integrations/telegram.js";
import { env } from "../config/env.js";
import { PROVIDER_QUOTAS } from "../config/quotas.js";

export const settingsRouter = Router();

// A day off that's already passed is dropped from what the API returns —
// nothing left to plan around it for — but never deleted from the
// document itself, so the record isn't lost if the user wants to look
// back (Section D's "past dates fade, not vanish").
function withUpcomingDaysOff(settings: InstanceType<typeof Settings>) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const obj = settings.toObject();
  return {
    ...obj,
    daysOff: (obj.daysOff ?? []).filter((d) => d.date != null && d.date.getTime() >= today.getTime()),
  };
}

settingsRouter.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(withUpcomingDaysOff(settings));
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
    res.json(withUpcomingDaysOff(settings!));
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
    const sameMonth = entry?.month === month;
    const used = sameMonth ? entry.count : 0;
    // Single-exact-date trips vs. genuine date-range trips (flexible-month,
    // days-off with multiple candidates, a fixed range) — informational
    // only (Section G), so the one person running this can see and tune
    // the tradeoff themselves rather than the split being invisible.
    const single = sameMonth ? (entry.byCategory?.single ?? 0) : 0;
    const range = sameMonth ? (entry.byCategory?.range ?? 0) : 0;
    return { provider, used, quota: meta.quota, unit: meta.unit, single, range };
  });
  res.json(usage);
});
