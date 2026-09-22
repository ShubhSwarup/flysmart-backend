import { Observation } from "../models/Observation.js";

interface PriorTripStats {
  low: number | null;
  lastPriceINR: number | null;
}

// Stats as they stood *before* this poll cycle — the baseline a new
// observation is compared against (Section 11.2's "previous low", "last
// check"). Pooled by tripId alone, across every candidate itinerary this
// trip has ever priced (searchCandidateService.ts) — for a trip with a real
// date range this is exactly the intended meaning ("the best we've found
// across every realistic option for this trip idea"), and for a trip with
// only ever one exact date (a fixed single-date trip) it's equivalent to
// scoping by that date anyway, since no other date pair exists under this
// tripId. (An earlier version of this function scoped by exact date pair
// specifically to stop a flexible-month trip's single silently-rolling
// sample date from blending two unrelated itineraries' history together —
// that rolling-single-date model no longer exists, so the narrower scoping
// it required is gone too.)
export async function getPriorTripStats(tripId: string, beforeDate: Date): Promise<PriorTripStats> {
  const prior = await Observation.find({ tripId, queriedAt: { $lt: beforeDate } })
    .sort({ queriedAt: -1 })
    .lean();
  if (prior.length === 0) return { low: null, lastPriceINR: null };
  return {
    low: Math.min(...prior.map((o) => o.priceINR)),
    lastPriceINR: prior[0].priceINR,
  };
}

// Route-scoped (cross-trip, cross-year) low — the bar for "historically rare
// deal" (Section 11.2 route_historic_low), independent of any one trip.
export async function getPriorRouteLow(routeKey: string, beforeDate: Date): Promise<number | null> {
  const cheapest = await Observation.findOne({ routeKey, queriedAt: { $lt: beforeDate } })
    .sort({ priceINR: 1 })
    .lean();
  return cheapest ? cheapest.priceINR : null;
}

export async function hasEverBeenUnderBudget(tripId: string, budgetAmount: number): Promise<boolean> {
  const hit = await Observation.findOne({ tripId, priceINR: { $lte: budgetAmount } }).lean();
  return hit != null;
}
