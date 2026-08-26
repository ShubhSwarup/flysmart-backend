// Static per-provider monthly quota knowledge (Section 10). Actual usage
// counts live in Settings.apiUsage, updated by each integration on every
// real call — this is just the ceiling each provider's free tier allows.
export const PROVIDER_QUOTAS: Record<string, { quota: number; unit: string }> = {
  serpapi: { quota: 250, unit: "searches" },
  duffel: { quota: 200, unit: "searches" },
  travelpayouts: { quota: 1000, unit: "requests" },
};
