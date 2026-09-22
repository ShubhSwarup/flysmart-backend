import type { Types } from "mongoose";
import { Trip } from "../models/Trip.js";
import { markPolled } from "./tripService.js";
import { searchFlights } from "../integrations/serpapi.js";
import { recordObservations, makeRouteKey, airportFromRouteKey } from "./observationService.js";
import { getPriorTripStats, getPriorRouteLow, hasEverBeenUnderBudget } from "./analyticsService.js";
import { evaluateTripNotifications } from "./notificationService.js";
import { getCandidateWindow, type CandidateWindow } from "./tripWindow.js";
import { withinTripConstraints } from "./tripConstraints.js";
import { isMultiCandidateWindow } from "./candidateRanking.js";
import { ensureCandidates, pickCandidatesToVerify, getBestVerifiedCandidate } from "./searchCandidateService.js";
import { SearchCandidate } from "../models/SearchCandidate.js";
import { MAX_CANDIDATES_PER_CYCLE } from "../config/quotas.js";

// The single per-trip poll operation — shared by the scheduled batch job
// (scripts/poll.ts) and the immediate baseline search on trip creation
// (api/trips.ts), so there is exactly one implementation of "how a trip
// gets checked," not two. Never throws — failures are caught and recorded
// via markPolled's error param so callers don't need their own try/catch.
//
// Every trip — a single exact date or a genuine range (a flexible-month
// selection, or a fixed trip with earliestDeparture < latestDeparture) —
// goes through the same candidate machinery. A single-exact-date trip
// simply resolves to exactly one candidate, so it spends exactly one search
// and behaves identically to before; there is no separate "simple" path to
// keep in sync with this one.
export async function pollTrip(trip: InstanceType<typeof Trip>): Promise<void> {
  const budget = trip.budget;
  const tripType = trip.tripType ?? "round_trip";
  const window = getCandidateWindow(trip);
  if (!window || !budget || (tripType === "round_trip" && !trip.tripDuration?.minNights)) {
    console.warn(`Skipping "${trip.name}" — no resolvable travel window (no dates or months set).`);
    return;
  }

  const pollTime = new Date();
  const usageCategory = isMultiCandidateWindow(
    window,
    tripType,
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
  )
    ? "range"
    : "single";

  try {
    await ensureCandidates(trip, window);
    const toVerify = await pickCandidatesToVerify(trip._id as Types.ObjectId, MAX_CANDIDATES_PER_CYCLE);

    let verifiedCount = 0;
    const failures: string[] = [];

    for (const candidate of toVerify) {
      try {
        await verifyCandidate(trip, candidate, tripType, pollTime, usageCategory);
        verifiedCount++;
      } catch (err) {
        // One candidate's provider error never aborts the trip's other
        // candidates this cycle — the same per-trip isolation pollTrip
        // already gives the rest of the batch run, one level deeper.
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${candidate.departureDate.toISOString().slice(0, 10)}: ${message}`);
        console.error(`Candidate search failed for "${trip.name}":`, err);
      }
    }

    if (toVerify.length > 0 && verifiedCount === 0) {
      await markPolled(String(trip._id), `All ${toVerify.length} candidate search(es) failed: ${failures.join("; ")}`);
      return;
    }

    console.log(
      `${trip.name} → ${trip.destinationAirports.join("/")}: verified ${verifiedCount}/${toVerify.length} candidate(s)`,
    );

    await evaluateBestCandidate(trip, window, tripType, budget, pollTime);
    await markPolled(String(trip._id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to poll ${trip.name}:`, err);
    await markPolled(String(trip._id), message);
  }
}

// Runs one real search for one candidate: prices it, records every
// itinerary the provider returned (full history preserved regardless of
// this trip's own stop/layover constraints — Section 3.4), and marks the
// candidate verified with whichever constraint-satisfying itinerary was
// cheapest (or none, if nothing satisfied the constraints).
async function verifyCandidate(
  trip: InstanceType<typeof Trip>,
  candidate: InstanceType<typeof SearchCandidate>,
  tripType: "round_trip" | "one_way",
  pollTime: Date,
  usageCategory: "single" | "range",
): Promise<void> {
  const departureDate = candidate.departureDate.toISOString().slice(0, 10);
  const returnDate = candidate.returnDate ? candidate.returnDate.toISOString().slice(0, 10) : undefined;

  const result = await searchFlights({
    origin: trip.origin,
    destinationAirports: trip.destinationAirports,
    departureDate,
    returnDate,
    cabinClass: trip.cabinClass,
    usageCategory,
    // Open-jaw only makes sense with a return leg to actually depart
    // differently from — meaningless (and not sent) for a one-way search.
    returnDepartureAirports: tripType === "round_trip" ? trip.openJawReturnAirports : undefined,
  });

  // Google's price-insight signal (Section 10.1/12.4) — free on every
  // search, captured regardless of whether any itinerary below ends up
  // recorded, since it's a market-snapshot signal independent of that.
  if (result.priceInsights) {
    await Trip.updateOne(
      { _id: trip._id },
      {
        lastPriceInsight: {
          lowestPrice: result.priceInsights.lowest_price ?? null,
          priceLevel: result.priceInsights.price_level ?? null,
          typicalPriceRangeLow: result.priceInsights.typical_price_range?.[0] ?? null,
          typicalPriceRangeHigh: result.priceInsights.typical_price_range?.[1] ?? null,
          checkedAt: pollTime,
        },
      },
    );
  }

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

  const eligible = inserted.filter((o) => withinTripConstraints(trip, o));
  const cheapest = eligible.length > 0 ? eligible.reduce((a, b) => (a.priceINR < b.priceINR ? a : b)) : null;

  await SearchCandidate.updateOne(
    { _id: candidate._id },
    { status: "verified", observationId: cheapest?._id ?? null, lastCheckedAt: pollTime },
  );
}

// After this cycle's verifications land, re-derive "the best realistic
// trip found so far" across every candidate in the trip's live window —
// not just whatever this cycle happened to check — and evaluate
// notifications against that. For a single-candidate trip this is exactly
// today's one itinerary; for a real range it's the actual point of
// searching more than one date at all.
async function evaluateBestCandidate(
  trip: InstanceType<typeof Trip>,
  window: CandidateWindow,
  tripType: "round_trip" | "one_way",
  budget: NonNullable<InstanceType<typeof Trip>["budget"]>,
  pollTime: Date,
): Promise<void> {
  const best = await getBestVerifiedCandidate(trip._id as Types.ObjectId, window);
  if (!best) return;
  const { observation } = best;

  const priorTrip = await getPriorTripStats(String(trip._id), pollTime);
  const everUnderBudget = await hasEverBeenUnderBudget(String(trip._id), budget.amount);
  const destinationAirport = airportFromRouteKey(observation.routeKey);
  const priorRouteLow = await getPriorRouteLow(
    makeRouteKey(trip.origin, destinationAirport, trip.cabinClass, tripType),
    pollTime,
  );

  await evaluateTripNotifications({
    trip: {
      _id: trip._id,
      name: trip.name,
      origin: trip.origin,
      tripType,
      budget,
      travelWindow: { earliestDeparture: window.earliest },
    },
    routeKey: observation.routeKey,
    destinationAirport,
    cheapest: {
      id: String(observation._id),
      priceINR: observation.priceINR,
      airlines: observation.airlines,
      stops: observation.stops,
      departureDate: observation.departureDate,
      returnDate: observation.returnDate ?? null,
      returnDepartureAirport: observation.returnDepartureAirport ?? null,
    },
    priorTripLow: priorTrip.low,
    priorRouteLow,
    priorLastPriceINR: priorTrip.lastPriceINR,
    everUnderBudget,
  });
}
