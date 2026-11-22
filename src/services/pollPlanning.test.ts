import { describe, test, expect } from "bun:test";
import { dailySearchAllowance, planPollRun, type PlannableTrip } from "./pollPlanning.js";

const nov2 = new Date("2026-11-02T03:00:00Z");

describe("dailySearchAllowance", () => {
  test("spreads what's left, less the interactive reserve, over the rest of the month", () => {
    expect(dailySearchAllowance(241, nov2)).toBe(8); // (241 - 15) / 29 days
  });

  test("counts today, so the last day of the month can spend what's left", () => {
    expect(dailySearchAllowance(25, new Date("2026-11-30T03:00:00Z"))).toBe(10);
  });

  test("holds back nothing it doesn't have", () => {
    expect(dailySearchAllowance(10, nov2)).toBe(0);
    expect(dailySearchAllowance(0, nov2)).toBe(0);
  });
});

describe("planPollRun", () => {
  interface T extends PlannableTrip {
    name: string;
    weight: number;
  }
  const trip = (name: string, weight: number, priority = "normal", lastPolledAt: Date | null = null): T => ({
    name,
    weight,
    priority,
    lastPolledAt,
  });
  const weightOf = (t: T) => t.weight;
  const names = (ts: T[]) => ts.map((t) => t.name);

  test("the real three trips can't all poll in one day, so a day's spend stays on pace", () => {
    const due = [trip("Japan", 5), trip("Switzerland", 3), trip("Vietnam", 5)];
    const { affordable, plannedSpend, allowance } = planPollRun(due, weightOf, 241, nov2);
    expect(allowance).toBe(8);
    expect(plannedSpend).toBeLessThanOrEqual(8);
    expect(affordable.length).toBeLessThan(3);
  });

  test("whichever trip has waited longest goes first, so nothing starves", () => {
    const due = [
      trip("Yesterday", 5, "normal", new Date("2026-11-01")),
      trip("LastWeek", 5, "normal", new Date("2026-10-26")),
    ];
    expect(names(planPollRun(due, weightOf, 241, nov2).affordable)[0]).toBe("LastWeek");
  });

  test("priority still outranks waiting", () => {
    const due = [trip("LongWait", 5, "low", new Date("2026-10-01")), trip("Urgent", 5, "high", new Date("2026-11-01"))];
    expect(names(planPollRun(due, weightOf, 241, nov2).affordable)[0]).toBe("Urgent");
  });

  test("a trip that costs more than the daily allowance still gets its turn", () => {
    const { affordable } = planPollRun([trip("Big", 5)], weightOf, 30, new Date("2026-11-02T03:00:00Z"));
    expect(names(affordable)).toEqual(["Big"]);
  });

  test("nothing runs once the month's quota truly can't cover it", () => {
    expect(planPollRun([trip("Big", 5)], weightOf, 3, nov2).affordable).toEqual([]);
  });

  test("a cheaper trip further down can still fit behind one that doesn't", () => {
    const due = [
      trip("A", 5, "normal", new Date("2026-10-01")),
      trip("B", 5, "normal", new Date("2026-10-02")),
      trip("C", 3, "normal", new Date("2026-10-03")),
    ];
    expect(names(planPollRun(due, weightOf, 241, nov2).affordable)).toEqual(["A", "C"]);
  });
});
