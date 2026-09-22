import { describe, test, expect } from "bun:test";
import { computeWindowOptions, describeOptions, isWeekend } from "./daysOffCalculator.js";

// Fixed, verified-weekday dates so tests never depend on when they're run:
// Fri Oct 1 2027, Sat Oct 2, Sun Oct 3, Mon Oct 4, Tue Oct 5, Wed Oct 6,
// Thu Oct 7, Fri Oct 8, Wed Oct 20.
const FRI_OCT1 = new Date("2027-10-01T00:00:00.000Z");
const SAT_OCT2 = new Date("2027-10-02T00:00:00.000Z");
const MON_OCT4 = new Date("2027-10-04T00:00:00.000Z");
const WED_OCT6 = new Date("2027-10-06T00:00:00.000Z");
const WED_OCT20 = new Date("2027-10-20T00:00:00.000Z");

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("isWeekend", () => {
  test("Saturday and Sunday are weekends", () => {
    expect(isWeekend(SAT_OCT2)).toBe(true);
    expect(isWeekend(new Date("2027-10-03T00:00:00.000Z"))).toBe(true);
  });
  test("weekdays are not", () => {
    expect(isWeekend(FRI_OCT1)).toBe(false);
    expect(isWeekend(WED_OCT6)).toBe(false);
  });
});

describe("computeWindowOptions — single anchor", () => {
  test("a Friday day off with no extra leave extends through the following weekend for free", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 0,
      ambientFreeDates: [FRI_OCT1],
    });
    expect(result.bridged).toBe(true);
    expect(result.options).toHaveLength(1);
    expect(iso(result.options[0].start)).toBe("2027-10-01");
    expect(iso(result.options[0].end)).toBe("2027-10-03");
    expect(result.options[0].leaveDaysUsed).toBe(0);
  });

  test("with 1 extra leave day, offers both a before and an after extension", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 1,
      ambientFreeDates: [FRI_OCT1],
    });
    const windows = result.options.map((o) => `${iso(o.start)}..${iso(o.end)}`);
    expect(windows).toContain("2027-10-01..2027-10-03"); // 0-leave base
    expect(windows).toContain("2027-09-30..2027-10-03"); // extend backward (Thursday)
    expect(windows).toContain("2027-10-01..2027-10-04"); // extend forward (Monday)
  });

  // The flagship behavior: spending leave to extend *backward* buries the
  // anchor inside the window instead of at its edge — the option where the
  // holiday itself is no longer a travel day.
  test("extending backward marks the anchor as no longer a boundary day", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 1,
      ambientFreeDates: [FRI_OCT1],
    });
    const extendedBack = result.options.find((o) => iso(o.start) === "2027-09-30")!;
    const extendedForward = result.options.find((o) => iso(o.end) === "2027-10-04")!;
    expect(extendedBack.anchorIsBoundary).toBe(false);
    expect(extendedForward.anchorIsBoundary).toBe(true); // anchor is still the start
  });

  test("an anchor that already falls on a weekend needs no leave at all", () => {
    const result = computeWindowOptions({
      anchors: [SAT_OCT2],
      leaveBudget: 0,
      ambientFreeDates: [SAT_OCT2],
    });
    expect(result.options[0].leaveDaysUsed).toBe(0);
    expect(iso(result.options[0].start)).toBe("2027-10-02");
    expect(iso(result.options[0].end)).toBe("2027-10-03");
  });

  test("more leave budget produces longer reachable windows", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 3,
      ambientFreeDates: [FRI_OCT1],
    });
    const longest = Math.max(...result.options.map((o) => o.totalDaysOff));
    expect(longest).toBeGreaterThanOrEqual(6); // 3 leave days + the free weekend, at minimum
  });
});

describe("computeWindowOptions — multiple anchors", () => {
  test("bridges two anchors close enough to fit the leave budget", () => {
    // Fri Oct 1 .. Wed Oct 6: Mon/Tue between them are the only work days.
    const result = computeWindowOptions({
      anchors: [WED_OCT6, FRI_OCT1], // deliberately out of order
      leaveBudget: 2,
      ambientFreeDates: [FRI_OCT1, WED_OCT6],
    });
    expect(result.bridged).toBe(true);
    expect(result.options[0].leaveDaysUsed).toBe(2);
    expect(iso(result.options[0].start)).toBe("2027-10-01");
    expect(iso(result.options[0].end)).toBe("2027-10-06");
  });

  test("falls back to separate options when anchors are too far apart for the budget", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1, WED_OCT20],
      leaveBudget: 2,
      ambientFreeDates: [FRI_OCT1, WED_OCT20],
    });
    expect(result.bridged).toBe(false);
    // Every returned option should relate to one anchor or the other, not
    // span the full (unaffordable) gap between them.
    for (const option of result.options) {
      expect(option.totalDaysOff).toBeLessThan(15);
    }
  });

  // Regression: a real report where 3 selected anchors (too far apart to
  // bridge) produced only 4 total options — capped globally by "lowest
  // leave cost wins," which let two anchors' cheaper options crowd out the
  // third anchor's entirely, even though it was explicitly selected.
  test("every anchor gets at least one option, even with 3+ anchors and a small options cap", () => {
    const NOV11 = new Date("2027-11-11T00:00:00.000Z");
    const result = computeWindowOptions({
      anchors: [FRI_OCT1, WED_OCT20, NOV11],
      leaveBudget: 0,
      ambientFreeDates: [FRI_OCT1, WED_OCT20, NOV11],
      minNights: 7,
      maxNights: 12,
      maxOptions: 4, // deliberately smaller than 3 anchors x 2 options each
    });
    expect(result.bridged).toBe(false);
    const coversAnchor = (anchor: Date) =>
      result.options.some((o) => o.start.getTime() <= anchor.getTime() && anchor.getTime() <= o.end.getTime());
    expect(coversAnchor(FRI_OCT1)).toBe(true);
    expect(coversAnchor(WED_OCT20)).toBe(true);
    expect(coversAnchor(NOV11)).toBe(true);
  });

  test("consecutive anchors merge into one span with no special-casing", () => {
    const MON_OCT4 = new Date("2027-10-04T00:00:00.000Z");
    const TUE_OCT5 = new Date("2027-10-05T00:00:00.000Z");
    const result = computeWindowOptions({
      anchors: [MON_OCT4, TUE_OCT5],
      leaveBudget: 0,
      ambientFreeDates: [MON_OCT4, TUE_OCT5],
    });
    // Both anchors are adjacent, non-weekend days declared off — plus the
    // weekend immediately before them extends the span for free.
    expect(iso(result.options[0].start)).toBe("2027-10-02");
    expect(iso(result.options[0].end)).toBe("2027-10-05");
    expect(result.options[0].leaveDaysUsed).toBe(0);
  });
});

describe("computeWindowOptions — desired length filtering", () => {
  test("prefers options that match the requested night count when one exists", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 3,
      ambientFreeDates: [FRI_OCT1],
      minNights: 5,
      maxNights: 5,
    });
    expect(result.options.every((o) => o.totalDaysOff - 1 === 5)).toBe(true);
  });

  test("falls back to whatever is achievable when nothing matches the requested length", () => {
    const result = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 0,
      ambientFreeDates: [FRI_OCT1],
      minNights: 20,
      maxNights: 25,
    });
    expect(result.options.length).toBeGreaterThan(0); // never empty
  });
});

// Regression coverage for a real report: "I have one day off on a Monday
// and want a 7-10 night trip around it" was silently producing a 1-2 night
// trip when the (separately chosen) leave budget wasn't enough — the
// requested length must drive the leave calculation, not the other way
// around, regardless of what leaveBudget happens to be set to.
describe("computeWindowOptions — a desired minimum drives leave, not the other way around", () => {
  test("a lone Monday day off with 0 leave budget still reaches a 7-10 night request", () => {
    const result = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 0,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 10,
    });
    expect(result.options.length).toBeGreaterThan(0);
    for (const o of result.options) {
      const nights = o.totalDaysOff - 1;
      expect(nights).toBeGreaterThanOrEqual(7);
      expect(nights).toBeLessThanOrEqual(10);
      // The true cost is reported honestly — never silently capped at the
      // (insufficient) leaveBudget of 0.
      expect(o.leaveDaysUsed).toBeGreaterThan(0);
    }
  });

  test("the leave actually used is independent of a too-small stated leaveBudget", () => {
    const atZero = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 0,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 7,
    });
    const atThree = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 3,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 7,
    });
    // Same real-world answer regardless of the (both insufficient) stated
    // budget — the target length is what determines the leave spent.
    const leaveAtZero = atZero.options.map((o) => o.leaveDaysUsed).sort();
    const leaveAtThree = atThree.options.map((o) => o.leaveDaysUsed).sort();
    expect(leaveAtZero).toEqual(leaveAtThree);
  });

  test("describeOptions flags when an option needs more leave than the stated budget", () => {
    const preview = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 1,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 7,
    });
    const described = describeOptions(preview, [MON_OCT4], { leaveBudget: 1, minNights: 7 });
    expect(described.length).toBeGreaterThan(0);
    for (const o of described) {
      expect(o.nights).toBe(7);
      expect(o.note).toContain("more leave day");
      expect(o.note).toContain("you set");
    }
  });

  test("no such caveat appears once the stated budget actually covers the requested length", () => {
    const preview = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 10,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 7,
    });
    const described = describeOptions(preview, [MON_OCT4], { leaveBudget: 10, minNights: 7 });
    for (const o of described) {
      expect(o.note).not.toContain("you set");
    }
  });
});

// Regression: a real report where minNights=7/maxNights=12 only ever
// produced options at exactly 7 or exactly 12 nights — nothing in between
// (8, 9, 10, 11) was ever generated, even though the whole point of a
// min/max range is that any length inside it is a valid trip.
describe("computeWindowOptions — covers every length in a requested range, not just the endpoints", () => {
  test("a small range (<= 6 distinct nights) is fully enumerated", () => {
    const result = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 0,
      ambientFreeDates: [MON_OCT4],
      minNights: 7,
      maxNights: 12,
    });
    const nightsSeen = new Set(result.options.map((o) => o.totalDaysOff - 1));
    for (let n = 7; n <= 12; n++) {
      expect(nightsSeen.has(n)).toBe(true);
    }
  });

  test("a large range is thinned to a bounded, evenly spread sample rather than exploding", () => {
    const result = computeWindowOptions({
      anchors: [MON_OCT4],
      leaveBudget: 0,
      ambientFreeDates: [MON_OCT4],
      minNights: 5,
      maxNights: 30,
    });
    const nightsSeen = new Set(result.options.map((o) => o.totalDaysOff - 1));
    expect(nightsSeen.size).toBeLessThanOrEqual(6);
    expect([...nightsSeen].every((n) => n >= 5 && n <= 30)).toBe(true);
  });
});

describe("describeOptions", () => {
  test("labels a zero-leave option as needing no extra leave", () => {
    const preview = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 0,
      ambientFreeDates: [FRI_OCT1],
    });
    const described = describeOptions(preview, [FRI_OCT1]);
    expect(described[0].note).toContain("No extra leave needed");
  });

  test("flags the option that skips the anchor date as a travel day", () => {
    const preview = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 1,
      ambientFreeDates: [FRI_OCT1],
    });
    const described = describeOptions(preview, [FRI_OCT1]);
    const buriedOption = described.find((o) => o.departureDate === "2027-09-30")!;
    expect(buriedOption.note).toContain("Skips");
    expect(buriedOption.note).toContain("fares typically spike");
  });

  test("also states the leave-vs-already-free breakdown as its own plain sentence", () => {
    const preview = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 1,
      ambientFreeDates: [FRI_OCT1],
    });
    const described = describeOptions(preview, [FRI_OCT1]);
    const buriedOption = described.find((o) => o.departureDate === "2027-09-30")!;
    // 4-night span (Sep30-Oct3), 1 leave day (Sep30) + 3 already free
    // (Oct1 anchor + the following weekend) — spelled out as its own
    // sentence, not folded into a single line with nested parentheticals.
    expect(buriedOption.note).toContain("Needs 1 leave day");
    expect(buriedOption.note).toContain("the other 3 days are already a weekend or a saved day off");
  });

  test("labels a non-buried option that uses the most leave as the longest available", () => {
    // With a symmetric budget, the backward and forward extensions can tie
    // on both leave spent and total length — when they do, the more
    // specific "skips the holiday" note (for whichever one buries the
    // anchor) takes priority over the generic "longest" label, so this
    // checks the *other* tied option gets it, not "whichever tied option
    // happens to be found first".
    const preview = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 2,
      ambientFreeDates: [FRI_OCT1],
    });
    const described = describeOptions(preview, [FRI_OCT1]);
    const maxLeave = Math.max(...described.map((o) => o.leaveDaysUsed));
    const longest = described.find((o) => o.leaveDaysUsed === maxLeave && !o.note.includes("Skips"))!;
    expect(longest.note).toContain("The longest option within your leave budget.");
  });

  // Regression: "the longest option within your leave budget" must never
  // appear on an option that actually needs *more* leave than the stated
  // budget — that was a direct, visible contradiction sitting right next
  // to the "more leave days than you set" caveat on the same line.
  test("never claims 'within your leave budget' on an option that exceeds it", () => {
    const preview = computeWindowOptions({
      anchors: [FRI_OCT1],
      leaveBudget: 0,
      ambientFreeDates: [FRI_OCT1],
      minNights: 10,
      maxNights: 11,
    });
    const described = describeOptions(preview, [FRI_OCT1], { leaveBudget: 0, minNights: 10 });
    for (const o of described) {
      if (o.note.includes("more leave day") && o.note.includes("you set aside")) {
        expect(o.note).not.toContain("within your leave budget");
      }
    }
  });
});
