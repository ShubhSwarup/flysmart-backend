import { describe, test, expect } from "bun:test";
import { withinTripConstraints } from "./tripConstraints.js";

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
