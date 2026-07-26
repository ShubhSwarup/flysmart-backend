import { env } from "../config/env.js";

// Response shapes per SerpApi's Google Flights engine docs
// (https://serpapi.com/google-flights-api) — only the fields we use.
interface FlightLeg {
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
  destinationAirport: string;
  departureDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD — omit for one-way
  cabinClass: string;
  currency?: string;
}

export interface NormalizedItinerary {
  price: number;
  currency: string;
  airlines: string[];
  stops: number;
  layoverMinutes: number[];
  raw: FlightItineraryRaw;
}

export interface FlightSearchResult {
  itineraries: NormalizedItinerary[];
  priceInsights: GoogleFlightsResponse["price_insights"] | null;
}

export async function searchFlights(params: FlightSearchParams): Promise<FlightSearchResult> {
  const currency = params.currency ?? "INR";
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("departure_id", params.origin);
  url.searchParams.set("arrival_id", params.destinationAirport);
  url.searchParams.set("outbound_date", params.departureDate);
  if (params.returnDate) {
    url.searchParams.set("return_date", params.returnDate);
    url.searchParams.set("type", "1"); // round trip
  } else {
    url.searchParams.set("type", "2"); // one way
  }
  url.searchParams.set("currency", currency);
  url.searchParams.set(
    "travel_class",
    String(CABIN_TO_TRAVEL_CLASS[params.cabinClass] ?? CABIN_TO_TRAVEL_CLASS.economy),
  );
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", env.serpApiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`SerpApi request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as GoogleFlightsResponse;
  if (data.error) {
    throw new Error(`SerpApi error: ${data.error}`);
  }

  const all = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
  const itineraries: NormalizedItinerary[] = all.map((it) => ({
    price: it.price,
    currency,
    airlines: [...new Set(it.flights.map((f) => f.airline))],
    stops: Math.max(0, it.flights.length - 1),
    layoverMinutes: (it.layovers ?? []).map((l) => l.duration),
    raw: it,
  }));

  return { itineraries, priceInsights: data.price_insights ?? null };
}
