import { Schema, model, type InferSchemaType } from "mongoose";

const notificationSchema = new Schema({
  // Nullable: run_failure is an operational alert, not tied to any trip (Section 11.2).
  tripId: { type: Schema.Types.ObjectId, ref: "Trip", default: null },
  type: {
    type: String,
    enum: [
      "baseline_established",
      "new_low",
      "budget_reached",
      "route_historic_low",
      "price_spike",
      "window_closing",
      "run_failure",
    ],
    required: true,
  },
  triggeredAt: { type: Date, required: true, default: Date.now },
  message: { type: String, required: true },
  relatedObservationId: { type: Schema.Types.ObjectId, ref: "Observation", default: null },
  // e.g. `${tripId}:${type}:${YYYY-MM-DD}` — unique index enforces one send
  // per (trip, type, day) max (Section 11.3).
  dedupeKey: { type: String, required: true, unique: true },
  // Set once actually delivered. Null means either not yet due (queued during
  // quiet hours, Section 11.4) or a delivery attempt failed and will retry
  // next run.
  sentAt: { type: Date, default: null },
});

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification = model("Notification", notificationSchema);
