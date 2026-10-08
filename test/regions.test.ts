import { describe, expect, it } from "vitest";

import { coloOf, REGIONS, regionFor, traceColo } from "../src/room/regions";
import { mapPins, MAP_H, MAP_W, project, REGION_INFO } from "../src/ui/map";

describe("regions", () => {
  it("G1: the first three robots get three continents, and five get five regions", () => {
    expect([0, 1, 2].map(regionFor)).toEqual(["wnam", "weur", "oc"]);
    expect([0, 1, 2, 3, 4].map(regionFor)).toEqual(["wnam", "weur", "oc", "enam", "eeur"]);
    // Hong Kong (where "apac" landed) is refused by the model API.
    expect(REGIONS).not.toContain("apac");
    expect(regionFor(5)).toBe("wnam");
    expect(new Set(REGIONS).size).toBe(5);
    // The page draws every region the server hands out.
    for (const region of REGIONS) expect(REGION_INFO[region]).toBeDefined();
  });

  it("G2: only a three-letter data center code is kept, from text or a trace", () => {
    expect(coloOf(" AMS\n")).toBe("AMS");
    for (const bad of ["ams", "AMSX", "<b>", "", 3, undefined]) expect(coloOf(bad)).toBeUndefined();
    expect(traceColo("fl=1\nh=x\nip=1.2.3.4\ncolo=SJC\nhttp=http/2\n")).toBe("SJC");
    expect(traceColo("colo=\n")).toBeUndefined();
  });

  it("G4: each region lands on its continent, and robots sharing a region sit side by side", () => {
    // [lon min, lon max, lat min, lat max] per region's continent.
    const boxes: Record<string, [number, number, number, number]> = {
      wnam: [-130, -100, 25, 50],
      enam: [-90, -65, 25, 50],
      weur: [-10, 15, 40, 60],
      eeur: [15, 40, 40, 60],
      oc: [113, 154, -44, -10],
      apac: [100, 125, 15, 30],
    };
    for (const [region, info] of Object.entries(REGION_INFO)) {
      const [lonMin, lonMax, latMin, latMax] = boxes[region]!;
      const at = project(info.lat, info.lon);
      expect(at.x).toBeGreaterThanOrEqual(project(0, lonMin).x);
      expect(at.x).toBeLessThanOrEqual(project(0, lonMax).x);
      expect(at.y).toBeGreaterThanOrEqual(project(latMax, 0).y);
      expect(at.y).toBeLessThanOrEqual(project(latMin, 0).y);
      expect(at.x).toBeGreaterThan(0);
      expect(at.x).toBeLessThan(MAP_W);
      expect(at.y).toBeGreaterThan(0);
      expect(at.y).toBeLessThan(MAP_H);
    }
    const pins = mapPins([
      { name: "ponder", status: "running", region: "weur", colo: "AMS" },
      { name: "zippy", status: "running", region: "weur" },
      { name: "testy", status: "running" }, // a race from before the map
      { name: "snip", status: "running", region: "mars" },
    ]);
    expect(pins.map((p) => [p.agent, p.colo])).toEqual([["ponder", "AMS"], ["zippy", undefined]]);
    expect(pins[1]!.x - pins[0]!.x).toBe(8);
  });
});
