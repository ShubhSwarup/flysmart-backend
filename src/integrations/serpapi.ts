import { env } from "../config/env.js";
import { incrementApiUsage } from "../models/Settings.js";

// Response shapes per SerpApi's Google Flights engine docs
// (https://serpapi.com/google-flights-api) — only the fields we use.
export interface FlightLeg {
  departure_airport: { name: string; id: string; time: string };
  arrival_airport: { name: string; id: string; time: string };
  duration: number;
  airline: string;
  flight_number: string;
  travel_class: string;
}

interface FlightItineraryRaw {
  flights: FlightLeg[];
  layovers?: { duration: number; name: string; id: string }[];
  total_duration: number;
  price: number;
  type: string;
  // Present on the outbound step of a round-trip/multi-city search — the
  // handle for asking "and which return flights go with this one?"
  departure_token?: string;
}

interface GoogleFlightsResponse {
  best_flights?: FlightItineraryRaw[];
  other_flights?: FlightItineraryRaw[];
  price_insights?: {
    lowest_price?: number;
    price_level?: string;
    typical_price_range?: [number, number];
    // [unix seconds, price] per day, ~60 days back — Google's own record of
    // this exact search. Only sent for a single-airport, non-multi-city search.
    price_history?: [number, number][];
  };
  search_metadata?: { google_flights_url?: string };
  error?: string;
}

const CABIN_TO_TRAVEL_CLASS: Record<string, number> = {
  economy: 1,
  premium_economy: 2,
  business: 3,
  first: 4,
};

export interface FlightSearchParams {
  origin: string;
  // Multiple arrival airports are sent as one comma-separated search
  // (confirmed against the real API: a single call with e.g. "NRT,HND,KIX"
  // returns itineraries across all three, each correctly labeled with its
  // actual arrival airport) rather than one call per airport — cheaper on
  // quota and the correct way to model "any of these airports is fine."
  destinationAirports: string[];
  departureDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD — omit for one-way
  cabinClass: string;
  currency?: string;
  // Which quota-usage bucket this call counts against, purely for the
  // Settings usage breakdown (Section G) — has no effect on the request.
  usageCategory?: "single" | "range";
  // Open-jaw: when set (and returnDate is set), the return leg departs from
  // these airport(s) instead of wherever the outbound leg landed — e.g.
  // arrive Manila, depart Cebu. Switches the request from Google Flights'
  // native round-trip mode (which always assumes the same airports both
  // ways) to its multi-city mode, a 2-leg itinerary with its own
  // departure/arrival per leg.
  returnDepartureAirports?: string[];
  // The trip's own rules, enforced by Google on every leg of the search.
  // Filtering afterwards can't do this: a round-trip search only ever shows
  // the outbound leg, so a "1 stop" result could still hide a 3-stop return.
  maxStops?: number | null;
  maxLayoverMinutes?: number | null;
}

export interface NormalizedItinerary {
  price: number;
  currency: string;
  airlines: string[];
  stops: number;
  layoverMinutes: number[];
  // The itinerary's actual arrival airport — not assumed from the search
  // input, since a multi-airport search can return results for any of them.
  // For an open-jaw itinerary this is the outbound leg's arrival airport
  // specifically (what "destination" means for routeKey purposes);
  // returnDepartureAirport separately records where the return leg left
  // from, when it differs.
  arrivalAirport: string;
  returnDepartureAirport: string | null;
  durationMinutes: number;
  // Null for a one-way fare, whose price is already final. Otherwise this
  // itinerary's price is only a lead until a return is picked with this token
  // (searchReturnFlights) — see the note on that function.
  departureToken: string | null;
  raw: FlightItineraryRaw;
}

export interface FlightSearchResult {
  itineraries: NormalizedItinerary[];
  priceInsights: GoogleFlightsResponse["price_insights"] | null;
  googleFlightsUrl: string | null;
}

export interface ReturnFlightOption {
  price: number;
  currency: string;
  airlines: string[];
  stops: number;
  layoverMinutes: number[];
  departureAirport: string;
  departAt: string | null;
  arriveAt: string | null;
  durationMinutes: number;
  raw: FlightItineraryRaw;
}

export interface ReturnFlightsResult {
  options: ReturnFlightOption[];
  googleFlightsUrl: string | null;
}

// Splits a multi-city itinerary's concatenated flight segments back into
// its outbound and inbound legs, so stops can be counted per leg instead of
// across the whole array — naively counting `flights.length - 1` on a
// 2-leg itinerary would wrongly treat the gap between the two legs (the
// entire time spent at the destination) as a layover. The split point is
// the first segment landing at one of the outbound leg's requested
// destination airports.
export function splitMultiCityLegs(
  flights: FlightLeg[],
  destinationAirports: string[],
): { outbound: FlightLeg[]; inbound: FlightLeg[] } {
  const splitIndex = flights.findIndex((f) => destinationAirports.includes(f.arrival_airport.id));
  if (splitIndex === -1) return { outbound: flights, inbound: [] };
  return { outbound: flights.slice(0, splitIndex + 1), inbound: flights.slice(splitIndex + 1) };
}

// The filter values Google Flights expects: 0 any (omitted here), 1 nonstop,
// 2 one stop or fewer, 3 two stops or fewer. Its minimum layover has to be
// set alongside the maximum, so 30 minutes stands in for "no real minimum".
function setConstraintFilters(url: URL, params: FlightSearchParams): void {
  if (params.maxStops != null) url.searchParams.set("stops", String(params.maxStops + 1));
  if (params.maxLayoverMinutes != null) {
    const min = Math.min(30, params.maxLayoverMinutes);
    url.searchParams.set("layover_duration", `${min},${params.maxLayoverMinutes}`);
  }
}

function isOpenJawSearch(params: FlightSearchParams): boolean {
  return !!params.returnDate && !!params.returnDepartureAirports?.length;
}

export function buildSearchUrl(params: FlightSearchParams): URL {
  const currency = params.currency ?? "INR";
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_flights");

  if (isOpenJawSearch(params)) {
    // Google Flights' multi-city mode — an open-jaw round trip is exactly a
    // 2-leg multi-city itinerary: out on departureDate, back on returnDate,
    // each leg with its own airports (confirmed against SerpApi's docs:
    // type=3 + multi_city_json, an array of {departure_id, arrival_id,
    // date} objects). Whether each leg's departure_id/arrival_id accepts a
    // comma-separated list the same way the single-leg round-trip params do
    // is *not* separately confirmed for this nested shape — sent the same
    // way regardless, since that degrades safely (Google just resolves it
    // against whichever airports are valid) rather than failing outright.
    url.searchParams.set("type", "3");
    const legs = [
      {
        departure_id: params.origin,
        arrival_id: params.destinationAirports.join(","),
        date: params.departureDate,
      },
      {
        departure_id: params.returnDepartureAirports!.join(","),
        arrival_id: params.origin,
        date: params.returnDate,
      },
    ];
    url.searchParams.set("multi_city_json", JSON.stringify(legs));
  } else {
    url.searchParams.set("departure_id", params.origin);
    url.searchParams.set("arrival_id", params.destinationAirports.join(","));
    url.searchParams.set("outbound_date", params.departureDate);
    if (params.returnDate) {
      url.searchParams.set("return_date", params.returnDate);
      url.searchParams.set("type", "1"); // round trip
    } else {
      url.searchParams.set("type", "2"); // one way
    }
  }
  url.searchParams.set("currency", currency);
  url.searchParams.set(
    "travel_class",
    String(CABIN_TO_TRAVEL_CLASS[params.cabinClass] ?? CABIN_TO_TRAVEL_CLASS.economy),
  );
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", env.serpApiKey);
  setConstraintFilters(url, params);
  return url;
}

// SerpApi reports "this search simply has no flights" through the same error
// field as a real failure. It's a legitimate answer (a date with nothing that
// fits the trip's rules) and must not look like a broken search — that would
// leave the date unverified, to be searched again and again.
export function isNoResultsError(message: string): boolean {
  return /hasn't returned any results/i.test(message);
}

async function fetchGoogleFlights(url: URL, usageCategory: FlightSearchParams["usageCategory"]) {
  const res = await fetch(url.toString());
  await incrementApiUsage("serpapi", usageCategory); // count the call regardless of outcome — it still spent quota
  if (!res.ok) {
    throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as GoogleFlightsResponse;
  if (data.error && !isNoResultsError(data.error)) {
    throw new Error(`SerpApi error: ${data.error}`);
  }
  return data;
}

// What SerpApi itself says is left this month. The account endpoint doesn't
// use up a search, and unlike our own count it includes every search made with
// this key from anywhere else. Null if it can't be reached, so a caller can
// fall back on the count it keeps.
export async function fetchSearchesLeft(): Promise<number | null> {
  try {
    const url = new URL("https://serpapi.com/account.json");
    url.searchParams.set("api_key", env.serpApiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const account = (await res.json()) as { plan_searches_left?: number };
    return account.plan_searches_left ?? null;
  } catch {
    return null;
  }
}

export async function searchFlights(params: FlightSearchParams): Promise<FlightSearchResult> {
  const currency = params.currency ?? "INR";
  const isOpenJaw = isOpenJawSearch(params);
  const data = await fetchGoogleFlights(buildSearchUrl(params), params.usageCategory);

  const all = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
  // Some itineraries come back with no `price` at all (observed on a real
  // BLR->Philippines search — likely a booking-partner redirect Google
  // doesn't have a firm price for at scrape time). One bad entry would
  // otherwise fail the whole insertMany batch, so drop these rather than
  // recording a price we don't actually have.
  const priced = all.filter((it) => typeof it.price === "number" && it.price > 0);
  if (priced.length < all.length) {
    console.warn(`SerpApi returned ${all.length - priced.length} itinerary(ies) with no price — skipped.`);
  }
  const itineraries: NormalizedItinerary[] = priced.map((it) => {
    if (isOpenJaw) {
      const { outbound, inbound } = splitMultiCityLegs(it.flights, params.destinationAirports);
      return {
        price: it.price,
        currency,
        airlines: [...new Set(it.flights.map((f) => f.airline))],
        stops: Math.max(0, outbound.length - 1) + Math.max(0, inbound.length - 1),
        layoverMinutes: (it.layovers ?? []).map((l) => l.duration),
        arrivalAirport: outbound[outbound.length - 1]?.arrival_airport.id ?? params.destinationAirports[0],
        returnDepartureAirport: inbound[0]?.departure_airport.id ?? params.returnDepartureAirports![0],
        durationMinutes: it.total_duration,
        departureToken: it.departure_token ?? null,
        raw: it,
      };
    }
    return {
      price: it.price,
      currency,
      airlines: [...new Set(it.flights.map((f) => f.airline))],
      stops: Math.max(0, it.flights.length - 1),
      layoverMinutes: (it.layovers ?? []).map((l) => l.duration),
      arrivalAirport: it.flights[it.flights.length - 1].arrival_airport.id,
      returnDepartureAirport: null,
      durationMinutes: it.total_duration,
      departureToken: it.departure_token ?? null,
      raw: it,
    };
  });

  return {
    itineraries,
    priceInsights: data.price_insights ?? null,
    googleFlightsUrl: data.search_metadata?.google_flights_url ?? null,
  };
}

// The second step of a round-trip or open-jaw search: the return flights that
// can actually be paired with one outbound flight, each with the real total
// for the whole trip. The price on the outbound step is only Google's guess at
// that total, and live searches show it can be wrong in either direction
// (₹42,765 had no return at all; ₹60,871 really cost ₹77,934), so a fare isn't
// known until this step has been done. Costs one search.
export async function searchReturnFlights(
  params: FlightSearchParams,
  departureToken: string,
): Promise<ReturnFlightsResult> {
  const currency = params.currency ?? "INR";
  const url = buildSearchUrl(params);
  url.searchParams.set("departure_token", departureToken);
  const data = await fetchGoogleFlights(url, params.usageCategory);

  const all = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
  const options: ReturnFlightOption[] = all
    .filter((it) => typeof it.price === "number" && it.price > 0)
    .map((it) => ({
      price: it.price,
      currency,
      airlines: [...new Set(it.flights.map((f) => f.airline))],
      stops: Math.max(0, it.flights.length - 1),
      layoverMinutes: (it.layovers ?? []).map((l) => l.duration),
      departureAirport: it.flights[0].departure_airport.id,
      departAt: it.flights[0].departure_airport.time ?? null,
      arriveAt: it.flights[it.flights.length - 1].arrival_airport.time ?? null,
      durationMinutes: it.total_duration,
      raw: it,
    }));

  return { options, googleFlightsUrl: data.search_metadata?.google_flights_url ?? null };
}
