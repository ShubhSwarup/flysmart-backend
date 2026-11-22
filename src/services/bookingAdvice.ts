import type { SearchCoverage } from "./searchCandidateService.js";
import { LONG_LAYOVER_MINUTES } from "./tripConstraints.js";

export type AdviceVerdict =
  | "checking" // nothing solid to judge yet
  | "no_fare" // searched, and nothing fits the trip's rules
  | "good_to_book" // under budget and low for this trip by Google's own record
  | "within_budget" // under budget, nothing special about the price
  | "close_to_budget" // near enough that normal movement could get there
  | "over_budget"
  | "budget_unrealistic"; // even typical fares here are above the budget

export interface BookingAdvice {
  verdict: AdviceVerdict;
  headline: string;
  reasons: string[];
  // Part of the window is still unchecked, so a better date may exist.
  preliminary: boolean;
}

export interface AdviceInput {
  bestPriceINR: number | null;
  confirmed: boolean;
  budgetINR: number;
  coverage: SearchCoverage | null;
  insight: {
    priceLevel?: string | null;
    typicalPriceRangeLow?: number | null;
    typicalPriceRangeHigh?: number | null;
    priceHistory?: { priceINR?: number | null }[];
    airport?: string | null;
    plainRoundTripPriceINR?: number | null;
  } | null;
  // The trip's own best fare at each previous check, oldest first.
  bestPrices: number[];
  longestLayoverMinutes: number;
  daysUntilTravel: number | null;
  openJawReturnAirports: string[];
}

// Under budget by this much of a margin counts as low against the record.
const NEAR_LOW_RATIO = 1.03;
// Fares routinely move this much, so a gap this small is worth waiting on.
const CLOSE_TO_BUDGET_RATIO = 1.15;
const SOON_DAYS = 21;

// Google's insight describes one exact pair of dates. Held against a fare on
// other dates it says nothing — March's price history can't make an April
// fare a good deal — so advice only ever uses an insight that matches.
export function insightCoversDates(
  insight: { departureDate?: Date | null; returnDate?: Date | null } | null | undefined,
  departureDate: Date,
  returnDate: Date | null,
): boolean {
  if (!insight?.departureDate) return false;
  return (
    insight.departureDate.getTime() === departureDate.getTime() &&
    (insight.returnDate?.getTime() ?? null) === (returnDate?.getTime() ?? null)
  );
}

const fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function coverageReason(coverage: SearchCoverage): string | null {
  if (coverage.weeksTotal <= 1 && coverage.datesChecked >= coverage.datesTotal) return null;
  if (coverage.weeksChecked >= coverage.weeksTotal) {
    return `At least one date in every week has been checked (${coverage.datesChecked} of ${coverage.datesTotal} date options).`;
  }
  return `Only ${coverage.weeksChecked} of ${coverage.weeksTotal} weeks checked so far, so a cheaper date may still turn up.`;
}

// The product's one question — book now or keep waiting — answered with the
// numbers behind it (Product Principle 4). Plain thresholds on purpose: there
// is no prediction here, only where today's confirmed fare sits against the
// budget and against what's on record, and the wording never claims more than
// that (Principle 2).
export function buildBookingAdvice(input: AdviceInput): BookingAdvice {
  const { bestPriceINR: price, budgetINR: budget, coverage, insight } = input;
  const preliminary = coverage != null && coverage.weeksChecked < coverage.weeksTotal;
  const coverageNote = coverage ? coverageReason(coverage) : null;
  const withCoverage = (reasons: (string | null)[]) =>
    [...reasons, coverageNote].filter((r): r is string => r != null);

  if (!coverage || coverage.datesChecked === 0) {
    return { verdict: "checking", headline: "Waiting for the first price check", reasons: [], preliminary: true };
  }
  if (price == null) {
    return {
      verdict: "no_fare",
      headline: "Nothing fits your rules on the dates checked so far",
      reasons: withCoverage([
        "Try allowing another stop, or a longer layover, if this continues.",
      ]),
      preliminary,
    };
  }
  if (!input.confirmed) {
    return {
      verdict: "checking",
      headline: "No confirmed fare yet",
      reasons: withCoverage([
        `Google's first quote is ${fmt(price)}, but that price isn't real until a return flight has been matched to it.`,
      ]),
      preliminary: true,
    };
  }

  const history = (insight?.priceHistory ?? [])
    .map((point) => point.priceINR)
    .filter((p): p is number => p != null);
  const historyLow = history.length > 0 ? Math.min(...history) : null;
  const historyHigh = history.length > 0 ? Math.max(...history) : null;
  const typicalLow = insight?.typicalPriceRangeLow ?? null;
  const typicalHigh = insight?.typicalPriceRangeHigh ?? null;
  const scope = insight?.airport ? ` to ${insight.airport}` : "";

  const gap = price - budget;
  const reasons: (string | null)[] = [
    gap <= 0
      ? `${fmt(price)} is ${fmt(-gap)} under your ${fmt(budget)} budget.`
      : `${fmt(price)} is ${fmt(gap)} over your ${fmt(budget)} budget.`,
  ];

  if (typicalLow != null && typicalHigh != null) {
    const position =
      price < typicalLow ? "below" : price > typicalHigh ? "above" : "inside";
    reasons.push(
      `That's ${position} the ${fmt(typicalLow)}–${fmt(typicalHigh)} Google calls typical${scope} for these dates.`,
    );
  }
  if (historyLow != null && historyHigh != null && historyHigh > historyLow) {
    reasons.push(
      `Google's last ${history.length} days for these dates ran ${fmt(historyLow)}–${fmt(historyHigh)}.`,
    );
  }
  if (input.bestPrices.length >= 2) {
    reasons.push(
      `Best fare across your window has ranged ${fmt(Math.min(...input.bestPrices))}–${fmt(Math.max(...input.bestPrices))} over ${input.bestPrices.length} checks.`,
    );
  }

  const plainPrice = insight?.plainRoundTripPriceINR ?? null;
  const openJawExtra = plainPrice != null ? price - plainPrice : 0;
  if (plainPrice != null && openJawExtra > 0) {
    const from = input.openJawReturnAirports.join("/");
    reasons.push(
      `Flying home from ${from} looks like it costs about ${fmt(openJawExtra)} more: the same dates as a normal round trip${scope} are around ${fmt(plainPrice)}.`,
    );
  }
  if (input.longestLayoverMinutes >= LONG_LAYOVER_MINUTES) {
    reasons.push(`This fare includes a ${Math.round(input.longestLayoverMinutes / 60)}h layover.`);
  }
  if (input.daysUntilTravel != null && input.daysUntilTravel <= SOON_DAYS) {
    reasons.push(`Your travel window opens in ${input.daysUntilTravel} days.`);
  }

  const isLowOnRecord =
    insight?.priceLevel === "low" || (historyLow != null && price <= historyLow * NEAR_LOW_RATIO);
  const budgetEverPlausible =
    (historyLow != null && historyLow <= budget) || (typicalLow != null && typicalLow <= budget);

  if (gap <= 0) {
    return isLowOnRecord
      ? { verdict: "good_to_book", headline: "Good price, under budget", reasons: withCoverage(reasons), preliminary }
      : { verdict: "within_budget", headline: "Under budget", reasons: withCoverage(reasons), preliminary };
  }
  if (price <= budget * CLOSE_TO_BUDGET_RATIO) {
    return { verdict: "close_to_budget", headline: "Close to budget, worth watching", reasons: withCoverage(reasons), preliminary };
  }
  if (typicalLow != null && !budgetEverPlausible) {
    return { verdict: "budget_unrealistic", headline: "Budget looks too low for this route", reasons: withCoverage(reasons), preliminary };
  }
  return { verdict: "over_budget", headline: "Over budget", reasons: withCoverage(reasons), preliminary };
}
