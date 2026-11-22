import { Schema, model, type InferSchemaType } from "mongoose";

const tripSchema = new Schema(
  {
    name: { type: String, required: true },
    origin: { type: String, required: true },
    originAlternates: { type: [String], default: [] },
    destination: { type: String, required: true },
    destinationAirports: { type: [String], required: true },
    // Open-jaw round trip: the return leg departs from these airport(s)
    // instead of wherever the outbound leg landed — e.g. arrive Manila,
    // depart Cebu. Empty means a normal symmetric round trip (unchanged
    // behavior); meaningless for a one-way trip.
    openJawReturnAirports: { type: [String], default: [] },
    regionTag: { type: String, required: true, index: true },
    travelWindowType: {
      type: String,
      enum: ["fixed", "flexible-month", "days-off"],
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
      // Provenance for a "days-off" trip — resolves through
      // earliestDeparture/latestDeparture above exactly like a fixed trip
      // (a days-off option is a single, already-decided window, not an
      // open range to keep searching), this is purely for display and
      // for a future "recheck options" action, never read by the search
      // engine itself.
      daysOffContext: {
        anchors: { type: [Date], default: undefined },
        leaveBudget: { type: Number, default: null },
        leaveDaysUsed: { type: Number, default: null },
      },
    },
    // Trips created together from one Days Off preview (more than one
    // option chosen to track at once) share this id so the dashboard can
    // show them as one trip idea with a few open date options, rather than
    // as unrelated trips. Unset for every other trip.
    daysOffGroupId: { type: String, default: null, index: true },
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
    // Google's own price-insight signal, returned free on every SerpApi
    // search (Section 10.1/12.4) — captured here so it's available as a
    // cold-start comparison before this trip has its own dense history,
    // rather than being fetched and discarded.
    lastPriceInsight: {
      lowestPrice: { type: Number, default: null },
      priceLevel: { type: String, default: null },
      typicalPriceRangeLow: { type: Number, default: null },
      typicalPriceRangeHigh: { type: Number, default: null },
      checkedAt: { type: Date, default: null },
      // Google's daily price for the searched dates over the last ~60 days —
      // real history on day one, instead of waiting months to build our own.
      priceHistory: {
        type: [{ _id: false, at: Date, priceINR: Number }],
        default: [],
      },
      // Which search the insight describes. It isn't always the trip itself:
      // Google gives none for a multi-airport or open-jaw search, so those
      // come from a plain single-airport search on the same dates.
      airport: { type: String, default: null },
      departureDate: { type: Date, default: null },
      returnDate: { type: Date, default: null },
      // Open-jaw only: roughly what the same dates cost as a normal round
      // trip, which is what the open-jaw has to justify itself against.
      plainRoundTripPriceINR: { type: Number, default: null },
    },
    // The best confirmed fare at each poll — one point per check, which is
    // what "price over time" actually means for a trip spanning many dates.
    // Raw observations mix every airline and date from every search, so they
    // can't answer "did it go up?". Notifications and the dashboard read this.
    bestHistory: {
      type: [
        {
          _id: false,
          at: { type: Date, required: true },
          priceINR: { type: Number, required: true },
          airlines: { type: [String], default: [] },
          stops: { type: Number, default: 0 },
          departureDate: { type: Date, default: null },
          returnDate: { type: Date, default: null },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export type TripDoc = InferSchemaType<typeof tripSchema>;
export const Trip = model("Trip", tripSchema);
