import type { Types } from "mongoose";
import { Observation } from "../models/Observation.js";
import { toINR } from "../integrations/fx.js";
import type { NormalizedItinerary } from "../integrations/serpapi.js";

// ORIGIN-DESTINATIONAIRPORT-CABINCLASS-TRIPTYPE — independent of any one
// trip's filters, so observations accumulate across trips and years
// (Section 3.4). tripType is part of the key (not just metadata) because a
// one-way fare and a round-trip fare for the same route are not comparable
// numbers — mixing them under one key would corrupt "all-time low" /
// "historic low" comparisons the moment either type existed alongside the
// other (e.g. a one-way price would almost always look like a fake
// "historic low" against round-trip history).
export function makeRouteKey(
  origin: string,
  destinationAirport: string,
  cabinClass: string,
  tripType: string,
): string {
  return `${origin}-${destinationAirport}-${cabinClass}-${tripType}`;
}

// Inverse of makeRouteKey's second segment. Index-based (not slice-based)
// so it stays correct regardless of how many segments follow — safe because
// origin/destination airport codes are always exactly 3 letters with no
// hyphens, and cabinClass/tripType values use underscores, never hyphens.
export function airportFromRouteKey(routeKey: string): string {
  return routeKey.split("-")[1];
}

interface RecordObservationsInput {
  tripId: Types.ObjectId | null;
  origin: string;
  departureDate: string;
  returnDate?: string;
  cabinClass: string;
  tripType: string;
  source: "serpapi" | "duffel" | "travelpayouts" | "manual";
  itineraries: NormalizedItinerary[];
}

export async function recordObservations(input: RecordObservationsInput) {
  if (input.itineraries.length === 0) return [];

  const docs = await Promise.all(
    input.itineraries.map(async (it) => ({
      tripId: input.tripId,
      // Derived per itinerary, not once for the whole batch — a combined
      // multi-airport search returns itineraries to different airports.
      routeKey: makeRouteKey(input.origin, it.arrivalAirport, input.cabinClass, input.tripType),
      source: input.source,
      queriedAt: new Date(),
      departureDate: new Date(input.departureDate),
      returnDate: input.returnDate ? new Date(input.returnDate) : null,
      price: { amount: it.price, currency: it.currency },
      priceINR: await toINR(it.price, it.currency),
      airlines: it.airlines,
      stops: it.stops,
      layoverMinutes: it.layoverMinutes,
      cabinClass: input.cabinClass,
      refundable: null,
      baggageIncluded: null,
      raw: it.raw,
    })),
  );

  return Observation.insertMany(docs);
}
