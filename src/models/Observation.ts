import { Schema, model, type InferSchemaType } from "mongoose";

const observationSchema = new Schema({
  tripId: { type: Schema.Types.ObjectId, ref: "Trip", default: null },
  // Deterministic ORIGIN-DESTINATIONAIRPORT-CABINCLASS join key (Section 3.4 / 10.6) —
  // independent of any one trip's filters, so history accumulates across trips/years.
  routeKey: { type: String, required: true, index: true },
  source: {
    type: String,
    enum: ["serpapi", "duffel", "travelpayouts", "manual"],
    required: true,
  },
  queriedAt: { type: Date, required: true, default: Date.now },
  departureDate: { type: Date, required: true },
  returnDate: { type: Date, default: null },
  price: {
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
  },
  priceINR: { type: Number, required: true },
  airlines: { type: [String], default: [] },
  stops: { type: Number, required: true },
  layoverMinutes: { type: [Number], default: [] },
  // Set only for an open-jaw itinerary — the return leg's actual departure
  // airport, when it differs from where the outbound leg landed (arrival
  // Manila, return departing Cebu). Null for a normal round trip or a
  // one-way fare.
  returnDepartureAirport: { type: String, default: null },
  cabinClass: { type: String, required: true },
  refundable: { type: Boolean, default: null },
  baggageIncluded: { type: Boolean, default: null },
  // Raw provider response slice, retained so fields not yet modeled can be
  // re-derived later without re-querying the provider (Section 8.2).
  raw: { type: Schema.Types.Mixed },
});

observationSchema.index({ routeKey: 1, departureDate: 1, queriedAt: -1 });
observationSchema.index({ tripId: 1, queriedAt: -1 });

export type ObservationDoc = InferSchemaType<typeof observationSchema>;
export const Observation = model("Observation", observationSchema);
