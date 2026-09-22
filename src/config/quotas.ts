// Static per-provider monthly quota knowledge (Section 10). Actual usage
// counts live in Settings.apiUsage, updated by each integration on every
// real call — this is just the ceiling each provider's free tier allows.
export const PROVIDER_QUOTAS: Record<string, { quota: number; unit: string }> = {
  serpapi: { quota: 250, unit: "searches" },
  duffel: { quota: 200, unit: "searches" },
  travelpayouts: { quota: 1000, unit: "requests" },
};

// The most real searches a single trip with a genuine date range (a
// flexible-month or fixed-date-range trip) spends verifying candidates in
// one poll cycle — deliberately small and shared across every such trip, so
// no one trip's window size can dominate the shared monthly SerpApi budget.
// A trip with exactly one candidate (a single exact date) only ever spends
// 1 regardless of this constant.
export const MAX_CANDIDATES_PER_CYCLE = 3;
