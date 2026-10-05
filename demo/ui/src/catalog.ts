import { slugify } from "./slug.ts";

export interface Product {
  title: string;
  cents: number;
  blurb: string;
  saleCents?: number; // the sale price, when the product is on sale
}

export const PRODUCTS: Product[] = [
  { title: "Thunderdome Mug", cents: 1999, blurb: "Holds one winning idea." },
  { title: "Café Crème", cents: 450, blurb: "Smooth coffee with warm milk." },
  { title: "Judge Notebook", cents: 2500, blurb: "Writes down why.", saleCents: 1800 },
  { title: "Thunder Brew", cents: 1205, blurb: "Cold brew for long days.", saleCents: 999 },
  { title: "Fork Stickers", cents: 600, blurb: "One for every agent." },
];

export function slugOf(product: Product): string {
  return slugify(product.title);
}
