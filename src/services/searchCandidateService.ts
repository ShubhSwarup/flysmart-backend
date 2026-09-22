import type { Types } from "mongoose";
import { SearchCandidate } from "../models/SearchCandidate.js";
import { Observation } from "../models/Observation.js";
import { enumerateCandidateSpecs, estimateCandidate } from "./candidateRanking.js";
import type { CandidateWindow } from "./tripWindow.js";

interface TripLike {
  _id: Types.ObjectId;
  origin: string;
  destinationAirports: string[];
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
  const routeKeys = trip.destinationAirports.map(
    (airport) => `${trip.origin}-${airport}-${trip.cabinClass}-${trip.tripType}`,
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

// Which of a trip's candidates get a real search spent on them this cycle,
// bounded by `limit` (Section G's per-cycle budget). Never-verified
// candidates always come first, cheapest-looking (by the free Tier-1
// ranking) first among them — once every candidate has been checked at
// least once, verified candidates get re-checked oldest-first, which
// naturally rotates through the whole window over time (including,
// eventually, the current best-known one) without needing a special case
// for "keep the best one extra fresh."
export async function pickCandidatesToVerify(tripId: Types.ObjectId, limit: number) {
  const unverified = await SearchCandidate.find({ tripId, status: "estimated" })
    .sort({ rankScore: 1 })
    .limit(limit);
  if (unverified.length >= limit) return unverified;

  const remaining = limit - unverified.length;
  const dueForRefresh = await SearchCandidate.find({ tripId, status: "verified" })
    .sort({ lastCheckedAt: 1 })
    .limit(remaining);
  return [...unverified, ...dueForRefresh];
}

export interface BestVerifiedCandidate {
  candidate: InstanceType<typeof SearchCandidate>;
  observation: InstanceType<typeof Observation>;
}

// The cheapest verified candidate currently within the trip's live window —
// "the best realistic trip found so far," which is what a multi-candidate
// trip's notifications and displayed price should mean, not "whatever this
// one cycle happened to check." Candidates outside the current window
// (e.g. left over from a flexible-month trip's since-elapsed month) are
// excluded, so a stale document can never resurface as "the best trip."
export async function getBestVerifiedCandidate(
  tripId: Types.ObjectId,
  window: CandidateWindow,
): Promise<BestVerifiedCandidate | null> {
  const candidates = await SearchCandidate.find({
    tripId,
    status: "verified",
    observationId: { $ne: null },
    departureDate: { $gte: window.earliest, $lte: window.latest },
  });
  if (candidates.length === 0) return null;

  const observations = await Observation.find({
    _id: { $in: candidates.map((c) => c.observationId) },
  });
  const byId = new Map(observations.map((o) => [String(o._id), o]));

  let best: BestVerifiedCandidate | null = null;
  for (const candidate of candidates) {
    const observation = byId.get(String(candidate.observationId));
    if (!observation) continue;
    if (!best || observation.priceINR < best.observation.priceINR) {
      best = { candidate, observation };
    }
  }
  return best;
}
