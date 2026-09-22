import { Schema, model, type InferSchemaType } from "mongoose";

// One document per (departure, return) pair a trip's window/duration range
// implies (candidateRanking.ts's enumerateCandidateSpecs) — the persisted
// memory the poll loop uses to know, across cron runs, which of a trip's
// candidates have already been verified with a real search and which are
// still just a free Tier-1 estimate (Section C/H of the architecture plan).
const searchCandidateSchema = new Schema(
  {
    tripId: { type: Schema.Types.ObjectId, ref: "Trip", required: true, index: true },
    departureDate: { type: Date, required: true },
    returnDate: { type: Date, default: null },
    status: { type: String, enum: ["estimated", "verified"], default: "estimated" },
    // Tier-1 signal, computed once at generation time — never treated as a
    // real historical observation (analyticsService/Observation stay the
    // only source of truth for actual prices).
    estimatedPriceINR: { type: Number, default: null },
    rankScore: { type: Number, required: true },
    // Set once a real search has priced this candidate — the Observation
    // that represents it (the cheapest constraint-satisfying itinerary from
    // that search), or null if the search returned nothing usable.
    observationId: { type: Schema.Types.ObjectId, ref: "Observation", default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One candidate per exact date pair per trip — ensureCandidates relies on
// this to make repeated generation idempotent across poll cycles.
searchCandidateSchema.index({ tripId: 1, departureDate: 1, returnDate: 1 }, { unique: true });

export type SearchCandidateDoc = InferSchemaType<typeof searchCandidateSchema>;
export const SearchCandidate = model("SearchCandidate", searchCandidateSchema);
