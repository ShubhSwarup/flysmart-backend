import { describe, test, expect } from "bun:test";
import {
  durationPoints,
  enumerateCandidateSpecs,
  dayOfWeekMultiplier,
  estimateCandidate,
} from "./candidateRanking.js";
import type { CandidateWindow } from "./tripWindow.js";

describe("durationPoints", () => {
  test("collapses to one point when min equals max (a fixed-duration trip)", () => {
    expect(durationPoints(7, 7)).toEqual([7]);
  });

  test("collapses to one point when max is missing or not greater than min", () => {
    expect(durationPoints(7, null)).toEqual([7]);
    expect(durationPoints(7, 5)).toEqual([7]);
  });

  test("returns min, a midpoint, and max for a real range", () => {
    expect(durationPoints(5, 10)).toEqual([5, 8, 10]);
  });

  test("dedupes when the midpoint lands on min or max", () => {
    expect(durationPoints(5, 6)).toEqual([5, 6]); // midpoint rounds to 6 (or 5), still just 2 points
  });

  test("returns no points for a one-way trip's absent duration", () => {
    expect(durationPoints(null, null)).toEqual([]);
  });
});

describe("enumerateCandidateSpecs", () => {
  const window: CandidateWindow = {
    earliest: new Date("2027-03-01T00:00:00.000Z"),
    latest: new Date("2027-03-03T00:00:00.000Z"), // 3 days inclusive
  };

  test("one-way trips get one candidate per departure day, no return date", () => {
    const specs = enumerateCandidateSpecs(window, "one_way", null, null);
    expect(specs).toHaveLength(3);
    expect(specs.every((s) => s.returnDate === null)).toBe(true);
    expect(specs.map((s) => s.departureDate.toISOString().slice(0, 10))).toEqual([
      "2027-03-01",
      "2027-03-02",
      "2027-03-03",
    ]);
  });

  test("round trips get one candidate per (departure day, duration point) pair", () => {
    const specs = enumerateCandidateSpecs(window, "round_trip", 7, 7); // fixed duration -> 1 point
    expect(specs).toHaveLength(3); // 3 days * 1 duration point
    for (const spec of specs) {
      expect(spec.returnDate).not.toBeNull();
      const nights = (spec.returnDate!.getTime() - spec.departureDate.getTime()) / 86_400_000;
      expect(nights).toBe(7);
    }
  });

  test("a real duration range multiplies candidates by the number of duration points", () => {
    const specs = enumerateCandidateSpecs(window, "round_trip", 5, 10); // 3 duration points
    expect(specs).toHaveLength(9); // 3 days * 3 duration points
  });

  test("a single-day window with a fixed duration yields exactly one candidate", () => {
    const singleDay: CandidateWindow = { earliest: window.earliest, latest: window.earliest };
    expect(enumerateCandidateSpecs(singleDay, "round_trip", 7, 7)).toHaveLength(1);
    expect(enumerateCandidateSpecs(singleDay, "one_way", null, null)).toHaveLength(1);
  });

  test("round trips with no resolvable duration produce no candidates at all", () => {
    expect(enumerateCandidateSpecs(window, "round_trip", null, null)).toHaveLength(0);
  });
});

describe("dayOfWeekMultiplier", () => {
  test("Tuesday and Wednesday are weighted cheapest", () => {
    const tuesday = new Date("2027-03-02T00:00:00.000Z"); // known Tuesday
    const wednesday = new Date("2027-03-03T00:00:00.000Z");
    const sunday = new Date("2027-02-28T00:00:00.000Z"); // known Sunday
    expect(dayOfWeekMultiplier(tuesday)).toBeLessThan(dayOfWeekMultiplier(sunday));
    expect(dayOfWeekMultiplier(wednesday)).toBeLessThan(dayOfWeekMultiplier(sunday));
  });

  test("Sunday is weighted as the most expensive day", () => {
    const sunday = new Date("2027-02-28T00:00:00.000Z");
    const allDays = [0, 1, 2, 3, 4, 5, 6].map(
      (offset) => new Date(sunday.getTime() + offset * 86_400_000),
    );
    const sundayWeight = dayOfWeekMultiplier(sunday);
    expect(allDays.every((d) => dayOfWeekMultiplier(d) <= sundayWeight)).toBe(true);
  });
});

describe("estimateCandidate", () => {
  const tuesday = new Date("2027-03-02T00:00:00.000Z");

  test("returns no price estimate when there's no route history yet", () => {
    const result = estimateCandidate({ departureDate: tuesday, returnDate: null }, null);
    expect(result.estimatedPriceINR).toBeNull();
    expect(result.rankScore).toBe(dayOfWeekMultiplier(tuesday));
  });

  test("scales the route's historical average by the day-of-week pattern", () => {
    const result = estimateCandidate({ departureDate: tuesday, returnDate: null }, 40_000);
    const expectedPrice = Math.round(40_000 * dayOfWeekMultiplier(tuesday));
    expect(result.estimatedPriceINR).toBe(expectedPrice);
    expect(result.rankScore).toBe(expectedPrice);
  });

  test("round-trip estimates average the departure and return day-of-week weights", () => {
    const sunday = new Date("2027-02-28T00:00:00.000Z");
    const result = estimateCandidate({ departureDate: tuesday, returnDate: sunday }, 40_000);
    const expectedMultiplier = (dayOfWeekMultiplier(tuesday) + dayOfWeekMultiplier(sunday)) / 2;
    expect(result.estimatedPriceINR).toBe(Math.round(40_000 * expectedMultiplier));
  });

  test("a cheaper-looking day-of-week combination ranks below a pricier one", () => {
    const sunday = new Date("2027-02-28T00:00:00.000Z");
    const cheapLooking = estimateCandidate({ departureDate: tuesday, returnDate: null }, 40_000);
    const pricyLooking = estimateCandidate({ departureDate: sunday, returnDate: null }, 40_000);
    expect(cheapLooking.rankScore).toBeLessThan(pricyLooking.rankScore);
  });
});
