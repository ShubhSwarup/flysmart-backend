import { Observation } from "../models/Observation.js";
import { Notification } from "../models/Notification.js";
import { cadenceDays } from "./tripWindow.js";

export type MonitoringStatus =
  | "not_monitored" // trip status isn't "active" — lifecycle status covers this instead
  | "waiting_for_first_check"
  | "monitoring"
  | "budget_reached"
  | "notification_sent"
  | "search_failed";

export interface MonitoringInfo {
  monitoringStatus: MonitoringStatus;
  lastCheckedAt: string | null;
  nextScheduledCheckAt: string;
  lastNotification: { type: string; message: string } | null;
}

interface TripLike {
  _id: unknown;
  status: string;
  budget?: { amount: number } | null;
  lastPolledAt?: Date | null;
  lastPollStatus?: string | null;
  travelWindowType: "fixed" | "flexible-month";
  travelWindow?: { earliestDeparture?: Date | null; months?: string[] } | null;
  priority: "high" | "normal" | "low";
}

// Must match .github/workflows/poll.yml's schedule ("0 3 * * *") — the cron
// only fires once a day, so "next check" is always some future occurrence
// of this hour, never an arbitrary time in between.
const SCHEDULED_HOUR_UTC = 3;

export function nextScheduledCheck(from: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), SCHEDULED_HOUR_UTC, 0, 0),
  );
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// A trip on the 3-day cadence (Section 10.4) isn't actually due at
// tomorrow's cron run — it becomes due `cadenceDays` after its last poll,
// and "next check" is the first scheduled cron run on or after that.
function computeNextScheduledCheck(trip: TripLike, now: Date): Date {
  if (!trip.lastPolledAt) return nextScheduledCheck(now);
  const dueAt = new Date(trip.lastPolledAt.getTime() + cadenceDays(trip) * 86_400_000);
  return nextScheduledCheck(dueAt > now ? dueAt : now);
}

export async function getMonitoringInfo(trip: TripLike): Promise<MonitoringInfo> {
  const now = new Date();
  const nextScheduledCheckAt = computeNextScheduledCheck(trip, now).toISOString();
  const lastCheckedAt = trip.lastPolledAt ? trip.lastPolledAt.toISOString() : null;

  if (trip.status !== "active") {
    return { monitoringStatus: "not_monitored", lastCheckedAt, nextScheduledCheckAt, lastNotification: null };
  }

  if (trip.lastPollStatus === "error") {
    return { monitoringStatus: "search_failed", lastCheckedAt, nextScheduledCheckAt, lastNotification: null };
  }

  const latestObservation = await Observation.findOne({ tripId: trip._id })
    .sort({ queriedAt: -1 })
    .lean();

  if (!latestObservation) {
    return {
      monitoringStatus: "waiting_for_first_check",
      lastCheckedAt,
      nextScheduledCheckAt,
      lastNotification: null,
    };
  }

  // Was a notification triggered by the most recent check specifically? Ties
  // to the latest observation's id, so this naturally reverts to "monitoring"
  // once a later check comes in without a fresh notification.
  const relatedNotification = await Notification.findOne({
    relatedObservationId: latestObservation._id,
  }).lean();

  if (relatedNotification) {
    return {
      monitoringStatus: "notification_sent",
      lastCheckedAt,
      nextScheduledCheckAt,
      lastNotification: { type: relatedNotification.type, message: relatedNotification.message },
    };
  }

  if (trip.budget && latestObservation.priceINR <= trip.budget.amount) {
    return { monitoringStatus: "budget_reached", lastCheckedAt, nextScheduledCheckAt, lastNotification: null };
  }

  return { monitoringStatus: "monitoring", lastCheckedAt, nextScheduledCheckAt, lastNotification: null };
}
