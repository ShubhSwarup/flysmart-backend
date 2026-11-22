import { INTERACTIVE_SEARCH_RESERVE } from "../config/quotas.js";

// A month's quota spread over the days left in it. Without pacing, a few
// date-range trips polling daily use up the whole free tier before the month
// ends and everything goes quiet for the last week — the part of the month
// that might matter most. Recomputed from what's actually left on every run,
// so a quiet day's leftovers roll forward by themselves.
export function dailySearchAllowance(remainingThisMonth: number, now: Date): number {
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = lastDay - now.getUTCDate() + 1;
  const spendable = Math.max(0, remainingThisMonth - INTERACTIVE_SEARCH_RESERVE);
  return Math.ceil(spendable / daysLeft);
}

export interface PlannableTrip {
  priority: string;
  lastPolledAt?: Date | null;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

// Which due trips run today, and which wait. Higher priority first, then
// whichever has gone longest unchecked — so when the allowance can't cover
// everything, trips take turns rather than the same ones always missing out.
// At least one trip always runs while the month's quota can cover it, or an
// allowance smaller than a single trip's cost would stall everything forever.
export function planPollRun<T extends PlannableTrip>(
  due: T[],
  weightOf: (trip: T) => number,
  remainingThisMonth: number,
  now: Date,
): { affordable: T[]; skipped: T[]; plannedSpend: number; allowance: number } {
  const allowance = dailySearchAllowance(remainingThisMonth, now);
  const ordered = [...due].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (a.lastPolledAt?.getTime() ?? 0) - (b.lastPolledAt?.getTime() ?? 0),
  );

  const affordable: T[] = [];
  const skipped: T[] = [];
  let plannedSpend = 0;
  for (const trip of ordered) {
    const weight = weightOf(trip);
    const fitsToday = plannedSpend + weight <= allowance;
    const firstOfTheDay = affordable.length === 0 && weight <= remainingThisMonth;
    if (fitsToday || firstOfTheDay) {
      affordable.push(trip);
      plannedSpend += weight;
    } else {
      skipped.push(trip);
    }
  }
  return { affordable, skipped, plannedSpend, allowance };
}
