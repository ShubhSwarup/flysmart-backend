// Whether an itinerary satisfies a trip's stated stop/layover constraints.
// Google already applies these as search filters (serpapi.ts), so this is the
// backstop that also covers the return leg once it's known, and any provider
// or older observation that wasn't filtered.
export interface TripConstraints {
  maxStops?: number | null;
  maxLayoverMinutes?: number | null;
}

export interface ConstrainableItinerary {
  stops: number;
  layoverMinutes: number[];
}

export function withinTripConstraints(
  trip: TripConstraints,
  itinerary: ConstrainableItinerary,
): boolean {
  if (trip.maxStops != null && itinerary.stops > trip.maxStops) return false;
  // A nonstop itinerary has no layovers to exceed the limit, so the layover
  // check is only meaningful once there's at least one stop (matches the
  // trip form's own "applies when stops > 0" hint for this field).
  if (
    itinerary.stops > 0 &&
    trip.maxLayoverMinutes != null &&
    itinerary.layoverMinutes.some((minutes) => minutes > trip.maxLayoverMinutes!)
  ) {
    return false;
  }
  return true;
}

// Long enough that it stops being a connection and becomes part of the plan.
// Allowed unless the trip says otherwise, but never left unmentioned.
export const LONG_LAYOVER_MINUTES = 360;

// Paying this little extra is always worth it for at least this much less
// time travelling — the real case behind it: Philippine Airlines at ₹64,089
// with a 22-hour layover beat Cathay Pacific at ₹64,412 with a 3.5-hour one.
const NEAR_TIE_PRICE_RATIO = 1.05;
const NEAR_TIE_MINUTES_SAVED = 180;

interface ComparableFare {
  price: number;
  durationMinutes: number;
}

// Cheapest first, except that a near-tie goes to the much shorter journey. A
// truly cheaper long journey stays first — that's the trip-owner's call, made
// visible by the layover warning, not something to hide from them.
export function rankFares<T extends ComparableFare>(fares: T[]): T[] {
  const byPrice = [...fares].sort((a, b) => a.price - b.price || a.durationMinutes - b.durationMinutes);
  const cheapest = byPrice[0];
  if (!cheapest) return byPrice;
  const nearTies = byPrice.filter((fare) => fare.price <= cheapest.price * NEAR_TIE_PRICE_RATIO);
  const shortest = nearTies.reduce((a, b) => (b.durationMinutes < a.durationMinutes ? b : a));
  if (cheapest.durationMinutes - shortest.durationMinutes < NEAR_TIE_MINUTES_SAVED) return byPrice;
  return [shortest, ...byPrice.filter((fare) => fare !== shortest)];
}
