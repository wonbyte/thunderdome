// Spectator reactions: a viewer taps one of a few emoji and every viewer sees it float over a
// robot. Pure: the room parses and limits with these; nothing is stored, and only an emoji from
// the list and an agent the room checks ever travel, never a viewer's own text.

/** The reactions a viewer may send. */
export const REACTIONS: readonly string[] = ["🔥", "👏", "😂", "😮", "💪", "⚡"];
/** One reaction per socket per this many ms. */
export const SOCKET_GAP_MS = 1_000;
/** The room relays at most this many reactions per second to everyone; the rest are dropped. */
export const ROOM_PER_SECOND = 10;

/** A viewer's reaction, as the room relays it. */
export interface Reaction {
  emoji: string;
  agent?: string; // the viewer's pick, when it is one of the race's robots
}

/** The reaction in a socket message, or undefined for anything else. `agent` is kept only when `agents` has it. */
export function parseReaction(data: unknown, agents: readonly string[]): Reaction | undefined {
  if (typeof data !== "string" || data.length > 200) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { kind, emoji, agent } = body as Record<string, unknown>;
  if (kind !== "react" || typeof emoji !== "string" || !REACTIONS.includes(emoji)) return undefined;
  return typeof agent === "string" && agents.includes(agent) ? { emoji, agent } : { emoji };
}

/** True when a socket that last reacted at `last` (undefined: never) may react at `now`. */
export function socketAllows(last: number | undefined, now: number, gapMs: number = SOCKET_GAP_MS): boolean {
  return last === undefined || now - last >= gapMs;
}

/** The room's second: how many it relayed since `startedAt`. */
export interface RoomWindow { startedAt: number; count: number }

/** The window after one more reaction at `now`, or undefined when the room's limit drops it. */
export function roomAllows(window: RoomWindow | undefined, now: number, perSecond: number = ROOM_PER_SECOND): RoomWindow | undefined {
  const fresh = window === undefined || now - window.startedAt >= 1_000 ? { startedAt: now, count: 0 } : window;
  if (fresh.count >= perSecond) return undefined;
  return { startedAt: fresh.startedAt, count: fresh.count + 1 };
}
