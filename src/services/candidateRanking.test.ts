import { describe, test, expect } from "bun:test";
import {
  durationPoints,
  enumerateCandidateSpecs,
  dayOfWeekMultiplier,
  estimateCandidate,
  chooseCandidatesToVerify,
  orderLeadsForConfirmation,
  type PickableCandidate,
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

describe("chooseCandidatesToVerify", () => {
  const DAY = 86_400_000;
  const start = new Date("2027-03-01T00:00:00Z");
  const now = new Date("2026-11-02T00:00:00Z");

  // A Mar-Apr window with 8/11/14-night stays — the real Japan trip's shape.
  function window(days = 61, nights: (number | null)[] = [8, 11, 14]): PickableCandidate[] {
    const candidates: PickableCandidate[] = [];
    for (let d = 0; d < days; d++) {
      for (const n of nights) {
        const departureDate = new Date(start.getTime() + d * DAY);
        const returnDate = n == null ? null : new Date(departureDate.getTime() + n * DAY);
        candidates.push({
          id: `${d}-${n}`,
          departureDate,
          returnDate,
          verified: false,
          rankScore: 1 + (departureDate.getUTCDay() % 3) / 10,
          lastCheckedAt: null,
          priceINR: null,
        });
      }
    }
    return candidates;
  }

  function markChecked(c: PickableCandidate, priceINR: number | null, checkedAt = now): PickableCandidate {
    return { ...c, verified: true, priceINR, lastCheckedAt: new Date(checkedAt.getTime() - 2 * DAY) };
  }

  const weekOf = (c: PickableCandidate) => Math.floor((c.departureDate.getTime() - start.getTime()) / (7 * DAY));

  test("a first pass reaches both ends of the window, not just its first week", () => {
    const picks = chooseCandidatesToVerify(window(), start, 3, null, now);
    const weeks = picks.map(weekOf);
    expect(new Set(weeks).size).toBe(3);
    expect(Math.max(...weeks) - Math.min(...weeks)).toBeGreaterThanOrEqual(6);
  });

  test("sees every week of the window before repeating one", () => {
    let candidates = window();
    const totalWeeks = new Set(candidates.map(weekOf)).size;
    const seen = new Set<number>();
    for (let cycle = 0; cycle < Math.ceil(totalWeeks / 3); cycle++) {
      const picks = chooseCandidatesToVerify(candidates, start, 3, null, now);
      for (const pick of picks) {
        expect(seen.has(weekOf(pick))).toBe(false);
        seen.add(weekOf(pick));
      }
      const pickedIds = new Set(picks.map((p) => p.id));
      candidates = candidates.map((c) => (pickedIds.has(c.id) ? markChecked(c, 70000) : c));
    }
    expect(seen.size).toBe(totalWeeks);
  });

  test("picks up where the old first-week-only scan left off", () => {
    const candidates = window().map((c) =>
      ["1-8", "1-14", "2-14"].includes(c.id) ? markChecked(c, 64000) : c,
    );
    const picks = chooseCandidatesToVerify(candidates, start, 3, "1-8", now);
    expect(picks[0].id).toBe("1-8"); // the current best stays fresh
    expect(picks.slice(1).every((p) => weekOf(p) >= 4)).toBe(true); // far from what's known
  });

  test("re-checks the current best first", () => {
    const candidates = window().map((c) => (c.id === "20-8" ? markChecked(c, 60000) : c));
    expect(chooseCandidatesToVerify(candidates, start, 3, "20-8", now)[0].id).toBe("20-8");
  });

  test("doesn't spend a search on a best fare already checked today", () => {
    const candidates = window().map((c) =>
      c.id === "20-8" ? { ...c, verified: true, priceINR: 60000, lastCheckedAt: now } : c,
    );
    expect(chooseCandidatesToVerify(candidates, start, 3, "20-8", now).map((p) => p.id)).not.toContain("20-8");
  });

  test("tries different stay lengths as it moves through the window", () => {
    let candidates = window();
    const nights = new Set<number>();
    for (let cycle = 0; cycle < 3; cycle++) {
      const picks = chooseCandidatesToVerify(candidates, start, 3, null, now);
      const pickedIds = new Set(picks.map((p) => p.id));
      for (const pick of picks) {
        nights.add(Math.round((pick.returnDate!.getTime() - pick.departureDate.getTime()) / DAY));
      }
      candidates = candidates.map((c) => (pickedIds.has(c.id) ? markChecked(c, 70000) : c));
    }
    expect([...nights].sort()).toEqual([11, 14, 8].sort());
  });

  test("once every week has been seen, digs into the cheapest one", () => {
    const candidates = window(21, [7]).map((c) => {
      if (c.id === "0-7") return markChecked(c, 90000);
      if (c.id === "7-7") return markChecked(c, 50000);
      if (c.id === "14-7") return markChecked(c, 80000);
      return c;
    });
    const picks = chooseCandidatesToVerify(candidates, start, 3, null, now);
    expect(picks.every((p) => weekOf(p) === 1)).toBe(true);
  });

  test("a trip with one date keeps re-checking it, with no duplicates", () => {
    const candidates = window(1, [7]).map((c) => markChecked(c, 70000));
    expect(chooseCandidatesToVerify(candidates, start, 3, "0-7", now).map((p) => p.id)).toEqual(["0-7"]);
  });

  test("handles one-way trips, which have no stay length", () => {
    const picks = chooseCandidatesToVerify(window(31, [null]), start, 3, null, now);
    expect(picks).toHaveLength(3);
    expect(new Set(picks.map((p) => p.id)).size).toBe(3);
  });

  test("once everything has been checked, refreshes the longest-unchecked dates", () => {
    const candidates = window(3, [7]).map((c, i) => ({
      ...c,
      verified: true,
      priceINR: 70000,
      lastCheckedAt: new Date(now.getTime() - (10 - i) * DAY),
    }));
    expect(chooseCandidatesToVerify(candidates, start, 1, null, now)[0].id).toBe("0-7");
  });

  test("copes with no candidates at all", () => {
    expect(chooseCandidatesToVerify([], start, 3, null, now)).toEqual([]);
  });
});

describe("orderLeadsForConfirmation", () => {
  const lead = (priceINR: number, airline: string) => ({ priceINR, airlines: [airline] });

  // The real re-baseline: 27 Apr's cheap quotes all fell apart, and spending
  // every lookup there left ANA's ₹70,113 nonstop on 30 Mar unchecked.
  const dates = [
    { id: "27-apr", leads: [lead(46064, "SQ"), lead(49240, "SQ"), lead(49302, "VN")] },
    { id: "2-mar", leads: [lead(56323, "SQ"), lead(64412, "CX")] },
    { id: "30-mar", leads: [lead(70113, "NH"), lead(74831, "TG")] },
  ];
  const order = (bestId: string | null = null) =>
    orderLeadsForConfirmation(dates, bestId).map((l) => `${l.id}:${l.lead.priceINR}`);

  test("every date gets its first try before any date gets a second", () => {
    expect(order().slice(0, 3)).toEqual(["27-apr:46064", "2-mar:56323", "30-mar:70113"]);
  });

  test("the current best goes first, even when it isn't the cheapest quote", () => {
    expect(order("30-mar")[0]).toBe("30-mar:70113");
    expect(order("30-mar").slice(1, 3)).toEqual(["27-apr:46064", "2-mar:56323"]);
  });

  test("a second try on a date goes to a different airline", () => {
    const ordered = order();
    expect(ordered).toContain("27-apr:49302");
    expect(ordered).not.toContain("27-apr:49240");
  });

  test("the cheapest quote per airline is the one kept, whatever order they arrive in", () => {
    const shuffled = [{ id: "d", leads: [lead(70000, "SQ"), lead(60000, "SQ")] }];
    expect(orderLeadsForConfirmation(shuffled, null).map((l) => l.lead.priceINR)).toEqual([60000]);
  });

  test("copes with dates that have nothing to confirm", () => {
    expect(orderLeadsForConfirmation([{ id: "d", leads: [] }], null)).toEqual([]);
    expect(orderLeadsForConfirmation([], null)).toEqual([]);
  });
});
