import { Observation } from "../models/Observation.js";
import { Notification } from "../models/Notification.js";

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
}

// Must match .github/workflows/poll.yml's schedule ("0 3 * * *"). There's no
// per-trip cadence yet (Section 10.4's priority-based cadence isn't built),
// so every active trip shares this one daily check time.
const SCHEDULED_HOUR_UTC = 3;

export function nextScheduledCheck(from: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), SCHEDULED_HOUR_UTC, 0, 0),
  );
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function getMonitoringInfo(trip: TripLike): Promise<MonitoringInfo> {
  const nextScheduledCheckAt = nextScheduledCheck().toISOString();
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
