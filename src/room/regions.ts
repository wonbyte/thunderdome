// Where each robot's sandbox is asked to run. Pure: TaskRoom passes the pick to getByName as a
// location hint. A hint is best effort, so the race also records the data center the sandbox's
// Durable Object really ran in (the slot's colo).

/** Durable Object location hints, in the order robots get them. */
export type Region = "wnam" | "weur" | "oc" | "enam" | "eeur";

/**
 * The first three are on three continents, so a 3-robot race is spread too. Only regions the
 * model API serves: "apac" put a robot in Hong Kong, where every model call got 403 (Oct 8).
 */
export const REGIONS: readonly Region[] = ["wnam", "weur", "oc", "enam", "eeur"];

/** The region for the robot at `index` in the race. */
export function regionFor(index: number): Region {
  return REGIONS[((index % REGIONS.length) + REGIONS.length) % REGIONS.length]!;
}

/** A Cloudflare data center code (an airport code, "AMS"), or undefined for anything else. */
export function coloOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const code = text.trim();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** The `colo=` line of a /cdn-cgi/trace body. */
export function traceColo(trace: string): string | undefined {
  return coloOf(/^colo=(.*)$/m.exec(trace)?.[1]);
}
