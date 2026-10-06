// Pure: clips a fork diff before it is saved for the diff route.

/** Characters of diff kept per fork. */
export const MAX_SAVED_DIFF = 200_000;

/** A fork's diff as saved for the diff route, and whether it was cut to MAX_SAVED_DIFF. */
export type SavedDiff = { diff: string; clipped: boolean };

/**
 * A short diff stays whole. A long one is cut after the last newline at or before max
 * (whole lines only), or at max when there is no newline.
 */
export function clipDiff(diff: string, max: number = MAX_SAVED_DIFF): SavedDiff {
  if (diff.length <= max) return { diff, clipped: false };
  const i = diff.lastIndexOf("\n", max - 1);
  return { diff: i >= 0 ? diff.slice(0, i + 1) : diff.slice(0, max), clipped: true };
}
