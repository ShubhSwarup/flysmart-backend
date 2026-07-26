import type { Types } from "mongoose";
import { connectDB, disconnectDB } from "../config/db.js";
import { Trip } from "../models/Trip.js";
import { getActiveTrips, markPolled } from "../services/tripService.js";
import { searchFlights } from "../integrations/serpapi.js";
import { recordObservations, makeRouteKey } from "../services/observationService.js";
import {
  getPriorTripStats,
  getPriorRouteLow,
  hasEverBeenUnderBudget,
} from "../services/analyticsService.js";
import {
  evaluateTripNotifications,
  notifyRunFailure,
  flushQueuedNotifications,
} from "../services/notificationService.js";

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

async function pollTrip(trip: InstanceType<typeof Trip>): Promise<void> {
  const budget = trip.budget;
  const earliestDeparture = trip.travelWindow?.earliestDeparture;
  if (!earliestDeparture || !trip.tripDuration || !budget) {
    console.warn(
      `Skipping "${trip.name}" — no earliestDeparture set (flexible-month trips aren't handled yet).`,
    );
    return;
  }
  const departureDate = earliestDeparture.toISOString().slice(0, 10);
  const returnDate = new Date(
    earliestDeparture.getTime() + trip.tripDuration.minNights * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const pollTime = new Date();

  for (const destinationAirport of trip.destinationAirports) {
    try {
      const routeKey = makeRouteKey(trip.origin, destinationAirport, trip.cabinClass);
      // Capture the "before this poll" baseline first — recordObservations
      // below would otherwise pollute these queries with the new data.
      const priorTrip = await getPriorTripStats(String(trip._id), pollTime);
      const priorRouteLow = await getPriorRouteLow(routeKey, pollTime);

      const result = await searchFlights({
        origin: trip.origin,
        destinationAirport,
        departureDate,
        returnDate,
        cabinClass: trip.cabinClass,
      });

      const inserted = await recordObservations({
        tripId: trip._id as Types.ObjectId,
        origin: trip.origin,
        destinationAirport,
        departureDate,
        returnDate,
        cabinClass: trip.cabinClass,
        source: "serpapi",
        itineraries: result.itineraries,
      });

      console.log(
        `${trip.name} → ${destinationAirport}: recorded ${inserted.length} observation(s)` +
          (inserted.length ? `, cheapest ₹${Math.min(...inserted.map((o) => o.priceINR)).toLocaleString("en-IN")}` : ""),
      );

      if (inserted.length > 0) {
        const cheapest = inserted.reduce((a, b) => (a.priceINR < b.priceINR ? a : b));
        const everUnderBudget = await hasEverBeenUnderBudget(String(trip._id), budget.amount);

        await evaluateTripNotifications({
          trip: { _id: trip._id, name: trip.name, budget, travelWindow: { earliestDeparture } },
          routeKey,
          priorTripLow: priorTrip.low,
          priorRouteLow,
          priorLastPriceINR: priorTrip.lastPriceINR,
          newCheapestINR: cheapest.priceINR,
          newCheapestObservationId: String(cheapest._id),
          everUnderBudget,
        });
      }
    } catch (err) {
      console.error(`Failed to poll ${trip.name} → ${destinationAirport}:`, err);
    }
  }

  await markPolled(String(trip._id));
}

async function run(): Promise<void> {
  let connected = false;
  try {
    await connectDB();
    connected = true;
    console.log("Connected to MongoDB.");

    await ensureSeedTrip();
    await flushQueuedNotifications();

    const trips = await getActiveTrips();
    console.log(`Polling ${trips.length} active trip(s)...`);

    for (const trip of trips) {
      await pollTrip(trip);
    }

    console.log("Done.");
  } catch (err) {
    // A per-trip/per-destination failure is already caught and logged inside
    // pollTrip and doesn't reach here — this only fires for a failure that
    // breaks the whole run (e.g. the DB connection itself), which is exactly
    // when a silent monitoring tool becomes worse than useless (Section 13.2).
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
