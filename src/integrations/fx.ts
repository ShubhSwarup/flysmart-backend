// Currency normalization (Section 10.6) — converts an observed price to INR
// for cross-currency comparison. Cached per-currency for 24h so this never
// runs on every observation, just once a day per currency actually seen.
// frankfurter.app is free and requires no API key.

interface RateCacheEntry {
  rate: number;
  fetchedAt: number;
}

const cache = new Map<string, RateCacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;

export async function toINR(amount: number, currency: string): Promise<number> {
  if (currency === "INR") return Math.round(amount);

  const cached = cache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return Math.round(amount * cached.rate);
  }

  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${currency}&to=INR`);
    if (!res.ok) throw new Error(`frankfurter.app request failed: ${res.status}`);
    const data = (await res.json()) as { rates: Record<string, number> };
    const rate = data.rates.INR;
    if (!rate) throw new Error(`No INR rate returned for ${currency}`);
    cache.set(currency, { rate, fetchedAt: Date.now() });
    return Math.round(amount * rate);
  } catch (err) {
    // Fall back to the last known rate rather than failing the whole poll
    // over a currency-conversion hiccup; if we've never seen this currency
    // before, storing the raw amount is the least-wrong option available.
    console.error(`FX lookup failed for ${currency}, using fallback:`, err);
    return cached ? Math.round(amount * cached.rate) : Math.round(amount);
  }
}
