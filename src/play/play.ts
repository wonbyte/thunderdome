// Pure: input checks and the daily quota for the public POST /play. No cloudflare:workers import.

/** The demo apps a public play may race on. */
export const PLAY_TEMPLATES = ["thunderdome-bugs", "thunderdome-ui", "thunderdome-clash", "thunderdome-fusion"] as const;
/** Shortest task a play accepts, in characters after trimming. */
export const PLAY_PROMPT_MIN = 10;
/** Longest task a play accepts, in characters after trimming. */
export const PLAY_PROMPT_MAX = 600;
/** Robots in a public play race. */
export const PLAY_AGENTS = 5;
/** Plays per IP per day. */
export const PLAY_PER_IP = 3;
/** Plays per day when PLAY_DAILY_LIMIT is missing or bad. */
export const PLAY_DAILY_DEFAULT = 10;

/** A checked play request: the demo app and the task. */
export type PlayInput = { template: string; prompt: string };
/** Why a play request was refused, with its HTTP status. */
export type PlayError = { error: string; status: 400 | 403 };

function isPlayTemplate(value: unknown): value is string {
  return typeof value === "string" && (PLAY_TEMPLATES as readonly string[]).includes(value);
}

/** The checked input with the prompt trimmed, or an error. invite "" means no invite code. */
export function parsePlay(body: unknown, invite: string): PlayInput | PlayError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Body must be a JSON object", status: 400 };
  const fields = body as Record<string, unknown>;
  if (!isPlayTemplate(fields.template)) return { error: `template must be one of ${PLAY_TEMPLATES.join(", ")}`, status: 400 };
  const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : undefined;
  if (prompt === undefined || prompt.length < PLAY_PROMPT_MIN || prompt.length > PLAY_PROMPT_MAX) {
    return { error: `prompt must be ${PLAY_PROMPT_MIN} to ${PLAY_PROMPT_MAX} characters`, status: 400 };
  }
  if (invite !== "" && fields.invite !== invite) return { error: "invite code is wrong", status: 403 };
  return { template: fields.template, prompt };
}

/** The saved quota for one UTC day: plays used, in all and per IP. */
export type QuotaState = { day: string; used: number; byIp: Record<string, number> };
/** Which limit refused a play: the day's total, or the IP's share. */
export type QuotaReason = "daily" | "ip";
/** takeQuota's answer: the new state and plays left, or the limit that refused it. */
export type TakeResult = { ok: true; state: QuotaState; remaining: number } | { ok: false; reason: QuotaReason; state: QuotaState };

/** What PlayQuota.take returns over RPC (no byIp, so IPs never leave the object). */
export type QuotaTaken = { ok: true; remaining: number } | { ok: false; reason: QuotaReason };

/** Takes one play for ip on day. A state from another day starts fresh. Never mutates state. */
export function takeQuota(state: QuotaState | undefined, day: string, ip: string, daily: number, perIp: number = PLAY_PER_IP): TakeResult {
  const base: QuotaState = state?.day === day ? state : { day, used: 0, byIp: {} };
  if (base.used >= daily) return { ok: false, reason: "daily", state: base };
  const n = base.byIp[ip] ?? 0;
  if (n >= perIp) return { ok: false, reason: "ip", state: base };
  const used = base.used + 1;
  return { ok: true, state: { day, used, byIp: { ...base.byIp, [ip]: n + 1 } }, remaining: Math.max(0, daily - used) };
}

/** The quota as the play page sees it. */
export type QuotaView = { day: string; used: number; limit: number; remaining: number };

/** The public view of the quota for day: no IPs. */
export function quotaView(state: QuotaState | undefined, day: string, daily: number): QuotaView {
  const used = state?.day === day ? state.used : 0;
  return { day, used, limit: daily, remaining: Math.max(0, daily - used) };
}

/** "YYYY-MM-DD" in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** A positive integer string gives that number; anything else gives PLAY_DAILY_DEFAULT. */
export function playDailyLimit(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return PLAY_DAILY_DEFAULT;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : PLAY_DAILY_DEFAULT;
}
