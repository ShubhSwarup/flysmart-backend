import { Router } from "express";
import { Settings, getSettings } from "../models/Settings.js";

export const settingsRouter = Router();

// Static per-provider quota knowledge (Section 10) — actual usage counts
// come from Settings.apiUsage, which integrations update on every real call.
const PROVIDER_QUOTAS: Record<string, { quota: number; unit: string }> = {
  serpapi: { quota: 250, unit: "searches" },
  duffel: { quota: 200, unit: "searches" },
  travelpayouts: { quota: 1000, unit: "requests" },
};

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
