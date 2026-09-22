const DAY_MS = 86_400_000;
const DEFAULT_MAX_OPTIONS = 4;

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function dayKey(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysInclusive(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

export interface WindowOption {
  start: Date;
  end: Date; // inclusive
  leaveDaysUsed: number;
  totalDaysOff: number;
  // Whether one of the trip's declared days off falls exactly on this
  // option's first or last day (i.e. is used as a travel day) rather than
  // resting safely inside the window — the flag the "skips the holiday
  // itself" insight is built on.
  anchorIsBoundary: boolean;
  // False only when a requested minNights couldn't be reached even at
  // SAFETY_CAP_LEAVE — the option shown is the closest we got, not a full
  // match, and describeOptions says so rather than presenting it as if it
  // satisfied the request.
  reachedTarget: boolean;
}

interface ComputeInput {
  anchors: Date[]; // this trip's selected days off — at least one
  leaveBudget: number;
  ambientFreeDates: Date[]; // every saved day off, including but not limited to `anchors`
  minNights?: number | null;
  maxNights?: number | null;
  maxOptions?: number;
}

export interface DaysOffPreview {
  bridged: boolean; // false when anchors were too far apart and got treated separately
  options: WindowOption[];
}

function buildIsFree(ambientFreeDates: Date[]): (date: Date) => boolean {
  const freeKeys = new Set(ambientFreeDates.map(dayKey));
  return (date: Date) => isWeekend(date) || freeKeys.has(dayKey(date));
}

// Extends `boundary` outward (backward or forward) by spending up to
// `budget` leave days — a free day in the way costs nothing and is always
// taken; a work day costs one leave day. Greedy, not exhaustive search: for
// the small budgets this feature deals with (a handful of leave days), the
// cheapest-first greedy extension is exactly the bridge-day strategy PTO
// planning tools use, and is trivially fast regardless of window size.
function extendWithLeave(
  boundary: Date,
  direction: "backward" | "forward",
  isFree: (d: Date) => boolean,
  budget: number,
): { boundary: Date; leaveSpent: number } {
  let current = boundary;
  let leaveSpent = 0;
  const step = direction === "backward" ? -1 : 1;
  while (true) {
    const next = addDays(current, step);
    const cost = isFree(next) ? 0 : 1;
    if (leaveSpent + cost > budget) break;
    current = next;
    leaveSpent += cost;
  }
  return { boundary: current, leaveSpent };
}

// The inverse of extendWithLeave: instead of "spend up to this much leave,
// see how far it goes," this asks "how much leave does it actually take to
// reach this length" — capped at SAFETY_CAP_LEAVE so an unreasonable
// request doesn't extend forever. This is the fix for the core bug: a
// requested trip length must never be silently abandoned just because the
// leave budget the user happened to pick wasn't enough — the true cost
// gets computed and reported instead.
function countNonFreeDays(start: Date, end: Date, isFree: (d: Date) => boolean): number {
  let count = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    if (!isFree(new Date(t))) count++;
  }
  return count;
}

// The actual fix for "the combination isn't good": reaching a target
// length by extending purely backward or purely forward (the two
// extremes) can silently skip a cheaper option in between. Two anchors
// sitting mid-week with a workday on both sides before the nearest weekend
// is exactly the case where it matters — extending only one way "spends"
// every day between here and there, while a balanced extension can pick up
// a free weekend on *both* sides instead of just one. This tries every
// possible split between backward and forward and keeps whichever is
// actually cheapest, rather than assuming one of the two extremes must be
// it. The search space is only `targetTotalDays - baseLength` splits, so
// this is trivially fast at the scale this feature deals with.
//
// Search width is capped at MAX_EXTRA_DAYS_SEARCH for sanity, but this
// never goes silent the way an earlier version of this logic did: if the
// full request is further than that cap, it still returns the best window
// it found within the cap, flagged as not having fully reached the target,
// rather than returning nothing.
const MAX_EXTRA_DAYS_SEARCH = 60;

function bestWindowForLength(
  baseStart: Date,
  baseEnd: Date,
  isFree: (d: Date) => boolean,
  targetTotalDays: number,
): { start: Date; end: Date; leaveSpent: number; reached: boolean } {
  const baseLength = daysInclusive(baseStart, baseEnd);
  const rawExtraDays = targetTotalDays - baseLength;
  if (rawExtraDays <= 0) {
    return {
      start: baseStart,
      end: baseEnd,
      leaveSpent: countNonFreeDays(baseStart, baseEnd, isFree),
      reached: true,
    };
  }
  const extraDays = Math.min(rawExtraDays, MAX_EXTRA_DAYS_SEARCH);

  let best: { start: Date; end: Date; leaveSpent: number } | null = null;
  for (let back = 0; back <= extraDays; back++) {
    const forward = extraDays - back;
    const start = addDays(baseStart, -back);
    const end = addDays(baseEnd, forward);
    const leaveSpent = countNonFreeDays(start, end, isFree);
    if (!best || leaveSpent < best.leaveSpent) best = { start, end, leaveSpent };
  }
  return { ...best!, reached: extraDays === rawExtraDays };
}

function withinDesiredLength(nights: number, minNights?: number | null, maxNights?: number | null): boolean {
  if (minNights != null && nights < minNights) return false;
  if (maxNights != null && nights > maxNights) return false;
  return true;
}

function toOption(
  start: Date,
  end: Date,
  leaveDaysUsed: number,
  anchors: Date[],
  reachedTarget = true,
): WindowOption {
  return {
    start,
    end,
    leaveDaysUsed,
    totalDaysOff: daysInclusive(start, end),
    anchorIsBoundary: anchors.some((a) => sameDay(a, start) || sameDay(a, end)),
    reachedTarget,
  };
}

// Which exact night-counts to try between a requested min and max — every
// value when the range is small enough to enumerate outright (this is one
// anchor at a time, not the many-departure-dates matrix the main
// flight-search engine has to sample down for; "7 to 12 nights" is only 6
// values, nowhere near enough to need thinning), falling back to an evenly
// spaced sample capped at 6 points for an unusually wide request so this
// can't explode for something like "5 to 30 nights."
function nightCountsToTry(minNights: number, maxNights: number): number[] {
  const span = maxNights - minNights;
  if (span <= 6) {
    return Array.from({ length: span + 1 }, (_, i) => minNights + i);
  }
  const steps = 5;
  const points = new Set<number>();
  for (let i = 0; i <= steps; i++) points.add(Math.round(minNights + (span * i) / steps));
  return [...points].sort((a, b) => a - b);
}

// Given a base [start, end] span and an optional desired length range,
// appends whatever additional options are needed to actually cover that
// range — every reachable night-count in it (see nightCountsToTry), each
// tried in both directions, always reporting the true leave cost regardless
// of the nominal leaveBudget. If no minimum is requested, falls back to
// exploring outward using the stated leaveBudget instead, for variety.
function addLengthDrivenOptions(
  options: WindowOption[],
  start: Date,
  end: Date,
  baseLeave: number,
  anchors: Date[],
  isFree: (d: Date) => boolean,
  leaveBudget: number,
  minNights: number | null | undefined,
  maxNights: number | null | undefined,
): void {
  const base = options[0];

  if (minNights != null) {
    const nightsToTry = nightCountsToTry(minNights, maxNights ?? minNights);
    for (const nights of nightsToTry) {
      const targetTotalDays = nights + 1;
      if (base.totalDaysOff >= targetTotalDays) continue; // already covered for free
      // The actual cheapest way to reach this length — tried across every
      // possible backward/forward split, not just "spend everything on one
      // side" (see bestWindowForLength for why that can miss a cheaper,
      // balanced option that picks up a free stretch on both sides).
      const best = bestWindowForLength(start, end, isFree, targetTotalDays);
      options.push(toOption(best.start, best.end, best.leaveSpent, anchors, best.reached));
    }
    return;
  }

  const extraBudget = leaveBudget - baseLeave;
  if (extraBudget > 0) {
    const back = extendWithLeave(start, "backward", isFree, extraBudget);
    const fwd = extendWithLeave(end, "forward", isFree, extraBudget);
    options.push(toOption(back.boundary, end, baseLeave + back.leaveSpent, anchors));
    options.push(toOption(start, fwd.boundary, baseLeave + fwd.leaveSpent, anchors));
  }
}

// The core calculator: given the day(s) off a trip is built around, an
// extra-leave ceiling, and every day the user already has free, produces a
// small set of genuinely different realistic windows — never a single
// "optimal" answer, since which one is actually best depends on flight
// prices this function has no access to (searchCandidateService.ts's
// existing Tier-1 ranking is what eventually decides that, once a chosen
// option becomes a real trip). Multiple anchors too far apart to plausibly
// combine within the leave budget fall back to separate per-anchor results
// rather than forcing an unrealistic combined window.
//
// A requested minNights/maxNights is treated as the authoritative goal: if
// reaching it needs more leave than `leaveBudget`, that's computed and
// shown anyway (flagged in describeOptions), rather than silently handing
// back whatever the stated budget alone could reach.
export function computeWindowOptions(input: ComputeInput): DaysOffPreview {
  const { leaveBudget, ambientFreeDates, minNights, maxNights } = input;
  // A plain "show at most 4" default would quietly re-crop exactly the
  // night-count variety addLengthDrivenOptions was just asked to generate
  // (e.g. 7-12 nights -> 6 distinct lengths x 2 directions) — when a
  // desired length range is given, size the default to actually fit it,
  // rather than capping it back down to something smaller than the range
  // itself calls for.
  const maxOptions =
    input.maxOptions ??
    (minNights != null ? nightCountsToTry(minNights, maxNights ?? minNights).length * 2 + 1 : DEFAULT_MAX_OPTIONS);
  const anchors = [...input.anchors].sort((a, b) => a.getTime() - b.getTime());
  if (anchors.length === 0) return { bridged: true, options: [] };

  const isFree = buildIsFree(ambientFreeDates);

  if (anchors.length > 1) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    let workDaysBetween = 0;
    for (let t = first.getTime() + DAY_MS; t < last.getTime(); t += DAY_MS) {
      if (!isFree(new Date(t))) workDaysBetween++;
    }
    if (workDaysBetween > leaveBudget) {
      // Too far apart to bridge — treat as independent trip ideas, one full
      // set of options per anchor (each sized to its own requested length
      // range via the same default computed above — deliberately not
      // divided across anchors or re-capped down to one shared
      // `maxOptions`), rather than forcing a combined window that would
      // cost far more leave than budgeted. A single "lowest leave cost
      // wins" cap across every anchor combined can silently squeeze an
      // entire anchor's options out of the result (two anchors that need
      // less leave crowding out a third that needs slightly more), even
      // though every one of them was explicitly selected — every anchor
      // must be represented, in full, and the total count can run higher
      // than a single-anchor call's default instead.
      const perAnchor = anchors.flatMap(
        (anchor) => computeWindowOptions({ ...input, anchors: [anchor] }).options,
      );
      return { bridged: false, options: dedupe(perAnchor) };
    }

    // Bridging is affordable — the base connected span costs exactly
    // workDaysBetween leave days, extended through any immediately
    // adjacent free days on either side at no further cost.
    let start = first;
    let end = last;
    while (isFree(addDays(start, -1))) start = addDays(start, -1);
    while (isFree(addDays(end, 1))) end = addDays(end, 1);

    const options: WindowOption[] = [toOption(start, end, workDaysBetween, anchors)];
    addLengthDrivenOptions(options, start, end, workDaysBetween, anchors, isFree, leaveBudget, minNights, maxNights);
    return { bridged: true, options: finalize(options, minNights, maxNights, maxOptions) };
  }

  // Single anchor — the common case.
  const anchor = anchors[0];
  let start = anchor;
  let end = anchor;
  while (isFree(addDays(start, -1))) start = addDays(start, -1);
  while (isFree(addDays(end, 1))) end = addDays(end, 1);

  const options: WindowOption[] = [toOption(start, end, 0, anchors)];
  addLengthDrivenOptions(options, start, end, 0, anchors, isFree, leaveBudget, minNights, maxNights);
  return { bridged: true, options: finalize(options, minNights, maxNights, maxOptions) };
}

function dedupe(options: WindowOption[]): WindowOption[] {
  const seen = new Set<string>();
  const deduped = options.filter((o) => {
    const key = `${dayKey(o.start)}-${dayKey(o.end)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.leaveDaysUsed - b.leaveDaysUsed);
  return deduped;
}

function dedupeAndCap(options: WindowOption[], maxOptions: number): WindowOption[] {
  return dedupe(options).slice(0, maxOptions);
}

function finalize(
  options: WindowOption[],
  minNights: number | null | undefined,
  maxNights: number | null | undefined,
  maxOptions: number,
): WindowOption[] {
  const deduped = dedupeAndCap(options, options.length); // dedupe first, cap after length filtering
  const withinLength = deduped.filter((o) => withinDesiredLength(o.totalDaysOff - 1, minNights, maxNights));
  // Prefer results that actually match the requested length; only fall
  // back to every computed option (still real, just not the length asked
  // for) when nothing fits — never return nothing when something exists.
  const chosen = withinLength.length > 0 ? withinLength : deduped;
  return chosen.slice(0, maxOptions);
}

export interface DescribedOption {
  departureDate: string; // ISO date (YYYY-MM-DD)
  returnDate: string;
  nights: number;
  leaveDaysUsed: number;
  note: string;
}

// The one piece of plain-language "why this option" text — kept
// server-side so the frontend only ever renders what's given it, never
// re-derives insight logic of its own (Section E's "explainable, not a
// black box" principle applied to Days Off specifically).
//
// `leaveBudget` is passed through purely to flag when an option needed
// more leave than the user said they'd consider — never to hide or cap
// the option itself, which would reintroduce the silent-shortfall bug
// this function exists to prevent.
export function describeOptions(
  preview: DaysOffPreview,
  anchors: Date[],
  context?: { leaveBudget?: number; minNights?: number | null },
): DescribedOption[] {
  const maxLeave = Math.max(0, ...preview.options.map((o) => o.leaveDaysUsed));
  return preview.options.map((option) => {
    const nights = option.totalDaysOff - 1;
    // totalDaysOff already counts every day in the span; leaveDaysUsed only
    // ever counted the ones that weren't already free (a weekend, or any
    // other saved day off that happens to fall inside the span) — so the
    // remainder is exactly how many days needed no leave at all. Leading
    // with this breakdown is the direct fix for "needs 7 more leave days"
    // reading as if the whole trip cost 7 days of leave, when several of
    // those days were weekends the calculation had already excluded.
    const alreadyFreeDays = option.totalDaysOff - option.leaveDaysUsed;
    const exceedsBudget = context?.leaveBudget != null && option.leaveDaysUsed > context.leaveBudget;

    // Built as short, separate sentences rather than one line with nested
    // parentheticals stacked on top of each other — each sentence answers
    // exactly one question (how much leave, why this shape, how it compares
    // to what you said you'd consider), so it reads in order instead of
    // needing to be unpacked.
    const sentences: string[] = [];

    if (option.leaveDaysUsed === 0) {
      sentences.push("No extra leave needed — every day is already a weekend or a saved day off.");
    } else {
      sentences.push(
        `Needs ${option.leaveDaysUsed} leave day${option.leaveDaysUsed === 1 ? "" : "s"} — the other ${alreadyFreeDays} day${alreadyFreeDays === 1 ? "" : "s"} ${alreadyFreeDays === 1 ? "is" : "are"} already a weekend or a saved day off.`,
      );
    }

    if (!option.anchorIsBoundary) {
      const buried = anchors.find((a) => a.getTime() >= option.start.getTime() && a.getTime() <= option.end.getTime());
      const dayName = buried
        ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(buried)
        : "your day off";
      sentences.push(`Skips ${dayName} itself, since fares typically spike that day.`);
    } else if (option.leaveDaysUsed === maxLeave && maxLeave > 0) {
      // Only ever true when it's actually true — "within your leave
      // budget" must never appear in the same breath as "needs more leave
      // than you set", which used to be a direct, visible contradiction.
      sentences.push(
        exceedsBudget
          ? "The longest of the options shown here."
          : "The longest option within your leave budget.",
      );
    }

    if (exceedsBudget) {
      const over = option.leaveDaysUsed - context!.leaveBudget!;
      sentences.push(
        `That's ${over} more leave day${over === 1 ? "" : "s"} than the ${context!.leaveBudget} you set aside.`,
      );
    }

    let note = sentences.join(" ");
    if (!option.reachedTarget) {
      note = `Closest we could get without an unusual amount of leave. ${note}`;
    }

    return {
      departureDate: option.start.toISOString().slice(0, 10),
      returnDate: option.end.toISOString().slice(0, 10),
      nights,
      leaveDaysUsed: option.leaveDaysUsed,
      note,
    };
  });
}
