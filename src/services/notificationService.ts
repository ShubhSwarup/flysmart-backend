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
    await sendTelegramMessage(doc.message);
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
  budget: { amount: number; currency: string };
  travelWindow?: { earliestDeparture?: Date | null } | null;
}

export async function evaluateTripNotifications(params: {
  trip: TripLike;
  routeKey: string;
  priorTripLow: number | null;
  priorRouteLow: number | null;
  priorLastPriceINR: number | null;
  newCheapestINR: number;
  newCheapestObservationId: string;
  everUnderBudget: boolean;
}): Promise<void> {
  const tripId = String(params.trip._id);
  const budget = params.trip.budget.amount;
  const fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

  // new_low: only meaningful once there's a previous low to beat.
  if (params.priorTripLow != null && params.newCheapestINR < params.priorTripLow) {
    await queueOrSend({
      tripId,
      type: "new_low",
      message: `New low for ${params.trip.name}: ${fmt(params.newCheapestINR)} (previous low ${fmt(params.priorTripLow)}).`,
      relatedObservationId: params.newCheapestObservationId,
    });
  }

  // budget_reached: fire on the crossing transition (or the very first
  // observation already being under budget), not every subsequent check.
  if (
    params.newCheapestINR <= budget &&
    (params.priorLastPriceINR == null || params.priorLastPriceINR > budget)
  ) {
    await queueOrSend({
      tripId,
      type: "budget_reached",
      message: `${params.trip.name} is now ${fmt(params.newCheapestINR)} — at or under your ${fmt(budget)} budget.`,
      relatedObservationId: params.newCheapestObservationId,
    });
  }

  // route_historic_low: rarer than a trip-scoped low — beats every trip/year
  // ever tracked for this route.
  if (params.priorRouteLow != null && params.newCheapestINR < params.priorRouteLow) {
    await queueOrSend({
      tripId,
      type: "route_historic_low",
      message: `Historically rare: this is the lowest fare FlySmart has ever recorded for ${params.routeKey} (${fmt(params.newCheapestINR)}).`,
      relatedObservationId: params.newCheapestObservationId,
    });
  }

  // price_spike: >=15% up since the last observation.
  if (params.priorLastPriceINR != null) {
    const change = (params.newCheapestINR - params.priorLastPriceINR) / params.priorLastPriceINR;
    if (change >= 0.15) {
      await queueOrSend({
        tripId,
        type: "price_spike",
        message: `Price jumped ${(change * 100).toFixed(0)}% for ${params.trip.name} — now ${fmt(params.newCheapestINR)}, up from ${fmt(params.priorLastPriceINR)}.`,
        relatedObservationId: params.newCheapestObservationId,
      });
    }
  }

  // window_closing: travel window opens within 21 days and price has never
  // crossed budget.
  const earliestDeparture = params.trip.travelWindow?.earliestDeparture;
  if (earliestDeparture && !params.everUnderBudget) {
    const daysOut = Math.round((earliestDeparture.getTime() - Date.now()) / 86_400_000);
    if (daysOut >= 0 && daysOut <= 21) {
      await queueOrSend({
        tripId,
        type: "window_closing",
        message: `${params.trip.name}'s travel window opens in ${daysOut} day${daysOut === 1 ? "" : "s"} and price still hasn't hit your ${fmt(budget)} budget — decide soon if you're still going.`,
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

  const message = `FlySmart poll run failed: ${errorSummary}`;
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
