import type { Types } from "mongoose";
import { SearchCandidate } from "../models/SearchCandidate.js";
import { Observation } from "../models/Observation.js";
import { makeRouteKey } from "./observationService.js";
import {
  chooseCandidatesToVerify,
  enumerateCandidateSpecs,
  estimateCandidate,
  weekIndex,
} from "./candidateRanking.js";
import { CONFIRMED_FARE_MAX_AGE_DAYS } from "../config/quotas.js";
import type { CandidateWindow } from "./tripWindow.js";

interface TripLike {
  _id: Types.ObjectId;
  origin: string;
  destinationAirports: string[];
  openJawReturnAirports?: string[];
  cabinClass: string;
  tripType: "round_trip" | "one_way";
  tripDuration?: { minNights?: number | null; maxNights?: number | null } | null;
}

// This route's own plain historical average price — from any trip, any
// date, any time it's ever been observed (Section 3.4's cross-trip pooling,
// reused here as the Tier-1 baseline). Deliberately a plain average, not a
// regression: simple, explainable, easy to see why a candidate ranked where
// it did. A brand-new route with no observations yet returns null rather
// than a fabricated number.
async function routeHistoryAverage(trip: TripLike): Promise<number | null> {
  const routeKeys = trip.destinationAirports.map((airport) =>
    makeRouteKey(trip.origin, airport, trip.cabinClass, trip.tripType, trip.openJawReturnAirports),
  );
  const result = await Observation.aggregate([
    { $match: { routeKey: { $in: routeKeys } } },
    { $group: { _id: null, avg: { $avg: "$priceINR" } } },
  ]);
  return result[0]?.avg ?? null;
}

function candidateKey(departureDate: Date, returnDate: Date | null): string {
  return `${departureDate.getTime()}-${returnDate?.getTime() ?? "null"}`;
}

// Generates any candidates the trip's current window/duration range calls
// for that don't already exist — safe to call on every poll cycle. Never
// deletes a candidate that's since fallen outside a shrunk window (e.g. a
// flexible-month trip as months elapse); it simply stops being eligible for
// verification or for "best known result" (see below), left as a harmless,
// unused document rather than requiring a cleanup pass for what amounts to
// a handful of small records on a single-user tool's database.
export async function ensureCandidates(trip: TripLike, window: CandidateWindow): Promise<void> {
  const specs = enumerateCandidateSpecs(
    window,
    trip.tripType,
    trip.tripDuration?.minNights ?? null,
    trip.tripDuration?.maxNights ?? null,
  );
  if (specs.length === 0) return;

  const existing = await SearchCandidate.find({ tripId: trip._id }, { departureDate: 1, returnDate: 1 }).lean();
  const existingKeys = new Set(existing.map((c) => candidateKey(c.departureDate, c.returnDate ?? null)));
  const missing = specs.filter((spec) => !existingKeys.has(candidateKey(spec.departureDate, spec.returnDate)));
  if (missing.length === 0) return;

  const baseline = await routeHistoryAverage(trip);
  const docs = missing.map((spec) => {
    const { estimatedPriceINR, rankScore } = estimateCandidate(spec, baseline);
    return {
      tripId: trip._id,
      departureDate: spec.departureDate,
      returnDate: spec.returnDate,
      estimatedPriceINR,
      rankScore,
    };
  });

  try {
    await SearchCandidate.insertMany(docs, { ordered: false });
  } catch (err) {
    // Duplicate-key races (e.g. two overlapping poll runs touching the same
    // trip) just mean the candidate already exists — harmless. Anything
    // else is a real failure and should surface.
    const code = (err as { code?: number })?.code;
    if (code !== 11000) throw err;
  }
}

function inWindowFilter(tripId: Types.ObjectId, window: CandidateWindow) {
  return { tripId, departureDate: { $gte: window.earliest, $lte: window.latest } };
}

// Which of a trip's candidates get a real search spent on them this cycle,
// bounded by `limit` (Section G's per-cycle budget) — see
// chooseCandidatesToVerify for how. Only dates still inside the live window
// are considered, so a date that's slipped into the past is never searched.
export async function pickCandidatesToVerify(
  tripId: Types.ObjectId,
  window: CandidateWindow,
  limit: number,
  bestCandidateId: Types.ObjectId | null,
) {
  const candidates = await SearchCandidate.find(inWindowFilter(tripId, window));
  const priced = await loadObservations(candidates);
  const priceOf = (candidate: InstanceType<typeof SearchCandidate>) => {
    const id = candidate.confirmedObservationId ?? candidate.observationId;
    return id ? (priced.get(String(id))?.priceINR ?? null) : null;
  };

  const chosen = chooseCandidatesToVerify(
    candidates.map((c) => ({
      id: String(c._id),
      departureDate: c.departureDate,
      returnDate: c.returnDate ?? null,
      verified: c.status === "verified",
      rankScore: c.rankScore,
      lastCheckedAt: c.lastCheckedAt ?? null,
      priceINR: priceOf(c),
    })),
    window.earliest,
    limit,
    bestCandidateId ? String(bestCandidateId) : null,
  );
  const byId = new Map(candidates.map((c) => [String(c._id), c]));
  return chosen.map((c) => byId.get(c.id)!);
}

async function loadObservations(candidates: InstanceType<typeof SearchCandidate>[]) {
  const ids = candidates.flatMap((c) =>
    [c.observationId, c.confirmedObservationId].filter((id) => id != null),
  );
  const observations = await Observation.find({ _id: { $in: ids } });
  return new Map(observations.map((o) => [String(o._id), o]));
}

export interface BestVerifiedCandidate {
  candidate: InstanceType<typeof SearchCandidate>;
  observation: InstanceType<typeof Observation>;
  confirmed: boolean;
}

// The cheapest date pair in the trip's live window with a confirmed, recent
// whole-trip fare — "the best realistic trip found so far," which is what a
// multi-candidate trip's notifications and displayed price should mean.
// Candidates outside the current window are excluded, so a stale document can
// never resurface as "the best trip."
//
// Only when nothing is confirmed does this fall back to the cheapest lead,
// flagged as such (confirmed: false), so the dashboard has something honest to
// show instead of nothing. Notifications ignore those.
export async function getBestVerifiedCandidate(
  tripId: Types.ObjectId,
  window: CandidateWindow,
): Promise<BestVerifiedCandidate | null> {
  const candidates = await SearchCandidate.find({
    ...inWindowFilter(tripId, window),
    status: "verified",
    $or: [{ observationId: { $ne: null } }, { confirmedObservationId: { $ne: null } }],
  });
  if (candidates.length === 0) return null;
  const byId = await loadObservations(candidates);

  const oldestConfirmation = Date.now() - CONFIRMED_FARE_MAX_AGE_DAYS * 86_400_000;
  let bestConfirmed: BestVerifiedCandidate | null = null;
  let bestLead: BestVerifiedCandidate | null = null;
  for (const candidate of candidates) {
    const confirmed = candidate.confirmedObservationId
      ? byId.get(String(candidate.confirmedObservationId))
      : undefined;
    if (
      confirmed &&
      candidate.confirmedAt &&
      candidate.confirmedAt.getTime() >= oldestConfirmation &&
      (!bestConfirmed || confirmed.priceINR < bestConfirmed.observation.priceINR)
    ) {
      bestConfirmed = { candidate, observation: confirmed, confirmed: true };
    }
    const lead = candidate.observationId ? byId.get(String(candidate.observationId)) : undefined;
    if (
      lead &&
      !candidate.noBookableReturn &&
      (!bestLead || lead.priceINR < bestLead.observation.priceINR)
    ) {
      bestLead = { candidate, observation: lead, confirmed: false };
    }
  }
  return bestConfirmed ?? bestLead;
}

export interface SearchCoverage {
  datesChecked: number;
  datesTotal: number;
  weeksChecked: number;
  weeksTotal: number;
}

// How much of the window has really been looked at. "Cheapest fare" means very
// little without it: 3 of 183 options is a first impression, not an answer.
export async function getCoverage(
  tripId: Types.ObjectId,
  window: CandidateWindow,
): Promise<SearchCoverage> {
  const candidates = await SearchCandidate.find(inWindowFilter(tripId, window), {
    departureDate: 1,
    status: 1,
  }).lean();
  const weeks = new Set(candidates.map((c) => weekIndex(c.departureDate, window.earliest)));
  const checked = candidates.filter((c) => c.status === "verified");
  const checkedWeeks = new Set(checked.map((c) => weekIndex(c.departureDate, window.earliest)));
  return {
    datesChecked: checked.length,
    datesTotal: candidates.length,
    weeksChecked: checkedWeeks.size,
    weeksTotal: weeks.size,
  };
}
