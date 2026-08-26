// Duck-typed rather than InstanceType<typeof Trip> so both a full Mongoose
// document and a plain object (e.g. monitoringService's TripLike) satisfy it.
interface TripWindowLike {
  travelWindowType: "fixed" | "flexible-month";
  travelWindow?: { earliestDeparture?: Date | null; months?: string[] } | null;
  priority: "high" | "normal" | "low";
}

// Resolves a trip's travel window down to one concrete date FlySmart can
// actually search a fare for. Fixed-date trips already have one. Flexible-
// month trips don't — searching every day across every selected month would
// multiply SerpApi usage far past the free monthly quota, so we deliberately
// sample a single representative date (the 15th of the earliest selected
// month) rather than leave these trips unmonitored entirely. Rotating the
// sampled date across all selected months over time is a reasonable future
// extension (Section 15) once this simpler version has proven itself.
export function getEffectiveEarliestDeparture(trip: TripWindowLike): Date | null {
  if (trip.travelWindowType === "fixed") {
    return trip.travelWindow?.earliestDeparture ?? null;
  }
  const months = trip.travelWindow?.months ?? [];
  if (months.length === 0) return null;
  const [year, month] = months[0].split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 15));
}

// Cadence table (Section 10.4), shared by tripService (deciding which trips
// are due for the scheduled batch run) and monitoringService (displaying an
// accurate "next check" to the user — a trip on the 3-day cadence shouldn't
// claim it'll be checked at tomorrow's cron run). Daily unless a trip's
// window is still more than 90 days out AND it isn't high priority.
export function cadenceDays(trip: TripWindowLike): number {
  const earliestDeparture = getEffectiveEarliestDeparture(trip);
  if (!earliestDeparture) return 1;
  const daysUntilWindow = (earliestDeparture.getTime() - Date.now()) / 86_400_000;
  if (daysUntilWindow > 90 && trip.priority !== "high") return 3;
  return 1;
}
