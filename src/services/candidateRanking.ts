import type { CandidateWindow } from "./tripWindow.js";

const DAY_MS = 86_400_000;

export interface CandidateSpec {
  departureDate: Date;
  returnDate: Date | null;
}

// A trip's duration range collapses to a small, fixed set of points to try
// per departure date — not every integer night count in between. Price
// sensitivity to trip length is generally far flatter than sensitivity to
// which date you fly, so this concentrates the (deliberately small) search
// budget where it actually earns something: the shortest option, the
// longest the range allows, and a midpoint between them. Equal min/max (a
// fixed-duration trip, e.g. "exactly 7 nights") collapses to that one point.
export function durationPoints(minNights: number | null, maxNights: number | null): number[] {
  if (!minNights || minNights < 1) return [];
  const max = maxNights && maxNights > minNights ? maxNights : minNights;
  const mid = Math.round((minNights + max) / 2);
  return [...new Set([minNights, mid, max])].sort((a, b) => a - b);
}

// Every (departure, return) pair a trip's window and duration range imply.
// One-way trips have no return leg, so no duration to sample — one
// candidate per departure day. Purely a Cartesian expansion; nothing here
// touches a provider or the database, so generating this for a wide window
// (a two-month flexible selection is ~60 candidates × up to 3 durations)
// costs nothing — only a small slice of these is ever actually searched
// (see pickCandidatesToVerify in searchCandidateService.ts).
export function enumerateCandidateSpecs(
  window: CandidateWindow,
  tripType: "round_trip" | "one_way",
  minNights: number | null,
  maxNights: number | null,
): CandidateSpec[] {
  const durations = tripType === "round_trip" ? durationPoints(minNights, maxNights) : [];
  const specs: CandidateSpec[] = [];
  for (let t = window.earliest.getTime(); t <= window.latest.getTime(); t += DAY_MS) {
    const departureDate = new Date(t);
    if (tripType === "one_way") {
      specs.push({ departureDate, returnDate: null });
      continue;
    }
    for (const nights of durations) {
      specs.push({ departureDate, returnDate: new Date(t + nights * DAY_MS) });
    }
  }
  return specs;
}

// Relative fare weight by day of week — Tuesday/Wednesday reliably cheapest,
// Sunday reliably priciest, driven by business travel clustering on
// Sunday/Friday (documented pattern, not FlySmart-specific data). Index
// matches Date#getUTCDay() (0 = Sunday .. 6 = Saturday). Deliberately one
// simple, stated table rather than a fitted model — easy to see why a
// candidate ranked where it did (Product Principle 4: no black-box scoring).
const DAY_OF_WEEK_MULTIPLIER = [1.1, 1.0, 0.9, 0.9, 0.95, 1.05, 1.05];

export function dayOfWeekMultiplier(date: Date): number {
  return DAY_OF_WEEK_MULTIPLIER[date.getUTCDay()];
}

// Whether a trip's window genuinely requires the multi-candidate machinery
// (more than one departure day, or more than one duration point) rather
// than resolving to exactly one candidate — shared by pollService.ts (to
// tag which quota bucket a real search counts against) and tripService.ts
// (to weight the due-list quota trimming), so "what counts as a range
// trip" is defined in exactly one place.
export function isMultiCandidateWindow(
  window: CandidateWindow,
  tripType: "round_trip" | "one_way",
  minNights: number | null,
  maxNights: number | null,
): boolean {
  const spansMultipleDays = window.latest.getTime() > window.earliest.getTime();
  const hasDurationRange = tripType === "round_trip" && durationPoints(minNights, maxNights).length > 1;
  return spansMultipleDays || hasDurationRange;
}

export interface CandidateEstimate {
  estimatedPriceINR: number | null;
  rankScore: number;
}

// The free, no-provider-call Tier-1 signal used to decide which candidates
// are worth spending a real search on first (searchCandidateService.ts).
// `routeHistoryAveragePriceINR` is this route's own plain historical
// average (however many observations already exist for it, from any trip,
// any date) — a real number scaled by the day-of-week pattern above, not a
// fabricated one. With no history yet for a brand-new route, there's
// nothing real to scale, so the estimate stays null and candidates are
// ranked by the day-of-week pattern alone (rankScore is still a valid sort
// key even though it isn't a price).
export function estimateCandidate(
  spec: CandidateSpec,
  routeHistoryAveragePriceINR: number | null,
): CandidateEstimate {
  const departureMultiplier = dayOfWeekMultiplier(spec.departureDate);
  const combinedMultiplier = spec.returnDate
    ? (departureMultiplier + dayOfWeekMultiplier(spec.returnDate)) / 2
    : departureMultiplier;

  if (routeHistoryAveragePriceINR != null) {
    const estimatedPriceINR = Math.round(routeHistoryAveragePriceINR * combinedMultiplier);
    return { estimatedPriceINR, rankScore: estimatedPriceINR };
  }
  return { estimatedPriceINR: null, rankScore: combinedMultiplier };
}
