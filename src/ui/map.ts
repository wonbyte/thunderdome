// The "where the robots ran" map: rough continents, the five regions robots are asked to run in,
// and a pin per robot with the data center its container answered from. Pure; app.ts draws it.

import type { WireAgent } from "./board";

/** A region the robots are asked to run in (src/room/regions.ts REGIONS, duplicated on purpose). */
export interface RegionInfo { name: string; lat: number; lon: number }

/** Where each location hint is drawn: a large Cloudflare city in that region. */
export const REGION_INFO: Readonly<Record<string, RegionInfo>> = {
  wnam: { name: "Western North America", lat: 37.4, lon: -122 },
  enam: { name: "Eastern North America", lat: 39, lon: -77.5 },
  weur: { name: "Western Europe", lat: 50.1, lon: 8.7 },
  eeur: { name: "Eastern Europe", lat: 52.2, lon: 21 },
  apac: { name: "Asia-Pacific", lat: 1.35, lon: 103.8 },
};

/** The map's viewBox: longitude -180..180, latitude 80..-60 (no polar caps). */
export const MAP_W = 360;
export const MAP_H = 140;

/** Equirectangular: one map unit per degree. */
export function project(lat: number, lon: number): { x: number; y: number } {
  return { x: lon + 180, y: 80 - lat };
}

// Hand-drawn continent outlines in [lon, lat]: a few dozen points each, enough to read as a world map.
const OUTLINES: readonly (readonly [number, number])[][] = [
  // North America
  [[-168, 66], [-156, 71], [-125, 70], [-95, 72], [-80, 73], [-62, 60], [-55, 52], [-66, 45], [-76, 35], [-81, 25], [-97, 26], [-97, 18], [-87, 15], [-83, 9], [-80, 8], [-92, 15], [-105, 20], [-112, 29], [-117, 33], [-124, 40], [-124, 48], [-135, 58], [-150, 60], [-165, 62]],
  // Greenland
  [[-50, 60], [-42, 60], [-20, 70], [-20, 80], [-60, 80], [-70, 77], [-55, 68]],
  // South America
  [[-80, 8], [-60, 10], [-50, 0], [-35, -5], [-39, -15], [-48, -26], [-58, -38], [-65, -55], [-72, -50], [-73, -37], [-70, -18], [-81, -5]],
  // Europe and Asia
  [[-10, 36], [-9, 43], [-2, 47], [-5, 48], [1, 51], [5, 53], [8, 57], [5, 62], [15, 69], [28, 71], [40, 67], [60, 69], [80, 73], [105, 78], [140, 72], [180, 69], [180, 65], [160, 60], [142, 53], [135, 43], [127, 38], [122, 30], [117, 23], [108, 21], [106, 10], [100, 13], [104, 1], [98, 8], [94, 16], [90, 22], [80, 15], [77, 8], [72, 20], [67, 25], [57, 25], [56, 27], [48, 30], [50, 26], [56, 24], [59, 22], [52, 16], [43, 13], [39, 21], [34, 28], [32, 31], [35, 36], [27, 36], [26, 40], [22, 37], [19, 42], [13, 45], [12, 42], [16, 38], [9, 44], [3, 43], [-1, 37], [-5, 36]],
  // Great Britain
  [[-6, 50], [1, 51], [-2, 56], [-5, 58], [-6, 55]],
  // Japan
  [[130, 31], [136, 34], [141, 36], [142, 43], [140, 41], [133, 35]],
  // Sumatra, Java and Borneo, as one
  [[95, 5], [104, -6], [115, -8], [119, -6], [118, 6], [110, 2], [104, 1]],
  // Africa
  [[-17, 21], [-10, 30], [-6, 36], [10, 37], [11, 33], [20, 31], [32, 31], [34, 28], [43, 12], [51, 12], [40, -2], [40, -15], [33, -26], [20, -35], [17, -29], [12, -17], [9, -1], [9, 4], [-8, 4], [-17, 14]],
  // Australia
  [[114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [146, -19], [153, -28], [150, -37], [141, -38], [131, -31], [115, -34]],
];

/** The continents as one SVG path. */
export const LAND_PATH: string = OUTLINES.map((ring) => `M${ring.map(([lon, lat]) => { const p = project(lat, lon); return `${p.x} ${p.y}`; }).join("L")}Z`).join("");

/** One robot on the map. */
export interface MapPin { agent: string; region: string; name: string; colo?: string; x: number; y: number }

/** A pin per robot that was given a region; robots sharing a region sit side by side. */
export function mapPins(agents: readonly WireAgent[]): MapPin[] {
  const seen = new Map<string, number>();
  const pins: MapPin[] = [];
  for (const slot of agents) {
    const info = slot.region === undefined ? undefined : REGION_INFO[slot.region];
    if (slot.region === undefined || info === undefined) continue;
    const n = seen.get(slot.region) ?? 0;
    seen.set(slot.region, n + 1);
    const at = project(info.lat, info.lon);
    pins.push({ agent: slot.name, region: slot.region, name: info.name, ...(slot.colo === undefined ? {} : { colo: slot.colo }), x: at.x + n * 8, y: at.y });
  }
  return pins;
}
