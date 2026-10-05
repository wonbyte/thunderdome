import { slugify } from "./slug.ts";

export interface Product {
  title: string;
  cents: number;
  blurb: string;
}

export const PRODUCTS: Product[] = [
  { title: "Café Crème", cents: 450, blurb: "Smooth coffee with warm milk." },
  { title: "Thunder Brew", cents: 1205, blurb: "Cold brew for long days." },
  { title: "Thunderdome Mug", cents: 1999, blurb: "Holds one winning idea." },
  { title: "Judge Notebook", cents: 2500, blurb: "Writes down why." },
];

// The product with this slug, or undefined.
export function findProduct(slug: string): Product | undefined {
  return PRODUCTS.find((product) => slugify(product.title) === slug);
}
