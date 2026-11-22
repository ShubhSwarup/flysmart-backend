import { describe, test, expect } from "bun:test";
import { withinTripConstraints, rankFares } from "./tripConstraints.js";

describe("withinTripConstraints", () => {
  test("no constraints set — everything passes", () => {
    expect(
      withinTripConstraints(
        { maxStops: null, maxLayoverMinutes: null },
        { stops: 2, layoverMinutes: [500, 500] },
      ),
    ).toBe(true);
  });

  test("rejects itineraries with more stops than maxStops", () => {
    expect(
      withinTripConstraints({ maxStops: 1, maxLayoverMinutes: null }, { stops: 2, layoverMinutes: [60, 60] }),
    ).toBe(false);
  });

  test("accepts itineraries with stops at or under maxStops", () => {
    expect(
      withinTripConstraints({ maxStops: 1, maxLayoverMinutes: null }, { stops: 1, layoverMinutes: [90] }),
    ).toBe(true);
    expect(
      withinTripConstraints({ maxStops: 1, maxLayoverMinutes: null }, { stops: 0, layoverMinutes: [] }),
    ).toBe(true);
  });

  test("nonstop itineraries always pass the layover check, regardless of maxLayoverMinutes", () => {
    expect(
      withinTripConstraints({ maxStops: null, maxLayoverMinutes: 60 }, { stops: 0, layoverMinutes: [] }),
    ).toBe(true);
  });

  test("rejects itineraries whose longest layover exceeds maxLayoverMinutes", () => {
    expect(
      withinTripConstraints({ maxStops: null, maxLayoverMinutes: 120 }, { stops: 1, layoverMinutes: [150] }),
    ).toBe(false);
  });

  test("accepts itineraries whose layovers are all within maxLayoverMinutes", () => {
    expect(
      withinTripConstraints(
        { maxStops: null, maxLayoverMinutes: 120 },
        { stops: 2, layoverMinutes: [90, 100] },
      ),
    ).toBe(true);
  });

  test("applies both constraints together", () => {
    const trip = { maxStops: 1, maxLayoverMinutes: 120 };
    expect(withinTripConstraints(trip, { stops: 1, layoverMinutes: [90] })).toBe(true);
    expect(withinTripConstraints(trip, { stops: 1, layoverMinutes: [150] })).toBe(false);
    expect(withinTripConstraints(trip, { stops: 2, layoverMinutes: [50, 50] })).toBe(false);
  });
});

describe("rankFares", () => {
  test("puts the cheapest fare first when journeys are comparable", () => {
    const fares = [
      { price: 70000, durationMinutes: 800 },
      { price: 60000, durationMinutes: 800 },
    ];
    expect(rankFares(fares)[0].price).toBe(60000);
  });

  test("won't headline a 22-hour layover to save a few hundred rupees", () => {
    // The real BOM-NRT case: Philippine Airlines ₹64,089 vs Cathay ₹64,412.
    const fares = [
      { price: 64089, durationMinutes: 2025 },
      { price: 64412, durationMinutes: 785 },
    ];
    expect(rankFares(fares)[0].price).toBe(64412);
  });

  test("keeps a long journey first when it saves real money", () => {
    const fares = [
      { price: 56999, durationMinutes: 2025 },
      { price: 70113, durationMinutes: 475 },
    ];
    expect(rankFares(fares)[0].price).toBe(56999);
  });

  test("breaks an exact price tie with the shorter journey", () => {
    const fares = [
      { price: 77934, durationMinutes: 2170 },
      { price: 77934, durationMinutes: 1080 },
    ];
    expect(rankFares(fares)[0].durationMinutes).toBe(1080);
  });

  test("returns every fare exactly once, and copes with none", () => {
    const fares = [
      { price: 64089, durationMinutes: 2025 },
      { price: 64412, durationMinutes: 785 },
      { price: 90000, durationMinutes: 500 },
    ];
    expect(rankFares(fares)).toHaveLength(3);
    expect(new Set(rankFares(fares)).size).toBe(3);
    expect(rankFares([])).toEqual([]);
  });
});
