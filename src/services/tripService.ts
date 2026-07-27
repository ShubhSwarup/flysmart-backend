import { Trip } from "../models/Trip.js";

export async function getActiveTrips() {
  return Trip.find({ status: "active" });
}

export async function markPolled(tripId: string, error?: string): Promise<void> {
  await Trip.updateOne(
    { _id: tripId },
    {
      lastPolledAt: new Date(),
      lastPollStatus: error ? "error" : "ok",
      lastPollError: error ?? null,
    },
  );
}
