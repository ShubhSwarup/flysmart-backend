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

// The most return-flight lookups one poll cycle spends turning leads into real
// fares (searchReturnFlights): enough to keep the current best honest and still
// try another airline or the most promising new date.
export const MAX_FARE_CONFIRMATIONS_PER_CYCLE = 3;

// Left unspent by the scheduled runs so that creating or editing a trip, whose
// baseline search runs immediately, always has something to work with.
export const INTERACTIVE_SEARCH_RESERVE = 15;

// How long a confirmed fare may headline a trip without being re-confirmed.
// Beyond this it's a memory of a price, not a price.
export const CONFIRMED_FARE_MAX_AGE_DAYS = 7;

// How often a trip whose own searches carry no Google insight (multi-airport,
// open-jaw) spends one extra search fetching it.
export const MARKET_INSIGHT_MAX_AGE_DAYS = 7;
