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
    travelWindow: {
      earliestDeparture: { type: Date, default: null },
      latestDeparture: { type: Date, default: null },
      months: { type: [String], default: [] },
    },
    tripDuration: {
      minNights: { type: Number, required: true },
      maxNights: { type: Number, required: true },
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
  },
  { timestamps: true },
);

export type TripDoc = InferSchemaType<typeof tripSchema>;
export const Trip = model("Trip", tripSchema);
