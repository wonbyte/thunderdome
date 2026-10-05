// Turns a title into a URL slug: "Hello, World!" -> "hello-world".
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Counts the words in a text. Words are split by white space.
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

// Formats an amount in cents as dollars: 1999 -> "$19.99".
export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars}.${rest}`;
}
