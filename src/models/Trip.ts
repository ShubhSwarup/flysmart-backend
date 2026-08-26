import { Schema, model, type InferSchemaType } from "mongoose";

const tripSchema = new Schema(
  {
    name: { type: String, required: true },
    origin: { type: String, required: true },
    originAlternates: { type: [String], default: [] },
    destination: { type: String, required: true },
    destinationAirports: { type: [String], required: true },
    regionTag: { type: String, required: true, index: true },
    travelWindowType: {
      type: String,
      enum: ["fixed", "flexible-month"],
      required: true,
    },
    // Orthogonal to travelWindowType — a trip can be fixed-date-and-one-way,
    // flexible-month-and-round-trip, etc. Defaults to "round_trip" so
    // pre-existing trips (created before this field existed) read back
    // correctly via Mongoose's default-on-missing-path behavior, no
    // migration needed for the trips collection itself.
    tripType: { type: String, enum: ["round_trip", "one_way"], default: "round_trip" },
    travelWindow: {
      earliestDeparture: { type: Date, default: null },
      latestDeparture: { type: Date, default: null },
      months: { type: [String], default: [] },
    },
    // Not required — meaningless for a one-way trip (no return leg to
    // measure a stay length against).
    tripDuration: {
      minNights: { type: Number, default: null },
      maxNights: { type: Number, default: null },
    },
    budget: {
      amount: { type: Number, required: true },
      currency: { type: String, required: true, default: "INR" },
    },
    cabinClass: {
      type: String,
      enum: ["economy", "premium_economy", "business", "first"],
      required: true,
    },
    maxStops: { type: Number, enum: [0, 1, 2, null], default: null },
    maxLayoverMinutes: { type: Number, default: null },
    preferredAirlines: { type: [String], default: [] },
    priority: { type: String, enum: ["high", "normal", "low"], default: "normal" },
    status: {
      type: String,
      enum: ["active", "booked", "archived", "expired"],
      default: "active",
      index: true,
    },
    notes: { type: String, default: "" },
    lastPolledAt: { type: Date, default: null },
    // Outcome of the most recent poll attempt — drives the "Search failed"
    // monitoring state. null means never polled yet.
    lastPollStatus: { type: String, enum: ["ok", "error", null], default: null },
    lastPollError: { type: String, default: null },
  },
  { timestamps: true },
);

export type TripDoc = InferSchemaType<typeof tripSchema>;
export const Trip = model("Trip", tripSchema);
