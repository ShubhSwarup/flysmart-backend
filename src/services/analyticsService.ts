import { Observation } from "../models/Observation.js";

interface PriorTripStats {
  low: number | null;
  lastPriceINR: number | null;
}

// Stats as they stood *before* this poll cycle — the baseline a new
// observation is compared against (Section 11.2's "previous low", "last check").
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
