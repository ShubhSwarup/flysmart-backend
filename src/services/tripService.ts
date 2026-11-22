import { Trip } from "../models/Trip.js";
import { getSettings } from "../models/Settings.js";
import { fetchSearchesLeft } from "../integrations/serpapi.js";
import { SearchCandidate } from "../models/SearchCandidate.js";
import {
  PROVIDER_QUOTAS,
  MAX_CANDIDATES_PER_CYCLE,
  MAX_FARE_CONFIRMATIONS_PER_CYCLE,
} from "../config/quotas.js";
import { cadenceDays, getCandidateWindow } from "./tripWindow.js";
import { isMultiCandidateWindow } from "./candidateRanking.js";
import { planPollRun } from "./pollPlanning.js";

function isDue(trip: InstanceType<typeof Trip>, now: Date): boolean {
  if (!trip.lastPolledAt) return true;
  const daysSincePoll = (now.getTime() - trip.lastPolledAt.getTime()) / 86_400_000;
  // Small tolerance since the scheduled cron isn't exactly N*24h apart run
  // to run — the cadence table means "roughly every N days," not to-the-
  // minute precision.
  return daysSincePoll >= cadenceDays(trip) - 0.5;
}

// How many real searches this trip could spend if it's polled this cycle.
// Pricing dates costs exactly 1 for a single-exact-date trip and up to
// MAX_CANDIDATES_PER_CYCLE for a genuine date range, and a round trip then
// also spends searches picking return flights to get real totals. A trip with
// no resolvable window costs nothing — pollTrip will skip it without touching
// the provider.
function requestedSearchWeight(trip: InstanceType<typeof Trip>): number {
  const window = getCandidateWindow(trip);
  if (!window) return 0;
  const tripType = trip.tripType ?? "round_trip";
  const isRange = isMultiCandidateWindow(
    window,
    tripType,
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
  );
  const dateSearches = isRange ? MAX_CANDIDATES_PER_CYCLE : 1;
  return dateSearches + (tripType === "round_trip" ? MAX_FARE_CONFIRMATIONS_PER_CYCLE : 0);
}

// Cadence-eligible trips for a scheduled batch run (Section 3.3 step 2),
// throttled against the monthly SerpApi quota (Section 10.4) by planPollRun.
// Skipped trips simply become due again on the next run rather than the run
// failing or silently overrunning the free tier.
export async function getDueTrips() {
  const now = new Date();
  const active = await Trip.find({ status: "active" });
  const due = active.filter((t) => isDue(t, now));

  const settings = await getSettings();
  const month = now.toISOString().slice(0, 7);
  const usage = settings.apiUsage?.get("serpapi");
  const usedThisMonth = usage && usage.month === month ? (usage.count ?? 0) : 0;
  const remaining =
    (await fetchSearchesLeft()) ?? Math.max(0, PROVIDER_QUOTAS.serpapi.quota - usedThisMonth);

  const { affordable, skipped, plannedSpend, allowance } = planPollRun(
    due,
    requestedSearchWeight,
    remaining,
    now,
  );
  if (skipped.length > 0) {
    console.warn(
      `Holding back ${skipped.length} due trip(s) to pace the monthly SerpApi quota ` +
        `(${remaining} searches left this month, today's allowance ${allowance}, ` +
        `${plannedSpend} planned). They run first once their turn comes.`,
    );
  }
  return affordable;
}

// What makes up a trip's search — change any of it and everything already
// found describes a different trip. Budget and notes aren't here because they
// change how results are judged, not what they are.
function searchSignature(trip: InstanceType<typeof Trip>): string {
  return JSON.stringify([
    trip.origin,
    trip.destinationAirports,
    trip.openJawReturnAirports,
    trip.tripType,
    trip.travelWindowType,
    trip.travelWindow?.earliestDeparture ?? null,
    trip.travelWindow?.latestDeparture ?? null,
    trip.travelWindow?.months ?? [],
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
    trip.cabinClass,
    trip.maxStops ?? null,
    trip.maxLayoverMinutes ?? null,
  ]);
}

export function searchChanged(
  before: InstanceType<typeof Trip>,
  after: InstanceType<typeof Trip>,
): boolean {
  return searchSignature(before) !== searchSignature(after);
}

// Starts a trip's search over after an edit, so dates and fares found under
// the old route or rules can't keep posing as its best option. Only the
// working state goes — observations stay, they're permanent route history.
export async function resetTripSearch(tripId: unknown): Promise<void> {
  await SearchCandidate.deleteMany({ tripId });
  await Trip.updateOne(
    { _id: tripId },
    {
      $set: { bestHistory: [], lastPolledAt: null, lastPollStatus: null, lastPollError: null },
      $unset: { lastPriceInsight: 1 },
    },
  );
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
