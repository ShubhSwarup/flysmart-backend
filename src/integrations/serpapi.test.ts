import { describe, test, expect } from "bun:test";
import { splitMultiCityLegs, type FlightLeg } from "./serpapi.js";

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
