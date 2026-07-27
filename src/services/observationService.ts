import type { Types } from "mongoose";
import { Observation } from "../models/Observation.js";
import { toINR } from "../integrations/fx.js";
import type { NormalizedItinerary } from "../integrations/serpapi.js";

// ORIGIN-DESTINATIONAIRPORT-CABINCLASS — independent of any one trip's
// filters, so observations accumulate across trips and years (Section 3.4).
export function makeRouteKey(origin: string, destinationAirport: string, cabinClass: string): string {
  return `${origin}-${destinationAirport}-${cabinClass}`;
}

// Inverse of makeRouteKey's middle segment. Safe because origin/destination
// airport codes are always exactly 3 letters with no hyphens, and cabinClass
// values use underscores (e.g. "premium_economy"), never hyphens.
export function airportFromRouteKey(routeKey: string): string {
  return routeKey.split("-").slice(1, -1).join("-");
}

interface RecordObservationsInput {
  tripId: Types.ObjectId | null;
  origin: string;
  departureDate: string;
  returnDate?: string;
  cabinClass: string;
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
      routeKey: makeRouteKey(input.origin, it.arrivalAirport, input.cabinClass),
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
