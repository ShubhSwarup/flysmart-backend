import type { HydratedDocument } from "mongoose";
import { Notification, type NotificationDoc } from "../models/Notification.js";
import { getSettings } from "../models/Settings.js";
import { sendTelegramMessage } from "../integrations/telegram.js";
import { LONG_LAYOVER_MINUTES } from "./tripConstraints.js";
import type { SearchCoverage } from "./searchCandidateService.js";

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
  layoverMinutes: number[];
  departureDate: Date;
  returnDate: Date | null;
  // Set only for an open-jaw itinerary — the return leg's actual departure
  // airport, when it differs from the outbound leg's arrival airport.
  returnDepartureAirport: string | null;
  returnLeg: { airlines: string[]; stops: number; layoverMinutes: number[] } | null;
  googleFlightsUrl: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A fallback for a fare with no link from Google itself. Scoped to the exact
// itinerary that triggered the alert, not just the trip's general route. An
// open-jaw itinerary needs its query phrased as two explicit legs — a plain
// "returning" query would silently imply flying back from the same city it
// flew into, which isn't the fare that was actually found.
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

function stopsLabel(stops: number): string {
  return stops === 0 ? "nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function describeFlight(obs: CheapestObservationLike): string {
  const airline = obs.airlines[0] ?? "Unknown airline";
  const lines = [`${escapeHtml(airline)}, ${stopsLabel(obs.stops)}, departing ${shortDate(obs.departureDate)}`];
  if (obs.returnLeg && obs.returnDate) {
    const from = obs.returnDepartureAirport ? ` from ${obs.returnDepartureAirport}` : "";
    const returnAirline = obs.returnLeg.airlines[0] ?? "Unknown airline";
    lines.push(
      `Back ${shortDate(obs.returnDate)}${from}: ${escapeHtml(returnAirline)}, ${stopsLabel(obs.returnLeg.stops)}`,
    );
  }
  const layovers = [...obs.layoverMinutes, ...(obs.returnLeg?.layoverMinutes ?? [])];
  const longest = Math.max(0, ...layovers);
  if (longest >= LONG_LAYOVER_MINUTES) lines.push(`Includes a ${Math.round(longest / 60)}h layover.`);
  return lines.join("\n");
}

// Appended to every alert that's tied to one specific fare (not window_closing,
// which is a deadline nudge rather than a "here's the fare" alert).
function flightDetailsBlock(trip: TripLike, destinationAirport: string, cheapest: CheapestObservationLike): string {
  const link =
    cheapest.googleFlightsUrl ??
    googleFlightsUrl({
      origin: trip.origin,
      destinationAirport,
      departureDate: cheapest.departureDate,
      returnDate: cheapest.returnDate,
      returnDepartureAirport: cheapest.returnDepartureAirport,
    });
  return `\n${describeFlight(cheapest)}\n<a href="${escapeHtml(link)}">View on Google Flights</a>`;
}

// "Cheapest so far" is only as strong as what's been looked at, so a first
// report says how much of the window that is.
function coverageNote(coverage: SearchCoverage): string {
  if (coverage.weeksChecked >= coverage.weeksTotal) return "";
  return ` ${coverage.weeksChecked} of ${coverage.weeksTotal} weeks checked so far.`;
}

type FareAlertType = "budget_reached" | "route_historic_low" | "new_low";

// The single alert, if any, for a new best fare. A fare crossing into budget
// comes first since that's the one the user acted on by setting a budget.
export function chooseFareAlert(input: {
  newBest: number;
  budget: number;
  priorBest: number | null;
  priorLow: number | null;
  priorRouteLow: number | null;
}): { type: FareAlertType; alsoRouteRecord: boolean } | null {
  const { newBest, budget, priorBest, priorLow, priorRouteLow } = input;
  const isRouteRecord = priorRouteLow != null && newBest < priorRouteLow;
  // A first fare doesn't cross anything — the baseline message covers it.
  const crossedBudget = priorBest != null && newBest <= budget && priorBest > budget;

  if (crossedBudget) return { type: "budget_reached", alsoRouteRecord: isRouteRecord };
  if (isRouteRecord) return { type: "route_historic_low", alsoRouteRecord: false };
  if (priorLow != null && newBest < priorLow) return { type: "new_low", alsoRouteRecord: false };
  return null;
}

export async function evaluateTripNotifications(params: {
  trip: TripLike;
  routeKey: string;
  destinationAirport: string;
  cheapest: CheapestObservationLike;
  // The trip's previous best fare, and the lowest it has ever been. Null on a
  // trip's first confirmed fare.
  priorBest: number | null;
  priorLow: number | null;
  priorRouteLow: number | null;
  everUnderBudget: boolean;
  coverage: SearchCoverage;
  // Set on a first confirmed fare when the trip already has recorded prices
  // (an existing trip, or a search that was just edited) — the lowest of them.
  previouslyRecordedLow: number | null;
}): Promise<void> {
  const tripId = String(params.trip._id);
  const tripName = escapeHtml(params.trip.name);
  const budget = params.trip.budget.amount;
  const fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const newCheapestINR = params.cheapest.priceINR;
  const typeLabel = tripTypeLabel(params.trip.tripType);
  const details = flightDetailsBlock(params.trip, params.destinationAirport, params.cheapest);
  const underBudget = newCheapestINR <= budget;

  // baseline_established: fires exactly once, on a trip's first confirmed fare
  // (no prior best to compare against) — unconditionally, unlike every other
  // trigger here, since it's a "monitoring is working, here's what we found"
  // confirmation rather than a "something notable happened" alert.
  //
  // If the trip already has recorded prices, this replaces whatever earlier
  // alerts said, and has to own up to any lower figure the user may be
  // holding on to: those hadn't been checked against a return flight or the
  // trip's rules, so they may never have been on offer.
  if (params.priorBest == null) {
    const budgetNote = underBudget ? ` (already at or under your ${fmt(budget)} budget).` : `.`;
    const earlier = params.previouslyRecordedLow;
    const correction =
      earlier != null && earlier < newCheapestINR
        ? ` Earlier figures as low as ${fmt(earlier)} weren't checked against a return flight and your trip rules, so please disregard them.`
        : "";
    const lead =
      earlier != null
        ? `Updated price for ${tripName}: the cheapest fare with both directions confirmed is`
        : `Started monitoring ${tripName} — the cheapest fare found so far is`;
    await queueOrSend({
      tripId,
      type: "baseline_established",
      message: `${lead} ${fmt(newCheapestINR)} ${typeLabel}${budgetNote}${correction}${coverageNote(params.coverage)}${details}`,
      relatedObservationId: params.cheapest.id,
    });
  }

  // One better price is one piece of news, however many thresholds it crossed
  // at once (Principle 3), so it gets one message, saying the most useful
  // thing it can. The route record is added to a budget crossing, not sent
  // separately.
  const alert = chooseFareAlert({
    newBest: newCheapestINR,
    budget,
    priorBest: params.priorBest,
    priorLow: params.priorLow,
    priorRouteLow: params.priorRouteLow,
  });
  if (alert) {
    const routeRecord =
      alert.alsoRouteRecord
        ? ` That's also the lowest FlySmart has ever recorded on this route.`
        : "";
    const messages = {
      budget_reached: `${tripName} is now ${fmt(newCheapestINR)} ${typeLabel} — at or under your ${fmt(budget)} budget.${routeRecord}`,
      route_historic_low: `Historically rare: this is the lowest fare FlySmart has ever recorded for ${escapeHtml(params.routeKey)} (${fmt(newCheapestINR)} ${typeLabel}).`,
      new_low: `New low for ${tripName}: ${fmt(newCheapestINR)} ${typeLabel} (previous low ${fmt(params.priorLow ?? newCheapestINR)}).`,
    };
    await queueOrSend({
      tripId,
      type: alert.type,
      message: `${messages[alert.type]}${details}`,
      relatedObservationId: params.cheapest.id,
    });
  }

  // price_spike: >=15% up on the previous best fare.
  if (params.priorBest != null) {
    const change = (newCheapestINR - params.priorBest) / params.priorBest;
    if (change >= 0.15) {
      await queueOrSend({
        tripId,
        type: "price_spike",
        message: `Price jumped ${(change * 100).toFixed(0)}% for ${tripName} — now ${fmt(newCheapestINR)} ${typeLabel}, up from ${fmt(params.priorBest)}.${details}`,
        relatedObservationId: params.cheapest.id,
      });
    }
  }

  // window_closing: travel window opens within 21 days and price has never
  // crossed budget. Not tied to one specific fare, so no flight-details block.
  // The window's start is clamped to today once it has opened, so a daysOut of
  // 0 means "already open" — there's nothing left to count down to.
  const earliestDeparture = params.trip.travelWindow?.earliestDeparture;
  if (earliestDeparture && !params.everUnderBudget && !underBudget) {
    const daysOut = Math.round((earliestDeparture.getTime() - Date.now()) / 86_400_000);
    if (daysOut >= 1 && daysOut <= 21) {
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
