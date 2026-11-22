import { Router } from "express";
import { Observation } from "../models/Observation.js";

export const observationsRouter = Router();

// GET /api/observations?tripId=... or ?routeKey=...
observationsRouter.get("/", async (req, res) => {
  const { tripId, routeKey } = req.query;
  if (typeof tripId !== "string" && typeof routeKey !== "string") {
    return res.status(400).json({ error: "Provide a tripId or routeKey query parameter" });
  }
  const filter: Record<string, unknown> = {};
  if (typeof tripId === "string") filter.tripId = tripId;
  if (typeof routeKey === "string") filter.routeKey = routeKey;
  const observations = await Observation.find(filter).sort({ queriedAt: 1 });
  res.json(observations);
});