import type { HydratedDocument } from "mongoose";
import { Notification, type NotificationDoc } from "../models/Notification.js";
import { getSettings } from "../models/Settings.js";
import { sendTelegramMessage } from "../integrations/telegram.js";

interface QuietHours {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
  timezone: string;
}

// Section 11.4 — supports overnight ranges (e.g. 22:00 -> 08:00).
function isWithinQuietHours(quietHours: QuietHours): boolean {
  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes === endMinutes) return false;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quietHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMinutes = hour * 60 + minute;

  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps midnight
}

function dedupeKey(tripId: string, type: string): string {
  return `${tripId}:${type}:${new Date().toISOString().slice(0, 10)}`;
}

async function sendAndMark(doc: HydratedDocument<NotificationDoc>): Promise<void> {
  try {
    await sendTelegramMessage(doc.message, { parseMode: "HTML" });
    doc.sentAt = new Date();
    await doc.save();
    console.log(`Notification sent: ${doc.message}`);
  } catch (err) {
    // Leave sentAt null — picked up and retried on the next poll run.
    console.error("Telegram send failed, will retry next run:", err);
  }
}

async function queueOrSend(params: {
  tripId: string | null;
  type: NotificationDoc["type"];
  message: string;
  relatedObservationId?: string;
}): Promise<void> {
  const key = dedupeKey(params.tripId ?? "system", params.type);
  const existing = await Notification.findOne({ dedupeKey: key });
  if (existing?.sentAt) return; // already delivered today for this trip+type

  const doc =
    existing ??
    (await Notification.create({
      tripId: params.tripId,
      type: params.type,
      triggeredAt: new Date(),
      message: params.message,
      relatedObservationId: params.relatedObservationId ?? null,
      dedupeKey: key,
      sentAt: null,
    }));

  const settings = await getSettings();
  const quietHours = settings.quietHours ?? DEFAULT_QUIET_HOURS;
  if (isWithinQuietHours(quietHours)) {
    console.log(`Queued (quiet hours), will send after ${quietHours.end}: ${params.message}`);
    return;
  }
  await sendAndMark(doc);
}

const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00", timezone: "Asia/Kolkata" };

// Called at the start of every poll run so anything queued during quiet
// hours on a previous run goes out once quiet hours have ended, rather than
// waiting for its own trigger condition to fire again (Section 11.4).
export async function flushQueuedNotifications(): Promise<void> {
  const settings = await getSettings();
  if (isWithinQuietHours(settings.quietHours ?? DEFAULT_QUIET_HOURS)) return;
  const pending = await Notification.find({ sentAt: null });
  for (const doc of pending) {
    await sendAndMark(doc);
  }
}

interface TripLike {
  _id: unknown;
  name: string;
  origin: string;
  tripType: "round_trip" | "one_way";
  budget: { amount: number; currency: string };
  travelWindow?: { earliestDeparture?: Date | null } | null;
}

function tripTypeLabel(tripType: TripLike["tripType"]): string {
  return tripType === "one_way" ? "one-way" : "round trip";
}

interface CheapestObservationLike {
  id: string;
  priceINR: number;
  airlines: string[];
  stops: number;
  departureDate: Date;
  returnDate: Date | null;
  // Set only for an open-jaw itinerary — the return leg's actual departure
  // airport, when it differs from the outbound leg's arrival airport.
  returnDepartureAirport: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Mirrors the frontend's googleFlightsUrl() helper (trips.$tripId.index.tsx)
// but scoped to the exact itinerary that triggered the alert, not just the
// trip's general route — so tapping the link reproduces the fare that was
// actually found, not a generic search. An open-jaw itinerary needs its
// query phrased as two explicit legs — a plain "returning" query would
// silently imply flying back from the same city it flew into, which isn't
// the fare that was actually found.
function googleFlightsUrl(params: {
  origin: string;
  destinationAirport: string;
  departureDate: Date;
  returnDate: Date | null;
  returnDepartureAirport: string | null;
}): string {
  const dep = params.departureDate.toISOString().slice(0, 10);
  let query: string;
  if (params.returnDate && params.returnDepartureAirport) {
    const ret = params.returnDate.toISOString().slice(0, 10);
    query = `Flights from ${params.origin} to ${params.destinationAirport} on ${dep}, then ${params.returnDepartureAirport} to ${params.origin} on ${ret}`;
  } else if (params.returnDate) {
    query = `Flights to ${params.destinationAirport} from ${params.origin} on ${dep} returning ${params.returnDate.toISOString().slice(0, 10)}`;
  } else {
    query = `Flights to ${params.destinationAirport} from ${params.origin} on ${dep}`;
  }
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function describeFlight(obs: CheapestObservationLike): string {
  const airline = obs.airlines[0] ?? "Unknown airline";
  const stopsLabel = obs.stops === 0 ? "nonstop" : `${obs.stops} stop${obs.stops === 1 ? "" : "s"}`;
  const date = obs.departureDate.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const openJawNote = obs.returnDepartureAirport ? `, returning from ${obs.returnDepartureAirport}` : "";
  return `${escapeHtml(airline)}, ${stopsLabel}, departing ${date}${openJawNote}`;
}

// Appended to every alert that's tied to one specific fare (not window_closing,
// which is a deadline nudge rather than a "here's the fare" alert).
function flightDetailsBlock(trip: TripLike, destinationAirport: string, cheapest: CheapestObservationLike): string {
  const link = googleFlightsUrl({
    origin: trip.origin,
    destinationAirport,
    departureDate: cheapest.departureDate,
    returnDate: cheapest.returnDate,
    returnDepartureAirport: cheapest.returnDepartureAirport,
  });
  return `\n${describeFlight(cheapest)}\n<a href="${link}">View on Google Flights</a>`;
}

export async function evaluateTripNotifications(params: {
  trip: TripLike;
  routeKey: string;
  destinationAirport: string;
  cheapest: CheapestObservationLike;
  priorTripLow: number | null;
  priorRouteLow: number | null;
  priorLastPriceINR: number | null;
  everUnderBudget: boolean;
}): Promise<void> {
  const tripId = String(params.trip._id);
  const tripName = escapeHtml(params.trip.name);
  const budget = params.trip.budget.amount;
  const fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const newCheapestINR = params.cheapest.priceINR;
  const typeLabel = tripTypeLabel(params.trip.tripType);
  const details = flightDetailsBlock(params.trip, params.destinationAirport, params.cheapest);

  // baseline_established: fires exactly once, on a trip's genuine first-ever
  // check (no prior trip low to compare against) — unconditionally, unlike
  // every other trigger here, since it's a "monitoring is working, here's
  // what we found" confirmation rather than a "something notable happened"
  // alert. Runs alongside whatever else fires below (e.g. budget_reached can
  // still fire too on the same first check) since they're different signals.
  if (params.priorTripLow == null) {
    const underBudget = newCheapestINR <= budget;
    await queueOrSend({
      tripId,
      type: "baseline_established",
      message:
        `Started monitoring ${tripName} — cheapest fare found so far is ${fmt(newCheapestINR)} ${typeLabel}` +
        (underBudget ? ` (already at or under your ${fmt(budget)} budget).` : `.`) +
        details,
      relatedObservationId: params.cheapest.id,
    });
  }

  // new_low: only meaningful once there's a previous low to beat.
  if (params.priorTripLow != null && newCheapestINR < params.priorTripLow) {
    await queueOrSend({
      tripId,
      type: "new_low",
      message: `New low for ${tripName}: ${fmt(newCheapestINR)} ${typeLabel} (previous low ${fmt(params.priorTripLow)}).${details}`,
      relatedObservationId: params.cheapest.id,
    });
  }

  // budget_reached: fire on the crossing transition (or the very first
  // observation already being under budget), not every subsequent check.
  if (
    newCheapestINR <= budget &&
    (params.priorLastPriceINR == null || params.priorLastPriceINR > budget)
  ) {
    await queueOrSend({
      tripId,
      type: "budget_reached",
      message: `${tripName} is now ${fmt(newCheapestINR)} ${typeLabel} — at or under your ${fmt(budget)} budget.${details}`,
      relatedObservationId: params.cheapest.id,
    });
  }

  // route_historic_low: rarer than a trip-scoped low — beats every trip/year
  // ever tracked for this route.
  if (params.priorRouteLow != null && newCheapestINR < params.priorRouteLow) {
    await queueOrSend({
      tripId,
      type: "route_historic_low",
      message: `Historically rare: this is the lowest fare FlySmart has ever recorded for ${escapeHtml(params.routeKey)} (${fmt(newCheapestINR)} ${typeLabel}).${details}`,
      relatedObservationId: params.cheapest.id,
    });
  }

  // price_spike: >=15% up since the last observation.
  if (params.priorLastPriceINR != null) {
    const change = (newCheapestINR - params.priorLastPriceINR) / params.priorLastPriceINR;
    if (change >= 0.15) {
      await queueOrSend({
        tripId,
        type: "price_spike",
        message: `Price jumped ${(change * 100).toFixed(0)}% for ${tripName} — now ${fmt(newCheapestINR)} ${typeLabel}, up from ${fmt(params.priorLastPriceINR)}.${details}`,
        relatedObservationId: params.cheapest.id,
      });
    }
  }

  // window_closing: travel window opens within 21 days and price has never
  // crossed budget. Not tied to one specific fare, so no flight-details block.
  const earliestDeparture = params.trip.travelWindow?.earliestDeparture;
  if (earliestDeparture && !params.everUnderBudget) {
    const daysOut = Math.round((earliestDeparture.getTime() - Date.now()) / 86_400_000);
    if (daysOut >= 0 && daysOut <= 21) {
      await queueOrSend({
        tripId,
        type: "window_closing",
        message: `${tripName}'s travel window opens in ${daysOut} day${daysOut === 1 ? "" : "s"} and price still hasn't hit your ${fmt(budget)} budget — decide soon if you're still going.`,
      });
    }
  }
}

// Operational alert (Section 10.5 / 13.2) — deliberately bypasses quiet
// hours, since "the poller is broken" is worth knowing regardless of time.
export async function notifyRunFailure(errorSummary: string): Promise<void> {
  const key = dedupeKey("system", "run_failure");
  const existing = await Notification.findOne({ dedupeKey: key });
  if (existing?.sentAt) return;

  const message = `FlySmart poll run failed: ${escapeHtml(errorSummary)}`;
  const doc =
    existing ??
    (await Notification.create({
      tripId: null,
      type: "run_failure",
      triggeredAt: new Date(),
      message,
      dedupeKey: key,
      sentAt: null,
    }));

  await sendAndMark(doc);
}
