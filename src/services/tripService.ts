import { Trip } from "../models/Trip.js";
import { getSettings } from "../models/Settings.js";
import { PROVIDER_QUOTAS, MAX_CANDIDATES_PER_CYCLE } from "../config/quotas.js";
import { cadenceDays, getCandidateWindow } from "./tripWindow.js";
import { isMultiCandidateWindow } from "./candidateRanking.js";

function isDue(trip: InstanceType<typeof Trip>, now: Date): boolean {
  if (!trip.lastPolledAt) return true;
  const daysSincePoll = (now.getTime() - trip.lastPolledAt.getTime()) / 86_400_000;
  // Small tolerance since the scheduled cron isn't exactly N*24h apart run
  // to run — the cadence table means "roughly every N days," not to-the-
  // minute precision.
  return daysSincePoll >= cadenceDays(trip) - 0.5;
}

// How many real searches this trip would like to spend if it's polled this
// cycle — exactly 1 for a single-exact-date trip, up to
// MAX_CANDIDATES_PER_CYCLE for a trip with a genuine date range (a
// flexible-month selection, or a fixed trip whose latestDeparture differs
// from earliestDeparture), since pollTrip caps a range trip's spend at
// exactly that constant. A trip with no resolvable window costs nothing —
// pollTrip will skip it without touching the provider.
function requestedSearchWeight(trip: InstanceType<typeof Trip>): number {
  const window = getCandidateWindow(trip);
  if (!window) return 0;
  const isRange = isMultiCandidateWindow(
    window,
    trip.tripType ?? "round_trip",
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
  );
  return isRange ? MAX_CANDIDATES_PER_CYCLE : 1;
}

// Cadence-eligible trips for a scheduled batch run (Section 3.3 step 2),
// additionally throttled against the monthly SerpApi quota (Section 10.4):
// if today's due list would exceed what's left this month, lower-priority
// trips are skipped first — skipped trips simply become due again on their
// next cadence-eligible day rather than the run failing or silently
// overrunning the free tier. Trimming is by planned search count, not trip
// count, so one trip with a wide date range can't silently starve several
// single-date trips that would otherwise easily fit the remaining budget.
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

  const affordable: InstanceType<typeof Trip>[] = [];
  const skipped: InstanceType<typeof Trip>[] = [];
  let plannedSpend = 0;
  for (const trip of due) {
    const weight = requestedSearchWeight(trip);
    if (plannedSpend + weight <= remaining) {
      affordable.push(trip);
      plannedSpend += weight;
    } else {
      skipped.push(trip);
    }
  }
  if (skipped.length > 0) {
    console.warn(
      `Skipping ${skipped.length} due trip(s) — projected to exceed the monthly SerpApi quota ` +
        `(${usedThisMonth}/${PROVIDER_QUOTAS.serpapi.quota} used this month, ${plannedSpend} more planned). ` +
        `Lower-priority trips skipped first.`,
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
