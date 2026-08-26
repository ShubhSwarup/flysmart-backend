import { connectDB, disconnectDB } from "../config/db.js";
import { Trip } from "../models/Trip.js";
import { getDueTrips } from "../services/tripService.js";
import { pollTrip } from "../services/pollService.js";
import { notifyRunFailure, flushQueuedNotifications } from "../services/notificationService.js";

// Phase 1 (MASTER_SPEC Section 16): prove the pipeline end-to-end for one
// trip before Phase 2 adds scheduling, multiple trips, and notifications.
// If no trips exist yet, seed this one so the script is runnable standalone.
const SEED_TRIP = {
  name: "Japan — Cherry Blossom",
  origin: "BLR",
  destinationAirports: ["NRT"],
  destination: "Japan",
  travelWindowType: "fixed" as const,
  travelWindow: {
    earliestDeparture: new Date(Date.now() + 60 * 86_400_000),
    latestDeparture: new Date(Date.now() + 67 * 86_400_000),
  },
  tripDuration: { minNights: 7, maxNights: 12 },
  budget: { amount: 55000, currency: "INR" },
  cabinClass: "economy" as const,
  maxStops: 1,
  maxLayoverMinutes: 240,
  preferredAirlines: ["NH"],
  priority: "high" as const,
  regionTag: "japan",
  notes: "Phase 1 seed trip — first end-to-end poll test.",
};

async function ensureSeedTrip(): Promise<void> {
  const count = await Trip.countDocuments();
  if (count > 0) return;
  await Trip.create(SEED_TRIP);
  console.log("No trips found — inserted the Phase 1 seed trip (BLR → NRT, Japan).");
}

async function run(): Promise<void> {
  let connected = false;
  try {
    await connectDB();
    connected = true;
    console.log("Connected to MongoDB.");

    await ensureSeedTrip();
    await flushQueuedNotifications();

    const trips = await getDueTrips();
    console.log(`Polling ${trips.length} due trip(s)...`);

    for (const trip of trips) {
      await pollTrip(trip);
    }

    console.log("Done.");
  } catch (err) {
    // A per-trip failure is already caught and logged inside pollTrip and
    // doesn't reach here — this only fires for a failure that breaks the
    // whole run (e.g. the DB connection itself), which is exactly when a
    // silent monitoring tool becomes worse than useless (Section 13.2).
    console.error("Poll run failed:", err);
    if (connected) {
      await notifyRunFailure(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  } finally {
    if (connected) await disconnectDB();
  }
}

run();
