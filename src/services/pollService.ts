import type { Types } from "mongoose";
import { Trip } from "../models/Trip.js";
import { markPolled } from "./tripService.js";
import {
  searchFlights,
  searchReturnFlights,
  type FlightSearchParams,
  type FlightSearchResult,
} from "../integrations/serpapi.js";
import { recordObservations, recordConfirmedFare, airportFromRouteKey } from "./observationService.js";
import { getPriorRouteLow, getLowestRecordedPrice } from "./analyticsService.js";
import { evaluateTripNotifications } from "./notificationService.js";
import { getCandidateWindow, type CandidateWindow } from "./tripWindow.js";
import { rankFares, withinTripConstraints } from "./tripConstraints.js";
import { isMultiCandidateWindow, orderLeadsForConfirmation } from "./candidateRanking.js";
import { insightCoversDates } from "./bookingAdvice.js";
import {
  ensureCandidates,
  pickCandidatesToVerify,
  getBestVerifiedCandidate,
  getCoverage,
  type BestVerifiedCandidate,
} from "./searchCandidateService.js";
import { SearchCandidate } from "../models/SearchCandidate.js";
import { Observation } from "../models/Observation.js";
import {
  MAX_CANDIDATES_PER_CYCLE,
  MAX_FARE_CONFIRMATIONS_PER_CYCLE,
  MARKET_INSIGHT_MAX_AGE_DAYS,
} from "../config/quotas.js";

type TripDocument = InstanceType<typeof Trip>;
type TripType = "round_trip" | "one_way";
type UsageCategory = "single" | "range";

interface VerifiedCandidate {
  candidate: InstanceType<typeof SearchCandidate>;
  // This search's itineraries that fit the trip's rules, best first.
  leads: InstanceType<typeof Observation>[];
  priceInsights: FlightSearchResult["priceInsights"];
}

// The single per-trip poll operation — shared by the scheduled batch job
// (scripts/poll.ts) and the immediate baseline search on trip creation
// (api/trips.ts), so there is exactly one implementation of "how a trip
// gets checked," not two. Never throws — failures are caught and recorded
// via markPolled's error param so callers don't need their own try/catch.
//
// Every trip — a single exact date or a genuine range (a flexible-month
// selection, or a fixed trip with earliestDeparture < latestDeparture) —
// goes through the same candidate machinery. A single-exact-date trip
// simply resolves to exactly one candidate; there is no separate "simple"
// path to keep in sync with this one.
//
// A cycle has three steps: price some dates (outbound step, cheap to do
// widely), turn the most promising leads into real whole-trip fares (picking
// return flights), and only then judge "the best fare" and tell the user.
export async function pollTrip(trip: TripDocument): Promise<void> {
  const budget = trip.budget;
  const tripType = trip.tripType ?? "round_trip";
  const window = getCandidateWindow(trip);
  if (!window || !budget || (tripType === "round_trip" && !trip.tripDuration?.minNights)) {
    console.warn(`Skipping "${trip.name}" — no resolvable travel window (no dates or months set).`);
    return;
  }

  const pollTime = new Date();
  const usageCategory: UsageCategory = isMultiCandidateWindow(
    window,
    tripType,
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
  )
    ? "range"
    : "single";

  try {
    await ensureCandidates(trip, window);
    const previousBest = await getBestVerifiedCandidate(trip._id as Types.ObjectId, window);
    const toVerify = await pickCandidatesToVerify(
      trip._id as Types.ObjectId,
      window,
      MAX_CANDIDATES_PER_CYCLE,
      previousBest?.candidate._id ?? null,
    );

    const verified: VerifiedCandidate[] = [];
    const failures: string[] = [];

    for (const candidate of toVerify) {
      try {
        verified.push(await verifyCandidate(trip, candidate, tripType, pollTime, usageCategory));
      } catch (err) {
        // One candidate's provider error never aborts the trip's other
        // candidates this cycle — the same per-trip isolation pollTrip
        // already gives the rest of the batch run, one level deeper.
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${candidate.departureDate.toISOString().slice(0, 10)}: ${message}`);
        console.error(`Candidate search failed for "${trip.name}":`, err);
      }
    }

    if (toVerify.length > 0 && verified.length === 0) {
      await markPolled(String(trip._id), `All ${toVerify.length} candidate search(es) failed: ${failures.join("; ")}`);
      return;
    }

    console.log(
      `${trip.name} → ${trip.destinationAirports.join("/")}: verified ${verified.length}/${toVerify.length} candidate(s)`,
    );

    if (tripType === "round_trip") {
      await confirmFares(trip, verified, previousBest, pollTime, usageCategory);
    }

    const best = await getBestVerifiedCandidate(trip._id as Types.ObjectId, window);
    if (best) await captureMarketInsight(trip, best, verified, tripType, pollTime, usageCategory);
    await evaluateBestCandidate(trip, window, best, budget, tripType, pollTime);
    await markPolled(String(trip._id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to poll ${trip.name}:`, err);
    await markPolled(String(trip._id), message);
  }
}

function searchParamsFor(
  trip: TripDocument,
  candidate: InstanceType<typeof SearchCandidate>,
  tripType: TripType,
  usageCategory: UsageCategory,
): FlightSearchParams {
  return {
    origin: trip.origin,
    destinationAirports: trip.destinationAirports,
    departureDate: candidate.departureDate.toISOString().slice(0, 10),
    returnDate: candidate.returnDate ? candidate.returnDate.toISOString().slice(0, 10) : undefined,
    cabinClass: trip.cabinClass,
    usageCategory,
    // Open-jaw only makes sense with a return leg to actually depart
    // differently from — meaningless (and not sent) for a one-way search.
    returnDepartureAirports: tripType === "round_trip" ? trip.openJawReturnAirports : undefined,
    maxStops: trip.maxStops ?? null,
    maxLayoverMinutes: trip.maxLayoverMinutes ?? null,
  };
}

// Runs one real search for one candidate: prices it, records every itinerary
// the provider returned (Section 3.4), and marks the candidate verified with
// the best constraint-satisfying itinerary (or none, if nothing satisfied the
// constraints). A one-way price is final, so that's the fare. A round trip's
// is only a lead, left for confirmFares.
async function verifyCandidate(
  trip: TripDocument,
  candidate: InstanceType<typeof SearchCandidate>,
  tripType: TripType,
  pollTime: Date,
  usageCategory: UsageCategory,
): Promise<VerifiedCandidate> {
  const params = searchParamsFor(trip, candidate, tripType, usageCategory);
  const result = await searchFlights(params);

  const inserted = await recordObservations({
    tripId: trip._id as Types.ObjectId,
    origin: trip.origin,
    departureDate: params.departureDate,
    returnDate: params.returnDate,
    cabinClass: trip.cabinClass,
    tripType,
    openJawReturnAirports: trip.openJawReturnAirports,
    source: "serpapi",
    itineraries: result.itineraries,
    googleFlightsUrl: result.googleFlightsUrl,
  });

  const eligible = inserted.filter((o) => withinTripConstraints(trip, o));
  const leads = rankFares(
    eligible.map((o) => ({ price: o.priceINR, durationMinutes: o.durationMinutes ?? 0, observation: o })),
  ).map((fare) => fare.observation);
  const top = leads[0] ?? null;
  const isFinalPrice = top != null && tripType === "one_way";

  await SearchCandidate.updateOne(
    { _id: candidate._id },
    {
      status: "verified",
      observationId: top?._id ?? null,
      lastCheckedAt: pollTime,
      noBookableReturn: false,
      // Nothing fits any more means any earlier fare for these dates is gone.
      ...(isFinalPrice
        ? { confirmedObservationId: top._id, confirmedAt: pollTime }
        : top == null
          ? { confirmedObservationId: null, confirmedAt: null }
          : {}),
    },
  );

  return { candidate, leads, priceInsights: result.priceInsights };
}

// Spends this cycle's few return-flight lookups in the order
// orderLeadsForConfirmation sets, skipping any lead whose quote can't beat
// what's already confirmed. A low quote settles nothing on its own (₹60,871
// on BOM-NRT really cost ₹77,934), so a date keeps its cheapest confirmed
// total of the cycle, and a dead end on one airline doesn't undo another's.
async function confirmFares(
  trip: TripDocument,
  verified: VerifiedCandidate[],
  previousBest: BestVerifiedCandidate | null,
  pollTime: Date,
  usageCategory: UsageCategory,
): Promise<void> {
  const entries = new Map(verified.map((entry) => [String(entry.candidate._id), entry]));
  const queue = orderLeadsForConfirmation(
    verified.map((entry) => ({ id: String(entry.candidate._id), leads: entry.leads })),
    previousBest ? String(previousBest.candidate._id) : null,
  );

  const confirmedThisCycle = new Map<string, number>();
  let attempts = 0;

  for (const { id, lead } of queue) {
    if (attempts >= MAX_FARE_CONFIRMATIONS_PER_CYCLE) break;
    if (lead.priceINR >= Math.min(Infinity, ...confirmedThisCycle.values())) continue;
    const token = (lead.raw as { departure_token?: string } | undefined)?.departure_token;
    if (!token) continue;
    const { candidate } = entries.get(id)!;

    attempts++;
    try {
      const params = searchParamsFor(trip, candidate, "round_trip", usageCategory);
      const result = await searchReturnFlights(params, token);
      const eligible = result.options.filter((option) => withinTripConstraints(trip, option));
      const [chosen] = rankFares(eligible);
      const alreadyConfirmed = confirmedThisCycle.get(id);

      if (!chosen) {
        if (alreadyConfirmed != null) continue;
        await SearchCandidate.updateOne(
          { _id: candidate._id },
          { noBookableReturn: true, confirmedObservationId: null, confirmedAt: null },
        );
        continue;
      }

      const fare = await recordConfirmedFare(lead, chosen, result.googleFlightsUrl);
      if (alreadyConfirmed != null && alreadyConfirmed <= fare.priceINR) continue;
      await SearchCandidate.updateOne(
        { _id: candidate._id },
        { confirmedObservationId: fare._id, confirmedAt: pollTime, noBookableReturn: false },
      );
      confirmedThisCycle.set(id, fare.priceINR);
    } catch (err) {
      console.error(`Return-flight lookup failed for "${trip.name}":`, err);
    }
  }
}

function insightFields(
  insights: NonNullable<FlightSearchResult["priceInsights"]>,
  scope: { airport: string | null; departureDate: Date; returnDate: Date | null },
  plainRoundTripPriceINR: number | null,
  pollTime: Date,
) {
  return {
    lowestPrice: insights.lowest_price ?? null,
    priceLevel: insights.price_level ?? null,
    typicalPriceRangeLow: insights.typical_price_range?.[0] ?? null,
    typicalPriceRangeHigh: insights.typical_price_range?.[1] ?? null,
    checkedAt: pollTime,
    priceHistory: (insights.price_history ?? []).map(([seconds, priceINR]) => ({
      at: new Date(seconds * 1000),
      priceINR,
    })),
    airport: scope.airport,
    departureDate: scope.departureDate,
    returnDate: scope.returnDate,
    plainRoundTripPriceINR,
  };
}

// Google's verdict on price, for the dates that are actually the best option
// — not whichever date happened to be searched last. A plain single-airport
// search carries it for free. A multi-airport or open-jaw search never does,
// so those spend one search asking for it directly on the best dates (again
// when those change, or after a week), which for an open-jaw also shows what
// the different return airport costs.
async function captureMarketInsight(
  trip: TripDocument,
  best: BestVerifiedCandidate,
  verified: VerifiedCandidate[],
  tripType: TripType,
  pollTime: Date,
  usageCategory: UsageCategory,
): Promise<void> {
  const { departureDate } = best.candidate;
  const returnDate = best.candidate.returnDate ?? null;
  const fromBestSearch = verified.find(
    (entry) => String(entry.candidate._id) === String(best.candidate._id),
  )?.priceInsights;

  if (fromBestSearch) {
    const scope = { airport: null, departureDate, returnDate };
    await Trip.updateOne(
      { _id: trip._id },
      { lastPriceInsight: insightFields(fromBestSearch, scope, null, pollTime) },
    );
    return;
  }

  const isOpenJaw = tripType === "round_trip" && trip.openJawReturnAirports.length > 0;
  if (!isOpenJaw && trip.destinationAirports.length <= 1) return;

  const airport = airportFromRouteKey(best.observation.routeKey);
  const known = trip.lastPriceInsight;
  const lastChecked = known?.checkedAt?.getTime() ?? 0;
  const isCurrent =
    known?.airport === airport &&
    insightCoversDates(known, departureDate, returnDate) &&
    pollTime.getTime() - lastChecked < MARKET_INSIGHT_MAX_AGE_DAYS * 86_400_000;
  if (isCurrent) return;

  try {
    const result = await searchFlights({
      ...searchParamsFor(trip, best.candidate, tripType, usageCategory),
      destinationAirports: [airport],
      returnDepartureAirports: undefined,
    });
    if (!result.priceInsights) return;
    const fitting = result.itineraries.filter((it) => withinTripConstraints(trip, it));
    const plainRoundTripPriceINR = isOpenJaw ? (rankFares(fitting)[0]?.price ?? null) : null;
    const scope = { airport, departureDate, returnDate };
    await Trip.updateOne(
      { _id: trip._id },
      { lastPriceInsight: insightFields(result.priceInsights, scope, plainRoundTripPriceINR, pollTime) },
    );
  } catch (err) {
    console.error(`Market insight search failed for "${trip.name}":`, err);
  }
}

// After this cycle's verifications land, judges "the best realistic trip found
// so far" across every candidate in the trip's live window — not just whatever
// this cycle happened to check — and evaluates notifications against that.
// Compared only with earlier best fares, never raw observations: those mix
// airlines and dates, so a "change" between them is noise, not news. A trip
// with no confirmed fare yet stays silent rather than quoting a guess.
async function evaluateBestCandidate(
  trip: TripDocument,
  window: CandidateWindow,
  best: BestVerifiedCandidate | null,
  budget: NonNullable<TripDocument["budget"]>,
  tripType: TripType,
  pollTime: Date,
): Promise<void> {
  if (!best?.confirmed) return;
  const { observation } = best;

  const history = trip.bestHistory ?? [];
  const priorPrices = history.map((point) => point.priceINR);
  const priorBest = priorPrices.length > 0 ? priorPrices[priorPrices.length - 1] : null;
  const priorLow = priorPrices.length > 0 ? Math.min(...priorPrices) : null;
  const coverage = await getCoverage(trip._id as Types.ObjectId, window);
  const priorRouteLow = await getPriorRouteLow(observation.routeKey, pollTime);
  const previouslyRecordedLow =
    history.length === 0 ? await getLowestRecordedPrice(String(trip._id), pollTime) : null;

  await Trip.updateOne(
    { _id: trip._id },
    {
      $push: {
        bestHistory: {
          at: pollTime,
          priceINR: observation.priceINR,
          airlines: observation.airlines,
          stops: observation.stops,
          departureDate: observation.departureDate,
          returnDate: observation.returnDate ?? null,
        },
      },
    },
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
    destinationAirport: airportFromRouteKey(observation.routeKey),
    cheapest: {
      id: String(observation._id),
      priceINR: observation.priceINR,
      airlines: observation.airlines,
      stops: observation.stops,
      layoverMinutes: observation.layoverMinutes,
      departureDate: observation.departureDate,
      returnDate: observation.returnDate ?? null,
      returnDepartureAirport: observation.returnDepartureAirport ?? null,
      returnLeg: observation.returnLeg ?? null,
      googleFlightsUrl: observation.googleFlightsUrl ?? null,
    },
    priorBest,
    priorLow,
    priorRouteLow,
    everUnderBudget: priorPrices.some((price) => price <= budget.amount),
    coverage,
    previouslyRecordedLow,
  });
}
