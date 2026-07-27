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
  apiUsage: {
    type: Map,
    of: new Schema({ month: String, count: Number }, { _id: false }),
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
// Resets automatically when the month rolls over.
export async function incrementApiUsage(provider: string): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const settings = await getSettings();
  const current = settings.apiUsage?.get(provider);
  const count = current && current.month === month ? (current.count ?? 0) + 1 : 1;
  await Settings.updateOne(
    { _id: "global" },
    { $set: { [`apiUsage.${provider}`]: { month, count } } },
  );
}
