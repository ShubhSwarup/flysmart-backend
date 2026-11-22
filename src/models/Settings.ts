import { Schema, model, type InferSchemaType } from "mongoose";

// Single-document collection — one user, one settings record, fixed _id.
const settingsSchema = new Schema({
  _id: { type: String, default: "global" },
  telegramChatId: { type: String, default: "" },
  quietHours: {
    start: { type: String, default: "22:00" },
    end: { type: String, default: "08:00" },
    timezone: { type: String, default: "Asia/Kolkata" },
  },
  defaultCurrency: { type: String, default: "INR" },
  defaultPriority: { type: String, enum: ["high", "normal", "low"], default: "normal" },
  // The user's personal "days I already have off" list (Days Off feature) —
  // a fact about their life, not about any one trip, so it lives here and
  // is reused across as many trip ideas as reference it. A date that's
  // already passed is filtered out at read time (api/settings.ts), not
  // deleted, so the record isn't lost if the user wants to look back.
  daysOff: {
    type: [{ date: Date, label: { type: String, default: "" } }],
    default: [],
  },
  apiUsage: {
    type: Map,
    of: new Schema(
      {
        month: String,
        count: Number,
        // How much of this month's spend came from a single-exact-date
        // search vs. a genuine date-range trip's candidate verification
        // (Section G's "give range trips their own visible budget line") —
        // informational only, never itself enforced as a separate cap.
        byCategory: { single: { type: Number, default: 0 }, range: { type: Number, default: 0 } },
      },
      { _id: false },
    ),
    default: {},
  },
});

export type SettingsDoc = InferSchemaType<typeof settingsSchema>;
export const Settings = model("Settings", settingsSchema);

export async function getSettings() {
  return (
    (await Settings.findById("global")) ??
    (await Settings.create({ _id: "global" }))
  );
}

// Called by each integration after a real provider call (Section 10.4).
// Resets automatically when the month rolls over. `category` tags whether
// this call came from a single-exact-date trip or a genuine date-range
// trip's candidate verification, purely for the Settings usage breakdown —
// omit it for providers/calls this distinction doesn't apply to.
export async function incrementApiUsage(
  provider: string,
  category?: "single" | "range",
): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const settings = await getSettings();
  const current = settings.apiUsage?.get(provider);
  const sameMonth = current?.month === month;
  const count = sameMonth ? (current?.count ?? 0) + 1 : 1;
  const byCategory = {
    single: sameMonth ? (current?.byCategory?.single ?? 0) : 0,
    range: sameMonth ? (current?.byCategory?.range ?? 0) : 0,
  };
  if (category) byCategory[category] += 1;
  await Settings.updateOne(
    { _id: "global" },
    { $set: { [`apiUsage.${provider}`]: { month, count, byCategory } } },
  );
}
