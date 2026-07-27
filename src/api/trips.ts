import { Router } from "express";
import { Trip } from "../models/Trip.js";
import { getMonitoringInfo } from "../services/monitoringService.js";
import { pollTrip } from "../services/pollService.js";

export const tripsRouter = Router();

async function withMonitoring(trip: InstanceType<typeof Trip>) {
  const monitoring = await getMonitoringInfo(trip);
  return { ...trip.toObject(), ...monitoring };
}

tripsRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === "string") filter.status = req.query.status;
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
