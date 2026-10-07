// A link to a moment of a replay: `?replay&t=1:42` (or `t=102`) opens the replay paused there.
// Pure, like board.ts; the time is relative to the replay's start, as the time readout shows it.

/** The `t` of a query as milliseconds into the replay, or undefined when it has none or it is not a time. */
export function parseMoment(search: string): number | undefined {
  const t = new URLSearchParams(search).get("t");
  if (t === null) return undefined;
  const m = /^(?:(\d{1,3}):)?(\d{1,6})(?:\.(\d{1,3}))?$/.exec(t.trim());
  if (m === null) return undefined;
  const mins = m[1] === undefined ? 0 : Number(m[1]);
  const secs = Number(m[2]);
  if (m[1] !== undefined && secs >= 60) return undefined;
  const frac = m[3] === undefined ? 0 : Number(`0.${m[3]}`);
  return Math.round((mins * 60 + secs + frac) * 1000);
}

/** `m:ss` for a link, with a tenth when there is one (`1:42.4`), so the link lands where the viewer was. */
export function momentText(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const secs = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${frac === 0 ? "" : `.${frac}`}`;
}

/** The replay link to a moment: `<origin>/race/<id>?replay&t=1:42`. */
export function momentLink(origin: string, taskId: string, ms: number): string {
  return `${origin}/race/${taskId}?replay&t=${momentText(ms)}`;
}
