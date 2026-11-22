import { describe, test, expect } from "bun:test";
import { buildSearchUrl, isNoResultsError, splitMultiCityLegs, type FlightLeg } from "./serpapi.js";

function leg(departure: string, arrival: string): FlightLeg {
  return {
    departure_airport: { name: departure, id: departure, time: "2027-01-01 10:00" },
    arrival_airport: { name: arrival, id: arrival, time: "2027-01-01 12:00" },
    duration: 120,
    airline: "TestAir",
    flight_number: "TA1",
    travel_class: "Economy",
  };
}

describe("splitMultiCityLegs", () => {
  test("splits a direct open-jaw itinerary into one outbound and one inbound segment", () => {
    // BOM -> MNL, then CEB -> BOM (arrived Manila, departing Cebu).
    const flights = [leg("BOM", "MNL"), leg("CEB", "BOM")];
    const { outbound, inbound } = splitMultiCityLegs(flights, ["MNL"]);
    expect(outbound).toEqual([flights[0]]);
    expect(inbound).toEqual([flights[1]]);
  });

  test("splits correctly when the outbound leg itself has a connection", () => {
    // BOM -> DXB -> MNL (1 stop outbound), then CEB -> BOM (nonstop inbound).
    const flights = [leg("BOM", "DXB"), leg("DXB", "MNL"), leg("CEB", "BOM")];
    const { outbound, inbound } = splitMultiCityLegs(flights, ["MNL"]);
    expect(outbound).toEqual([flights[0], flights[1]]);
    expect(inbound).toEqual([flights[2]]);
  });

  test("splits correctly when the inbound leg also has a connection", () => {
    const flights = [leg("BOM", "MNL"), leg("CEB", "DXB"), leg("DXB", "BOM")];
    const { outbound, inbound } = splitMultiCityLegs(flights, ["MNL"]);
    expect(outbound).toEqual([flights[0]]);
    expect(inbound).toEqual([flights[1], flights[2]]);
  });

  test("matches against any of several acceptable outbound destination airports", () => {
    const flights = [leg("BOM", "CEB"), leg("MNL", "BOM")];
    const { outbound, inbound } = splitMultiCityLegs(flights, ["MNL", "CEB"]);
    expect(outbound).toEqual([flights[0]]);
    expect(inbound).toEqual([flights[1]]);
  });

  test("falls back to treating everything as outbound if no split point is found", () => {
    // Defensive fallback only — not expected to happen against a real
    // multi-city response for a trip that requested one of these airports.
    const flights = [leg("BOM", "NRT"), leg("HND", "BOM")];
    const { outbound, inbound } = splitMultiCityLegs(flights, ["MNL"]);
    expect(outbound).toEqual(flights);
    expect(inbound).toEqual([]);
  });
});

describe("buildSearchUrl", () => {
  const roundTrip = {
    origin: "BOM",
    destinationAirports: ["NRT", "HND"],
    departureDate: "2027-03-03",
    returnDate: "2027-03-17",
    cabinClass: "economy",
  };

  test("sends the trip's stop limit as Google's filter value, which is offset by one", () => {
    const stopValue = (maxStops: number) =>
      buildSearchUrl({ ...roundTrip, maxStops }).searchParams.get("stops");
    expect(stopValue(0)).toBe("1"); // nonstop
    expect(stopValue(1)).toBe("2"); // one stop or fewer
    expect(stopValue(2)).toBe("3"); // two stops or fewer
  });

  test("leaves the search unfiltered when the trip accepts anything", () => {
    const url = buildSearchUrl({ ...roundTrip, maxStops: null, maxLayoverMinutes: null });
    expect(url.searchParams.has("stops")).toBe(false);
    expect(url.searchParams.has("layover_duration")).toBe(false);
  });

  test("sends the layover limit as a min,max range", () => {
    const url = buildSearchUrl({ ...roundTrip, maxLayoverMinutes: 360 });
    expect(url.searchParams.get("layover_duration")).toBe("30,360");
  });

  test("keeps an unusually short layover limit a valid range", () => {
    const url = buildSearchUrl({ ...roundTrip, maxLayoverMinutes: 20 });
    expect(url.searchParams.get("layover_duration")).toBe("20,20");
  });

  test("uses multi-city mode for an open-jaw trip, filters included", () => {
    const url = buildSearchUrl({
      ...roundTrip,
      destinationAirports: ["HAN"],
      returnDepartureAirports: ["PQC"],
      maxStops: 1,
    });
    expect(url.searchParams.get("type")).toBe("3");
    expect(url.searchParams.get("stops")).toBe("2");
    expect(JSON.parse(url.searchParams.get("multi_city_json")!)).toEqual([
      { departure_id: "BOM", arrival_id: "HAN", date: "2027-03-03" },
      { departure_id: "PQC", arrival_id: "BOM", date: "2027-03-17" },
    ]);
  });
});

describe("isNoResultsError", () => {
  test("recognises Google having no flights as an answer, not a failure", () => {
    expect(isNoResultsError("Google Flights hasn't returned any results for this query.")).toBe(true);
  });

  test("leaves real failures alone", () => {
    expect(isNoResultsError("Invalid API key.")).toBe(false);
    expect(isNoResultsError("Your account has run out of searches.")).toBe(false);
  });
});
