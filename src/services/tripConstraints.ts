// Whether an itinerary satisfies a trip's stated stop/layover constraints.
// Applied when choosing which itinerary represents "this trip's cheapest
// fare" for notifications — never when recording observations, since every
// itinerary a search returns is still recorded regardless of whether this
// specific trip would accept it, preserving full route-level history
// (Section 3.4) even for itineraries this trip's own filters would reject.
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
