import { describe, test, expect } from "bun:test";
import { getCandidateWindow, cadenceDays } from "./tripWindow.js";

// Month keys / dates built relative to "now" rather than hardcoded calendar
// dates, so these tests stay correct regardless of when they're actually run.
function monthKey(offsetMonths: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysFromNow(days: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function today(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

describe("getCandidateWindow — fixed trips", () => {
  test("uses earliestDeparture/latestDeparture as-is when both are in the future", () => {
    const earliest = daysFromNow(30);
    const latest = daysFromNow(37);
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: earliest, latestDeparture: latest },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toEqual({ earliest, latest });
  });

  test("a single exact date (earliest === latest) is a valid one-day window", () => {
    const date = daysFromNow(30);
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: date, latestDeparture: date },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toEqual({ earliest: date, latest: date });
  });

  test("defaults latestDeparture to earliestDeparture when missing", () => {
    const date = daysFromNow(30);
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: date },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toEqual({ earliest: date, latest: date });
  });

  test("with no earliestDeparture set, there's no resolvable window", () => {
    const trip = { travelWindowType: "fixed" as const, travelWindow: {}, priority: "normal" as const };
    expect(getCandidateWindow(trip)).toBeNull();
  });

  // The bug found during the audit: a fixed trip's earliestDeparture is
  // "when I could earliest go", not "the only date to search" — a range
  // whose start has already passed should still search its remaining,
  // still-future portion, not vanish or search a stale past date.
  test("clamps a window that has partly elapsed forward to today", () => {
    const earliest = daysFromNow(-5); // already past
    const latest = daysFromNow(10);
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: earliest, latestDeparture: latest },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toEqual({ earliest: today(), latest });
  });

  test("a window that has fully elapsed has no resolvable window", () => {
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: daysFromNow(-10), latestDeparture: daysFromNow(-2) },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toBeNull();
  });
});

describe("getCandidateWindow — flexible-month trips", () => {
  test("with no months selected, there's no resolvable window", () => {
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [] },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toBeNull();
  });

  test("a single future month resolves to that month's full range", () => {
    const key = monthKey(6);
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [key] },
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip)!;
    const [year, month] = key.split("-").map(Number);
    expect(window.earliest).toEqual(new Date(Date.UTC(year, month - 1, 1)));
    expect(window.latest).toEqual(new Date(Date.UTC(year, month, 0)));
  });

  // The core F1 fix: every selected month is genuinely covered, not just
  // whichever happened to be first in the (unsorted) input array.
  test("spans every selected month, regardless of input order", () => {
    const earlier = monthKey(5);
    const later = monthKey(7);
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [later, earlier] }, // deliberately out of order
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip)!;
    const [ey, em] = earlier.split("-").map(Number);
    const [ly, lm] = later.split("-").map(Number);
    expect(window.earliest).toEqual(new Date(Date.UTC(ey, em - 1, 1)));
    expect(window.latest).toEqual(new Date(Date.UTC(ly, lm, 0)));
  });

  test("drops a selected month that has already fully elapsed", () => {
    const past = monthKey(-13);
    const future = monthKey(3);
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [past, future] },
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip)!;
    const [year, month] = future.split("-").map(Number);
    expect(window.earliest).toEqual(new Date(Date.UTC(year, month - 1, 1)));
  });

  test("no resolvable window when every selected month has already elapsed", () => {
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [monthKey(-13), monthKey(-7)] },
      priority: "normal" as const,
    };
    expect(getCandidateWindow(trip)).toBeNull();
  });

  test("the current month's window starts today, not the 1st", () => {
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [monthKey(0)] },
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip);
    if (window) expect(window.earliest.getTime()).toBe(today().getTime());
  });

  test("handles a December -> January selection spanning a year boundary", () => {
    const base = new Date();
    base.setUTCFullYear(base.getUTCFullYear() + 2, 11, 1); // December, safely 2 years out
    const decemberKey = `${base.getUTCFullYear()}-12`;
    const januaryKey = `${base.getUTCFullYear() + 1}-01`;
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [januaryKey, decemberKey] }, // out of order
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip)!;
    expect(window.earliest).toEqual(new Date(Date.UTC(base.getUTCFullYear(), 11, 1)));
    expect(window.latest).toEqual(new Date(Date.UTC(base.getUTCFullYear() + 1, 1, 0))); // last day of January
  });

  test("handles a leap-year February correctly (29 days)", () => {
    let year = new Date().getUTCFullYear();
    const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    while (!isLeap(year) || new Date(Date.UTC(year, 2, 0)).getTime() <= Date.now()) year++;
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [`${year}-02`] },
      priority: "normal" as const,
    };
    const window = getCandidateWindow(trip)!;
    expect(window.latest).toEqual(new Date(Date.UTC(year, 1, 29)));
  });
});

describe("cadenceDays", () => {
  test("defaults to daily when there's no resolvable window", () => {
    const trip = {
      travelWindowType: "flexible-month" as const,
      travelWindow: { months: [] },
      priority: "normal" as const,
    };
    expect(cadenceDays(trip)).toBe(1);
  });

  test("normal-priority trips more than 90 days out poll every 3 days", () => {
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: daysFromNow(120), latestDeparture: daysFromNow(120) },
      priority: "normal" as const,
    };
    expect(cadenceDays(trip)).toBe(3);
  });

  test("high-priority trips poll daily even far out", () => {
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: daysFromNow(120), latestDeparture: daysFromNow(120) },
      priority: "high" as const,
    };
    expect(cadenceDays(trip)).toBe(1);
  });

  test("trips within 90 days poll daily regardless of priority", () => {
    const trip = {
      travelWindowType: "fixed" as const,
      travelWindow: { earliestDeparture: daysFromNow(30), latestDeparture: daysFromNow(30) },
      priority: "low" as const,
    };
    expect(cadenceDays(trip)).toBe(1);
  });
});
