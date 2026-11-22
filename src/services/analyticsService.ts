import { Observation } from "../models/Observation.js";

const MIN_ROUTE_HISTORY_DAYS = 30;

// Route-scoped (cross-trip, cross-year) low — the bar for "historically rare
// deal" (Section 11.2 route_historic_low), independent of any one trip.
// Unconfirmed leads don't count: comparing a real fare against a guessed price
// would make a genuine low look unremarkable. Anything recorded before leads
// were told apart (fareConfirmed unset) still does. Null until the route has a
// month of history, since a few days of prices can't make anything "historic".
export async function getPriorRouteLow(routeKey: string, beforeDate: Date): Promise<number | null> {
  const oldest = await Observation.findOne({ routeKey }).sort({ queriedAt: 1 }).lean();
  if (!oldest) return null;
  const historyDays = (beforeDate.getTime() - oldest.queriedAt.getTime()) / 86_400_000;
  if (historyDays < MIN_ROUTE_HISTORY_DAYS) return null;

  const cheapest = await Observation.findOne({
    routeKey,
    queriedAt: { $lt: beforeDate },
    fareConfirmed: { $ne: false },
  })
    .sort({ priceINR: 1 })
    .lean();
  return cheapest ? cheapest.priceINR : null;
}

// The lowest raw figure on record for a trip. Only used to explain, when a
// trip is re-baselined, why the new price is higher than earlier alerts said.
export async function getLowestRecordedPrice(tripId: string, beforeDate: Date): Promise<number | null> {
  const cheapest = await Observation.findOne({ tripId, queriedAt: { $lt: beforeDate } })
    .sort({ priceINR: 1 })
    .lean();
  return cheapest ? cheapest.priceINR : null;
}
