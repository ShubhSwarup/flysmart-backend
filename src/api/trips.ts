import { Router } from "express";
import type { Types } from "mongoose";
import { Trip } from "../models/Trip.js";
import { Observation } from "../models/Observation.js";
import { SearchCandidate } from "../models/SearchCandidate.js";
import { getSettings } from "../models/Settings.js";
import { getMonitoringInfo } from "../services/monitoringService.js";
import { pollTrip } from "../services/pollService.js";
import { getCandidateWindow } from "../services/tripWindow.js";
import { getBestVerifiedCandidate } from "../services/searchCandidateService.js";
import { computeWindowOptions, describeOptions } from "../services/daysOffCalculator.js";

export const tripsRouter = Router();

// Given the day(s) off a trip idea is built around, an extra-leave ceiling,
// and a rough desired length, returns a short list of realistic date
// options — pure calendar math (daysOffCalculator.ts), no provider call, no
// trip created. Powers the trip form's "see options before you save"
// preview (Section D of the architecture plan) — real flight prices only
// get checked once the user actually picks one and saves it as a trip.
tripsRouter.post("/days-off-preview", async (req, res) => {
  try {
    const body = req.body as {
      anchors?: string[];
      leaveBudget?: number;
      minNights?: number | null;
      maxNights?: number | null;
    };
    if (!Array.isArray(body.anchors) || body.anchors.length === 0) {
      return res.status(400).json({ error: "Select at least one day off to build a trip around." });
    }
    const anchors = body.anchors.map((a) => new Date(a));
    const settings = await getSettings();
    const ambientFreeDates = (settings.daysOff ?? [])
      .map((d) => d.date)
      .filter((d): d is Date => d != null);

    const preview = computeWindowOptions({
      anchors,
      leaveBudget: body.leaveBudget ?? 0,
      ambientFreeDates,
      minNights: body.minNights ?? null,
      maxNights: body.maxNights ?? null,
    });
    res.json({
      bridged: preview.bridged,
      options: describeOptions(preview, anchors, {
        leaveBudget: body.leaveBudget ?? 0,
        minNights: body.minNights ?? null,
      }),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function withMonitoring(trip: InstanceType<typeof Trip>) {
  const monitoring = await getMonitoringInfo(trip);
  // What to show as "the window this trip is checking" — the dates of the
  // best real result found so far, once there is one (the same "best
  // realistic trip found so far" pollService.ts evaluates notifications
  // against), or the raw window's start as a placeholder before anything's
  // been verified yet. null only when the trip has no resolvable window at
  // all (e.g. every selected flexible month has already elapsed).
  const window = getCandidateWindow(trip);
  let effectiveDeparture: Date | null = null;
  let effectiveReturn: Date | null = null;
  if (window) {
    const best = await getBestVerifiedCandidate(trip._id as Types.ObjectId, window);
    effectiveDeparture = best ? best.candidate.departureDate : window.earliest;
    effectiveReturn = best ? (best.candidate.returnDate ?? null) : null;
  }
  return { ...trip.toObject(), ...monitoring, effectiveDeparture, effectiveReturn };
}

tripsRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === "string") filter.status = req.query.status;
  // Lets the dashboard fetch the sibling trips created together from one
  // Days Off preview (more than one option chosen to track at once), so
  // they can be shown as one trip idea with a few open date options.
  if (typeof req.query.daysOffGroupId === "string") filter.daysOffGroupId = req.query.daysOffGroupId;
  const trips = await Trip.find(filter).sort({ createdAt: -1 });
  res.json(await Promise.all(trips.map(withMonitoring)));
});

tripsRouter.get("/:id", async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    res.json(await withMonitoring(trip));
  } catch {
    res.status(400).json({ error: "Invalid trip id" });
  }
});

// Every candidate date FlySmart is (or was) considering for this trip,
// verified or still just a Tier-1 estimate — the data searchCandidateService
// already persists on every poll cycle, but that nothing before this
// endpoint ever exposed. Powers the calendar/price-by-date view; a trip
// that resolves to exactly one candidate (the common single-exact-date
// case) still returns that one entry, which the frontend just doesn't
// bother rendering as a calendar.
tripsRouter.get("/:id/candidates", async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    const window = getCandidateWindow(trip);
    if (!window) return res.json([]);

    const candidates = await SearchCandidate.find({
      tripId: trip._id,
      departureDate: { $gte: window.earliest, $lte: window.latest },
    }).sort({ departureDate: 1 });
    const observationIds = candidates
      .map((c) => c.observationId)
      .filter((id): id is Types.ObjectId => id != null);
    const observations = await Observation.find({ _id: { $in: observationIds } });
    const observationById = new Map(observations.map((o) => [String(o._id), o]));

    res.json(
      candidates.map((c) => {
        const observation = c.observationId ? observationById.get(String(c.observationId)) : undefined;
        return {
          departureDate: c.departureDate,
          returnDate: c.returnDate,
          status: c.status,
          estimatedPriceINR: c.estimatedPriceINR,
          priceINR: observation?.priceINR ?? null,
          stops: observation?.stops ?? null,
          airlines: observation?.airlines ?? [],
          returnDepartureAirport: observation?.returnDepartureAirport ?? null,
          lastCheckedAt: c.lastCheckedAt,
        };
      }),
    );
  } catch {
    res.status(400).json({ error: "Invalid trip id" });
  }
});

tripsRouter.post("/", async (req, res) => {
  try {
    const trip = await Trip.create(req.body);
    // Establish a baseline immediately instead of waiting for the next
    // scheduled run — reuses the exact same per-trip poll logic the batch
    // job uses (services/pollService.ts), so this isn't a second, divergent
    // implementation of "how a trip gets checked." pollTrip never throws
    // (failures are recorded on the trip itself), so trip creation always
    // succeeds even if this first search fails.
    await pollTrip(trip);
    const fresh = await Trip.findById(trip._id);
    res.status(201).json(await withMonitoring(fresh!));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

tripsRouter.patch("/:id", async (req, res) => {
  try {
    const trip = await Trip.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    res.json(await withMonitoring(trip));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

tripsRouter.delete("/:id", async (req, res) => {
  try {
    const trip = await Trip.findByIdAndDelete(req.params.id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    res.status(204).end();
  } catch {
    res.status(400).json({ error: "Invalid trip id" });
  }
});
