// Duck-typed rather than InstanceType<typeof Trip> so both a full Mongoose
// document and a plain object (e.g. monitoringService's TripLike) satisfy it.
interface TripWindowLike {
  travelWindowType: "fixed" | "flexible-month" | "days-off";
  travelWindow?: {
    earliestDeparture?: Date | null;
    latestDeparture?: Date | null;
    months?: string[];
  } | null;
  priority: "high" | "normal" | "low";
}

export interface CandidateWindow {
  earliest: Date; // UTC midnight, never in the past
  latest: Date; // UTC midnight, inclusive — equal to `earliest` for a single exact date
}

function startOfUTCDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function monthStart(monthKey: string): Date {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

// Day 0 of the following month is the last day of this one — handles every
// month length (28/29/30/31) without a lookup table.
function monthEnd(monthKey: string): Date {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0));
}

// Resolves a trip's travel window to the full range of departure dates
// FlySmart should actually consider — not a single sampled day. A fixed
// trip's range is exactly what the user entered (earliestDeparture through
// latestDeparture — a range, per its own field names, not a single point).
// A flexible-month trip's range is the union of every selected month that
// hasn't fully elapsed yet, so a trip with several months selected has all
// of them genuinely in play, not just the first.
//
// Either way, the window's start is clamped forward to today — FlySmart
// never searches a date that's already in the past — and a window whose
// entire span has already elapsed resolves to no window at all (the same
// "unmonitored until edited" outcome a trip with no dates/months set at all
// already has, not a new failure mode).
export function getCandidateWindow(trip: TripWindowLike): CandidateWindow | null {
  const today = startOfUTCDay(new Date());

  // A "days-off" trip is a single, already-decided window chosen from a
  // Days Off preview (daysOffCalculator.ts) at creation time — not an open
  // range to keep exploring, so it resolves exactly like a fixed trip.
  if (trip.travelWindowType === "fixed" || trip.travelWindowType === "days-off") {
    const earliestDeparture = trip.travelWindow?.earliestDeparture ?? null;
    if (!earliestDeparture) return null;
    // latestDeparture is expected on every trip created through the current
    // form, but defaults to earliestDeparture (a single-day window) for
    // defensiveness against older or hand-inserted records missing it.
    const latestDeparture = trip.travelWindow?.latestDeparture ?? earliestDeparture;
    const earliest = earliestDeparture.getTime() > today.getTime() ? earliestDeparture : today;
    if (earliest.getTime() > latestDeparture.getTime()) return null;
    return { earliest, latest: latestDeparture };
  }

  const months = trip.travelWindow?.months ?? [];
  const now = Date.now();
  // "YYYY-MM" strings sort correctly as plain strings — the stored array is
  // user click-order, not chronological, so it's sorted here rather than
  // trusted. A month that has already fully elapsed (its last day is in the
  // past) is dropped entirely rather than contributing a stale range.
  const validMonths = [...months].sort().filter((key) => monthEnd(key).getTime() >= today.getTime());
  if (validMonths.length === 0) return null;

  const firstMonthStart = monthStart(validMonths[0]);
  const earliest = firstMonthStart.getTime() > now ? firstMonthStart : today;
  const latest = monthEnd(validMonths[validMonths.length - 1]);
  return { earliest, latest };
}

// Cadence table (Section 10.4), shared by tripService (deciding which trips
// are due for the scheduled batch run) and monitoringService (displaying an
// accurate "next check" to the user — a trip on the 3-day cadence shouldn't
// claim it'll be checked at tomorrow's cron run). Daily unless a trip's
// window is still more than 90 days out AND it isn't high priority.
export function cadenceDays(trip: TripWindowLike): number {
  const window = getCandidateWindow(trip);
  if (!window) return 1;
  const daysUntilWindow = (window.earliest.getTime() - Date.now()) / 86_400_000;
  if (daysUntilWindow > 90 && trip.priority !== "high") return 3;
  return 1;
}
