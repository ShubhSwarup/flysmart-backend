import type { Types } from "mongoose";
import type { Trip } from "../models/Trip.js";
import { markPolled } from "./tripService.js";
import { searchFlights } from "../integrations/serpapi.js";
import { recordObservations, makeRouteKey, airportFromRouteKey } from "./observationService.js";
import { getPriorTripStats, getPriorRouteLow, hasEverBeenUnderBudget } from "./analyticsService.js";
import { evaluateTripNotifications } from "./notificationService.js";
import { getEffectiveEarliestDeparture } from "./tripWindow.js";

// The single per-trip poll operation — shared by the scheduled batch job
// (scripts/poll.ts) and the immediate baseline search on trip creation
// (api/trips.ts), so there is exactly one implementation of "how a trip
// gets checked," not two. Never throws — failures are caught and recorded
// via markPolled's error param so callers don't need their own try/catch.
export async function pollTrip(trip: InstanceType<typeof Trip>): Promise<void> {
  const budget = trip.budget;
  const tripType = trip.tripType ?? "round_trip";
  // Fixed-date trips use their own earliestDeparture. Flexible-month trips
  // have no single date — getEffectiveEarliestDeparture samples the 15th of
  // the earliest selected month as a representative search date, so these
  // trips actually get monitored instead of being skipped entirely.
  const earliestDeparture = getEffectiveEarliestDeparture(trip);
  // tripDuration only matters for round trip — it's what a return date is
  // computed from. A one-way trip has no return leg, so no duration to
  // require.
  if (!earliestDeparture || !budget || (tripType === "round_trip" && !trip.tripDuration?.minNights)) {
    console.warn(`Skipping "${trip.name}" — no resolvable travel window (no dates or months set).`);
    return;
  }
  const departureDate = earliestDeparture.toISOString().slice(0, 10);
  const returnDate =
    tripType === "round_trip"
      ? new Date(earliestDeparture.getTime() + trip.tripDuration!.minNights! * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : undefined;
  const pollTime = new Date();

  try {
    // Capture "before this poll" baselines first — recordObservations below
    // would otherwise pollute these queries with the new data. One combined
    // search can return itineraries to any of the trip's accepted airports,
    // so we need each airport's own prior route-low, looked up after we know
    // which airport the overall-cheapest result actually landed at.
    const priorRouteLowByAirport = new Map<string, number | null>();
    for (const destinationAirport of trip.destinationAirports) {
      const routeKey = makeRouteKey(trip.origin, destinationAirport, trip.cabinClass, tripType);
      priorRouteLowByAirport.set(destinationAirport, await getPriorRouteLow(routeKey, pollTime));
    }
    const priorTrip = await getPriorTripStats(String(trip._id), pollTime);

    const result = await searchFlights({
      origin: trip.origin,
      destinationAirports: trip.destinationAirports,
      departureDate,
      returnDate,
      cabinClass: trip.cabinClass,
    });

    const inserted = await recordObservations({
      tripId: trip._id as Types.ObjectId,
      origin: trip.origin,
      departureDate,
      returnDate,
      cabinClass: trip.cabinClass,
      tripType,
      source: "serpapi",
      itineraries: result.itineraries,
    });

    console.log(
      `${trip.name} → ${trip.destinationAirports.join("/")}: recorded ${inserted.length} observation(s)` +
        (inserted.length
          ? `, cheapest ₹${Math.min(...inserted.map((o) => o.priceINR)).toLocaleString("en-IN")}`
          : ""),
    );

    if (inserted.length > 0) {
      const cheapest = inserted.reduce((a, b) => (a.priceINR < b.priceINR ? a : b));
      const everUnderBudget = await hasEverBeenUnderBudget(String(trip._id), budget.amount);
      const cheapestAirport = airportFromRouteKey(cheapest.routeKey);

      await evaluateTripNotifications({
        trip: {
          _id: trip._id,
          name: trip.name,
          origin: trip.origin,
          tripType,
          budget,
          travelWindow: { earliestDeparture },
        },
        routeKey: cheapest.routeKey,
        destinationAirport: cheapestAirport,
        cheapest: {
          id: String(cheapest._id),
          priceINR: cheapest.priceINR,
          airlines: cheapest.airlines,
          stops: cheapest.stops,
          departureDate: cheapest.departureDate,
          returnDate: cheapest.returnDate ?? null,
        },
        priorTripLow: priorTrip.low,
        priorRouteLow: priorRouteLowByAirport.get(cheapestAirport) ?? null,
        priorLastPriceINR: priorTrip.lastPriceINR,
        everUnderBudget,
      });
    }

    await markPolled(String(trip._id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to poll ${trip.name}:`, err);
    await markPolled(String(trip._id), message);
  }
}
