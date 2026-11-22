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

export interface PickableCandidate {
  id: string;
  departureDate: Date;
  returnDate: Date | null;
  verified: boolean;
  rankScore: number;
  lastCheckedAt: Date | null;
  // The best price known for this date pair, lead or confirmed. Null if it
  // hasn't been priced, or the search found nothing usable.
  priceINR: number | null;
}

export function weekIndex(date: Date, windowStart: Date): number {
  return Math.floor((date.getTime() - windowStart.getTime()) / (7 * DAY_MS));
}

function nightsOf(candidate: PickableCandidate): number | null {
  if (!candidate.returnDate) return null;
  return Math.round((candidate.returnDate.getTime() - candidate.departureDate.getTime()) / DAY_MS);
}

// Which dates get a real search this cycle. Fares vary far more by week than
// by weekday (BOM-HAN was ₹77,498 on 2 Feb and ₹42,765 on 9 Feb, either side
// of Tet), so the search budget goes on seeing the whole window first:
//
//   1. The current best, if not already checked today — the number a person
//      books on has to be fresh.
//   2. Coverage: one date from each unseen week, starting with whichever is
//      furthest from anything seen, so a partial scan is spread across the
//      window and not bunched at its start.
//   3. Refinement: other dates in the cheapest weeks.
//   4. Refresh: the longest-unchecked dates.
//
// Within a week the day-of-week ranking still picks the likely-cheapest day.
// Stay length rotates week to week, so a range like 8-14 nights gets tried
// across the board rather than whichever length happens to rank best.
export function chooseCandidatesToVerify(
  candidates: PickableCandidate[],
  windowStart: Date,
  limit: number,
  bestId: string | null,
  now: Date = new Date(),
): PickableCandidate[] {
  const picks: PickableCandidate[] = [];
  const picked = new Set<string>();
  const pick = (candidate: PickableCandidate) => {
    picks.push(candidate);
    picked.add(candidate.id);
  };

  const best = bestId ? candidates.find((c) => c.id === bestId) : undefined;
  const checkedToday = (c: PickableCandidate) =>
    c.lastCheckedAt != null && now.getTime() - c.lastCheckedAt.getTime() < DAY_MS / 2;
  if (best && !checkedToday(best)) pick(best);

  const byWeek = new Map<number, PickableCandidate[]>();
  for (const candidate of candidates) {
    const week = weekIndex(candidate.departureDate, windowStart);
    byWeek.set(week, [...(byWeek.get(week) ?? []), candidate]);
  }
  const allNights = [...new Set(candidates.map(nightsOf))].sort((a, b) => (a ?? 0) - (b ?? 0));

  const pickFromWeek = (week: number): boolean => {
    const options = (byWeek.get(week) ?? []).filter((c) => !c.verified && !picked.has(c.id));
    if (options.length === 0) return false;
    const preferredNights = allNights[week % allNights.length];
    const matching = options.filter((c) => nightsOf(c) === preferredNights);
    const pool = matching.length > 0 ? matching : options;
    pick(pool.reduce((a, b) => (b.rankScore < a.rankScore ? b : a)));
    return true;
  };

  const seenWeeks = new Set(
    [...byWeek.entries()].filter(([, cs]) => cs.some((c) => c.verified)).map(([week]) => week),
  );
  if (best) seenWeeks.add(weekIndex(best.departureDate, windowStart));
  const unseenWeeks = new Set([...byWeek.keys()].filter((week) => !seenWeeks.has(week)));

  const distanceToSeen = (week: number) =>
    seenWeeks.size === 0
      ? -week // nothing seen yet — simply start from the front of the window
      : Math.min(...[...seenWeeks].map((seen) => Math.abs(seen - week)));

  while (picks.length < limit && unseenWeeks.size > 0) {
    const next = [...unseenWeeks].reduce((a, b) => (distanceToSeen(b) > distanceToSeen(a) ? b : a));
    unseenWeeks.delete(next);
    seenWeeks.add(next);
    pickFromWeek(next);
  }

  const cheapestInWeek = (week: number) =>
    Math.min(...(byWeek.get(week) ?? []).map((c) => c.priceINR ?? Infinity));
  const weeksByPrice = [...byWeek.keys()].sort((a, b) => cheapestInWeek(a) - cheapestInWeek(b));
  while (picks.length < limit) {
    if (!weeksByPrice.some(pickFromWeek)) break;
  }

  const stalest = candidates
    .filter((c) => !picked.has(c.id) && c.verified)
    .sort((a, b) => (a.lastCheckedAt?.getTime() ?? 0) - (b.lastCheckedAt?.getTime() ?? 0));
  for (const candidate of stalest) {
    if (picks.length >= limit) break;
    pick(candidate);
  }

  return picks;
}

export interface ConfirmableDate<L> {
  id: string;
  leads: L[];
}

// The order to spend return-flight lookups in. A date's quotes can all be
// misleading together (on 27 Apr ₹46,064 was really ₹2,23,124), and a cheap
// quote says little about another date's plain ₹70,113 nonstop, so dates take
// turns: every date's cheapest quote comes before any date's second try, the
// current best's first of all. Within a date only one lead per airline is
// worth a lookup, since an airline's outbound flights tend to pair with the
// same return and come to the same total.
export function orderLeadsForConfirmation<L extends { priceINR: number; airlines: string[] }>(
  dates: ConfirmableDate<L>[],
  currentBestId: string | null,
): { id: string; lead: L }[] {
  const perDate = dates.map(({ id, leads }) => {
    const seenCarriers = new Set<string>();
    const distinct = [...leads]
      .sort((a, b) => a.priceINR - b.priceINR)
      .filter((lead) => {
        const carriers = lead.airlines.join("/");
        if (seenCarriers.has(carriers)) return false;
        seenCarriers.add(carriers);
        return true;
      });
    return { id, distinct };
  });

  const ordered: { id: string; lead: L }[] = [];
  const longest = Math.max(0, ...perDate.map((date) => date.distinct.length));
  for (let round = 0; round < longest; round++) {
    const turn = perDate
      .filter((date) => date.distinct[round])
      .map((date) => ({ id: date.id, lead: date.distinct[round] }))
      .sort(
        (a, b) =>
          Number(b.id === currentBestId && round === 0) - Number(a.id === currentBestId && round === 0) ||
          a.lead.priceINR - b.lead.priceINR,
      );
    ordered.push(...turn);
  }
  return ordered;
}
