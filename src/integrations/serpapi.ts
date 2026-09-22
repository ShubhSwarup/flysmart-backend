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
}

interface GoogleFlightsResponse {
  best_flights?: FlightItineraryRaw[];
  other_flights?: FlightItineraryRaw[];
  price_insights?: {
    lowest_price?: number;
    price_level?: string;
    typical_price_range?: [number, number];
  };
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
  raw: FlightItineraryRaw;
}

export interface FlightSearchResult {
  itineraries: NormalizedItinerary[];
  priceInsights: GoogleFlightsResponse["price_insights"] | null;
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

export async function searchFlights(params: FlightSearchParams): Promise<FlightSearchResult> {
  const currency = params.currency ?? "INR";
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_flights");
  const isOpenJaw = !!params.returnDate && !!params.returnDepartureAirports?.length;

  if (isOpenJaw) {
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

  const res = await fetch(url.toString());
  await incrementApiUsage("serpapi", params.usageCategory); // count the call regardless of outcome — it still spent quota
  if (!res.ok) {
    throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as GoogleFlightsResponse;
  if (data.error) {
    throw new Error(`SerpApi error: ${data.error}`);
  }

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
      raw: it,
    };
  });

  return { itineraries, priceInsights: data.price_insights ?? null };
}
