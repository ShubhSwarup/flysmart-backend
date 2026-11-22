import { describe, test, expect } from "bun:test";
import { chooseFareAlert } from "./notificationService.js";

const base = { budget: 60000, priorRouteLow: null };

describe("chooseFareAlert", () => {
  test("one improvement crossing every threshold is still one message", () => {
    // The real Japan run: ₹77,934 to ₹57,842 sent three messages before.
    const alert = chooseFareAlert({
      ...base,
      newBest: 57842,
      priorBest: 77934,
      priorLow: 77934,
      priorRouteLow: 64089,
    });
    expect(alert).toEqual({ type: "budget_reached", alsoRouteRecord: true });
  });

  test("a first fare is left to the baseline message", () => {
    const alert = chooseFareAlert({ ...base, newBest: 50000, priorBest: null, priorLow: null });
    expect(alert).toBeNull();
  });

  test("staying under budget isn't news every day", () => {
    const alert = chooseFareAlert({ ...base, newBest: 50000, priorBest: 50000, priorLow: 50000 });
    expect(alert).toBeNull();
  });

  test("a lower price while already under budget is a new low", () => {
    const alert = chooseFareAlert({ ...base, newBest: 48000, priorBest: 50000, priorLow: 50000 });
    expect(alert).toEqual({ type: "new_low", alsoRouteRecord: false });
  });

  test("a route record while over budget says so", () => {
    const alert = chooseFareAlert({
      ...base,
      newBest: 70000,
      priorBest: 75000,
      priorLow: 72000,
      priorRouteLow: 71000,
    });
    expect(alert).toEqual({ type: "route_historic_low", alsoRouteRecord: false });
  });

  test("a rebound that's still above the low is silent", () => {
    const alert = chooseFareAlert({ ...base, newBest: 72000, priorBest: 70000, priorLow: 68000 });
    expect(alert).toBeNull();
  });

  test("falling back under budget after rising fires again", () => {
    const alert = chooseFareAlert({ ...base, newBest: 59000, priorBest: 62000, priorLow: 55000 });
    expect(alert).toEqual({ type: "budget_reached", alsoRouteRecord: false });
  });
});
