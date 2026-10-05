// Formats an amount in cents as dollars: 1999 -> "$19.99".
export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${rest}`;
}

// The part of an amount that a percent stands for, rounded to the nearest cent: (1205, 10) -> 121.
export function percentOf(cents: number, percent: number): number {
  return Math.floor((cents * percent) / 100);
}
