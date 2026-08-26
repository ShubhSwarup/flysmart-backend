import { Trip } from "../models/Trip.js";
import { getSettings } from "../models/Settings.js";
import { PROVIDER_QUOTAS } from "../config/quotas.js";
import { cadenceDays } from "./tripWindow.js";

function isDue(trip: InstanceType<typeof Trip>, now: Date): boolean {
  if (!trip.lastPolledAt) return true;
  const daysSincePoll = (now.getTime() - trip.lastPolledAt.getTime()) / 86_400_000;
  // Small tolerance since the scheduled cron isn't exactly N*24h apart run
  // to run — the cadence table means "roughly every N days," not to-the-
  // minute precision.
  return daysSincePoll >= cadenceDays(trip) - 0.5;
}

// Cadence-eligible trips for a scheduled batch run (Section 3.3 step 2),
// additionally throttled against the monthly SerpApi quota (Section 10.4):
// if today's due list would exceed what's left this month, lower-priority
// trips are skipped first — skipped trips simply become due again on their
// next cadence-eligible day rather than the run failing or silently
// overrunning the free tier.
export async function getDueTrips() {
  const now = new Date();
  const active = await Trip.find({ status: "active" });
  const due = active.filter((t) => isDue(t, now));

  const settings = await getSettings();
  const month = now.toISOString().slice(0, 7);
  const usage = settings.apiUsage?.get("serpapi");
  const usedThisMonth = usage && usage.month === month ? (usage.count ?? 0) : 0;
  const remaining = Math.max(0, PROVIDER_QUOTAS.serpapi.quota - usedThisMonth);

  const priorityRank: Record<string, number> = { high: 0, normal: 1, low: 2 };
  due.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  const affordable = due.slice(0, remaining);
  const skipped = due.slice(remaining);
  if (skipped.length > 0) {
    console.warn(
      `Skipping ${skipped.length} due trip(s) — projected to exceed the monthly SerpApi quota ` +
        `(${usedThisMonth}/${PROVIDER_QUOTAS.serpapi.quota} used this month). Lower-priority trips skipped first.`,
    );
  }
  return affordable;
}

export async function markPolled(tripId: string, error?: string): Promise<void> {
  await Trip.updateOne(
    { _id: tripId },
    {
      lastPolledAt: new Date(),
      lastPollStatus: error ? "error" : "ok",
      lastPollError: error ?? null,
    },
  );
}
