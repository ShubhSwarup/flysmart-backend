import { describe, test, expect } from "bun:test";
import { buildBookingAdvice, insightCoversDates, type AdviceInput } from "./bookingAdvice.js";

const fullCoverage = { datesChecked: 40, datesTotal: 183, weeksChecked: 9, weeksTotal: 9 };

function input(overrides: Partial<AdviceInput> = {}): AdviceInput {
  return {
    bestPriceINR: 50000,
    confirmed: true,
    budgetINR: 60000,
    coverage: fullCoverage,
    insight: null,
    bestPrices: [],
    longestLayoverMinutes: 0,
    daysUntilTravel: 100,
    openJawReturnAirports: [],
    ...overrides,
  };
}

const text = (advice: { reasons: string[] }) => advice.reasons.join(" ");

describe("buildBookingAdvice", () => {
  test("says it's still waiting before anything has been searched", () => {
    const advice = buildBookingAdvice(
      input({ bestPriceINR: null, coverage: { datesChecked: 0, datesTotal: 31, weeksChecked: 0, weeksTotal: 5 } }),
    );
    expect(advice.verdict).toBe("checking");
  });

  test("never judges an unconfirmed price, however tempting", () => {
    const advice = buildBookingAdvice(input({ bestPriceINR: 20000, confirmed: false }));
    expect(advice.verdict).toBe("checking");
    expect(text(advice)).toContain("₹20,000");
    expect(text(advice)).toContain("isn't real");
  });

  test("says so when dates were searched and nothing fits", () => {
    expect(buildBookingAdvice(input({ bestPriceINR: null })).verdict).toBe("no_fare");
  });

  test("calls a good price only when the record backs it up", () => {
    const nearLow = { priceHistory: [{ priceINR: 49500 }, { priceINR: 58000 }] };
    expect(buildBookingAdvice(input({ insight: nearLow })).verdict).toBe("good_to_book");
    expect(buildBookingAdvice(input({ insight: { priceLevel: "low" } })).verdict).toBe("good_to_book");
    const notNearLow = { priceHistory: [{ priceINR: 40000 }, { priceINR: 58000 }] };
    expect(buildBookingAdvice(input({ insight: notNearLow })).verdict).toBe("within_budget");
    expect(buildBookingAdvice(input()).verdict).toBe("within_budget");
  });

  test("the Japan case: a little over budget and Google has seen lower", () => {
    const advice = buildBookingAdvice(
      input({
        bestPriceINR: 68279,
        insight: {
          priceLevel: "typical",
          typicalPriceRangeLow: 53000,
          typicalPriceRangeHigh: 89000,
          priceHistory: [{ priceINR: 58985 }, { priceINR: 68674 }],
          airport: "NRT",
        },
      }),
    );
    expect(advice.verdict).toBe("close_to_budget");
    expect(text(advice)).toContain("₹8,279 over");
    expect(text(advice)).toContain("₹53,000–₹89,000");
    expect(text(advice)).toContain("to NRT");
    expect(text(advice)).toContain("₹58,985–₹68,674");
  });

  test("the Vietnam case: names the open-jaw as what's costing the money", () => {
    const advice = buildBookingAdvice(
      input({
        bestPriceINR: 56761,
        budgetINR: 30000,
        insight: {
          typicalPriceRangeLow: 24000,
          typicalPriceRangeHigh: 34000,
          airport: "HAN",
          plainRoundTripPriceINR: 32233,
        },
        openJawReturnAirports: ["PQC"],
      }),
    );
    expect(advice.verdict).toBe("over_budget");
    expect(text(advice)).toContain("from PQC");
    expect(text(advice)).toContain("₹24,528");
    expect(text(advice)).toContain("₹32,233");
  });

  test("says when a budget is below what the route normally costs", () => {
    const advice = buildBookingAdvice(
      input({
        bestPriceINR: 80000,
        budgetINR: 40000,
        insight: { typicalPriceRangeLow: 60000, typicalPriceRangeHigh: 90000, priceHistory: [{ priceINR: 62000 }] },
      }),
    );
    expect(advice.verdict).toBe("budget_unrealistic");
  });

  test("doesn't call a budget unrealistic without evidence", () => {
    expect(buildBookingAdvice(input({ bestPriceINR: 90000 })).verdict).toBe("over_budget");
  });

  test("flags a partial scan, whatever the verdict", () => {
    const partial = { datesChecked: 3, datesTotal: 183, weeksChecked: 1, weeksTotal: 9 };
    const advice = buildBookingAdvice(input({ coverage: partial }));
    expect(advice.preliminary).toBe(true);
    expect(text(advice)).toContain("1 of 9 weeks");
  });

  test("a finished scan isn't preliminary", () => {
    expect(buildBookingAdvice(input()).preliminary).toBe(false);
  });

  test("doesn't mention coverage for a single exact date", () => {
    const single = { datesChecked: 1, datesTotal: 1, weeksChecked: 1, weeksTotal: 1 };
    expect(text(buildBookingAdvice(input({ coverage: single })))).not.toContain("week");
  });

  test("mentions a long layover and an approaching window", () => {
    const advice = buildBookingAdvice(input({ longestLayoverMinutes: 1345, daysUntilTravel: 10 }));
    expect(text(advice)).toContain("22h layover");
    expect(text(advice)).toContain("opens in 10 days");
  });
});

describe("insightCoversDates", () => {
  const march3 = new Date("2027-03-03");
  const march17 = new Date("2027-03-17");
  const april13 = new Date("2027-04-13");

  test("matches the exact dates the insight was fetched for", () => {
    expect(insightCoversDates({ departureDate: march3, returnDate: march17 }, march3, march17)).toBe(true);
    expect(insightCoversDates({ departureDate: march3, returnDate: null }, march3, null)).toBe(true);
  });

  test("won't let March's history judge an April fare", () => {
    expect(insightCoversDates({ departureDate: march3, returnDate: march17 }, april13, null)).toBe(false);
  });

  test("a different stay on the same departure is a different search", () => {
    expect(insightCoversDates({ departureDate: march3, returnDate: march17 }, march3, april13)).toBe(false);
  });

  test("has nothing to match on an insight with no dates", () => {
    expect(insightCoversDates({ departureDate: null }, march3, null)).toBe(false);
    expect(insightCoversDates(null, march3, null)).toBe(false);
  });
});
