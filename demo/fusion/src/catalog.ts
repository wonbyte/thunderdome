// The shop's products. Prices are in cents; a product on sale has a sale price too.
export interface Product {
  slug: string;
  title: string;
  cents: number;
  saleCents?: number;
}

export const PRODUCTS: Product[] = [
  { slug: "thunderdome-mug", title: "Thunderdome Mug", cents: 1999 },
  { slug: "judge-notebook", title: "Judge Notebook", cents: 2500, saleCents: 1800 },
  { slug: "arena-desk", title: "Arena Desk", cents: 129900, saleCents: 99950 },
  { slug: "fork-stickers", title: "Fork Stickers", cents: 600 },
  { slug: "thunder-brew", title: "Thunder Brew", cents: 1205, saleCents: 999 },
];
