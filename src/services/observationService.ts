import type { Types } from "mongoose";
import { Observation } from "../models/Observation.js";
import { toINR } from "../integrations/fx.js";
import type { NormalizedItinerary, ReturnFlightOption } from "../integrations/serpapi.js";

// ORIGIN-DESTINATIONAIRPORT-CABINCLASS-TRIPTYPE — independent of any one
// trip's filters, so observations accumulate across trips and years
// (Section 3.4). tripType is part of the key (not just metadata) because a
// one-way fare and a round-trip fare for the same route are not comparable
// numbers — mixing them under one key would corrupt "all-time low" /
// "historic low" comparisons the moment either type existed alongside the
// other (e.g. a one-way price would almost always look like a fake
// "historic low" against round-trip history).
//
// An open-jaw trip gets its own last segment for the same reason: flying home
// from a different city is a different product at a different price (BOM-HAN
// returning from PQC cost ₹24,000+ more than returning from HAN).
export function makeRouteKey(
  origin: string,
  destinationAirport: string,
  cabinClass: string,
  tripType: string,
  openJawReturnAirports: string[] = [],
): string {
  const typeSegment =
    tripType === "round_trip" && openJawReturnAirports.length > 0
      ? `open_jaw_${[...openJawReturnAirports].sort().join("_")}`
      : tripType;
  return `${origin}-${destinationAirport}-${cabinClass}-${typeSegment}`;
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
  openJawReturnAirports?: string[];
  source: "serpapi" | "duffel" | "travelpayouts" | "manual";
  itineraries: NormalizedItinerary[];
  googleFlightsUrl?: string | null;
}

export async function recordObservations(input: RecordObservationsInput) {
  if (input.itineraries.length === 0) return [];

  const docs = await Promise.all(
    input.itineraries.map(async (it) => ({
      tripId: input.tripId,
      // Derived per itinerary, not once for the whole batch — a combined
      // multi-airport search returns itineraries to different airports.
      routeKey: makeRouteKey(
        input.origin,
        it.arrivalAirport,
        input.cabinClass,
        input.tripType,
        input.openJawReturnAirports,
      ),
      source: input.source,
      queriedAt: new Date(),
      departureDate: new Date(input.departureDate),
      returnDate: input.returnDate ? new Date(input.returnDate) : null,
      price: { amount: it.price, currency: it.currency },
      priceINR: await toINR(it.price, it.currency),
      airlines: it.airlines,
      stops: it.stops,
      layoverMinutes: it.layoverMinutes,
      // Set only for an open-jaw itinerary (the return leg departed from a
      // different airport than the outbound leg arrived at) — null for a
      // normal symmetric round trip or a one-way fare.
      returnDepartureAirport: it.returnDepartureAirport,
      fareConfirmed: it.departureToken == null,
      durationMinutes: it.durationMinutes,
      googleFlightsUrl: input.googleFlightsUrl ?? null,
      cabinClass: input.cabinClass,
      refundable: null,
      baggageIncluded: null,
      raw: it.raw,
    })),
  );

  return Observation.insertMany(docs);
}

// Records the whole-trip fare once a return flight has been picked for an
// outbound lead. A new observation rather than an edit of the lead, since
// observations are append-only: the lead stays as the record of what Google
// first quoted, this one is what the trip really costs.
export async function recordConfirmedFare(
  lead: InstanceType<typeof Observation>,
  returnFlight: ReturnFlightOption,
  googleFlightsUrl: string | null,
) {
  const isOpenJaw = returnFlight.departureAirport !== airportFromRouteKey(lead.routeKey);
  return Observation.create({
    tripId: lead.tripId,
    routeKey: lead.routeKey,
    source: lead.source,
    queriedAt: new Date(),
    departureDate: lead.departureDate,
    returnDate: lead.returnDate,
    price: { amount: returnFlight.price, currency: returnFlight.currency },
    priceINR: await toINR(returnFlight.price, returnFlight.currency),
    airlines: lead.airlines,
    stops: lead.stops,
    layoverMinutes: lead.layoverMinutes,
    returnDepartureAirport: isOpenJaw ? returnFlight.departureAirport : null,
    fareConfirmed: true,
    returnLeg: {
      airlines: returnFlight.airlines,
      stops: returnFlight.stops,
      layoverMinutes: returnFlight.layoverMinutes,
      departureAirport: returnFlight.departureAirport,
      departAt: returnFlight.departAt,
      arriveAt: returnFlight.arriveAt,
      durationMinutes: returnFlight.durationMinutes,
    },
    durationMinutes: lead.durationMinutes,
    googleFlightsUrl: googleFlightsUrl ?? lead.googleFlightsUrl,
    cabinClass: lead.cabinClass,
    refundable: null,
    baggageIncluded: null,
    raw: { outbound: lead.raw, return: returnFlight.raw },
  });
}
